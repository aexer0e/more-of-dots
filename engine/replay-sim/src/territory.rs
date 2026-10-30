//! Native influence grid: x-major float32 sums, then stable side-order argmax.

use crate::contours;
use crate::geom::{trunc_i32, Vec2};
use crate::replay::Unit;
use std::sync::OnceLock;

const DOT_RADIUS: i32 = 12;
const CITY_RADIUS: i32 = 90;

fn kernel(radius: i32, power: i32, strength: f64) -> Vec<f32> {
    let size = (2 * radius + 1) as usize;
    let mut result = vec![0f32; size * size];
    for x in -radius..=radius {
        for y in -radius..=radius {
            let d2 = (x * x + y * y) as f64;
            result[(x + radius) as usize * size + (y + radius) as usize] = (strength / (1.0 + d2.powi(power))) as f32;
        }
    }
    result
}

fn dot_kernel() -> &'static [f32] {
    static K: OnceLock<Vec<f32>> = OnceLock::new();
    K.get_or_init(|| kernel(DOT_RADIUS, 3, 5.0))
}

fn city_kernel() -> &'static [f32] {
    static K: OnceLock<Vec<f32>> = OnceLock::new();
    K.get_or_init(|| kernel(CITY_RADIUS, 2, 1.0))
}

pub type Polygons = Vec<Vec<Vec2>>;

/// An influencing unit's side and grid cell.
type Cell = (usize, i32, i32);

pub struct Territory {
    pub width: usize,
    pub height: usize,
    side_count: usize,
    /// The grid, x-major. Replaced only when it changes; `version` counts replacements.
    pub regions: Option<Vec<u8>>,
    pub version: u64,
    pub city_colors: Vec<usize>,
    /// Units that influenced the latest update, by unit id.
    pub influence_units: Vec<bool>,
    // The grid depends only on each influencing unit's cell and the city colors.
    inputs: Vec<i32>,
    previous_inputs: Vec<i32>,
    influence: Vec<Vec<f32>>,
    contours: Option<(u64, Vec<Polygons>)>,
    // What the influence sums were made from.
    cells: Vec<Option<Cell>>,
    computed_city_colors: Vec<usize>,
    dirty: Vec<bool>,
}

impl Territory {
    pub fn new(map_width: usize, map_height: usize, side_count: usize, units: &[Unit], cities: &[Vec2]) -> Territory {
        let city_colors = cities
            .iter()
            .map(|city| {
                let mut best = &units[0];
                for unit in &units[1..] {
                    if (unit.position - *city).length_squared() < (best.position - *city).length_squared() {
                        best = unit;
                    }
                }
                best.owner
            })
            .collect();
        let (width, height) = (map_width / 10, map_height / 10);
        Territory {
            width,
            height,
            side_count,
            regions: None,
            version: 0,
            city_colors,
            influence_units: Vec::new(),
            inputs: Vec::new(),
            previous_inputs: Vec::new(),
            influence: vec![vec![0f32; width * height]; side_count],
            contours: None,
            cells: Vec::new(),
            computed_city_colors: Vec::new(),
            dirty: Vec::new(),
        }
    }

    pub fn update(&mut self, influence_units: Vec<bool>, units: &[Unit], cities: &[Vec2]) {
        self.influence_units = influence_units;
        let influences = |unit: &Unit, set: &[bool]| set.get(unit.id).copied().unwrap_or(false) && !unit.ship;
        // Repeating an update with the same inputs leaves the grid as it is.
        self.inputs.clear();
        for unit in units {
            if influences(unit, &self.influence_units) {
                self.inputs.extend([unit.owner as i32, trunc_i32(unit.position.x / 10.0), trunc_i32(unit.position.y / 10.0)]);
            }
        }
        self.inputs.push(-1);
        self.inputs.extend(self.city_colors.iter().map(|&c| c as i32));
        if self.regions.is_some() && self.inputs == self.previous_inputs {
            return;
        }
        std::mem::swap(&mut self.inputs, &mut self.previous_inputs);
        let (w, h) = (self.width, self.height);
        let cells: Vec<Option<Cell>> = units
            .iter()
            .map(|unit| influences(unit, &self.influence_units).then(|| (unit.owner, trunc_i32(unit.position.x / 10.0), trunc_i32(unit.position.y / 10.0))))
            .collect();
        let incremental = self.regions.is_some() && self.city_colors == self.computed_city_colors;
        let mut next = self.regions.clone().unwrap_or_else(|| vec![0u8; w * h]);
        if incremental {
            // Each cell is its own float32 sum of units in order, then cities in order.
            // A cell no changed unit reaches keeps its sum, so only reached cells are
            // summed again, in the same order, which gives the same values.
            self.dirty.clear();
            self.dirty.resize(w * h, false);
            for id in 0..cells.len().max(self.cells.len()) {
                let (old, new) = (self.cells.get(id).copied().flatten(), cells.get(id).copied().flatten());
                if old != new {
                    for (_, cx, cy) in [old, new].into_iter().flatten() {
                        mark(&mut self.dirty, w, h, cx, cy, DOT_RADIUS);
                    }
                }
            }
            let runs = runs(&self.dirty, w, h);
            for side in 0..self.side_count {
                let grid = &mut self.influence[side];
                for &(x, top, length) in &runs {
                    grid[x * h + top..][..length].fill(0.0);
                }
                for &(owner, cx, cy) in cells.iter().flatten() {
                    if owner == side {
                        add_runs(grid, h, &runs, cx, cy, dot_kernel(), DOT_RADIUS);
                    }
                }
                for (city, &color) in self.city_colors.iter().enumerate() {
                    if color == side {
                        let (cx, cy) = (trunc_i32(cities[city].x / 10.0), trunc_i32(cities[city].y / 10.0));
                        add_runs(grid, h, &runs, cx, cy, city_kernel(), CITY_RADIUS);
                    }
                }
            }
            let regions = self.regions.as_ref().unwrap();
            for &(x, top, length) in &runs {
                for i in x * h + top..x * h + top + length {
                    next[i] = owner_of(&self.influence, i, regions[i]);
                }
            }
        } else {
            for side in 0..self.side_count {
                let grid = &mut self.influence[side];
                grid.fill(0.0);
                for &(owner, cx, cy) in cells.iter().flatten() {
                    if owner == side {
                        add(grid, w, h, cx, cy, dot_kernel(), DOT_RADIUS);
                    }
                }
                for (city, &color) in self.city_colors.iter().enumerate() {
                    if color == side {
                        add(grid, w, h, trunc_i32(cities[city].x / 10.0), trunc_i32(cities[city].y / 10.0), city_kernel(), CITY_RADIUS);
                    }
                }
            }
            for i in 0..next.len() {
                next[i] = match &self.regions {
                    Some(regions) => owner_of(&self.influence, i, regions[i]),
                    None => owner_of(&self.influence, i, u8::MAX),
                };
            }
            self.computed_city_colors = self.city_colors.clone();
        }
        self.cells = cells;
        if self.regions.as_ref() != Some(&next) {
            self.regions = Some(next);
            self.version += 1;
        }
        for i in 0..self.city_colors.len() {
            self.city_colors[i] = self.owner_at(cities[i]);
        }
    }

    pub fn owner_at(&self, point: Vec2) -> usize {
        let x = trunc_i32(point.x / 10.0).clamp(0, self.width as i32 - 1) as usize;
        let y = trunc_i32(point.y / 10.0).clamp(0, self.height as i32 - 1) as usize;
        self.regions.as_ref().unwrap()[x * self.height + y] as usize
    }

    /// The same polygons are returned until the grid changes.
    pub fn contours(&mut self) -> &Vec<Polygons> {
        let stale = !matches!(&self.contours, Some((version, _)) if *version == self.version);
        if stale {
            let regions = self.regions.as_ref().expect("contours need a territory update");
            let polygons = (0..self.side_count).map(|side| contours::extract(regions, side as u8, self.width, self.height)).collect();
            self.contours = Some((self.version, polygons));
        }
        &self.contours.as_ref().unwrap().1
    }

    pub fn grid_groups(&mut self, units: &[Unit], cities: &[Vec2]) -> (Vec<Vec<Vec<usize>>>, Vec<Vec<Vec<i32>>>) {
        let side_count = self.side_count;
        let mut dots = vec![Vec::new(); side_count];
        let mut city_groups = vec![Vec::new(); side_count];
        let city_colors = self.city_colors.clone();
        let influence_units = self.influence_units.clone();
        let contours = self.contours().clone();
        for side in 0..side_count {
            let polygons = &contours[side];
            for polygon in polygons {
                let children: Vec<&Vec<Vec2>> = polygons.iter().filter(|other| contours::inside(other[0], polygon)).collect();
                let in_group = |p: Vec2| contours::inside(p, polygon) && !children.iter().any(|child| contours::inside(p, child));
                dots[side].push(
                    units
                        .iter()
                        .filter(|u| influence_units.get(u.id).copied().unwrap_or(false) && u.owner == side && in_group(u.position))
                        .map(|u| u.id)
                        .collect(),
                );
                city_groups[side].push((0..city_colors.len()).filter(|&city| city_colors[city] == side && in_group(cities[city])).map(|city| city as i32).collect());
            }
        }
        (dots, city_groups)
    }
}

/// The stable side-order argmax. A changed cell keeps its old owner (`previous`,
/// or none on the first update) while every influence is below 1e-5.
fn owner_of(influence: &[Vec<f32>], i: usize, previous: u8) -> u8 {
    let mut max = influence[0][i];
    let mut owner = 0u8;
    for (side, grid) in influence.iter().enumerate().skip(1) {
        if grid[i] >= max {
            max = grid[i];
            owner = side as u8;
        }
    }
    if previous != u8::MAX && owner != previous && max < 1e-5f32 {
        previous
    } else {
        owner
    }
}

/// The kernel window around a cell, clipped to the grid: columns, then the first row and row count.
fn window(width: usize, height: usize, cx: i32, cy: i32, radius: i32) -> Option<(std::ops::RangeInclusive<i32>, i32, usize)> {
    let top = (cy - radius).max(0);
    let length = (height as i32 - 1).min(cy + radius) - top + 1;
    (length > 0).then(|| ((cx - radius).max(0)..=(width as i32 - 1).min(cx + radius), top, length as usize))
}

fn mark(dirty: &mut [bool], width: usize, height: usize, cx: i32, cy: i32, radius: i32) {
    if let Some((columns, top, length)) = window(width, height, cx, cy, radius) {
        for x in columns {
            dirty[x as usize * height + top as usize..][..length].fill(true);
        }
    }
}

/// Runs of marked cells per column: (x, first row, row count).
fn runs(dirty: &[bool], width: usize, height: usize) -> Vec<(usize, usize, usize)> {
    let mut runs = Vec::new();
    for x in 0..width {
        let column = &dirty[x * height..(x + 1) * height];
        let mut y = 0;
        while y < height {
            if !column[y] {
                y += 1;
                continue;
            }
            let start = y;
            while y < height && column[y] {
                y += 1;
            }
            runs.push((x, start, y - start));
        }
    }
    runs
}

fn add(influence: &mut [f32], width: usize, height: usize, center_x: i32, center_y: i32, kernel: &[f32], radius: i32) {
    let size = (2 * radius + 1) as usize;
    let Some((columns, top, length)) = window(width, height, center_x, center_y, radius) else { return };
    for x in columns {
        let target = &mut influence[x as usize * height + top as usize..][..length];
        let source = &kernel[(x - center_x + radius) as usize * size + (top - center_y + radius) as usize..][..length];
        for (t, s) in target.iter_mut().zip(source) {
            *t += *s;
        }
    }
}

/// Adds the kernel only to the given runs of cells.
fn add_runs(influence: &mut [f32], height: usize, runs: &[(usize, usize, usize)], center_x: i32, center_y: i32, kernel: &[f32], radius: i32) {
    let size = (2 * radius + 1) as usize;
    let (low, high) = (center_y - radius, center_y + radius);
    for &(x, top, length) in runs {
        let x = x as i32;
        if (x - center_x).abs() > radius {
            continue;
        }
        let first = (top as i32).max(low);
        let last = (top as i32 + length as i32 - 1).min(high);
        if first > last {
            continue;
        }
        let count = (last - first + 1) as usize;
        let target = &mut influence[x as usize * height + first as usize..][..count];
        let source = &kernel[(x - center_x + radius) as usize * size + (first - center_y + radius) as usize..][..count];
        for (t, s) in target.iter_mut().zip(source) {
            *t += *s;
        }
    }
}
