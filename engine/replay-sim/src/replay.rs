//! Reading .rep files: version and mode rules, the map and the recorded commands.

use crate::deployments;
use crate::geom::Vec2;
use crate::surface::{MapFiles, MapSurface};
use flate2::read::GzDecoder;
use serde_json::Value;
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnitType {
    Infantry,
    Tank,
    Motorised,
}

impl UnitType {
    pub fn name(self) -> &'static str {
        match self {
            UnitType::Infantry => "infantry",
            UnitType::Tank => "tank",
            UnitType::Motorised => "motorised",
        }
    }

    /// The row in the speed, damage and matchup tables, and the binary frame code.
    pub fn index(self) -> usize {
        self as usize
    }

    fn parse(name: &str) -> Option<UnitType> {
        match name {
            "infantry" => Some(UnitType::Infantry),
            "tank" => Some(UnitType::Tank),
            "motorised" => Some(UnitType::Motorised),
            _ => None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Unit {
    pub id: usize,
    pub owner: usize,
    pub kind: UnitType,
    pub position: Vec2,
    pub health: f64,
    pub max_health: f64,
    pub morale: f64,
    pub in_city: bool,
    pub damage_received: f64,
    pub retreating: bool,
    pub retreated: bool,
    pub healing: bool,
    pub terrain: &'static str,
    pub stuck_timer: i32,
    pub objective_frame: i32,
    pub path: Vec<Vec2>,
    pub path_index: usize,
    pub fighting: bool,
    pub speed: f64,
    pub ship: bool,
    pub ship_land_blocked: bool,
    pub active: bool,
    pub water_timer: i32,
    pub ship_timer: i32,
    pub target_id: i32,
    pub destroyed: bool,
    pub had_objective: bool,
    pub previous_position: Vec2,
    pub simulation_position: Vec2,
    pub contact_position: Vec2,
    pub facing: Vec2,
    pub visual_direction: Vec2,
    pub first_visual_direction: Vec2,
    pub first_vibration: f64,
    pub second_vibration: f64,
}

impl Unit {
    pub fn new(id: usize, owner: usize, kind: UnitType, position: Vec2, max_health: f64) -> Unit {
        Unit {
            id,
            owner,
            kind,
            position,
            health: max_health,
            max_health,
            morale: 100.0,
            in_city: false,
            damage_received: 0.0,
            retreating: false,
            retreated: false,
            healing: false,
            terrain: "plain",
            stuck_timer: 0,
            objective_frame: 0,
            path: Vec::new(),
            path_index: 0,
            fighting: false,
            speed: 0.0,
            ship: false,
            ship_land_blocked: false,
            active: true,
            water_timer: 0,
            ship_timer: 0,
            target_id: -1,
            destroyed: false,
            had_objective: false,
            previous_position: position,
            simulation_position: position,
            contact_position: Vec2::default(),
            facing: Vec2::new(1.0, 0.0),
            visual_direction: Vec2::new(1.0, 0.0),
            first_visual_direction: Vec2::new(1.0, 0.0),
            first_vibration: 0.0,
            second_vibration: 0.0,
        }
    }

    pub fn alive(&self) -> bool {
        self.active && self.health > 0.0
    }

    pub fn remaining_path(&self) -> &[Vec2] {
        &self.path[self.path_index.min(self.path.len())..]
    }
}

#[derive(Clone, Debug)]
pub struct Order {
    pub unit_id: i32,
    pub points: Vec<Vec2>,
}

/// A production command either sets a side's rate and unit type, or (with zone)
/// chooses which of its cities produce.
#[derive(Clone, Debug)]
pub struct Production {
    pub slot: usize,
    pub kind: UnitType,
    pub rate: f64,
    pub zone: Option<Vec<i32>>,
    pub ratio: Option<f64>,
}

pub struct ReplayMap {
    pub width: usize,
    pub height: usize,
    /// The recorded map image, base64.
    pub map_surface: Option<String>,
    pub surface: MapSurface,
    pub infantry: Vec<Vec<Vec2>>,
    pub tanks: Vec<Vec<Vec2>>,
    pub motorised: Vec<Vec<Vec2>>,
    pub cities: Vec<Vec2>,
    pub capitals: Vec<i32>,
}

pub struct Replay {
    pub mode: String,
    pub version: String,
    pub source_mode: String,
    pub legacy_production: bool,
    pub end_tick: i32,
    /// The recording player's result (1 win, 0 loss, 0.5 peace, -1 ...); it picks the end sound.
    pub result: Option<f64>,
    pub map: ReplayMap,
    pub player_names: Vec<String>,
    pub player_labels: Vec<Vec<String>>,
    pub units: Vec<Unit>,
    pub orders: HashMap<i32, Vec<Order>>,
    pub productions: HashMap<i32, Vec<Production>>,
}

/// System.Version: two to four components; a missing one compares as -1.
fn parse_version(text: &str) -> Option<[i32; 4]> {
    let parts: Vec<&str> = text.split('.').collect();
    if !(2..=4).contains(&parts.len()) {
        return None;
    }
    let mut version = [-1; 4];
    for (i, part) in parts.iter().enumerate() {
        let part = part.trim();
        let digits = part.strip_prefix('+').unwrap_or(part);
        if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        version[i] = digits.parse().ok()?;
    }
    Some(version)
}

fn version_below(version: &str, limit: [i32; 4]) -> Option<bool> {
    parse_version(version).map(|v| v < limit)
}

impl Replay {
    pub fn conditional_retreat_rolls(&self) -> bool {
        version_below(&self.version, [1, 3, -1, -1]) == Some(true)
    }

    pub fn rounded_retreat_comparison(&self) -> bool {
        version_below(&self.version, [1, 3, -1, -1]) != Some(true)
    }

    pub fn full_precision_positions(&self) -> bool {
        version_below(&self.version, [1, 2, 23, -1]) == Some(true)
    }

    pub fn roll_production_before_block(&self) -> bool {
        self.legacy_production && version_below(&self.version, [1, 3, -1, -1]) == Some(false)
    }

    pub fn approximate_rules(&self) -> bool {
        self.version != "1.4.1"
            || self.legacy_production
            || !matches!(self.source_mode.as_str(), "classic" | "experiment" | "avalanche" | "1v1" | "2v2" | "v3" | "v4" | "ffa")
    }

    pub fn simulation_profile(&self) -> &'static str {
        if self.legacy_production {
            "wod-legacy-mixed-v1"
        } else {
            "wod-1.4.1-ea9225cf"
        }
    }

    pub fn experimental(&self) -> bool {
        self.mode == "experiment"
    }

    /// Avalanche plays by the classic rules; the game only changes its starting funds.
    pub fn avalanche(&self) -> bool {
        self.mode == "avalanche"
    }

    pub fn side_count(&self) -> usize {
        self.map.infantry.len()
    }

    pub fn colors(&self) -> &'static [&'static str] {
        &["blue", "red", "purple", "orange"][..self.side_count()]
    }

    pub fn order_count(&self) -> usize {
        self.orders.values().map(Vec::len).sum()
    }

    pub fn production_count(&self) -> usize {
        self.productions.values().map(Vec::len).sum()
    }

    pub fn read(path: &Path, files: &mut MapFiles) -> Result<Replay, String> {
        let root = read_json_file(path)?;
        let full = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
        let directory = full.parent().map(Path::to_path_buf).unwrap_or_default();
        Replay::from_json(&root, &directory, files)
    }

    pub fn from_json(root: &Value, replay_dir: &Path, files: &mut MapFiles) -> Result<Replay, String> {
        if !root.is_object() {
            return Err("The replay is not a JSON object.".into());
        }
        // Saved replays also use mode for the match format. 2v2 (two players per
        // color) and free-for-all use the classic rules.
        let mut map_value = root.get("map").cloned().unwrap_or(Value::Null);
        let mut have_map = map_value.is_object();
        if !have_map {
            if let Some(custom) = root.get("custom_map").filter(|m| m.is_object()) {
                map_value = custom.clone();
                have_map = true;
            }
        }
        if !have_map {
            if let Some(built_in) = deployments::try_resolve(&map_value, text(root, "mode"), &files.replay_dirs) {
                map_value = built_in;
                have_map = true;
            }
        }
        if !have_map {
            // A PNG can exist even when its mode-specific deployment is unknown.
            let id = match &map_value {
                Value::String(text) => text.clone(),
                Value::Number(number) => number.to_string(),
                _ => String::new(),
            };
            return Err(if !id.is_empty() {
                format!("This replay records map number ({id}), but the player has no layout of starting units and cities for this map and mode yet. Any replay of this map that records its full layout, such as one from experiment mode, provides it once it is among your replays.")
            } else {
                "This replay does not record its map, so it cannot be played back.".into()
            });
        }
        let version_name = text(root, "version").unwrap_or("unknown").to_string();
        let pygame_ce_raster = version_below(&version_name, [1, 3, 7, -1]) != Some(true);
        let map = ReplayMap::read(&map_value, replay_dir, pygame_ce_raster, files)?;
        let match_mode = text(root, "mode").or_else(|| text(&map_value, "mode")).unwrap_or("classic").to_string();
        let mut mode_name = deployments::rules_mode(Some(&match_mode)).to_string();
        // Files with new/unknown version strings still get a playback attempt. The
        // command schema determines production behavior, not an allowlist of versions.
        let (mut legacy_production, mut modern_production) = (false, false);
        let object = root.as_object().unwrap();
        for (name, frame) in object {
            if parse_int(name).is_none() || !frame.is_object() {
                continue;
            }
            for (key, entry) in frame.as_object().unwrap() {
                if !key.starts_with("production") || !entry.is_object() {
                    continue;
                }
                legacy_production |= entry.get("ratio").is_some() || entry.get("rate").is_some();
                modern_production |= entry.get("production_type").is_some();
                if text(entry, "production_type") == Some("motorised") {
                    mode_name = "experiment".into();
                }
            }
        }
        if map.motorised.iter().any(|side| !side.is_empty()) {
            mode_name = "experiment".into();
        }
        if !legacy_production && !modern_production {
            if let Some(below) = version_below(&version_name, [1, 4, -1, -1]) {
                legacy_production = below;
            }
        }
        let mut units = Vec::new();
        let experimental = mode_name == "experiment";
        for side in 0..map.infantry.len() {
            for p in &map.infantry[side] {
                units.push(Unit::new(units.len(), side, UnitType::Infantry, *p, 100.0));
            }
            for p in &map.tanks[side] {
                units.push(Unit::new(units.len(), side, UnitType::Tank, *p, 200.0));
            }
            if experimental {
                for p in &map.motorised[side] {
                    units.push(Unit::new(units.len(), side, UnitType::Motorised, *p, 100.0));
                }
            }
        }
        if units.is_empty() {
            return Err("The initial deployment contains no units.".into());
        }
        let mut orders: HashMap<i32, Vec<Order>> = HashMap::new();
        let mut productions: HashMap<i32, Vec<Production>> = HashMap::new();
        for (name, value) in object {
            let Some(tick) = parse_int(name) else { continue };
            if tick < 0 || !value.is_object() {
                continue;
            }
            for (key, entry) in value.as_object().unwrap() {
                if key.starts_with("production") {
                    if !entry.is_object() {
                        continue;
                    }
                    let slot = match entry.get("color") {
                        Some(color) => int32(color)?,
                        None => 0,
                    };
                    if slot < 0 || slot as usize >= map.infantry.len() {
                        continue;
                    }
                    if let Some(zone_value) = entry.get("zone") {
                        let mut zone = Vec::new();
                        for city in array(zone_value)? {
                            let city = int32(city)?;
                            if city >= 0 && (city as usize) < map.cities.len() && !zone.contains(&city) {
                                zone.push(city);
                            }
                        }
                        productions.entry(tick).or_default().push(Production { slot: slot as usize, kind: UnitType::Infantry, rate: 0.0, zone: Some(zone), ratio: None });
                        continue;
                    }
                    let rate = number(entry, "production_rate").or_else(|| number(entry, "rate")).unwrap_or(0.7);
                    let kind = text(entry, "production_type").and_then(UnitType::parse).unwrap_or(UnitType::Infantry);
                    let ratio = number(entry, "ratio").map(|r| r.clamp(0.0, 1.0));
                    productions.entry(tick).or_default().push(Production { slot: slot as usize, kind, rate: rate.max(0.0), zone: None, ratio });
                    continue;
                }
                let Some(id) = parse_int(key) else { continue };
                let mut points = Vec::new();
                for point in array(entry)? {
                    let values = array(point)?;
                    if values.len() < 2 {
                        return Err("Replay point must contain x and y.".into());
                    }
                    points.push(Vec2::new(double(&values[0])?, double(&values[1])?));
                }
                orders.entry(tick).or_default().push(Order { unit_id: id, points });
            }
        }
        let end_tick = match root.get("end") {
            Some(end) => int32(end)?,
            None => orders.keys().chain(productions.keys()).copied().max().unwrap_or(0),
        };
        if end_tick < 0 {
            return Err("Replay end frame must be non-negative.".into());
        }
        let result = match root.get("result") {
            Some(Value::Number(n)) => n.as_f64(),
            Some(Value::Bool(true)) => Some(1.0),
            Some(Value::Bool(false)) => Some(0.0),
            _ => None,
        };
        Ok(Replay {
            version: version_name,
            source_mode: match_mode,
            legacy_production,
            mode: mode_name,
            end_tick,
            result,
            map,
            player_names: read_player_names(root),
            player_labels: read_player_labels(root),
            units,
            orders,
            productions,
        })
    }
}

impl ReplayMap {
    fn read(map: &Value, replay_dir: &Path, pygame_ce_raster: bool, files: &mut MapFiles) -> Result<ReplayMap, String> {
        fn sides(map: &Value, name: &str, side_count: usize) -> Result<Vec<Vec<Vec2>>, String> {
            let Some(value) = map.get(name) else { return Ok(vec![Vec::new(); side_count]) };
            array(value)?.iter().map(|side| array(side)?.iter().map(point).collect()).collect()
        }
        let cities = match map.get("cities") {
            Some(value) => array(value)?.iter().map(point).collect::<Result<Vec<_>, _>>()?,
            None => Vec::new(),
        };
        let infantry = sides(map, "infantry", 2)?;
        if !(2..=4).contains(&infantry.len()) {
            return Err("The simulation profile supports two to four colors.".into());
        }
        let tanks = sides(map, "tanks", infantry.len())?;
        let motorised = sides(map, "motorised", infantry.len())?;
        if tanks.len() != infantry.len() || motorised.len() != infantry.len() {
            return Err("Deployment arrays must have the same number of colors.".into());
        }
        let map_path = match map.get("path") {
            None | Some(Value::Null) => None,
            Some(Value::String(path)) => Some(path.clone()),
            Some(_) => return Err("The map path must be text.".into()),
        };
        let embedded = map.get("map_surface");
        let (surface, source_surface) = match embedded {
            Some(value) => {
                let encoded = value.as_str();
                (encoded.and_then(MapSurface::decode_base64), encoded.map(str::to_string))
            }
            None => match files.resolve(map_path.as_deref(), replay_dir) {
                Some(bytes) => (MapSurface::decode(&bytes), Some(base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes))),
                None => (None, None),
            },
        };
        let surface = surface.ok_or_else(|| format!("Cannot decode terrain map '{}'.", map_path.as_deref().unwrap_or("")))?;
        let bridges = match map.get("bridges") {
            Some(value) => array(value)?.iter().map(|bridge| array(bridge)?.iter().map(point).collect()).collect::<Result<Vec<Vec<Vec2>>, String>>()?,
            None => Vec::new(),
        };
        let (width, height) = if surface.width == 960 { (1600, 900) } else { (1920, 1080) };
        let surface = surface.rasterize(&cities, &bridges, width, height, pygame_ce_raster)?;
        let capitals = match map.get("capitals") {
            Some(value) => array(value)?.iter().map(int32).collect::<Result<Vec<_>, _>>()?,
            None => Vec::new(),
        };
        Ok(ReplayMap { width, height, map_surface: source_surface.filter(|s| !s.trim().is_empty()), surface, infantry, tanks, motorised, cities, capitals })
    }
}

fn read_player_labels(root: &Value) -> Vec<Vec<String>> {
    let Some(Value::Array(players)) = root.get("player_usernames") else { return Vec::new() };
    fn label(player: &Value) -> String {
        if let Value::String(name) = player {
            return name.clone();
        }
        let name = text(player, "username").unwrap_or("");
        let title = text(player, "title").unwrap_or("");
        if title.is_empty() {
            name.to_string()
        } else {
            format!("{name} [{title}]")
        }
    }
    players
        .iter()
        .map(|side| match side {
            Value::Array(team) => team.iter().map(label).collect(),
            other => vec![label(other)],
        })
        .collect()
}

fn read_player_names(root: &Value) -> Vec<String> {
    let default = || vec!["blue".to_string(), "red".to_string()];
    let Some(Value::Array(sides)) = root.get("player_usernames") else { return default() };
    let mut names: Vec<String> = Vec::new();
    for side in sides {
        // A 2v2 side names both teammates.
        let name = match side {
            Value::Array(team) => Some(
                team.iter()
                    .filter_map(|x| match x {
                        Value::String(s) => Some(s.as_str()),
                        other => text(other, "username"),
                    })
                    .filter(|x| !x.trim().is_empty())
                    .collect::<Vec<_>>()
                    .join(" & "),
            ),
            Value::String(name) => Some(name.clone()),
            other => text(other, "username").map(str::to_string),
        };
        match name {
            Some(name) if !name.trim().is_empty() => names.push(name),
            _ => names.push(format!("player{}", names.len() + 1)),
        }
    }
    if names.is_empty() {
        default()
    } else {
        names
    }
}

/// Reads a gzip or plain JSON file.
pub fn read_json_file(path: &Path) -> Result<Value, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("Could not open {}: {e}", path.display()))?;
    parse_replay_bytes(&bytes)
}

pub fn parse_replay_bytes(bytes: &[u8]) -> Result<Value, String> {
    let decoded;
    let data = if bytes.len() >= 2 && bytes[0] == 0x1f && bytes[1] == 0x8b {
        let mut out = Vec::new();
        GzDecoder::new(bytes).read_to_end(&mut out).map_err(|e| format!("The replay could not be decompressed: {e}"))?;
        decoded = out;
        &decoded[..]
    } else {
        bytes
    };
    serde_json::from_slice(data).map_err(|e| format!("The replay is not valid JSON: {e}"))
}

/// int.TryParse with NumberStyles.Integer: surrounding white space and a sign.
fn parse_int(text: &str) -> Option<i32> {
    let text = text.trim();
    let digits = text.strip_prefix(['+', '-']).unwrap_or(text);
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

pub fn text<'a>(value: &'a Value, name: &str) -> Option<&'a str> {
    value.as_object()?.get(name)?.as_str()
}

fn number(value: &Value, name: &str) -> Option<f64> {
    value.get(name)?.as_f64().filter(|n| n.is_finite())
}

fn array(value: &Value) -> Result<&Vec<Value>, String> {
    value.as_array().ok_or_else(|| "The requested operation requires an element of type 'Array'.".to_string())
}

fn double(value: &Value) -> Result<f64, String> {
    value.as_f64().ok_or_else(|| "The requested operation requires an element of type 'Number'.".to_string())
}

fn int32(value: &Value) -> Result<i32, String> {
    value.as_i64().and_then(|n| i32::try_from(n).ok()).ok_or_else(|| "The requested operation requires an element of type 'Number' that fits an integer.".to_string())
}

fn point(value: &Value) -> Result<Vec2, String> {
    let values = array(value)?;
    if values.len() < 2 {
        return Err("Index was outside the bounds of the array.".into());
    }
    Ok(Vec2::new(double(&values[0])?, double(&values[1])?))
}
