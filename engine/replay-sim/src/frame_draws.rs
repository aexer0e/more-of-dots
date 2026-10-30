//! Port of the player's draw-list builder (src/player/engine.js paint, overlays.js
//! and frontline.js). Keep the two in step: the converter's video must look like
//! the player. It reads the simulator's state directly, the same values the
//! player reads from a state record.

use crate::render::Draw;
use crate::replay::UnitType;
use crate::sim::Simulator;
use std::collections::{HashMap, HashSet};

const COLORS: [&str; 4] = ["blue", "red", "purple", "orange"];
const RGB: [[i32; 3]; 4] = [[0, 0, 255], [255, 0, 0], [156, 0, 187], [255, 140, 57]];

#[derive(Clone, Debug)]
pub struct Label {
    pub key: String,
    pub width: f64,
    pub height: f64,
    pub line: usize,
}

pub struct FrameDraws {
    pub width: usize,
    pub height: usize,
    pub world: [f64; 2],
    pub layers: HashSet<String>,
    pub labels: Vec<Label>,
}

/// A living unit as a state record lists it.
struct Dot {
    id: usize,
    color: usize,
    kind: UnitType,
    position: [f64; 2],
    health: f64,
    max_health: f64,
    morale: f64,
    ship: bool,
    ship_timer: i32,
    water_timer: i32,
    in_city: bool,
    healing: bool,
    terrain: &'static str,
    path: Vec<[f64; 2]>,
}

fn sprite_color(color: usize) -> &'static str {
    COLORS[color.min(3)]
}

fn unit_sprite(dot: &Dot) -> String {
    let color = sprite_color(dot.color);
    if dot.ship {
        return format!("{color}_{}", if dot.kind == UnitType::Tank { "heavy_ship" } else { "ship" });
    }
    let ratio = dot.health / dot.max_health;
    format!("{color}_{}_{}", dot.kind.name(), if ratio > 0.5 { 100 } else if ratio > 0.15 { 50 } else { 15 })
}

fn unit_size(ship: bool, ship_timer: i32) -> [f64; 2] {
    let timer = ship_timer as f64;
    let scale = if timer > 0.0 { 1.0 + (timer / 4.0).sin() / 12.0 } else { 1.0 };
    if ship {
        [36.0 * scale, 18.0 * scale]
    } else {
        [24.0 * scale, 24.0 * scale]
    }
}

fn icon_for(dot: &Dot) -> Option<(&'static str, [f64; 2])> {
    if dot.ship_timer > 0 {
        return Some(("ship_icon", [32.0, 26.0]));
    }
    if dot.water_timer > 0 {
        return Some(("water_icon", [32.0, 31.0]));
    }
    if dot.in_city {
        return Some(("city_icon", [36.0, 34.0]));
    }
    if dot.healing {
        return Some(("healing_icon", [32.0, 31.0]));
    }
    if dot.kind == UnitType::Tank && dot.terrain == "forest" {
        return Some(("forest_icon", [32.0, 36.0]));
    }
    None
}

fn image(draws: &mut Vec<Draw>, name: &str, position: [f64; 2], size: [f64; 2], alpha: f64, direction: [f64; 2], screen: bool, flip_y: bool) {
    draws.push(Draw::Image { name: name.to_string(), position, size, alpha, direction, screen, flip_y });
}

fn simple_image(draws: &mut Vec<Draw>, name: &str, position: [f64; 2], size: [f64; 2]) {
    image(draws, name, position, size, 1.0, [1.0, 0.0], false, false);
}

fn polygon(draws: &mut Vec<Draw>, points: Vec<[f64; 2]>, color: [f64; 4]) {
    draws.push(Draw::Polygon { points, color });
}

fn rect(draws: &mut Vec<Draw>, x1: f64, y1: f64, x2: f64, y2: f64, color: [f64; 4]) {
    polygon(draws, vec![[x1, y1], [x1, y2], [x2, y2], [x2, y1]], color);
}

fn text(draws: &mut Vec<Draw>, name: &str, value: String, position: [f64; 2], color: [i32; 3], fix: &str) {
    draws.push(Draw::Text { name: name.to_string(), text: value, position, color, fix: fix.to_string(), font_size: 60, outline: 1.5 });
}

/// renderer.line: each smoothing pass subdivides in float32, as Math.fround does.
fn line(draws: &mut Vec<Draw>, points: Vec<[f64; 2]>, color: [f64; 4], width: f64, smooth: usize) {
    if points.len() < 2 {
        return;
    }
    let f = |value: f64| value as f32 as f64;
    let mut points = points;
    for pass in 0..smooth {
        let blend = |a: f64, b: f64, weight: f64| if pass == 0 { f(a * weight + b * (1.0 - weight)) } else { f(f(a * weight) + f(b * (1.0 - weight))) };
        let mut refined = Vec::with_capacity(points.len() * 2);
        refined.push([f(points[0][0]), f(points[0][1])]);
        for pair in points.windows(2) {
            let (a, b) = (pair[0], pair[1]);
            refined.push([blend(a[0], b[0], 0.75), blend(a[1], b[1], 0.75)]);
            refined.push([blend(a[0], b[0], 0.25), blend(a[1], b[1], 0.25)]);
        }
        let last = points[points.len() - 1];
        refined.push([f(last[0]), f(last[1])]);
        points = refined;
    }
    draws.push(Draw::Line { points, color, width });
}

/// Number.prototype.toLocaleString("en-US"): grouped, at most three decimals.
fn locale(value: f64) -> String {
    let rounded = (value * 1000.0).round() / 1000.0;
    let negative = rounded < 0.0;
    let magnitude = rounded.abs();
    let whole = magnitude.trunc();
    let mut digits = format!("{whole:.0}");
    let mut grouped = String::new();
    while digits.len() > 3 {
        let tail = digits.split_off(digits.len() - 3);
        grouped = format!(",{tail}{grouped}");
    }
    grouped = format!("{digits}{grouped}");
    let fraction = magnitude - whole;
    let mut decimals = format!("{fraction:.3}");
    decimals = decimals.trim_start_matches('0').trim_end_matches('0').to_string();
    if decimals == "." {
        decimals.clear();
    }
    format!("{}{grouped}{decimals}", if negative && (whole > 0.0 || !decimals.is_empty()) { "-" } else { "" })
}

/// A vertex's identity: the "x,y" key of the player, as exact doubles.
fn key(p: [f64; 2]) -> (u64, u64) {
    (p[0].to_bits(), p[1].to_bits())
}

fn smooth(points: &[[f64; 2]], looped: bool) -> Vec<[f64; 2]> {
    let count = points.len();
    let mut result = Vec::with_capacity(count + 1);
    for i in 0..count {
        let (mut sx, mut sy) = (0.0, 0.0);
        for delta in -2i64..=2 {
            let index = if looped { ((i as i64 + delta + count as i64) % count as i64) as usize } else { (i as i64 + delta).clamp(0, count as i64 - 1) as usize };
            sx += points[index][0] * 0.2;
            sy += points[index][1] * 0.2;
        }
        result.push([sx, sy]);
    }
    if looped {
        result.push(result[0]);
    } else {
        result[0] = points[0];
        result[count - 1] = points[count - 1];
    }
    result
}

fn pushout(points: Vec<[f64; 2]>, positions: &[[f64; 2]]) -> Vec<[f64; 2]> {
    const RADIUS: f64 = 18.0;
    if positions.is_empty() {
        return points;
    }
    points
        .into_iter()
        .map(|point| {
            let mut closest = positions[0];
            let mut distance2 = f64::INFINITY;
            for dot in positions {
                let (dx, dy) = (point[0] - dot[0], point[1] - dot[1]);
                let distance = dx * dx + dy * dy;
                if distance < distance2 {
                    distance2 = distance;
                    closest = *dot;
                }
            }
            if distance2 >= RADIUS * RADIUS {
                return point;
            }
            if distance2 == 0.0 {
                return [closest[0] + RADIUS, closest[1]];
            }
            let scale = RADIUS / distance2.sqrt();
            [closest[0] + (point[0] - closest[0]) * scale, closest[1] + (point[1] - closest[1]) * scale]
        })
        .collect()
}

impl FrameDraws {
    fn front_lines(&self, sim: &mut Simulator, dots: &[Dot]) -> Vec<Vec<[f64; 2]>> {
        let (world_w, world_h) = (self.world[0], self.world[1]);
        let contours: Vec<Vec<Vec<[f64; 2]>>> = if sim.territory.regions.is_none() {
            Vec::new()
        } else {
            sim.territory
                .contours()
                .iter()
                .enumerate()
                .map(|(color, side)| {
                    side.iter()
                        .map(|polygon| {
                            let mut p: Vec<[f64; 2]> = polygon.iter().map(|v| [v.x, v.y]).collect();
                            let last = p.len().wrapping_sub(1);
                            if color == 0 && p.len() > 2 && key(p[0]) != key(p[last]) && p.iter().all(|v| v[0] >= 0.0 && v[1] >= 0.0 && v[0] <= world_w && v[1] <= world_h) {
                                p[0] = [(p[0][0] + 0.5 * p[1][0]) / 1.5, (p[0][1] + 0.5 * p[1][1]) / 1.5];
                                p[last] = [(p[last][0] + 0.5 * p[last - 1][0]) / 1.5, (p[last][1] + 0.5 * p[last - 1][1]) / 1.5];
                            }
                            p
                        })
                        .collect()
                })
                .collect()
        };
        let positions: Vec<Vec<[f64; 2]>> = (0..contours.len()).map(|color| dots.iter().filter(|d| d.health > 0.0 && !d.ship && d.color == color).map(|d| d.position).collect()).collect();
        let sets: Vec<HashSet<(u64, u64)>> = contours.iter().map(|polygons| polygons.iter().flatten().map(|p| key(*p)).collect()).collect();
        let mut lines = Vec::new();
        for side in 0..contours.len() {
            for other in side + 1..contours.len() {
                for polygon in &contours[side] {
                    let mask: Vec<bool> = polygon.iter().map(|p| sets[other].contains(&key(*p))).collect();
                    let mut segments: Vec<(Vec<[f64; 2]>, bool)> = Vec::new();
                    if mask.iter().all(|&x| x) {
                        segments.push((polygon.clone(), true));
                    } else {
                        let n = mask.len();
                        for i in 0..n {
                            if !mask[i] || mask[(i + n - 1) % n] {
                                continue;
                            }
                            let mut points = Vec::new();
                            let mut j = i;
                            loop {
                                points.push(polygon[j]);
                                j = (j + 1) % n;
                                if !(mask[j] && j != i) {
                                    break;
                                }
                            }
                            if points.len() > 1 {
                                segments.push((points, false));
                            }
                        }
                    }
                    for (mut p, looped) in segments {
                        p[0] = [(p[0][0] - p[1][0]) * 1.5 + p[1][0], (p[0][1] - p[1][1]) * 1.5 + p[1][1]];
                        let last = p.len() - 1;
                        p[last] = [(p[last][0] - p[last - 1][0]) * 1.5 + p[last - 1][0], (p[last][1] - p[last - 1][1]) * 1.5 + p[last - 1][1]];
                        let mut line = smooth(&p, looped);
                        for color in [side, other] {
                            line = pushout(line, &positions[color]);
                        }
                        lines.push(line);
                    }
                }
            }
        }
        lines
    }

    pub fn build(&self, sim: &mut Simulator, frame: i32) -> Vec<Draw> {
        let mut draws = Vec::with_capacity(1024);
        let frame_f = frame as f64;
        let dots: Vec<Dot> = sim
            .replay
            .units
            .iter()
            .filter(|u| u.active)
            .map(|u| Dot {
                id: u.id,
                color: u.owner,
                kind: u.kind,
                position: [u.position.x, u.position.y],
                health: u.health.max(0.0),
                max_health: u.max_health,
                morale: u.morale,
                ship: u.ship,
                ship_timer: u.ship_timer,
                water_timer: u.water_timer,
                in_city: u.in_city,
                healing: u.healing,
                terrain: u.terrain,
                path: u.remaining_path().iter().map(|p| [p.x, p.y]).collect(),
            })
            .collect();
        let (world_w, world_h) = (self.world[0], self.world[1]);
        simple_image(&mut draws, "map", [world_w / 2.0, world_h / 2.0], [world_w, world_h]);
        for front in self.front_lines(sim, &dots) {
            line(&mut draws, front, [0.0, 0.0, 0.0, 1.0], 8.0, 1);
        }
        let cities = sim.replay.map.cities.clone();
        for (_, &city) in sim.economy.capitals.iter().enumerate().filter(|(_, &city)| sim.economy.is_city(city, &sim.territory)) {
            let p = cities[city as usize];
            simple_image(&mut draws, "capital", [p.x, p.y - 2.0], [35.0, 33.0]);
        }
        for death in &sim.deaths {
            let alpha = 0.75 - (frame_f - death.frame as f64) * 0.01;
            if alpha <= 0.0 {
                continue;
            }
            let color = sprite_color(death.color);
            let name = if death.ship { format!("{color}_{}", if death.kind == UnitType::Tank { "heavy_ship" } else { "ship" }) } else { format!("{color}_{}_15", death.kind.name()) };
            image(&mut draws, &name, [death.position.x, death.position.y], unit_size(death.ship, 0), alpha, [1.0, 0.0], false, false);
        }
        let visuals: HashMap<usize, &crate::replay::Unit> = sim.replay.units.iter().filter(|u| u.active).map(|u| (u.id, u)).collect();
        for pass in 0..2 {
            for dot in dots.iter().filter(|d| d.health > 0.0) {
                let visual = visuals[&dot.id];
                let vibration = if pass == 0 { visual.first_vibration } else { visual.second_vibration };
                let pos = [dot.position[0] + visual.facing.x * vibration, dot.position[1] + visual.facing.y * vibration];
                let direction = if pass == 0 { visual.first_visual_direction } else { visual.visual_direction };
                image(&mut draws, &unit_sprite(dot), pos, unit_size(dot.ship, dot.ship_timer), 1.0, [direction.x, direction.y], false, true);
            }
        }
        if self.layers.contains("orders") {
            let half = [0.0, 0.0, 0.0, 0.5];
            for dot in dots.iter().filter(|d| d.health > 0.0 && !d.path.is_empty()) {
                let mut path = vec![dot.position];
                path.extend_from_slice(&dot.path);
                line(&mut draws, path[..2].to_vec(), half, 5.0, 2);
                if dot.path.len() > 1 {
                    line(&mut draws, dot.path.clone(), half, 5.0, 2);
                }
                let (end, previous) = (path[path.len() - 1], path[path.len() - 2]);
                let (dx, dy) = (previous[0] - end[0], previous[1] - end[1]);
                let length = (dx * dx + dy * dy).sqrt() + 0.01;
                let (ux, uy) = (dx / length, dy / length);
                for side in [-1.0, 1.0] {
                    line(
                        &mut draws,
                        vec![end, [end[0] + 9.0 * ux - side * 6.0 * uy, end[1] + 9.0 * uy + side * 6.0 * ux], [end[0] + 12.0 * ux - side * 12.0 * uy, end[1] + 12.0 * uy + side * 12.0 * ux]],
                        half,
                        5.0,
                        2,
                    );
                }
            }
        }
        for dot in dots.iter().filter(|d| d.health > 0.0) {
            self.bars(&mut draws, dot);
        }
        if self.layers.contains("flags") {
            for (city, &color) in cities.iter().zip(&sim.territory.city_colors) {
                simple_image(&mut draws, &format!("{}_flag", sprite_color(color)), [city.x + 9.0, city.y - 13.0], [21.0, 27.0]);
            }
        }
        if self.layers.contains("icons") {
            for dot in dots.iter().filter(|d| d.health > 0.0) {
                if let Some((name, size)) = icon_for(dot) {
                    simple_image(&mut draws, name, [dot.position[0] + 20.0, dot.position[1] - 10.0], size);
                }
            }
        }
        if self.layers.contains("stats") {
            self.stats(&mut draws, sim, frame_f);
        }
        let view_scale = (self.width as f64 / world_w).min(self.height as f64 / world_h);
        let (view_w, view_h) = (world_w * view_scale, world_h * view_scale);
        if self.layers.contains("players") {
            for label in &self.labels {
                let (w, h) = (label.width * view_w / 1920.0, label.height * view_h / 1080.0);
                image(
                    &mut draws,
                    &label.key,
                    [(self.width as f64 - view_w) / 2.0 + view_w * 0.00313 + w / 2.0, (self.height as f64 - view_h) / 2.0 + view_h * (1.0 / 30.0 + label.line as f64 / 18.0)],
                    [w, h],
                    1.0,
                    [1.0, 0.0],
                    true,
                    false,
                );
            }
        }
        if self.layers.contains("produce") {
            production(&mut draws, sim);
        }
        draws
    }

    fn bars(&self, draws: &mut Vec<Draw>, dot: &Dot) {
        let (health, morale) = (self.layers.contains("health"), self.layers.contains("morale"));
        if !health && !morale {
            return;
        }
        let (x, y) = (dot.position[0], dot.position[1]);
        let both = health && morale;
        let top = y - if both { 22.8 } else { 20.8 };
        let bottom = y - if both { 10.8 } else { 12.8 };
        rect(draws, x - 14.4, top, x + 14.4, bottom, [0.0, 0.0, 0.0, 1.0]);
        rect(draws, x - 12.0, top + 2.0, x + 12.0, bottom - 2.0, [0.3, 0.3, 0.3, 1.0]);
        if morale {
            rect(draws, x - 12.0, bottom - 6.0, x - 12.0 + 24.0 * dot.morale.max(0.0) / 100.0, bottom - 2.0, [0.0, 1.0, 0.94, 1.0]);
        }
        if health {
            let fraction = dot.health / dot.max_health;
            let color = if fraction > 0.5 {
                [0.0, 1.0, 0.0, 1.0]
            } else if fraction > 0.15 {
                [1.0, 1.0, 0.0, 1.0]
            } else {
                [1.0, 0.498, 0.314, 1.0]
            };
            rect(draws, x - 12.0, top + 2.0, x - 12.0 + 24.0 * fraction, top + 6.0, color);
        }
    }

    fn stats(&self, draws: &mut Vec<Draw>, sim: &Simulator, frame: f64) {
        let sides = sim.strength.len().max(1);
        let sides = if sim.strength.is_empty() { 2 } else { sides };
        let gray = [200, 200, 200];
        text(draws, "tcasualties", "Casualties: ".into(), [0.00313, 0.05 * (sides + 1) as f64], gray, "left");
        text(draws, "tstrength", "Troops:  ".into(), [0.99688, 0.05 * (sides + 1) as f64], gray, "right");
        text(draws, "tmoney", "Funds:  ".into(), [0.99688, 0.95], gray, "right");
        let count = |value: f64, include_zero: bool| if frame > 1.0 && (value != 0.0 || include_zero) { format!("~{} ", locale(value * 100.0)) } else { "0".to_string() };
        for side in (0..sides).rev() {
            let y = 0.05 * (sides - side) as f64;
            let income = sim.economy.balances.get(side).and_then(|b| b.first()).copied().unwrap_or(0.0);
            let arrow = if income > 0.0 {
                "\u{25B2}"
            } else if income < 0.0 {
                "\u{25BC}"
            } else {
                "\u{25BA}"
            };
            let color = RGB[side.min(3)];
            let casualties = sim.troop_casualties.get(side).copied().unwrap_or(0) as f64;
            let strength = sim.strength.get(side).copied().unwrap_or(0) as f64;
            let funds = sim.economy.funds.get(side).copied().unwrap_or(0.0);
            text(draws, &format!("{side}casualties"), count(casualties, false), [0.00313, y], color, "left");
            text(draws, &format!("{side}strength"), count(strength, true), [0.99688, y], color, "right");
            let mut money = String::new();
            crate::output::number(&mut money, (funds + 0.5).floor());
            text(draws, &format!("{side}money"), format!("{arrow}{money} "), [0.99688, 0.95 - 0.05 * (sides - side) as f64], color, "right");
        }
    }
}

fn production(draws: &mut Vec<Draw>, sim: &Simulator) {
    let cities: Vec<[f64; 2]> = sim.replay.map.cities.iter().map(|c| [c.x, c.y]).collect();
    let zones = &sim.economy.industrial_zones;
    let groups_by_side: Vec<Vec<Vec<i32>>> = if sim.economy.has_paid && !sim.economy.city_groups.is_empty() { sim.economy.city_groups.clone() } else { zones.iter().map(|z| vec![z.clone()]).collect() };
    let gray = [0.2, 0.2, 0.2, 0.8];
    for (side, groups) in groups_by_side.iter().enumerate() {
        let empty = Vec::new();
        let zone = zones.get(side).unwrap_or(&empty);
        for group in groups {
            let indices: Vec<usize> = group.iter().filter(|c| zone.contains(c)).map(|&c| c as usize).collect();
            if indices.len() == 1 {
                draws.push(Draw::Circle { position: cities[indices[0]], radius: 10.0, color: gray });
            }
            for i in 0..indices.len() {
                for j in i + 1..indices.len() {
                    line(draws, vec![cities[indices[i]], cities[indices[j]]], gray, 10.0, 2);
                }
            }
        }
    }
}
