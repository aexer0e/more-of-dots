//! Reconstruction of the native proposal, friend-block, reroute and commit
//! phases, including mountain sliding, retreat and near-waypoint routing.

use crate::geom::Vec2;
use crate::grid::{Grid, CELL};
use crate::num::{native_masked_matrix_sum, numpy_round, python_hypot, sum_perimeter_offsets};
use crate::replay::Replay;
use crate::replay::Unit;
use crate::sim::Random;
use crate::surface::MapSurface;
use crate::surface::Terrain;

const EDGE_OFFSETS: [Vec2; 8] = [
    Vec2::new(8.0, 0.0),
    Vec2::new(5.0, 5.0),
    Vec2::new(0.0, 8.0),
    Vec2::new(-5.0, 5.0),
    Vec2::new(-8.0, 0.0),
    Vec2::new(-5.0, -5.0),
    Vec2::new(0.0, -8.0),
    Vec2::new(5.0, -5.0),
];

// Exact NumPy perimeter values from manifest-verified June and July cores.
const PERIMETER: [Vec2; 32] = [
    Vec2::new(1.0, 0.0),
    Vec2::new(0.9807852804032304, 0.19509032201612825),
    Vec2::new(0.9238795325112867, 0.3826834323650898),
    Vec2::new(0.8314696123025452, 0.5555702330196022),
    Vec2::new(0.7071067811865476, 0.7071067811865476),
    Vec2::new(0.5555702330196023, 0.8314696123025452),
    Vec2::new(0.38268343236508984, 0.9238795325112867),
    Vec2::new(0.19509032201612833, 0.9807852804032304),
    Vec2::new(6.123233995736766e-17, 1.0),
    Vec2::new(-0.1950903220161282, 0.9807852804032304),
    Vec2::new(-0.3826834323650897, 0.9238795325112867),
    Vec2::new(-0.555570233019602, 0.8314696123025453),
    Vec2::new(-0.7071067811865475, 0.7071067811865476),
    Vec2::new(-0.8314696123025453, 0.5555702330196022),
    Vec2::new(-0.9238795325112867, 0.3826834323650899),
    Vec2::new(-0.9807852804032304, 0.1950903220161286),
    Vec2::new(-1.0, 1.2246467991473532e-16),
    Vec2::new(-0.9807852804032304, -0.19509032201612836),
    Vec2::new(-0.9238795325112868, -0.38268343236508967),
    Vec2::new(-0.8314696123025455, -0.555570233019602),
    Vec2::new(-0.7071067811865477, -0.7071067811865475),
    Vec2::new(-0.5555702330196022, -0.8314696123025452),
    Vec2::new(-0.38268343236509034, -0.9238795325112865),
    Vec2::new(-0.19509032201612866, -0.9807852804032303),
    Vec2::new(-1.8369701987210297e-16, -1.0),
    Vec2::new(0.1950903220161283, -0.9807852804032304),
    Vec2::new(0.38268343236509, -0.9238795325112866),
    Vec2::new(0.5555702330196018, -0.8314696123025455),
    Vec2::new(0.7071067811865474, -0.7071067811865477),
    Vec2::new(0.8314696123025452, -0.5555702330196022),
    Vec2::new(0.9238795325112865, -0.3826834323650904),
    Vec2::new(0.9807852804032303, -0.19509032201612872),
];

pub fn mountain_projection(desired: Vec2, push: Vec2) -> Option<(Vec2, f64, Vec2)> {
    let push_length = python_hypot(push.x, push.y);
    if push_length <= 0.0 {
        return None;
    }
    // Native scalar mountain routing divides each component by math.hypot.
    // A reciprocal changes the projected slide by one ULP.
    let into = Vec2::new(push.x / push_length, push.y / push_length);
    let component = desired.x * into.x + desired.y * into.y;
    if component <= 0.0 {
        return None;
    }
    let slide = desired - into * component;
    let length = python_hypot(slide.x, slide.y);
    let direction = if length > 0.0 { Vec2::new(slide.x / length, slide.y / length) } else { Vec2::new(0.0, 0.0) };
    Some((slide, length, direction))
}

/// Reused per-tick buffers, so a step allocates nothing once warmed up.
#[derive(Default)]
pub struct Scratch {
    positions: Vec<Vec2>,
    proposals: Vec<Vec2>,
    directions: Vec<Vec2>,
    goals: Vec<Vec2>,
    speeds: Vec<f64>,
    moving: Vec<bool>,
    reached: Vec<bool>,
    mountain_handled: Vec<bool>,
    outside: Vec<bool>,
    friend_blocked: Vec<bool>,
    friend_hits: Vec<Vec<usize>>,
    rerouted: Vec<bool>,
    enemy_blocked: Vec<bool>,
    enemy_hits: Vec<Vec<usize>>,
    initial_path_indices: Vec<usize>,
    living: Vec<usize>,
    before_enemy_reset: Vec<Vec2>,
    enemy_mask: Vec<bool>,
    column_x: Vec<f64>,
    column_y: Vec<f64>,
    grid: Option<Grid>,
    near: Vec<usize>,
}

fn reset<T: Clone>(buffer: &mut Vec<T>, count: usize, value: T) {
    buffer.clear();
    buffer.resize(count, value);
}

/// One tick of movement. `speed_for` gives a unit's speed on its terrain and `rng`
/// the retreat rolls.
pub fn step(replay: &mut Replay, speed_for: &dyn Fn(&Unit, &MapSurface) -> f64, rng: &mut dyn Random, s: &mut Scratch) {
    let count = replay.units.len();
    let surface = &replay.map.surface;
    let (map_w, map_h) = (replay.map.width as f64, replay.map.height as f64);
    let full_precision = replay.full_precision_positions();
    let rounded_retreat = replay.rounded_retreat_comparison();
    let conditional_rolls = replay.conditional_retreat_rolls();
    reset(&mut s.positions, count, Vec2::default());
    reset(&mut s.proposals, count, Vec2::default());
    reset(&mut s.directions, count, Vec2::default());
    reset(&mut s.goals, count, Vec2::default());
    reset(&mut s.speeds, count, 0.0);
    reset(&mut s.moving, count, false);
    reset(&mut s.reached, count, false);
    reset(&mut s.mountain_handled, count, false);
    reset(&mut s.outside, count, false);
    reset(&mut s.friend_blocked, count, false);
    reset(&mut s.rerouted, count, false);
    reset(&mut s.enemy_blocked, count, false);
    reset(&mut s.initial_path_indices, count, 0);
    s.friend_hits.iter_mut().for_each(Vec::clear);
    s.friend_hits.resize_with(count, Vec::new);
    s.enemy_hits.iter_mut().for_each(Vec::clear);
    s.enemy_hits.resize_with(count, Vec::new);
    let units = &mut replay.units;
    s.living.clear();
    s.living.extend(units.iter().filter(|u| u.alive()).map(|u| u.id));
    let draw_retreat_rolls = !conditional_rolls || units.iter().any(|u| u.alive() && u.damage_received > 0.0);
    for i in 0..count {
        let unit = &mut units[i];
        s.initial_path_indices[i] = unit.path_index;
        s.positions[i] = unit.position;
        s.proposals[i] = unit.position;
        unit.previous_position = unit.position;
        unit.simulation_position = unit.position;
        unit.fighting = false;
        unit.speed = 0.0;
        unit.retreating = false;
        unit.retreated = false;
        unit.ship_land_blocked = false;
        if !unit.alive() {
            continue;
        }
        s.moving[i] = unit.path_index < unit.path.len();
        unit.had_objective = s.moving[i];
        let mut chance = (if s.moving[i] { 0.0 } else { 5.0 }) * unit.damage_received / unit.health.max(1e-9).sqrt() * (3.0 - 2.0 * (unit.morale / 100.0));
        if surface.at(unit.position) == Terrain::City {
            chance = chance * chance * chance;
        }
        // Historical cores skip the whole roll array when no unit was
        // damaged. Otherwise they draw once for every living unit.
        let mut roll = if draw_retreat_rolls { rng.next() } else { 0.0 };
        // The 1.3 cores round both arrays before the strict comparison.
        // Rounding only the chance, or neither value, changes rare retreats.
        if rounded_retreat {
            chance = numpy_round(chance, 6);
            roll = numpy_round(roll, 6);
        }
        let retreat = chance > roll;
        let (owner, position, damaged) = (units[i].owner, units[i].position, units[i].damage_received > 0.0);
        if damaged && retreat {
            reset(&mut s.enemy_mask, count, false);
            let mut enemies = 0usize;
            for u in units.iter() {
                if u.alive() && u.owner != owner && (u.position - position).length_squared() <= 36.0 * 36.0 {
                    s.enemy_mask[u.id] = true;
                    enemies += 1;
                }
            }
            if enemies > 0 {
                let row = s.living.iter().position(|&id| id == i).unwrap();
                s.column_x.clear();
                s.column_y.clear();
                for &id in &s.living {
                    let enemy = s.enemy_mask[id];
                    s.column_x.push(if enemy { units[id].position.x } else { 0.0 });
                    s.column_y.push(if enemy { units[id].position.y } else { 0.0 });
                }
                let mut center = Vec2::new(native_masked_matrix_sum(&s.column_x, row) / enemies as f64, native_masked_matrix_sum(&s.column_y, row) / enemies as f64);
                if !full_precision {
                    center = Vec2::new(numpy_round(center.x, 4), numpy_round(center.y, 4));
                }
                let delta_to_enemy = center - position;
                let enemy_distance = if delta_to_enemy.length() > 1e-9 { delta_to_enemy.length() } else { 1.0 };
                s.goals[i] = position - Vec2::new(delta_to_enemy.x / enemy_distance, delta_to_enemy.y / enemy_distance) * 100.0;
                s.moving[i] = true;
                units[i].had_objective = true;
                units[i].retreating = true;
            } else if s.moving[i] {
                s.goals[i] = units[i].path[units[i].path_index];
            }
        } else if s.moving[i] {
            s.goals[i] = units[i].path[units[i].path_index];
        }
        if !s.moving[i] {
            continue;
        }
        let unit = &units[i];
        let delta = s.goals[i] - s.positions[i];
        let distance = delta.length();
        // Native NumPy divides each component. Multiplying by a reciprocal
        // differs by one ULP on historical cores that retain full positions.
        let divisor = if distance > 1e-9 { distance } else { 1.0 };
        s.directions[i] = Vec2::new(delta.x / divisor, delta.y / divisor);
        s.speeds[i] = speed_for(unit, surface);
        if unit.retreating {
            s.speeds[i] *= 1.5;
        }
        s.proposals[i] = s.positions[i] + s.directions[i] * s.speeds[i];
        if distance < s.speeds[i] && !unit.retreating {
            s.proposals[i] = unit.path[unit.path_index];
            s.reached[i] = true;
        }
        let p = s.proposals[i];
        s.outside[i] = p.x < 12.0 || p.x > map_w - 12.0 || p.y < 12.0 || p.y > map_h - 12.0;
        if s.outside[i] {
            s.proposals[i] = s.positions[i];
        }
    }
    let mut mountain_x = [0.0f64; 32];
    let mut mountain_y = [0.0f64; 32];
    for i in 0..count {
        if !s.moving[i] {
            continue;
        }
        let p = s.proposals[i].truncate();
        if !EDGE_OFFSETS.iter().any(|&offset| surface.at(p + offset) == Terrain::Mountain) {
            continue;
        }
        s.mountain_handled[i] = true;
        if (s.goals[i] - s.positions[i]).length_squared() < 144.0 {
            if !units[i].retreating {
                units[i].path_index += 1;
            }
            s.proposals[i] = s.positions[i];
            continue;
        }
        let mut selected = 0;
        for offset in PERIMETER {
            if surface.at(s.positions[i] + offset * 12.0) == Terrain::Mountain {
                mountain_x[selected] = offset.x;
                mountain_y[selected] = offset.y;
                selected += 1;
            }
        }
        let push = Vec2::new(sum_perimeter_offsets(&mountain_x[..selected]), sum_perimeter_offsets(&mountain_y[..selected]));
        let desired = s.proposals[i] - s.positions[i];
        let Some((slide, length, direction)) = mountain_projection(desired, push) else { continue };
        if length <= 0.01 {
            s.proposals[i] = s.positions[i];
            continue;
        }
        let candidate = s.positions[i] + slide * (s.speeds[i] / length);
        if surface.at(candidate) == Terrain::Mountain {
            s.proposals[i] = s.positions[i];
            continue;
        }
        s.proposals[i] = candidate;
        // The later 22-pixel collision retry reuses this normalized vector.
        // Preserve native component division there too.
        s.directions[i] = direction;
    }
    // Ships wait at a land proposal before they can disembark.
    for i in 0..count {
        if units[i].ship && surface.at(s.proposals[i]) != Terrain::Water {
            s.proposals[i] = s.positions[i];
            units[i].ship_land_blocked = true;
        }
    }
    // The native hard boundary is 24. Reroutes recheck at 22. Both checks
    // include equality. The hit matrix is built once before resetting any
    // blocked proposal, and retries proceed in stable unit order.
    let grid = s.grid.get_or_insert_with(|| Grid::new(CELL));
    grid.build(replay.map.width, replay.map.height, &s.living, |id| s.proposals[id]);
    for a in 0..s.living.len() {
        let i = s.living[a];
        grid.near(s.proposals[i], 1, &mut s.near);
        for &j in &s.near {
            if i == j || units[i].owner != units[j].owner {
                continue;
            }
            if (s.proposals[i] - s.proposals[j]).length_squared() <= 576.0 {
                s.friend_hits[i].push(j);
                s.friend_blocked[i] = true;
            }
        }
    }
    for i in 0..count {
        if s.friend_blocked[i] {
            s.proposals[i] = s.positions[i];
        }
    }
    let slack_limit = 24.0 * 1.05;
    for i in 0..count {
        if !s.friend_blocked[i] || !s.moving[i] || s.outside[i] || units[i].ship_land_blocked {
            continue;
        }
        let forward = s.positions[i] + s.directions[i] * s.speeds[i];
        let clear = !s.friend_hits[i].iter().any(|&j| (s.proposals[j] - forward).length_squared() <= 484.0);
        if clear {
            s.proposals[i] = forward;
            s.rerouted[i] = true;
            continue;
        }
        let waypoint_slack = slack_limit - (s.goals[i] - s.positions[i]).length();
        if waypoint_slack > 0.0 {
            // A friendly unit occupying a nearby destination consumes
            // that waypoint without moving the blocked unit this tick.
            let mut occupied = false;
            for &j in &s.living {
                if j == i || units[j].owner != units[i].owner {
                    continue;
                }
                let mut original_other = if s.moving[j] { s.positions[j] + s.directions[j] * s.speeds[j] } else { s.positions[j] };
                if s.reached[j] {
                    original_other = s.goals[j];
                }
                let original_self = if s.reached[i] { s.goals[i] } else { forward };
                if (original_other - original_self).length_squared() <= 36.0 * 36.0 && (s.positions[j] - s.goals[i]).length_squared() < waypoint_slack * waypoint_slack {
                    occupied = true;
                }
            }
            if occupied {
                if !units[i].retreating {
                    units[i].path_index += 1;
                }
                continue;
            }
        }
        if surface.at(s.positions[i]) == Terrain::Bridge {
            continue;
        }
        let mut obstacle = usize::MAX;
        let mut nearest = f64::INFINITY;
        for &j in &s.friend_hits[i] {
            let distance = (s.proposals[j] - forward).length_squared();
            if distance < nearest {
                nearest = distance;
                obstacle = j;
            }
        }
        if obstacle == usize::MAX {
            continue;
        }
        let away = s.positions[i] - s.proposals[obstacle];
        let a = s.positions[i] + Vec2::new(-away.y, away.x);
        let b = s.positions[i] + Vec2::new(away.y, -away.x);
        let waypoint = s.goals[i];
        let tangent = if (waypoint - a).length_squared() <= (waypoint - b).length_squared() { Vec2::new(-away.y, away.x) } else { Vec2::new(away.y, -away.x) };
        // Native scalar rerouting uses Python math.hypot, whose rounded
        // result can differ from sqrt(x*x + y*y) by one ULP.
        let length = python_hypot(tangent.x, tangent.y);
        if length < 1e-9 {
            continue;
        }
        let candidate = s.positions[i] + tangent * (s.speeds[i] / length);
        let candidate_terrain = surface.at(candidate);
        if candidate_terrain == Terrain::Mountain || (units[i].ship && candidate_terrain != Terrain::Water) {
            continue;
        }
        let (mut candidate_min, mut previous_min) = (f64::INFINITY, f64::INFINITY);
        for &j in &s.friend_hits[i] {
            candidate_min = candidate_min.min((s.proposals[j] - candidate).length_squared());
            previous_min = previous_min.min((s.proposals[j] - s.positions[i]).length_squared());
        }
        if candidate_min <= 484.0 && candidate_min <= previous_min {
            continue;
        }
        s.proposals[i] = candidate;
        s.directions[i] = (candidate - s.positions[i]) * (1.0 / s.speeds[i].max(1e-9));
        s.rerouted[i] = true;
    }
    for i in 0..count {
        units[i].contact_position = s.proposals[i];
    }
    let enemy_limit = (18.0 * 1.9) * (18.0 * 1.9);
    let grid = s.grid.as_mut().unwrap();
    grid.build(replay.map.width, replay.map.height, &s.living, |id| s.proposals[id]);
    for a in 0..s.living.len() {
        let i = s.living[a];
        grid.near(s.proposals[i], 1, &mut s.near);
        for &j in &s.near {
            if units[i].owner == units[j].owner {
                continue;
            }
            if (s.proposals[i] - s.proposals[j]).length_squared() <= enemy_limit {
                s.enemy_hits[i].push(j);
                s.enemy_blocked[i] = true;
            }
        }
    }
    s.before_enemy_reset.clear();
    s.before_enemy_reset.extend_from_slice(&s.proposals);
    for i in 0..count {
        if s.enemy_blocked[i] && s.moving[i] && !units[i].retreating {
            s.proposals[i] = s.positions[i];
        }
    }
    for i in 0..count {
        if !s.enemy_blocked[i] || !s.moving[i] || units[i].retreating {
            continue;
        }
        let (mut candidate_min, mut old_min) = (f64::INFINITY, f64::INFINITY);
        for &j in &s.enemy_hits[i] {
            candidate_min = candidate_min.min((s.proposals[j] - s.before_enemy_reset[i]).length_squared());
            old_min = old_min.min((s.proposals[j] - s.positions[i]).length_squared());
        }
        if candidate_min > enemy_limit || candidate_min > old_min {
            s.proposals[i] = s.before_enemy_reset[i];
            s.enemy_blocked[i] = false;
        }
    }
    for i in 0..count {
        let unit = &mut units[i];
        if !unit.alive() {
            continue;
        }
        let commit = s.moving[i] && !(s.friend_blocked[i] && !s.rerouted[i]) && !s.enemy_blocked[i];
        if commit && s.directions[i].length_squared() > 1e-18 {
            unit.facing = s.directions[i];
        }
        let mut final_position = if commit { s.proposals[i] } else { s.positions[i] };
        if final_position.x < 12.0 || final_position.x >= map_w - 12.0 || final_position.y < 12.0 || final_position.y >= map_h - 12.0 || surface.at(final_position) == Terrain::Mountain {
            final_position = s.positions[i];
        }
        unit.simulation_position = final_position;
        unit.stuck_timer = if s.moving[i] && s.mountain_handled[i] && final_position == s.positions[i] && !unit.retreating && !unit.ship { unit.stuck_timer + 1 } else { 0 };
        if unit.stuck_timer >= 30 {
            if !unit.retreating && unit.path_index < unit.path.len() {
                unit.path_index += 1;
            }
            unit.stuck_timer = 0;
        }
        // Native boundary rejection consumes the attempted waypoint even
        // when the position cannot commit. Other routing branches may
        // already have consumed that same waypoint this tick.
        if s.outside[i] && !unit.retreating && unit.path_index == s.initial_path_indices[i] && unit.path_index < unit.path.len() {
            unit.path_index += 1;
        }
        unit.retreated = unit.retreating && commit;
        unit.position = if full_precision { final_position } else { Vec2::new(numpy_round(final_position.x, 2), numpy_round(final_position.y, 2)) };
        // The native commit snaps after collision retries. Combat still
        // uses the unsnapped proposal; the stored position and route use
        // the waypoint only when the movement mask permits the commit.
        if commit && s.reached[i] {
            unit.position = s.goals[i];
            unit.path_index += 1;
        }
    }
}
