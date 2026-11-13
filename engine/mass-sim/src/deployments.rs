//! Terrain images do not contain unit IDs, types, cities or capitals. Number-only
//! recordings need a deployment catalog as well as their PNG. Keep explicit map
//! objects authoritative: custom scenarios may reuse an official terrain image.

use crate::replay::read_json_file;
use serde_json::{Map, Value};
use std::path::PathBuf;
use std::sync::OnceLock;

static CATALOG: OnceLock<Value> = OnceLock::new();

fn catalog() -> &'static Value {
    CATALOG.get_or_init(|| serde_json::from_str(include_str!("../../maps/deployments.json")).expect("the built-in deployment catalog is valid JSON"))
}

/// Match format and simulation rules are separate: two teammates share each
/// color in 2v2, so its deployment is the same as a classic 1v1.
pub fn normalize_mode(mode: Option<&str>) -> String {
    mode.map(|mode| mode.trim().to_lowercase()).unwrap_or_default()
}

pub fn rules_mode(mode: Option<&str>) -> &'static str {
    match normalize_mode(mode).as_str() {
        "experiment" => "experiment",
        "avalanche" => "avalanche",
        _ => "classic",
    }
}

fn map_number(id: &Value) -> Option<i32> {
    let text = match id {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        _ => return None,
    };
    let text = text.trim();
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse::<i32>().ok()
}

/// Every map plays in every match format, so the format only picks the rules:
/// experimental and avalanche have their own layouts, everything else (1v1,
/// 2v2, free-for-all and unfamiliar labels) uses the classic one. A format
/// that names its number of colors still needs a map with that many.
pub fn try_resolve(id: &Value, mode: Option<&str>, replay_dirs: &[PathBuf]) -> Option<Value> {
    let number = map_number(id)?;
    let profile = rules_mode(mode);
    let known = catalog().get(number.to_string()).and_then(|entry| entry.get(profile).cloned().or_else(|| try_convert(entry, profile)));
    let map = match known {
        Some(map) => map,
        None => from_replays(number, profile, replay_dirs)?,
    };
    let required = match normalize_mode(mode).as_str() {
        "v3" | "3pffa" | "3p ffa" => 3,
        "v4" | "4pffa" | "4p ffa" => 4,
        _ => 0,
    };
    if required > 0 && map.get("infantry").and_then(Value::as_array).map(Vec::len) != Some(required) {
        return None;
    }
    Some(map)
}

/// Every official map can be played in each mode, and a replay that carries its
/// map carries the whole layout. So a map the catalog lacks, such as one added
/// by a game update, takes its layout from the newest replay of it in any mode.
fn from_replays(number: i32, profile: &str, replay_dirs: &[PathBuf]) -> Option<Value> {
    let image = format!("/map{number}.png");
    let mut files = Vec::new();
    for directory in replay_dirs.iter().filter(|directory| directory.is_dir()) {
        let Ok(entries) = std::fs::read_dir(directory) else { continue };
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            let extension = path.extension().map(|e| e.to_string_lossy().to_lowercase());
            if !matches!(extension.as_deref(), Some("rep") | Some("json")) || !path.is_file() {
                continue;
            }
            let modified = entry.metadata().and_then(|m| m.modified()).ok();
            files.push((modified, path));
        }
    }
    files.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, file) in files {
        let Ok(root) = read_json_file(&file) else { continue };
        let Some(candidate) = root.get("map").filter(|map| map.is_object()) else { continue };
        if candidate.get("map_surface").is_some() || candidate.get("infantry").is_none() {
            continue;
        }
        let Some(path) = candidate.get("path").and_then(Value::as_str) else { continue };
        if !path.replace('\\', "/").to_lowercase().ends_with(&image) {
            continue;
        }
        let recorded = match root.get("mode") {
            Some(Value::String(mode)) => rules_mode(Some(mode)),
            _ => "classic",
        };
        // Avalanche layouts are their own; they neither serve nor come from the others.
        if (recorded == "avalanche") != (profile == "avalanche") {
            continue;
        }
        if recorded == profile {
            return Some(candidate.clone());
        }
        let mut entry = Map::new();
        entry.insert(recorded.to_string(), candidate.clone());
        if let Some(map) = try_convert(&Value::Object(entry), profile) {
            return Some(map);
        }
    }
    None
}

/// Classic and experimental matches share one layout. Experimental turns every
/// fifth infantry, counted back from the last and never the first, into motorised,
/// listed last first; tanks, cities, capitals and bridges are unchanged. This holds
/// on both sides of all 33 maps the catalog recovered in both modes, so a map known
/// in one mode is converted to the other.
pub fn try_convert(entry: &Value, profile: &str) -> Option<Value> {
    let source = match profile {
        "classic" => "experiment",
        "experiment" => "classic",
        _ => return None,
    };
    let mut layout = entry.get(source)?.as_object()?.clone();
    let infantry = layout.get("infantry")?.as_array()?.clone();
    let motorised = layout.get("motorised").and_then(Value::as_array).cloned();
    let mut sides_infantry = Vec::new();
    let mut sides_motorised = Vec::new();
    for side in 0..infantry.len() {
        let units: Vec<Value> = infantry[side].as_array().cloned().unwrap_or_default();
        let fast: Vec<Value> = motorised.as_ref().and_then(|m| m.get(side)).and_then(Value::as_array).cloned().unwrap_or_default();
        if profile == "classic" {
            let total = units.len() + fast.len();
            let mut merged: Vec<Option<Value>> = vec![None; total];
            for (i, unit) in fast.into_iter().enumerate() {
                let at = total as i64 - 1 - 5 * i as i64;
                if at < 1 {
                    return None;
                }
                merged[at as usize] = Some(unit);
            }
            let mut next = units.into_iter();
            for slot in merged.iter_mut() {
                if slot.is_none() {
                    *slot = next.next();
                }
            }
            sides_infantry.push(Value::Array(merged.into_iter().map(|v| v.unwrap_or(Value::Null)).collect()));
            sides_motorised.push(Value::Array(Vec::new()));
        } else {
            if !fast.is_empty() {
                return None;
            }
            let count = units.len();
            let converted = |at: usize| at >= 1 && (count - 1 - at) % 5 == 0;
            sides_infantry.push(Value::Array(units.iter().enumerate().filter(|(at, _)| !converted(*at)).map(|(_, v)| v.clone()).collect()));
            sides_motorised.push(Value::Array(units.iter().enumerate().filter(|(at, _)| converted(*at)).map(|(_, v)| v.clone()).rev().collect()));
        }
    }
    layout.insert("infantry".into(), Value::Array(sides_infantry));
    layout.insert("motorised".into(), Value::Array(sides_motorised));
    Some(Value::Object(layout))
}
