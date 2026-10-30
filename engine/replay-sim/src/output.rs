//! The JSONL state records and the compact playback chunks (docs/replay-frames.md).

use crate::geom::Vec2;
use crate::replay::UnitType;
use crate::sim::{RunOptions, Simulator};
use crate::territory::Polygons;
use flate2::write::DeflateEncoder;
use flate2::Compression;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fmt::Write as _;
use std::io::{self, Write};

pub const FRAME_MAGIC: &[u8; 8] = b"WODFRM1\n";
pub const STATIC_RECORD: u8 = 1;
pub const CHUNK_RECORD: u8 = 2;
const BINARY_FRAMES: u8 = 1;
pub const CHUNK_FRAMES: usize = 60;
// Fading deaths are drawn for 75 frames.
const DEATH_WINDOW: i32 = 100;

/// How player names reach the static record: the desktop engine draws them,
/// the browser page draws them itself.
pub type LabelRenderer = dyn Fn(&str, usize) -> Value;

pub fn number(out: &mut String, value: f64) {
    if value.is_finite() {
        let mut buffer = ryu::Buffer::new();
        let text = buffer.format_finite(value);
        out.push_str(text.strip_suffix(".0").unwrap_or(text));
    } else {
        out.push_str(if value.is_nan() { "NaN" } else if value > 0.0 { "Infinity" } else { "-Infinity" });
    }
}

fn vec(out: &mut String, value: Vec2) {
    out.push('[');
    number(out, value.x);
    out.push(',');
    number(out, value.y);
    out.push(']');
}

fn json_string(out: &mut String, value: &str) {
    out.push('"');
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

fn list<T>(out: &mut String, items: impl IntoIterator<Item = T>, mut write: impl FnMut(&mut String, T)) {
    out.push('[');
    for (i, item) in items.into_iter().enumerate() {
        if i != 0 {
            out.push(',');
        }
        write(out, item);
    }
    out.push(']');
}

fn numbers<'a>(out: &mut String, values: impl IntoIterator<Item = &'a f64>) {
    list(out, values, |out, v| number(out, *v));
}

fn integers<T: std::fmt::Display>(out: &mut String, values: impl IntoIterator<Item = T>) {
    list(out, values, |out, v| {
        let _ = write!(out, "{v}");
    });
}

fn polygons_json(out: &mut String, contours: &[Polygons]) {
    list(out, contours, |out, side| list(out, side, |out, polygon| list(out, polygon, |out, p| vec(out, *p))));
}

/// Caches that survive between frames: the grid hash and contour JSON change only
/// when the territory does.
#[derive(Default)]
pub struct Writer {
    regions_hash: Option<(u64, String)>,
    contour_json: Option<(u64, String)>,
}

impl Writer {
    pub fn static_record(&self, sim: &Simulator, labels: &LabelRenderer) -> String {
        let replay = &sim.replay;
        let mut out = String::new();
        let _ = write!(out, "{{\"kind\":\"static\",\"static_core\":{{\"map_size\":[{},{}],\"city_positions\":", replay.map.width, replay.map.height);
        list(&mut out, &replay.map.cities, |out, c| vec(out, *c));
        out.push('}');
        out.push_str(",\"replay\":");
        out.push_str(
            &json!({
                "version": replay.version,
                "mode": replay.mode,
                "source_mode": replay.source_mode,
                "end": replay.end_tick,
                "result": replay.result,
                "player_names": replay.player_names,
            })
            .to_string(),
        );
        out.push_str(",\"simulation_profile\":");
        json_string(&mut out, replay.simulation_profile());
        out.push_str(",\"historical_rules_approximate\":");
        out.push_str(if replay.approximate_rules() { "true" } else { "false" });
        if sim.render_state {
            out.push_str(",\"render_profile\":\"wod-1.4.1-ea9225cf\",\"rendered_map_surface\":");
            json_string(&mut out, &replay.map.surface.png_base64());
            out.push_str(",\"player_labels\":");
            let teams: Vec<Value> = replay.player_labels.iter().enumerate().map(|(side, team)| Value::Array(team.iter().map(|label| labels(label, side)).collect())).collect();
            out.push_str(&Value::Array(teams).to_string());
        }
        if let Some(surface) = &replay.map.map_surface {
            out.push_str(",\"source_map_surface\":");
            json_string(&mut out, surface);
        }
        out.push('}');
        out
    }

    fn regions_hash(&mut self, sim: &Simulator) -> Option<&str> {
        let regions = sim.territory.regions.as_ref()?;
        if !matches!(&self.regions_hash, Some((version, _)) if *version == sim.territory.version) {
            let digest = Sha256::digest(regions);
            let mut hex = String::with_capacity(64);
            for byte in digest {
                let _ = write!(hex, "{byte:02x}");
            }
            self.regions_hash = Some((sim.territory.version, hex));
        }
        self.regions_hash.as_ref().map(|(_, hash)| hash.as_str())
    }

    fn contour_json(&mut self, sim: &mut Simulator) -> &str {
        let version = sim.territory.version;
        if !matches!(&self.contour_json, Some((v, _)) if *v == version) {
            let mut out = String::new();
            polygons_json(&mut out, sim.territory.contours());
            self.contour_json = Some((version, out));
        }
        &self.contour_json.as_ref().unwrap().1
    }

    pub fn state_record(&mut self, sim: &mut Simulator, frame: i32, out: &mut String) {
        let produced = sim.take_produced_sides();
        let _ = write!(out, "{{\"kind\":\"state\",\"frame\":{frame}");
        // Keep the frequent cue fields first so the player can index them without
        // parsing the much larger simulation state. Readers still accept any order.
        let _ = write!(out, ",\"audio\":[{},{}]", sim.fight_count, produced);
        let _ = write!(out, ",\"compatibility\":{{\"deferred_orders\":{},\"pending_orders\":{}}}", sim.deferred_order_count, sim.pending_order_count());
        out.push_str(",\"dots\":[");
        let mut first = true;
        for u in sim.replay.units.iter().filter(|u| u.active) {
            if !first {
                out.push(',');
            }
            first = false;
            let _ = write!(out, "{{\"id\":{},\"position\":", u.id);
            vec(out, u.position);
            let _ = write!(out, ",\"color\":{},\"type\":\"{}\",\"health\":", u.owner, u.kind.name());
            number(out, u.health.max(0.0));
            out.push_str(",\"max_health\":");
            number(out, u.max_health);
            out.push_str(",\"morale\":");
            number(out, u.morale);
            let _ = write!(out, ",\"water_timer\":{},\"ship_timer\":{},\"in_city\":{},\"healing\":{},\"zrtyqz\":", u.water_timer, u.ship_timer, u.in_city, u.healing);
            json_string(out, u.terrain);
            out.push_str(",\"damage_received\":");
            number(out, u.damage_received);
            let _ = write!(out, ",\"objective_frame\":{},\"stuck_timer\":{},\"path\":", u.objective_frame, u.stuck_timer);
            let start = out.len();
            list(out, u.remaining_path(), |out, p| vec(out, *p));
            let path = out[start..].to_string();
            out.push_str(",\"znmqz\":");
            out.push_str(&path);
            out.push_str(",\"target\":");
            if u.target_id < 0 {
                out.push_str("null");
            } else {
                let _ = write!(out, "{}", u.target_id);
            }
            let _ = write!(out, ",\"fighting\":{},\"speed\":", u.fighting);
            number(out, u.speed);
            let _ = write!(out, ",\"ship\":{}}}", u.ship);
        }
        let _ = write!(out, "],\"core\":{{\"frame\":{frame},\"winner\":");
        match sim.economy.winner {
            Some(w) => {
                let _ = write!(out, "{w}");
            }
            None => out.push_str("null"),
        }
        out.push_str(",\"economy\":");
        economy_json(sim, out);
        out.push_str(",\"dead_dots\":");
        list(out, &sim.deaths, |out, d| {
            let _ = write!(out, "{{\"frame\":{},\"position\":", d.frame);
            vec(out, d.position);
            let _ = write!(out, ",\"color\":{},\"type\":\"{}\",\"ship\":{}}}", d.color, d.kind.name(), d.ship);
        });
        out.push_str(",\"casualties\":");
        integers(out, &sim.casualties);
        out.push_str(",\"troop_casualties\":");
        integers(out, &sim.troop_casualties);
        out.push_str(",\"strength\":");
        integers(out, &sim.strength);
        let _ = write!(out, ",\"psrandom\":{{\"state\":{}}}", sim.rng.0);
        out.push_str(",\"capitals\":");
        capitals_json(sim, out);
        out.push_str(",\"city_positions\":");
        list(out, &sim.replay.map.cities, |out, c| vec(out, *c));
        out.push_str(",\"regions_sha256\":");
        match self.regions_hash(sim) {
            Some(hash) => json_string(out, hash),
            None => out.push_str("null"),
        }
        out.push_str(",\"cities\":");
        list(out, sim.replay.map.cities.iter().zip(&sim.territory.city_colors), |out, (city, color)| {
            out.push_str("{\"position\":");
            vec(out, *city);
            let _ = write!(out, ",\"color\":{color},\"flag_offset\":[9,-13]}}");
        });
        out.push_str(",\"alive_dots\":");
        integers(out, sim.replay.units.iter().filter(|u| u.alive()).map(|u| u.id));
        out.push('}');
        if sim.render_state {
            out.push_str(",\"render\":{\"contours\":");
            if sim.territory.regions.is_none() {
                out.push_str("[]");
            } else {
                out.push_str(self.contour_json(sim));
            }
            out.push_str(",\"directions\":");
            list(out, sim.replay.units.iter().filter(|u| u.active), |out, u| {
                let _ = write!(out, "{{\"id\":{},\"facing\":", u.id);
                vec(out, u.facing);
                out.push_str(",\"first_visual\":");
                vec(out, u.first_visual_direction);
                out.push_str(",\"visual\":");
                vec(out, u.visual_direction);
                out.push_str(",\"first_vibration\":");
                number(out, u.first_vibration);
                out.push_str(",\"second_vibration\":");
                number(out, u.second_vibration);
                out.push('}');
            });
            out.push('}');
        }
        out.push('}');
    }
}

fn type_names(out: &mut String, kinds: &[UnitType]) {
    list(out, kinds, |out, k| json_string(out, k.name()));
}

/// The economy of a state record, as `{"fields":{...}}`.
pub fn economy_json(sim: &Simulator, out: &mut String) {
    let e = &sim.economy;
    let replay = &sim.replay;
    out.push_str("{\"fields\":{\"zyuixz\":");
    list(out, replay.colors(), |out, c| json_string(out, c));
    out.push_str(",\"zrtyz\":");
    numbers(out, &e.funds);
    out.push_str(",\"city_count\":");
    integers(out, &e.city_count);
    out.push_str(",\"industrial_zone\":");
    list(out, &e.industrial_zones, |out, zone| integers(out, zone));
    out.push_str(",\"production_queue\":");
    type_names(out, &e.production_queue);
    out.push_str(",\"production_rate\":");
    numbers(out, &e.production_rates);
    out.push_str(",\"dot_enc\":");
    if e.has_paid {
        list(out, &e.dot_groups, |out, groups| list(out, groups, |out, g| integers(out, g)));
    } else {
        out.push_str("[]");
    }
    out.push_str(",\"city_enc\":");
    if e.has_paid {
        list(out, &e.city_groups, |out, groups| list(out, groups, |out, g| integers(out, g)));
    } else {
        out.push_str("[]");
    }
    out.push_str(",\"zasdxz\":");
    list(out, &e.balances, |out, b| numbers(out, b));
    if replay.legacy_production {
        out.push_str(",\"price\":{\"infantry\":200,\"tank\":400},\"production_ratio\":");
        list(out, &e.production_ratios, |out, r| match r {
            Some(r) => number(out, *r),
            None => out.push_str("null"),
        });
    } else {
        out.push_str(",\"price\":{\"infantry\":200,\"tank\":400,\"motorised\":400},\"production_type\":");
        type_names(out, &e.production_types);
        out.push_str(if replay.experimental() { ",\"available_units\":[\"infantry\",\"tank\",\"motorised\"]" } else { ",\"available_units\":[\"infantry\",\"tank\"]" });
    }
    out.push_str("}}");
}

fn capitals_json(sim: &Simulator, out: &mut String) {
    let cities = &sim.replay.map.cities;
    list(
        out,
        sim.economy.capitals.iter().enumerate().filter(|(_, &city)| sim.economy.is_city(city, &sim.territory)),
        |out, (side, &city)| {
            out.push_str("{\"position\":");
            vec(out, cities[city as usize]);
            let _ = write!(out, ",\"color\":{side},\"city_index\":{city}}}");
        },
    );
}

/// Writes the JSONL output: the static record, then one state record per sampled frame.
pub fn write_jsonl(sim: &mut Simulator, options: &RunOptions, labels: &LabelRenderer, output: &mut dyn Write) -> io::Result<u64> {
    let mut writer = Writer::default();
    sim.render_state = options.render_state;
    let mut line = writer.static_record(sim, labels);
    line.push('\n');
    output.write_all(line.as_bytes())?;
    let mut frames = 0u64;
    let mut buffer = io::BufWriter::with_capacity(1 << 16, output);
    sim.run(options, |sim, frame| {
        line.clear();
        writer.state_record(sim, frame, &mut line);
        line.push('\n');
        buffer.write_all(line.as_bytes())?;
        if frame == 0 {
            buffer.flush()?;
        }
        frames += 1;
        Ok::<(), io::Error>(())
    })?;
    buffer.flush()?;
    Ok(frames)
}

pub fn write_record(output: &mut dyn Write, kind: u8, payload: &[u8]) -> io::Result<()> {
    let mut header = [0u8; 5];
    header[0] = kind;
    header[1..].copy_from_slice(&(payload.len() as u32).to_le_bytes());
    output.write_all(&header)?;
    output.write_all(payload)
}

#[derive(Default)]
struct ChunkBuilder {
    frames: Vec<u8>,
    header: Vec<(i32, i32, i32)>,
    // What the previous frame of this chunk carried.
    paths: HashMap<usize, Vec<Vec2>>,
    contours: Option<Option<u64>>,
    core: String,
    deaths: usize,
    // Bytes of the frames that were written completely.
    complete: usize,
}

impl ChunkBuilder {
    fn flush(&mut self, output: &mut dyn Write) -> io::Result<()> {
        if self.header.is_empty() {
            return Ok(());
        }
        // A frame that failed while it was being written is left out.
        self.frames.truncate(self.complete);
        let mut payload = Vec::with_capacity(5 + self.header.len() * 12 + self.frames.len() / 4);
        payload.push(BINARY_FRAMES);
        payload.extend_from_slice(&(self.header.len() as u32).to_le_bytes());
        for row in &self.header {
            payload.extend_from_slice(&(row.0 as u32).to_le_bytes());
        }
        for row in &self.header {
            payload.extend_from_slice(&(row.1 as u32).to_le_bytes());
        }
        for row in &self.header {
            payload.extend_from_slice(&(row.2 as u32).to_le_bytes());
        }
        let mut deflate = DeflateEncoder::new(payload, Compression::fast());
        deflate.write_all(&self.frames)?;
        let payload = deflate.finish()?;
        write_record(output, CHUNK_RECORD, &payload)?;
        output.flush()?;
        self.frames.clear();
        self.header.clear();
        self.complete = 0;
        Ok(())
    }
}

trait Put {
    fn u8(&mut self, v: u8);
    fn u16(&mut self, v: u16);
    fn u32(&mut self, v: u32);
    fn f32(&mut self, v: f64);
    fn f64(&mut self, v: f64);
}

impl Put for Vec<u8> {
    fn u8(&mut self, v: u8) {
        self.push(v);
    }
    fn u16(&mut self, v: u16) {
        self.extend_from_slice(&v.to_le_bytes());
    }
    fn u32(&mut self, v: u32) {
        self.extend_from_slice(&v.to_le_bytes());
    }
    fn f32(&mut self, v: f64) {
        self.extend_from_slice(&(v as f32).to_le_bytes());
    }
    fn f64(&mut self, v: f64) {
        self.extend_from_slice(&v.to_le_bytes());
    }
}

fn write_frame(sim: &mut Simulator, chunk: &mut ChunkBuilder, frame: i32) {
    let key = chunk.header.is_empty();
    if key {
        chunk.paths.clear();
    }
    let w = &mut chunk.frames;
    w.u32(frame as u32);
    let live = sim.replay.units.iter().filter(|u| u.alive()).count();
    w.u16(live as u16);
    for u in sim.replay.units.iter().filter(|u| u.alive()) {
        w.u16(u.id as u16);
        w.u8(u.owner as u8);
        w.u8(u.kind.index() as u8);
        w.u8((u.ship as u8) | ((u.in_city as u8) << 1) | ((u.healing as u8) << 2));
        w.u8(terrain_code(u.terrain));
        w.u16(u.water_timer.clamp(0, u16::MAX as i32) as u16);
        w.u16(u.ship_timer.clamp(0, u16::MAX as i32) as u16);
        w.f32(u.position.x);
        w.f32(u.position.y);
        // Health picks the unit's sprite at exact thresholds, so it keeps full precision.
        w.f64(u.health);
        w.f32(u.max_health);
        w.f32(u.morale);
        w.f32(u.facing.x);
        w.f32(u.facing.y);
        w.f32(u.first_visual_direction.x);
        w.f32(u.first_visual_direction.y);
        w.f32(u.visual_direction.x);
        w.f32(u.visual_direction.y);
        w.f32(u.first_vibration);
        w.f32(u.second_vibration);
        let path = u.remaining_path();
        if chunk.paths.get(&u.id).is_some_and(|previous| previous.as_slice() == path) {
            w.u16(u16::MAX);
        } else {
            chunk.paths.insert(u.id, path.to_vec());
            w.u16(path.len() as u16);
            for p in path {
                w.f32(p.x);
                w.f32(p.y);
            }
        }
    }
    // A complete frame carries the deaths that are still fading; the others add new ones.
    let recent: Vec<_> = if key {
        sim.deaths.iter().filter(|d| frame - d.frame < DEATH_WINDOW).copied().collect()
    } else {
        sim.deaths[chunk.deaths.min(sim.deaths.len())..].to_vec()
    };
    chunk.deaths = sim.deaths.len();
    w.u16(recent.len() as u16);
    for d in &recent {
        w.u32(d.frame as u32);
        w.u8(d.color as u8);
        w.u8(d.kind.index() as u8);
        w.u8(d.ship as u8);
        w.f32(d.position.x);
        w.f32(d.position.y);
    }
    let contours = sim.territory.regions.as_ref().map(|_| sim.territory.version);
    let mut core = String::new();
    core_json(sim, &mut core);
    let contours_changed = key || chunk.contours != Some(contours);
    let core_changed = key || core != chunk.core;
    let w = &mut chunk.frames;
    w.u8((contours_changed as u8) | ((core_changed as u8) << 1));
    if contours_changed {
        chunk.contours = Some(contours);
        if contours.is_some() {
            let polygons = sim.territory.contours();
            w.u8(polygons.len() as u8);
            for side in polygons {
                w.u16(side.len() as u16);
                for polygon in side {
                    // Neighbouring sides share these vertices exactly; front lines match them.
                    w.u32(polygon.len() as u32);
                    for p in polygon {
                        w.f64(p.x);
                        w.f64(p.y);
                    }
                }
            }
        } else {
            w.u8(0);
        }
    }
    if core_changed {
        w.u32(core.len() as u32);
        w.extend_from_slice(core.as_bytes());
        chunk.core = core;
    }
}

fn terrain_code(name: &str) -> u8 {
    const TERRAINS: [&str; 10] = ["plain", "forest", "sand", "river", "mountain", "bridge", "hill", "snow", "mud", "city"];
    TERRAINS.iter().position(|t| *t == name).unwrap_or(0) as u8
}

fn core_json(sim: &Simulator, out: &mut String) {
    let e = &sim.economy;
    out.push_str("{\"economy\":{\"fields\":{\"zrtyz\":");
    numbers(out, &e.funds);
    out.push_str(",\"zasdxz\":");
    list(out, &e.balances, |out, b| numbers(out, b));
    out.push_str(",\"industrial_zone\":");
    list(out, &e.industrial_zones, |out, zone| integers(out, zone));
    out.push_str(",\"city_enc\":");
    if e.has_paid {
        list(out, &e.city_groups, |out, groups| list(out, groups, |out, g| integers(out, g)));
    } else {
        out.push_str("[]");
    }
    out.push_str("}},\"troop_casualties\":");
    integers(out, &sim.troop_casualties);
    out.push_str(",\"strength\":");
    integers(out, &sim.strength);
    out.push_str(",\"capitals\":");
    capitals_json(sim, out);
    out.push_str(",\"city_colors\":");
    integers(out, &sim.territory.city_colors);
    out.push('}');
}

/// Writes playback chunks. Frames simulated before a failure stay playable.
pub fn write_chunks(sim: &mut Simulator, options: &RunOptions, labels: &LabelRenderer, output: &mut dyn Write) -> io::Result<u64> {
    sim.render_state = true;
    output.write_all(FRAME_MAGIC)?;
    let header = Writer::default().static_record(sim, labels);
    write_record(output, STATIC_RECORD, header.trim_end().as_bytes())?;
    let mut chunk = ChunkBuilder::default();
    let mut frames = 0u64;
    let options = RunOptions { render_state: true, ..*options };
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        sim.run(&options, |sim, frame| -> io::Result<()> {
            write_frame(sim, &mut chunk, frame);
            let produced = sim.take_produced_sides();
            chunk.header.push((frame, sim.fight_count, produced));
            chunk.complete = chunk.frames.len();
            frames += 1;
            // The first frame goes out alone so playback can start at once.
            if frames == 1 || chunk.header.len() == CHUNK_FRAMES {
                chunk.flush(output)?;
            }
            Ok(())
        })
    }));
    chunk.flush(output)?;
    match result {
        Ok(result) => result.map(|_| frames),
        Err(panic) => std::panic::resume_unwind(panic),
    }
}
