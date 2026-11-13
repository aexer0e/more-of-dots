//! Influence grid: each side's influence per 10-pixel cell, then stable side-order argmax.
//!
//! mass-sim: replay-sim sums every unit's and city's influence again for every changed
//! cell, in a fixed order, to match the game's float32 sums exactly. With thousands of
//! units that is most of a tick. Here the influence is kept as exact fixed-point sums
//! that a unit changes only when it enters another cell (or a city when it changes
//! hands): its kernel is taken off at the old cell and added at the new one. The
//! result is the same on every page, which is what a match needs, though it is not
//! the game's float32 rounding.

use crate::contours;
use crate::geom::{trunc_i32, Vec2};
use crate::replay::Unit;
use std::sync::OnceLock;

/// mass-sim: six cells, not replay-sim's twelve. Past six a unit's influence is under
/// 0.02% of its peak, and each unit that changes cells costs a quarter of the work.
const DOT_RADIUS: i32 = 6;
const CITY_RADIUS: i32 = 90;
/// Fixed-point scale of the influence sums: 2^40 a unit of influence.
const SCALE: f64 = 1_099_511_627_776.0;
/// A changed cell keeps its owner while every influence is below this (1e-5).
const FAINT: i64 = (1e-5 * SCALE) as i64;

fn kernel(radius: i32, power: i32, strength: f64) -> Vec<i64> {
    let size = (2 * radius + 1) as usize;
    let mut result = vec![0i64; size * size];
    for x in -radius..=radius {
        for y in -radius..=radius {
            let d2 = (x * x + y * y) as f64;
            result[(x + radius) as usize * size + (y + radius) as usize] = (strength / (1.0 + d2.powi(power)) * SCALE).round() as i64;
        }
    }
    result
}

fn dot_kernel() -> &'static [i64] {
    static K: OnceLock<Vec<i64>> = OnceLock::new();
    K.get_or_init(|| kernel(DOT_RADIUS, 3, 5.0))
}

fn city_kernel() -> &'static [i64] {
    static K: OnceLock<Vec<i64>> = OnceLock::new();
    K.get_or_init(|| kernel(CITY_RADIUS, 2, 1.0))
}

pub type Polygons = Vec<Vec<Vec2>>;

/// An influencing unit's side and grid cell.
type Cell = (usize, i32, i32);

pub struct Territory {
    pub width: usize,
    pub height: usize,
    side_count: usize,
    /// The grid, x-major. `version` counts its changes.
    pub regions: Option<Vec<u8>>,
    pub version: u64,
    pub city_colors: Vec<usize>,
    /// Units that influenced the latest update, by unit id.
    pub influence_units: Vec<bool>,
    influence: Vec<Vec<i64>>,
    /// The outlines, with the update they were drawn at.
    contours: Option<(u64, Vec<Polygons>)>,
    updates: u64,
    /// Each unit's cell in the sums, by unit id.
    cells: Vec<Option<Cell>>,
    /// The side each city's influence is summed for.
    summed_city_colors: Vec<usize>,
    dirty: Vec<bool>,
    dirty_cells: Vec<usize>,
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
            influence: vec![vec![0i64; width * height]; side_count],
            contours: None,
            updates: 0,
            cells: Vec::new(),
            summed_city_colors: Vec::new(),
            dirty: vec![false; width * height],
            dirty_cells: Vec::new(),
        }
    }

    pub fn update(&mut self, influence_units: Vec<bool>, units: &[Unit], cities: &[Vec2]) {
        self.influence_units = influence_units;
        self.updates += 1;
        let influences = |unit: &Unit, set: &[bool]| set.get(unit.id).copied().unwrap_or(false) && !unit.ship;
        let (w, h) = (self.width, self.height);
        let first = self.regions.is_none();
        self.cells.resize(units.len(), None);
        for unit in units {
            let cell = influences(unit, &self.influence_units).then(|| (unit.owner, trunc_i32(unit.position.x / 10.0), trunc_i32(unit.position.y / 10.0)));
            let old = self.cells[unit.id];
            if old == cell {
                continue;
            }
            if let Some((owner, cx, cy)) = old {
                add(&mut self.influence[owner], w, h, cx, cy, dot_kernel(), DOT_RADIUS, -1);
                self.mark(cx, cy, DOT_RADIUS);
            }
            if let Some((owner, cx, cy)) = cell {
                add(&mut self.influence[owner], w, h, cx, cy, dot_kernel(), DOT_RADIUS, 1);
                self.mark(cx, cy, DOT_RADIUS);
            }
            self.cells[unit.id] = cell;
        }
        self.summed_city_colors.resize(cities.len(), usize::MAX);
        for city in 0..self.city_colors.len() {
            let color = self.city_colors[city];
            let old = self.summed_city_colors[city];
            if old == color {
                continue;
            }
            let (cx, cy) = (trunc_i32(cities[city].x / 10.0), trunc_i32(cities[city].y / 10.0));
            if old != usize::MAX {
                add(&mut self.influence[old], w, h, cx, cy, city_kernel(), CITY_RADIUS, -1);
            }
            add(&mut self.influence[color], w, h, cx, cy, city_kernel(), CITY_RADIUS, 1);
            self.mark(cx, cy, CITY_RADIUS);
            self.summed_city_colors[city] = color;
        }
        if first {
            let regions = (0..w * h).map(|i| owner_of(&self.influence, i, u8::MAX)).collect();
            self.regions = Some(regions);
            self.version += 1;
            for &i in &self.dirty_cells {
                self.dirty[i] = false;
            }
            self.dirty_cells.clear();
        } else {
            let regions = self.regions.as_mut().unwrap();
            let mut changed = false;
            for &i in &self.dirty_cells {
                self.dirty[i] = false;
                let owner = owner_of(&self.influence, i, regions[i]);
                if owner != regions[i] {
                    regions[i] = owner;
                    changed = true;
                }
            }
            self.dirty_cells.clear();
            if changed {
                self.version += 1;
            }
        }
        for i in 0..self.city_colors.len() {
            self.city_colors[i] = self.owner_at(cities[i]);
        }
    }

    fn mark(&mut self, cx: i32, cy: i32, radius: i32) {
        if let Some((columns, top, length)) = window(self.width, self.height, cx, cy, radius) {
            for x in columns {
                let start = x as usize * self.height + top as usize;
                for i in start..start + length {
                    if !self.dirty[i] {
                        self.dirty[i] = true;
                        self.dirty_cells.push(i);
                    }
                }
            }
        }
    }

    pub fn owner_at(&self, point: Vec2) -> usize {
        let x = trunc_i32(point.x / 10.0).clamp(0, self.width as i32 - 1) as usize;
        let y = trunc_i32(point.y / 10.0).clamp(0, self.height as i32 - 1) as usize;
        self.regions.as_ref().unwrap()[x * self.height + y] as usize
    }

    /// The update the outlines were traced at, if they were.
    pub fn contours_stamp(&self) -> Option<u64> {
        self.contours.as_ref().map(|(at, _)| *at)
    }

    /// The territory's outlines, which are only drawn.
    ///
    /// mass-sim: with thousands of units the territory changes almost every tick, and
    /// tracing it takes milliseconds, so the outlines are traced again at most every
    /// 15 updates (half a second). The simulation never reads them.
    pub fn contours(&mut self) -> &Vec<Polygons> {
        let stale = match &self.contours {
            None => true,
            Some((at, _)) => self.updates >= at + 15,
        };
        if stale {
            let regions = self.regions.as_ref().expect("contours need a territory update");
            let polygons = (0..self.side_count).map(|side| contours::extract(regions, side as u8, self.width, self.height)).collect();
            self.contours = Some((self.updates, polygons));
        }
        &self.contours.as_ref().unwrap().1
    }

    /// Each side's supply regions: the units and cities of each connected area of its
    /// territory (cells joined at their sides).
    ///
    /// mass-sim: replay-sim tests every unit and city against every outline of the
    /// territory, which with thousands of units takes a fifth of a second. Here the
    /// grid's connected areas are labelled once and each unit and city looks up its cell.
    pub fn grid_groups(&mut self, units: &[Unit], cities: &[Vec2]) -> (Vec<Vec<Vec<usize>>>, Vec<Vec<Vec<i32>>>) {
        let (w, h) = (self.width, self.height);
        let regions = self.regions.as_ref().expect("groups need a territory update");
        let mut label = vec![u32::MAX; w * h];
        let mut counts = vec![0usize; self.side_count];
        let mut stack = Vec::new();
        for start in 0..w * h {
            if label[start] != u32::MAX {
                continue;
            }
            let side = regions[start] as usize;
            if side >= self.side_count {
                continue;
            }
            let id = counts[side] as u32;
            counts[side] += 1;
            label[start] = id;
            stack.push(start);
            while let Some(i) = stack.pop() {
                let (x, y) = (i / h, i % h);
                let mut visit = |j: usize| {
                    if label[j] == u32::MAX && regions[j] as usize == side {
                        label[j] = id;
                        stack.push(j);
                    }
                };
                if x > 0 {
                    visit(i - h);
                }
                if x + 1 < w {
                    visit(i + h);
                }
                if y > 0 {
                    visit(i - 1);
                }
                if y + 1 < h {
                    visit(i + 1);
                }
            }
        }
        let mut dots: Vec<Vec<Vec<usize>>> = counts.iter().map(|&n| vec![Vec::new(); n]).collect();
        let mut city_groups: Vec<Vec<Vec<i32>>> = counts.iter().map(|&n| vec![Vec::new(); n]).collect();
        let cell_of = |p: Vec2| {
            let x = trunc_i32(p.x / 10.0).clamp(0, w as i32 - 1) as usize;
            let y = trunc_i32(p.y / 10.0).clamp(0, h as i32 - 1) as usize;
            x * h + y
        };
        for unit in units {
            if !self.influence_units.get(unit.id).copied().unwrap_or(false) {
                continue;
            }
            let cell = cell_of(unit.position);
            if regions[cell] as usize == unit.owner {
                dots[unit.owner][label[cell] as usize].push(unit.id);
            }
        }
        for (city, &color) in self.city_colors.iter().enumerate() {
            let cell = cell_of(cities[city]);
            if regions[cell] as usize == color {
                city_groups[color][label[cell] as usize].push(city as i32);
            }
        }
        (dots, city_groups)
    }
}

/// The stable side-order argmax. A changed cell keeps its old owner (`previous`,
/// or none on the first update) while every influence is below 1e-5.
fn owner_of(influence: &[Vec<i64>], i: usize, previous: u8) -> u8 {
    let mut max = influence[0][i];
    let mut owner = 0u8;
    for (side, grid) in influence.iter().enumerate().skip(1) {
        if grid[i] >= max {
            max = grid[i];
            owner = side as u8;
        }
    }
    if previous != u8::MAX && owner != previous && max < FAINT {
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

/// Adds (`sign` 1) or takes off (-1) a kernel at a cell.
#[allow(clippy::too_many_arguments)]
fn add(influence: &mut [i64], width: usize, height: usize, center_x: i32, center_y: i32, kernel: &[i64], radius: i32, sign: i64) {
    let size = (2 * radius + 1) as usize;
    let Some((columns, top, length)) = window(width, height, center_x, center_y, radius) else { return };
    for x in columns {
        let target = &mut influence[x as usize * height + top as usize..][..length];
        let source = &kernel[(x - center_x + radius) as usize * size + (top - center_y + radius) as usize..][..length];
        for (t, s) in target.iter_mut().zip(source) {
            *t += sign * *s;
        }
    }
}
