//! Live play. A match continues a replay from one of its frames: `live_start`
//! simulates the replay up to that frame with its recorded commands, then forgets
//! the commands recorded after it. Each `live_step` applies the players' commands
//! for the next tick and simulates it. Both players' pages run the same module on
//! the same commands in the same order, so their simulations stay identical.

use super::{install_panic_message, set_message, take, text_label, write, STATE};
use replay_sim::geom::Vec2;
use replay_sim::output::{self, LabelRenderer};
use replay_sim::replay::{Order, Production, UnitType};
use replay_sim::sim::Simulator;
use serde_json::{json, Value};

/// A match continued from a replay: the simulation and the next tick it runs.
pub struct Live {
    sim: Simulator,
    tick: i32,
}

fn emit(bytes: &[u8]) {
    unsafe { write(bytes.as_ptr(), bytes.len()) };
}

fn fail(text: &str) -> i32 {
    set_message(text);
    2
}

/// Starts a match from `frame` of the opened replay and writes the stream header
/// and static record (docs/replay-frames.md). Returns 0, or 2 with an error.
#[no_mangle]
pub extern "C" fn live_start(frame: i32) -> i32 {
    install_panic_message();
    let Some(replay) = STATE.with(|state| state.borrow_mut().replay.take()) else {
        return fail("Open a replay first.");
    };
    let frame = frame.clamp(0, replay.end_tick.max(0));
    let mut sim = Simulator::new(replay);
    sim.render_state = true;
    for tick in 0..frame {
        sim.live_tick(tick);
    }
    sim.drop_commands_from(frame);
    sim.replay.end_tick = i32::MAX;
    let labels: &LabelRenderer = &text_label;
    let header = output::Writer::default().static_record(&sim, labels);
    let mut out = Vec::new();
    out.extend_from_slice(output::FRAME_MAGIC);
    if output::write_record(&mut out, output::STATIC_RECORD, header.trim_end().as_bytes()).is_err() {
        return fail("The match could not be started.");
    }
    emit(&out);
    STATE.with(|state| state.borrow_mut().live = Some(Live { sim, tick: frame }));
    0
}

fn finite(value: &Value) -> Option<f64> {
    value.as_f64().filter(|v| v.is_finite())
}

/// Queues one turn's commands as the match server sent them:
/// `[{"side": 0, "orders": [[unit, [[x, y], ...]], ...], "production": [...]}, ...]`.
/// A player commands only their own units and cities; anything else is ignored, the
/// same way on every page.
fn queue_commands(live: &mut Live, commands: &Value) {
    let Some(entries) = commands.as_array() else { return };
    let sides = live.sim.replay.side_count();
    let cities = live.sim.replay.map.cities.len();
    for entry in entries {
        let Some(side) = entry.get("side").and_then(Value::as_u64).map(|s| s as usize).filter(|&s| s < sides) else { continue };
        for order in entry.get("orders").and_then(Value::as_array).into_iter().flatten() {
            let Some(parts) = order.as_array().filter(|parts| parts.len() == 2) else { continue };
            let Some(id) = parts[0].as_u64().map(|id| id as usize) else { continue };
            let Some(unit) = live.sim.replay.units.get(id) else { continue };
            if unit.owner != side || !unit.alive() {
                continue;
            }
            let mut path = Vec::new();
            for point in parts[1].as_array().into_iter().flatten().take(512) {
                if let (Some(x), Some(y)) = (point.get(0).and_then(finite), point.get(1).and_then(finite)) {
                    // The game sends whole pixels.
                    path.push(Vec2::new(x.trunc(), y.trunc()));
                }
            }
            live.sim.queue_order(live.tick, Order { unit_id: id as i32, points: path });
        }
        for command in entry.get("production").and_then(Value::as_array).into_iter().flatten() {
            if let Some(zone) = command.get("zone").and_then(Value::as_array) {
                let mut chosen = Vec::new();
                for city in zone.iter().filter_map(Value::as_i64) {
                    let city = city as i32;
                    let owned = city >= 0 && (city as usize) < cities && live.sim.territory.city_colors[city as usize] == side;
                    if owned && !chosen.contains(&city) {
                        chosen.push(city);
                    }
                }
                live.sim.queue_production(live.tick, Production { slot: side, kind: UnitType::Infantry, rate: 0.0, zone: Some(chosen), ratio: None });
                continue;
            }
            let rate = command.get("production_rate").and_then(finite).unwrap_or(0.7).clamp(0.0, 1.0);
            let kind = match command.get("production_type").and_then(Value::as_str) {
                Some("tank") => UnitType::Tank,
                Some("motorised") if live.sim.replay.experimental() => UnitType::Motorised,
                _ => UnitType::Infantry,
            };
            live.sim.queue_production(live.tick, Production { slot: side, kind, rate, zone: None, ratio: None });
        }
    }
}

/// Applies the commands in the buffer (JSON, or empty for none) and simulates one
/// tick. Returns 0, or 2 with an error in the message.
///
/// # Safety
/// The buffer comes from `alloc` with this length; the module takes it.
#[no_mangle]
pub unsafe extern "C" fn live_step(data_ptr: *mut u8, data_len: usize) -> i32 {
    let data = take(data_ptr, data_len);
    let commands = if data.is_empty() {
        None
    } else {
        match serde_json::from_slice::<Value>(&data) {
            Ok(commands) => Some(commands),
            Err(_) => return fail("The match server sent unreadable commands."),
        }
    };
    let ran = STATE.with(|state| {
        let mut state = state.borrow_mut();
        let Some(live) = state.live.as_mut() else { return false };
        if let Some(commands) = &commands {
            queue_commands(live, commands);
        }
        let tick = live.tick;
        live.sim.live_tick(tick);
        live.tick += 1;
        true
    });
    if ran { 0 } else { fail("Start a match first.") }
}

/// Writes the current frame as a chunk record holding one complete frame.
#[no_mangle]
pub extern "C" fn live_frame() -> i32 {
    let bytes = STATE.with(|state| {
        let mut state = state.borrow_mut();
        let live = state.live.as_mut()?;
        output::live_chunk(&mut live.sim, live.tick).ok()
    });
    match bytes {
        Some(bytes) => {
            emit(&bytes);
            0
        }
        None => fail("Start a match first."),
    }
}

/// Writes `{"tick", "winner", "hash", "territory", "rates", "types"}` as JSON: the
/// next tick, the winning side or null, the state digest, the territory grid's
/// version, and each side's production rate and unit type.
#[no_mangle]
pub extern "C" fn live_info() -> i32 {
    let text = STATE.with(|state| {
        let state = state.borrow();
        let live = state.live.as_ref()?;
        let economy = &live.sim.economy;
        Some(
            json!({
                "tick": live.tick,
                "winner": economy.winner,
                "hash": format!("{:016x}", live.sim.state_hash()),
                "territory": live.sim.territory.version,
                "rates": economy.production_rates,
                "types": economy.production_types.iter().map(|kind| kind.name()).collect::<Vec<_>>(),
            })
            .to_string(),
        )
    });
    match text {
        Some(text) => {
            emit(text.as_bytes());
            0
        }
        None => fail("Start a match first."),
    }
}

/// The fog of war over `side`, as the game computes it: every cell outside the
/// side's territory, except under its ships, shrunk by seven cells. Writes the
/// grid's width and height (`u32` each), the grid (x-major, 1 where fogged), then
/// its outlines in map pixels as JSON, before smoothing.
#[no_mangle]
pub extern "C" fn live_fog(side: i32) -> i32 {
    let out = STATE.with(|state| {
        let state = state.borrow();
        let live = state.live.as_ref()?;
        let territory = &live.sim.territory;
        let (width, height) = (territory.width, territory.height);
        let mut out = Vec::new();
        out.extend_from_slice(&(width as u32).to_le_bytes());
        out.extend_from_slice(&(height as u32).to_le_bytes());
        let Some(regions) = territory.regions.as_ref() else {
            // No territory yet: nothing is fogged.
            out.extend(std::iter::repeat(0u8).take(width * height));
            out.extend_from_slice(b"[]");
            return Some(out);
        };
        let mut fog: Vec<u8> = regions.iter().map(|&r| (r as i32 != side) as u8).collect();
        for unit in live.sim.replay.units.iter().filter(|u| u.alive() && u.ship && u.owner as i32 == side) {
            let (x, y) = ((unit.position.x / 10.0) as i64, (unit.position.y / 10.0) as i64);
            if x >= 0 && y >= 0 && (x as usize) < width && (y as usize) < height {
                fog[x as usize * height + y as usize] = 0;
            }
        }
        for _ in 0..7 {
            let mask = fog.clone();
            for x in 0..width {
                for y in 0..height {
                    let i = x * height + y;
                    let mut cell = mask[i];
                    if x + 1 < width {
                        cell &= mask[i + height];
                    }
                    if x > 0 {
                        cell &= mask[i - height];
                    }
                    if y + 1 < height {
                        cell &= mask[i + 1];
                    }
                    if y > 0 {
                        cell &= mask[i - 1];
                    }
                    fog[i] = cell;
                }
            }
        }
        let outlines = replay_sim::contours::extract(&fog, 1, width, height);
        out.extend_from_slice(&fog);
        let polygons: Vec<Vec<[f64; 2]>> = outlines.iter().map(|p| p.iter().map(|v| [v.x, v.y]).collect()).collect();
        out.extend_from_slice(serde_json::to_string(&polygons).unwrap_or_else(|_| "[]".into()).as_bytes());
        Some(out)
    });
    match out {
        Some(out) => {
            emit(&out);
            0
        }
        None => fail("Start a match first."),
    }
}
