//! Binary marching squares with low-valued diagonal connectivity. Directed
//! segment assembly preserves scan order and the first-created contour ID.
//! The assembly follows scikit-image's find_contours (see THIRD-PARTY-NOTICES).

use crate::geom::Vec2;
use std::cell::RefCell;
use std::collections::VecDeque;

// Contour points are cell-edge midpoints, kept as doubled integer coordinates and
// looked up in dense tables (0 = empty, otherwise chain index + 1).
type Point = (i32, i32);

struct Chain {
    id: usize,
    points: VecDeque<Point>,
}

#[derive(Default)]
struct Tables {
    stride: usize,
    starts: Vec<u32>,
    ends: Vec<u32>,
    touched: Vec<usize>,
    mask: Vec<u8>,
}

impl Tables {
    fn prepare(&mut self, width: usize, height: usize) {
        let stride = 2 * height + 3;
        let size = (2 * width + 3) * stride;
        if self.starts.len() != size || self.stride != stride {
            self.stride = stride;
            self.starts = vec![0; size];
            self.ends = vec![0; size];
        }
    }

    fn index(&self, p: Point) -> usize {
        p.0 as usize * self.stride + p.1 as usize
    }

    fn take(table: &mut [u32], i: usize) -> Option<usize> {
        let value = std::mem::take(&mut table[i]);
        (value != 0).then(|| value as usize - 1)
    }

    fn put(table: &mut [u32], touched: &mut Vec<usize>, i: usize, chain: usize) {
        table[i] = chain as u32 + 1;
        touched.push(i);
    }

    fn reset(&mut self) {
        for &i in &self.touched {
            self.starts[i] = 0;
            self.ends[i] = 0;
        }
        self.touched.clear();
    }

    fn segment(&mut self, chains: &mut Vec<Option<Chain>>, from: Point, to: Point) {
        let (fi, ti) = (self.index(from), self.index(to));
        let tail = Tables::take(&mut self.starts, ti);
        let head = Tables::take(&mut self.ends, fi);
        match (head, tail) {
            (None, None) => {
                let id = chains.len();
                chains.push(Some(Chain { id, points: VecDeque::from([from, to]) }));
                Tables::put(&mut self.starts, &mut self.touched, fi, id);
                Tables::put(&mut self.ends, &mut self.touched, ti, id);
            }
            (None, Some(tail)) => {
                chains[tail].as_mut().unwrap().points.push_front(from);
                Tables::put(&mut self.starts, &mut self.touched, fi, tail);
            }
            (Some(head), None) => {
                chains[head].as_mut().unwrap().points.push_back(to);
                Tables::put(&mut self.ends, &mut self.touched, ti, head);
            }
            (Some(head), Some(tail)) if head == tail => {
                chains[head].as_mut().unwrap().points.push_back(to);
            }
            (Some(head), Some(tail)) => {
                if chains[tail].as_ref().unwrap().id > chains[head].as_ref().unwrap().id {
                    let moved = chains[tail].take().unwrap();
                    let chain = chains[head].as_mut().unwrap();
                    chain.points.extend(moved.points);
                    let (first, last) = (self.index(chain.points[0]), self.index(*chain.points.back().unwrap()));
                    Tables::put(&mut self.starts, &mut self.touched, first, head);
                    Tables::put(&mut self.ends, &mut self.touched, last, head);
                } else {
                    let moved = chains[head].take().unwrap();
                    let old_start = self.index(moved.points[0]);
                    self.starts[old_start] = 0;
                    let chain = chains[tail].as_mut().unwrap();
                    for p in moved.points.into_iter().rev() {
                        chain.points.push_front(p);
                    }
                    let (first, last) = (self.index(chain.points[0]), self.index(*chain.points.back().unwrap()));
                    Tables::put(&mut self.starts, &mut self.touched, first, tail);
                    Tables::put(&mut self.ends, &mut self.touched, last, tail);
                }
            }
        }
    }
}

thread_local! {
    static TABLES: RefCell<Tables> = RefCell::new(Tables::default());
}

pub fn extract(regions: &[u8], side: u8, width: usize, height: usize) -> Vec<Vec<Vec2>> {
    TABLES.with(|tables| extract_with(&mut tables.borrow_mut(), regions, side, width, height))
}

fn extract_with(t: &mut Tables, regions: &[u8], side: u8, width: usize, height: usize) -> Vec<Vec<Vec2>> {
    t.prepare(width, height);
    let mut chains: Vec<Option<Chain>> = Vec::new();
    // The side's cells with an empty border, x-major like the grid.
    let stride = height + 2;
    t.mask.clear();
    t.mask.resize((width + 2) * stride, 0);
    let mut occupied = vec![false; width + 2];
    for x in 0..width {
        let column = &regions[x * height..(x + 1) * height];
        let target = &mut t.mask[(x + 1) * stride + 1..][..height];
        for (m, &r) in target.iter_mut().zip(column) {
            *m = (r == side) as u8;
        }
        occupied[x + 1] = target.contains(&1);
    }
    let mask = std::mem::take(&mut t.mask);
    for x in 0..width + 1 {
        if !occupied[x] && !occupied[x + 1] {
            continue;
        }
        let (left, right) = (&mask[x * stride..(x + 1) * stride], &mask[(x + 1) * stride..(x + 2) * stride]);
        for y in 0..height + 1 {
            let code = left[y] | (left[y + 1] << 1) | (right[y] << 2) | (right[y + 1] << 3);
            if code == 0 || code == 15 {
                continue;
            }
            let (x2, y2) = (2 * x as i32, 2 * y as i32);
            let top = (x2, y2 + 1);
            let bottom = (x2 + 2, y2 + 1);
            let left = (x2 + 1, y2);
            let right = (x2 + 1, y2 + 2);
            match code {
                1 => t.segment(&mut chains, top, left),
                2 => t.segment(&mut chains, right, top),
                3 => t.segment(&mut chains, right, left),
                4 => t.segment(&mut chains, left, bottom),
                5 => t.segment(&mut chains, top, bottom),
                6 => {
                    t.segment(&mut chains, right, top);
                    t.segment(&mut chains, left, bottom);
                }
                7 => t.segment(&mut chains, right, bottom),
                8 => t.segment(&mut chains, bottom, right),
                9 => {
                    t.segment(&mut chains, top, left);
                    t.segment(&mut chains, bottom, right);
                }
                10 => t.segment(&mut chains, bottom, top),
                11 => t.segment(&mut chains, bottom, left),
                12 => t.segment(&mut chains, left, right),
                13 => t.segment(&mut chains, top, right),
                14 => t.segment(&mut chains, left, top),
                _ => {}
            }
        }
    }
    t.reset();
    t.mask = mask;
    let mut polygons: Vec<Vec<Vec2>> = chains
        .into_iter()
        .flatten()
        .map(|chain| simplify(chain.points.into_iter().map(|(x, y)| Vec2::new(x as f64 / 2.0, y as f64 / 2.0)), width, height))
        .collect();
    if side == 0 {
        let (w, h) = (width as f64, height as f64);
        for polygon in polygons.iter_mut() {
            if polygon.len() > 2 && !polygon.iter().any(|p| p.x == -10.0 || p.x == (w + 1.0) * 10.0 || p.y == -10.0 || p.y == (h + 1.0) * 10.0) {
                let n = polygon.len();
                polygon[0] = (polygon[0] - polygon[1]) * 0.5 * 3.0 + polygon[1];
                polygon[n - 1] = (polygon[n - 1] - polygon[n - 2]) * 0.5 * 3.0 + polygon[n - 2];
            }
        }
    }
    polygons
}

fn simplify(source: impl ExactSizeIterator<Item = Vec2>, width: usize, height: usize) -> Vec<Vec2> {
    let (w, h) = (width as f64, height as f64);
    let n = source.len();
    let mut points = Vec::with_capacity(n);
    let mut boundary = Vec::with_capacity(n);
    let mut corners = Vec::with_capacity(n);
    for p in source {
        let p = p - Vec2::new(0.5, 0.5);
        let x_edge = p.x <= 0.5 || p.x >= w - 0.5;
        let y_edge = p.y <= 0.5 || p.y >= h - 0.5;
        points.push(Vec2::new(
            if p.x <= 0.5 { -1.0 } else if p.x >= w - 0.5 { w + 1.0 } else { p.x },
            if p.y <= 0.5 { -1.0 } else if p.y >= h - 0.5 { h + 1.0 } else { p.y },
        ));
        boundary.push(x_edge || y_edge);
        corners.push(x_edge && y_edge);
    }
    (0..n)
        .filter(|&i| corners[i] || !(boundary[i] && boundary[(i + n - 1) % n] && boundary[(i + 1) % n]))
        .map(|i| points[i] * 10.0)
        .collect()
}

pub fn inside(point: Vec2, polygon: &[Vec2]) -> bool {
    let mut crossings = 0;
    let n = polygon.len();
    for i in 0..n {
        let a = polygon[i];
        let b = polygon[(i + 1) % n];
        if (point.x - a.x).abs() <= 1e-8 + 1e-5 * a.x.abs() && (point.y - a.y).abs() <= 1e-8 + 1e-5 * a.y.abs() {
            return false;
        }
        if (a.y > point.y) != (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y + 1e-12) + a.x {
            crossings += 1;
        }
    }
    crossings % 2 == 1
}
