//! The map a replay was played on, as a map file the editor can open.
//!
//! A replay records its map in one of three ways: a custom map object with its
//! terrain image (`map`, or `custom_map` in older files), an official map's
//! object with its layout but no image (experiment replays), or only the
//! official map's number. Layouts the replay leaves out come from the engine's
//! deployment catalog, and official terrain comes from the game's own images.
//! Experiment layouts list shock units apart; `maps::to_game_format` puts them
//! back among the infantry, where the engine takes them from.

use super::{map_image_path, maps::to_game_format};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use replay_sim::{deployments, replay::parse_replay_bytes};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

const GAME_FIELDS: [&str; 5] = ["infantry", "tanks", "cities", "capitals", "bridges"];

fn surface(value: &Value) -> Option<String> {
    value
        .get("map_surface")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|surface| !surface.is_empty())
        .map(String::from)
}

/// The number in an official map's image name, such as `assets/fahero_maps/map12.png`.
fn map_number(path: &str) -> Option<String> {
    let name = path.replace('\\', "/");
    let stem = name.rsplit('/').next()?.strip_suffix(".png")?;
    let digits = stem.strip_prefix("map")?;
    (!digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())).then(|| digits.to_string())
}

pub(super) fn map_from_replay(bytes: &[u8], game_root: Option<&Path>, replay_dirs: &[PathBuf]) -> Result<Value, String> {
    let root = parse_replay_bytes(bytes)?;
    let recorded = match (root.get("map"), root.get("custom_map")) {
        (Some(map @ Value::Object(_)), _) => map,
        (_, Some(map @ Value::Object(_))) => map,
        (Some(map), _) => map,
        _ => return Err("This replay does not record its map.".into()),
    };
    let image = recorded.get("path").and_then(Value::as_str).map(String::from);
    let number = match recorded {
        Value::String(text) if text.trim().bytes().all(|b| b.is_ascii_digit()) && !text.trim().is_empty() => Some(text.trim().to_string()),
        Value::Number(number) => Some(number.to_string()),
        _ => image.as_deref().and_then(map_number),
    };

    let layout = if recorded.get("infantry").is_some() {
        recorded.clone()
    } else {
        let number = number.clone().ok_or("This replay records neither its map nor a map number.")?;
        deployments::try_resolve(&Value::String(number.clone()), Some("classic"), replay_dirs)
            .ok_or_else(|| format!("More of Dots has no layout of starting units and cities for map {number}."))?
    };

    let terrain = match surface(&layout).or_else(|| surface(recorded)) {
        Some(terrain) => terrain,
        None => {
            let root = game_root.ok_or("War of Dots was not found, so the map's terrain image is not available.")?;
            // A recorded image path first, then the map number, which any numbered map folder may hold.
            let candidates = [layout.get("path").and_then(Value::as_str).map(String::from), image, number];
            let path = candidates
                .iter()
                .flatten()
                .find_map(|image| map_image_path(root, image))
                .ok_or("The terrain image of this map was not found in War of Dots.")?;
            BASE64.encode(std::fs::read(&path).map_err(|error| format!("Could not read {}: {error}", path.display()))?)
        }
    };

    let mut map = Map::new();
    map.insert("map_surface".into(), Value::String(terrain));
    for key in GAME_FIELDS {
        map.insert(key.into(), layout.get(key).cloned().unwrap_or_else(|| Value::Array(Vec::new())));
    }
    if let Some(motorised) = layout.get("motorised") {
        map.insert("motorised".into(), motorised.clone());
    }
    let mut map = Value::Object(map);
    to_game_format(&mut map);
    let teams = map["infantry"].as_array().map(Vec::len).unwrap_or(0);
    if !(2..=4).contains(&teams) {
        return Err(format!("This replay has {teams} teams. Maps have 2 to 4."));
    }
    Ok(map)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn png() -> String {
        crate::solid_map_surface_base64(960, 540).unwrap()
    }

    #[test]
    fn custom_replays_keep_their_map_and_drop_fields_the_game_does_not_read() {
        let replay = json!({
            "mode": "1v1",
            "map": {
                "map_surface": png(), "mode": "v3",
                "infantry": [[[100, 100]], [[200, 200]]], "tanks": [[], [[300, 300]]],
                "cities": [[10, 10]], "capitals": [0], "bridges": [[[1, 1], [5, 5]]]
            }
        });
        let map = map_from_replay(replay.to_string().as_bytes(), None, &[]).unwrap();
        let keys: Vec<&String> = map.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["map_surface", "infantry", "tanks", "cities", "capitals", "bridges"]);
        assert_eq!(map["tanks"], json!([[], [[300, 300]]]));
    }

    #[test]
    fn experiment_replays_put_shock_units_back_among_the_infantry() {
        // Six infantry per side: the engine turns index 5 into a shock unit.
        let infantry = |x: i32| (0..6).map(|i| json!([x, 100 + 10 * i])).collect::<Vec<_>>();
        let mut classic = json!({"map_surface": png(), "infantry": [infantry(100), infantry(900)], "tanks": [[], []], "cities": [], "capitals": [], "bridges": []});
        let entry = json!({"classic": classic.clone()});
        let experiment = deployments::try_convert(&entry, "experiment").unwrap();
        assert_eq!(experiment["motorised"][0].as_array().unwrap().len(), 1);
        let replay = json!({"mode": "experiment", "map": experiment});
        let map = map_from_replay(replay.to_string().as_bytes(), None, &[]).unwrap();
        classic.as_object_mut().unwrap().remove("motorised");
        assert_eq!(map["infantry"], classic["infantry"]);
        assert!(map.get("motorised").is_none());
    }

    #[test]
    fn official_map_numbers_take_the_catalog_layout() {
        let root = std::env::temp_dir().join(format!("mod-replay-map-{}", std::process::id()));
        let folder = root.join("assets").join(crate::installed_maps::NUMBERED_MAP_FOLDERS[0]);
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("map1.png"), BASE64.decode(png()).unwrap()).unwrap();
        let map = map_from_replay(json!({"mode": "1v1", "map": "1"}).to_string().as_bytes(), Some(&root), &[]).unwrap();
        assert_eq!(map["infantry"].as_array().unwrap().len(), 2);
        assert!(map["infantry"][0].as_array().unwrap().len() > 1);
        assert!(map.get("motorised").is_none());
        std::fs::remove_dir_all(root).unwrap();
    }
}
