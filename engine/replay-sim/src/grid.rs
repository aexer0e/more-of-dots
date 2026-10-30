//! A uniform grid for finding units near a point. Queries return unit ids in
//! ascending order, the order the reference engine scans units in.

use crate::geom::Vec2;

pub struct Grid {
    cell: f64,
    columns: usize,
    rows: usize,
    heads: Vec<u32>,
    next: Vec<u32>,
}

const NONE: u32 = u32::MAX;

/// Wider than every contact distance (24, 34.2 and 36), so one cell of reach finds
/// them all despite rounding at cell borders.
pub const CELL: f64 = 40.0;
/// Wider than the 100 within which an enemy blocks healing.
pub const HEAL_CELL: f64 = 105.0;

impl Grid {
    pub fn new(cell: f64) -> Grid {
        Grid { cell, columns: 0, rows: 0, heads: Vec::new(), next: Vec::new() }
    }

    fn coordinates(&self, p: Vec2) -> (usize, usize) {
        // Clamping is monotone and never stretches distances, so points within one
        // cell of each other stay within one cell after it.
        let x = (p.x / self.cell).floor();
        let y = (p.y / self.cell).floor();
        let x = if x.is_nan() { 0.0 } else { x.clamp(0.0, (self.columns - 1) as f64) };
        let y = if y.is_nan() { 0.0 } else { y.clamp(0.0, (self.rows - 1) as f64) };
        (x as usize, y as usize)
    }

    /// Indexes the given units by position. `ids` must be ascending.
    pub fn build(&mut self, width: usize, height: usize, ids: &[usize], position: impl Fn(usize) -> Vec2) {
        self.columns = (width as f64 / self.cell).ceil() as usize + 1;
        self.rows = (height as f64 / self.cell).ceil() as usize + 1;
        self.heads.clear();
        self.heads.resize(self.columns * self.rows, NONE);
        let count = ids.iter().copied().max().map_or(0, |m| m + 1);
        self.next.clear();
        self.next.resize(count, NONE);
        // Inserting in descending order leaves each cell's list ascending.
        for &id in ids.iter().rev() {
            let (x, y) = self.coordinates(position(id));
            let cell = y * self.columns + x;
            self.next[id] = self.heads[cell];
            self.heads[cell] = id as u32;
        }
    }

    /// Units in the cells within `reach` cells of `p`, ascending by id.
    pub fn near(&self, p: Vec2, reach: usize, out: &mut Vec<usize>) {
        self.near_unordered(p, reach, out);
        out.sort_unstable();
    }

    /// The same units in no particular order.
    pub fn near_unordered(&self, p: Vec2, reach: usize, out: &mut Vec<usize>) {
        out.clear();
        if self.heads.is_empty() {
            return;
        }
        let (cx, cy) = self.coordinates(p);
        for y in cy.saturating_sub(reach)..=(cy + reach).min(self.rows - 1) {
            for x in cx.saturating_sub(reach)..=(cx + reach).min(self.columns - 1) {
                let mut id = self.heads[y * self.columns + x];
                while id != NONE {
                    out.push(id as usize);
                    id = self.next[id as usize];
                }
            }
        }
    }
}
