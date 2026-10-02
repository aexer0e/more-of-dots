//! Drafts never live in the game's map scan directory. Publishing is explicit.
use super::{
    default_game_map_value, display_name_for_map_file, map_dimensions, map_team_count,
    read_gzip_json_file, safe_map_file_name, safe_map_name_slug, validate_game_map_value,
    write_gzip_json_file, GameMapRecord,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Cursor, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub(super) fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("Map has no parent directory.")?;
    let mut temporary = tempfile::Builder::new()
        .prefix(".mod-map-")
        .suffix(".tmp")
        .tempfile_in(parent)
        .map_err(|e| e.to_string())?;
    temporary.write_all(bytes).map_err(|e| e.to_string())?;
    temporary.as_file().sync_all().map_err(|e| e.to_string())?;
    // persist replaces the destination atomically on Windows as well as Unix.
    temporary
        .persist(path)
        .map_err(|e| format!("Could not replace {}: {e}", path.display()))?;
    Ok(())
}

fn validate_terrain(data: &Value) -> Result<(), String> {
    let (width, height) = map_dimensions(data);
    if width > 9600 || height > 5400 {
        return Err("Map terrain exceeds the maximum size of 9600 × 5400 pixels.".into());
    }
    let bytes = BASE64
        .decode(data["map_surface"].as_str().unwrap().trim())
        .map_err(|e| e.to_string())?;
    let mut decoder = png::Decoder::new(Cursor::new(bytes));
    decoder.set_limits(png::Limits {
        bytes: 256 * 1024 * 1024,
    });
    let mut reader = decoder
        .read_info()
        .map_err(|e| format!("Map terrain PNG is damaged: {e}"))?;
    if reader.output_buffer_size() > 256 * 1024 * 1024 {
        return Err("Map terrain PNG requires too much memory to decode.".into());
    }
    let mut buffer = vec![0; reader.output_buffer_size()];
    reader
        .next_frame(&mut buffer)
        .map_err(|e| format!("Map terrain PNG is damaged: {e}"))?;
    Ok(())
}

pub(super) fn validate_publish(data: &Value) -> Result<(), String> {
    validate_game_map_value(data)?;
    validate_terrain(data)?;
    validate_content(data)
}

fn validate_content(data: &Value) -> Result<(), String> {
    let teams = match data["mode"].as_str() {
        Some("1v1") => 2,
        Some("v3") => 3,
        Some("v4") => 4,
        _ => return Err("Choose a supported map mode before saving to the game.".into()),
    };
    let (width, height) = map_dimensions(data);
    let (logical_width, logical_height) = if (width, height) == (960, 540) {
        (1600, 900)
    } else {
        (width, height)
    };
    let point = |value: &Value| -> Result<(), String> {
        let valid = value.as_array().filter(|p| p.len() == 2).is_some_and(|p| {
            p[0].as_f64()
                .is_some_and(|x| x.is_finite() && x >= 0.0 && x < logical_width as f64)
                && p[1]
                    .as_f64()
                    .is_some_and(|y| y.is_finite() && y >= 0.0 && y < logical_height as f64)
        });
        if valid {
            Ok(())
        } else {
            Err("Map contains an invalid or out-of-bounds position.".into())
        }
    };
    let mut unit_counts = vec![0; teams];
    for key in ["infantry", "tanks", "motorised"] {
        // Legacy maps did not contain motorised infantry.
        if key == "motorised" && data.get(key).is_none() {
            continue;
        }
        let buckets = data[key]
            .as_array()
            .filter(|a| a.len() == teams)
            .ok_or_else(|| format!("{key} must have exactly {teams} team lists."))?;
        for (team, bucket) in buckets.iter().enumerate() {
            let units = bucket
                .as_array()
                .ok_or_else(|| format!("{key} team {} is not a list.", team + 1))?;
            for unit in units {
                point(unit)?;
            }
            unit_counts[team] += units.len();
        }
    }
    if let Some(team) = unit_counts.iter().position(|count| *count == 0) {
        return Err(format!("Team {} needs at least one unit before saving to the game. You can save this map as a draft.", team + 1));
    }
    let cities = data["cities"].as_array().unwrap();
    for city in cities {
        point(city)?;
    }
    let mut capitals = std::collections::HashSet::new();
    for capital in data["capitals"].as_array().unwrap() {
        let index = capital
            .as_u64()
            .filter(|i| *i < cities.len() as u64)
            .ok_or("Every capital must refer to an existing city.")?;
        if !capitals.insert(index) {
            return Err("A city is listed as a capital more than once.".into());
        }
    }
    for bridge in data["bridges"].as_array().unwrap() {
        match bridge.as_array() {
            Some(ends) if ends.len() == 2 => {
                point(&ends[0])?;
                point(&ends[1])?;
            }
            Some(flat) if flat.len() == 4 => {
                point(&Value::Array(flat[..2].to_vec()))?;
                point(&Value::Array(flat[2..].to_vec()))?;
            }
            _ => return Err("A bridge must contain two endpoint positions.".into()),
        }
    }
    Ok(())
}

#[derive(Serialize, Deserialize)]
struct Draft {
    file_name: String,
    source: Option<PathBuf>,
    data: Value,
    published: bool,
}

pub(super) struct MapStore {
    drafts: PathBuf,
    game_dirs: Vec<PathBuf>,
}

impl MapStore {
    pub fn new(drafts: PathBuf, game_dirs: Vec<PathBuf>) -> Result<Self, String> {
        fs::create_dir_all(&drafts).map_err(|e| e.to_string())?;
        Ok(Self { drafts, game_dirs })
    }

    fn draft_path(&self, id: &str) -> Result<PathBuf, String> {
        let name = id.strip_prefix("draft:").ok_or("Invalid draft ID.")?;
        if !name.ends_with(".json") || name.contains(['/', '\\', ':']) || name.starts_with('.') {
            return Err("Invalid draft ID.".into());
        }
        let path = self.drafts.join(name);
        if path.exists() {
            Self::check_parent(&path, &self.drafts)?;
        }
        Ok(path)
    }

    fn check_parent(path: &Path, parent: &Path) -> Result<(), String> {
        let actual = path.canonicalize().map_err(|e| e.to_string())?;
        let expected = parent.canonicalize().map_err(|e| e.to_string())?;
        if actual.parent() != Some(expected.as_path()) {
            return Err("Map path is outside its storage folder.".into());
        }
        Ok(())
    }

    fn game_path(&self, id: &str) -> Result<PathBuf, String> {
        let path = PathBuf::from(id.strip_prefix("game:").ok_or("Invalid game map ID.")?);
        safe_map_file_name(
            path.file_name()
                .and_then(|n| n.to_str())
                .ok_or("Invalid map filename.")?,
        )?;
        for root in &self.game_dirs {
            if path.parent() == Some(root.as_path()) {
                if path.exists() {
                    Self::check_parent(&path, root)?;
                }
                return Ok(path);
            }
        }
        Err("Map path is outside the War of Dots map folders.".into())
    }

    fn load_draft(&self, id: &str) -> Result<Draft, String> {
        let bytes = fs::read(self.draft_path(id)?).map_err(|e| e.to_string())?;
        serde_json::from_slice(&bytes).map_err(|e| format!("Could not read draft: {e}"))
    }

    fn write_draft(&self, id: &str, draft: &Draft) -> Result<(), String> {
        atomic_write(
            &self.draft_path(id)?,
            &serde_json::to_vec(draft).map_err(|e| e.to_string())?,
        )
    }

    fn draft_id_for_source(path: &Path) -> String {
        format!(
            "draft:map_{:x}.json",
            Sha256::digest(path.to_string_lossy().as_bytes())
        )
    }

    pub fn create(&self, name: &str, mode: &str) -> Result<GameMapRecord, String> {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos();
        let stem = format!("map_{}_{stamp}", safe_map_name_slug(name));
        let id = format!("draft:{stem}.json");
        self.write_draft(
            &id,
            &Draft {
                file_name: format!("{stem}.txt"),
                source: None,
                data: default_game_map_value(mode)?,
                published: false,
            },
        )?;
        self.read(&id)
    }

    pub fn read(&self, id: &str) -> Result<GameMapRecord, String> {
        let (path, file_name, source, result, published) = if id.starts_with("draft:") {
            let path = self.draft_path(id)?;
            match self.load_draft(id) {
                Ok(draft) => {
                    let published = draft.published
                        && draft.source.as_ref().is_some_and(|source| {
                            read_gzip_json_file(source).ok().as_ref() == Some(&draft.data)
                        });
                    (
                        path,
                        draft.file_name,
                        draft.source,
                        Ok(draft.data),
                        published,
                    )
                }
                Err(error) => {
                    let file_name = path.file_name().unwrap().to_string_lossy().to_string();
                    (path, file_name, None, Err(error), false)
                }
            }
        } else {
            let path = self.game_path(id)?;
            let file_name = path.file_name().unwrap().to_string_lossy().to_string();
            let result = read_gzip_json_file(&path);
            (path.clone(), file_name, Some(path), result, true)
        };
        let result = result.and_then(|data| {
            validate_game_map_value(&data)?;
            validate_terrain(&data)?;
            Ok(data)
        });
        let (data, status, issue) = match result {
            Ok(data) => {
                let issue = if published {
                    validate_content(&data).err()
                } else {
                    None
                };
                (data, if published { "published" } else { "draft" }, issue)
            }
            Err(error) => (default_game_map_value("1v1")?, "invalid", Some(error)),
        };
        let modified = fs::metadata(&path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|t| t.as_millis() as u64)
            .unwrap_or(0);
        let (width, height) = map_dimensions(&data);
        let team_count = map_team_count(&data);
        Ok(GameMapRecord {
            id: id.into(),
            file_name: file_name.clone(),
            file_path: path.to_string_lossy().into(),
            name: display_name_for_map_file(&file_name),
            data,
            created_at: modified,
            updated_at: modified,
            width,
            height,
            team_count,
            status: status.into(),
            issue,
            game_file_path: source
                .filter(|p| p.is_file())
                .map(|p| p.to_string_lossy().into()),
        })
    }

    pub fn list(&self) -> Result<Vec<GameMapRecord>, String> {
        let mut maps = Vec::new();
        let mut published_sources = std::collections::HashSet::new();
        for entry in fs::read_dir(&self.drafts)
            .map_err(|e| e.to_string())?
            .flatten()
        {
            if entry.path().extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let id = format!("draft:{}", entry.file_name().to_string_lossy());
            let record = self.read(&id)?;
            if record.status == "published" {
                if let Some(source) = &record.game_file_path {
                    published_sources.insert(PathBuf::from(source));
                }
            }
            maps.push(record);
        }
        for root in &self.game_dirs {
            for entry in fs::read_dir(root).map_err(|e| e.to_string())?.flatten() {
                let path = entry.path();
                if !path.is_file()
                    || published_sources.contains(&path)
                    || !path
                        .extension()
                        .and_then(|e| e.to_str())
                        .is_some_and(|e| e.eq_ignore_ascii_case("txt"))
                {
                    continue;
                }
                maps.push(self.read(&format!("game:{}", path.to_string_lossy()))?);
            }
        }
        maps.sort_by(|a, b| {
            b.updated_at
                .cmp(&a.updated_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        Ok(maps)
    }

    pub fn save(&self, id: &str, data: Value, publish: bool) -> Result<GameMapRecord, String> {
        validate_game_map_value(&data)?;
        let (draft_id, mut draft) = if id.starts_with("draft:") {
            (id.to_string(), self.load_draft(id)?)
        } else {
            let source = self.game_path(id)?;
            let existing = read_gzip_json_file(&source)?;
            (
                Self::draft_id_for_source(&source),
                Draft {
                    file_name: source.file_name().unwrap().to_string_lossy().into(),
                    source: Some(source),
                    data: existing,
                    published: false,
                },
            )
        };
        if let (Some(existing), Some(incoming)) = (draft.data.as_object_mut(), data.as_object()) {
            existing.extend(incoming.clone());
        } else {
            draft.data = data;
        }
        draft.published = false;
        if publish {
            validate_publish(&draft.data)?;
            let target = match &draft.source {
                Some(source) => self.game_path(&format!("game:{}", source.to_string_lossy()))?,
                None => {
                    let root = self.game_dirs.first().ok_or(
                        "War of Dots map_editor folder was not found. Save a draft instead.",
                    )?;
                    let target = root.join(safe_map_file_name(&draft.file_name)?);
                    if target.exists() {
                        return Err("A game map with this filename already exists. It has not been overwritten.".into());
                    }
                    target
                }
            };
            // Keep the editable copy even if writing to the game fails.
            self.write_draft(&draft_id, &draft)?;
            write_gzip_json_file(&target, &draft.data)?;
            draft.source = Some(target);
            draft.published = true;
        }
        self.write_draft(&draft_id, &draft)?;
        self.read(&draft_id)
    }

    pub fn delete(&self, ids: &[String]) -> Result<Vec<String>, String> {
        let mut paths = Vec::new();
        for id in ids {
            let (path, game) = if id.starts_with("draft:") {
                let record = self.read(id)?;
                let game = if record.status == "published" {
                    record.game_file_path.map(PathBuf::from)
                } else {
                    None
                };
                (self.draft_path(id)?, game)
            } else {
                let path = self.game_path(id)?;
                (path.clone(), Some(path))
            };
            if let Some(game) = game.filter(|p| p.exists()) {
                let game = self.game_path(&format!("game:{}", game.to_string_lossy()))?;
                let png = game.with_extension("png");
                if png.exists() {
                    Self::check_parent(&png, game.parent().unwrap())?;
                    paths.push(png);
                }
                paths.push(game);
            }
            paths.push(path);
        }
        let mut deleted = std::collections::HashSet::new();
        for path in paths {
            if !deleted.insert(path.clone()) {
                continue;
            }
            fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
        Ok(ids.to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn store() -> (tempfile::TempDir, MapStore) {
        let root = tempfile::tempdir().unwrap();
        let game = root.path().join("game");
        fs::create_dir(&game).unwrap();
        let store = MapStore::new(root.path().join("drafts"), vec![game]).unwrap();
        (root, store)
    }

    fn playable() -> Value {
        let mut map = default_game_map_value("1v1").unwrap();
        map["infantry"] = json!([[[100, 100]], [[1400, 800]]]);
        map["cities"] = json!([[200, 200], [1300, 700]]);
        map["capitals"] = json!([0, 1]);
        map["future_field"] = json!({"keep": true});
        map
    }

    #[test]
    fn empty_draft_never_enters_game_folder_even_after_save_or_rejected_publish() {
        let (_root, store) = store();
        let draft = store.create("Unfinished", "1v1").unwrap();
        assert_eq!(draft.status, "draft");
        assert!(draft.game_file_path.is_none());
        store.save(&draft.id, draft.data.clone(), false).unwrap();
        assert!(store
            .save(&draft.id, draft.data, true)
            .unwrap_err()
            .contains("needs at least one unit"));
        assert_eq!(fs::read_dir(&store.game_dirs[0]).unwrap().count(), 0);
        assert_eq!(store.list().unwrap().len(), 1);
    }

    #[test]
    fn drafts_work_without_a_game_installation() {
        let root = tempfile::tempdir().unwrap();
        let store = MapStore::new(root.path().join("drafts"), vec![]).unwrap();
        let draft = store.create("offline", "1v1").unwrap();
        let saved = store.save(&draft.id, playable(), false).unwrap();
        assert!(store
            .save(&saved.id, saved.data, true)
            .unwrap_err()
            .contains("folder was not found"));
        assert_eq!(store.list().unwrap().len(), 1);
    }

    #[test]
    fn incomplete_edits_and_failed_publish_preserve_last_published_bytes() {
        let (_root, store) = store();
        let draft = store.create("test", "1v1").unwrap();
        let published = store.save(&draft.id, playable(), true).unwrap();
        let path = PathBuf::from(published.game_file_path.unwrap());
        let bytes = fs::read(&path).unwrap();
        let incomplete = default_game_map_value("1v1").unwrap();
        store.save(&draft.id, incomplete.clone(), false).unwrap();
        assert!(store.save(&draft.id, incomplete, true).is_err());
        assert_eq!(fs::read(&path).unwrap(), bytes);
        assert_eq!(store.list().unwrap().len(), 2); // draft and last published copy
        let mut changed = playable();
        changed["infantry"][0][0] = json!([250, 100]);
        store.save(&draft.id, changed.clone(), true).unwrap();
        assert_eq!(read_gzip_json_file(&path).unwrap(), changed);
        assert_eq!(store.list().unwrap().len(), 1);
    }

    #[test]
    fn existing_map_edits_are_saved_outside_game_and_keep_unknown_fields() {
        let (_root, store) = store();
        let path = store.game_dirs[0].join("old.txt");
        let original = playable();
        write_gzip_json_file(&path, &original).unwrap();
        let id = format!("game:{}", path.to_string_lossy());
        let draft = store
            .save(&id, default_game_map_value("1v1").unwrap(), false)
            .unwrap();
        assert_eq!(read_gzip_json_file(&path).unwrap(), original);
        assert_eq!(draft.data["future_field"], original["future_field"]);
        store.delete(&[draft.id]).unwrap();
        assert!(path.exists());
    }

    #[test]
    fn malformed_and_unfinished_game_maps_can_be_deleted_without_backups() {
        let (_root, store) = store();
        for (name, malformed) in [("broken", true), ("empty", false)] {
            let path = store.game_dirs[0].join(format!("{name}.txt"));
            if malformed {
                fs::write(&path, b"broken gzip").unwrap();
            } else {
                write_gzip_json_file(&path, &default_game_map_value("1v1").unwrap()).unwrap();
            }
            let png = path.with_extension("png");
            fs::write(&png, b"original thumbnail").unwrap();
            let id = format!("game:{}", path.to_string_lossy());
            let entry = store.list().unwrap().into_iter().find(|m| m.id == id).unwrap();
            assert!(entry.issue.is_some());
            assert_eq!(entry.status == "invalid", malformed);
            store.delete(&[id]).unwrap();
            assert!(!path.exists());
            assert!(!png.exists());
        }
        assert!(store.list().unwrap().is_empty());
        assert_eq!(fs::read_dir(&store.drafts).unwrap().count(), 0);
        assert_eq!(fs::read_dir(&store.game_dirs[0]).unwrap().count(), 0);
    }

    #[test]
    fn deleting_a_game_map_preserves_an_existing_unsaved_draft() {
        let (_root, store) = store();
        let draft = store.create("test", "1v1").unwrap();
        let published = store.save(&draft.id, playable(), true).unwrap();
        let empty = default_game_map_value("1v1").unwrap();
        store.save(&draft.id, empty.clone(), false).unwrap();
        let game_id = format!("game:{}", published.game_file_path.unwrap());
        store.delete(&[game_id]).unwrap();
        let maps = store.list().unwrap();
        assert_eq!(maps.len(), 1);
        assert_eq!(maps[0].data["infantry"], empty["infantry"]);
        assert!(maps[0].game_file_path.is_none());
        assert_eq!(fs::read_dir(&store.drafts).unwrap().count(), 1);
    }

    #[test]
    fn publishing_rejects_bad_geometry_teams_capitals_and_png() {
        validate_publish(&playable()).unwrap();
        let mut legacy = playable();
        legacy.as_object_mut().unwrap().remove("motorised");
        legacy["bridges"] = json!([[10, 10, 20, 20]]);
        validate_publish(&legacy).unwrap();
        for (key, value) in [
            ("infantry", json!([[], []])),
            ("tanks", json!([[]])),
            ("motorised", json!(null)),
            ("mode", json!("unknown")),
            ("cities", json!([[1600, 900]])),
            ("cities", json!([["x", 0]])),
            ("capitals", json!([2])),
            ("capitals", json!([0, 0])),
            ("bridges", json!([[[0, 0], [-1, 10]]])),
            ("bridges", json!([[0, 0, 10]])),
        ] {
            let mut bad = playable();
            bad[key] = value;
            assert!(validate_publish(&bad).is_err(), "accepted bad {key}");
        }
        let mut truncated = playable();
        let png = BASE64
            .decode(truncated["map_surface"].as_str().unwrap())
            .unwrap();
        truncated["map_surface"] = json!(BASE64.encode(&png[..24]));
        assert!(validate_publish(&truncated)
            .unwrap_err()
            .contains("PNG is damaged"));
    }

    #[test]
    fn ids_cannot_escape_storage_or_overwrite_an_unrelated_map() {
        let (root, store) = store();
        let outside = root.path().join("outside.txt");
        fs::write(&outside, b"keep").unwrap();
        let id = format!("game:{}", outside.to_string_lossy());
        assert!(store.delete(&[id.clone()]).is_err());
        assert!(store
            .save("draft:../outside.json", playable(), false)
            .is_err());
        let draft = store.create("test", "1v1").unwrap();
        let target = store.game_dirs[0].join(&draft.file_name);
        fs::write(&target, b"another map").unwrap();
        assert!(store.save(&draft.id, playable(), true).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"another map");
        assert_eq!(fs::read(&outside).unwrap(), b"keep");
    }

    #[test]
    fn deletion_of_published_draft_removes_game_and_thumbnail() {
        let (_root, store) = store();
        let draft = store.create("test", "1v1").unwrap();
        let published = store.save(&draft.id, playable(), true).unwrap();
        let path = PathBuf::from(published.game_file_path.unwrap());
        fs::write(path.with_extension("png"), b"thumbnail").unwrap();
        store.delete(&[draft.id]).unwrap();
        assert!(!path.exists());
        assert!(!path.with_extension("png").exists());
        assert!(store.list().unwrap().is_empty());
        assert_eq!(fs::read_dir(&store.drafts).unwrap().count(), 0);
        assert_eq!(fs::read_dir(&store.game_dirs[0]).unwrap().count(), 0);
    }

    #[test]
    fn atomic_replacement_leaves_no_scanable_temporary_maps() {
        let (_root, store) = store();
        let path = store.game_dirs[0].join("map.txt");
        atomic_write(&path, b"old").unwrap();
        atomic_write(&path, b"new").unwrap();
        assert_eq!(fs::read(path).unwrap(), b"new");
        assert_eq!(fs::read_dir(&store.game_dirs[0]).unwrap().count(), 1);
    }

    #[test]
    fn corrupt_draft_does_not_hide_other_maps_and_can_be_deleted() {
        let (_root, store) = store();
        store.create("good", "1v1").unwrap();
        fs::write(store.drafts.join("broken.json"), b"broken json").unwrap();
        let maps = store.list().unwrap();
        assert_eq!(maps.len(), 2);
        assert_eq!(
            maps.iter()
                .find(|m| m.id == "draft:broken.json")
                .unwrap()
                .status,
            "invalid"
        );
        store.delete(&["draft:broken.json".into()]).unwrap();
        assert_eq!(store.list().unwrap().len(), 1);
    }

    #[test]
    fn external_game_changes_are_visible_and_not_deleted_with_the_older_draft() {
        let (_root, store) = store();
        let draft = store.create("test", "1v1").unwrap();
        let published = store.save(&draft.id, playable(), true).unwrap();
        let path = PathBuf::from(published.game_file_path.unwrap());
        fs::write(&path, b"externally damaged").unwrap();
        let maps = store.list().unwrap();
        assert_eq!(maps.len(), 2);
        assert_eq!(
            maps.iter().find(|m| m.id == draft.id).unwrap().status,
            "draft"
        );
        assert!(maps.iter().any(|m| m.status == "invalid"));
        store.delete(&[draft.id]).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"externally damaged");
    }

    #[test]
    fn same_filename_in_two_installations_has_distinct_identity() {
        let (root, mut store) = store();
        let second = root.path().join("second-game");
        fs::create_dir(&second).unwrap();
        store.game_dirs.push(second.clone());
        for dir in &store.game_dirs {
            write_gzip_json_file(&dir.join("map.txt"), &playable()).unwrap();
        }
        let maps = store.list().unwrap();
        assert_eq!(maps.len(), 2);
        assert_ne!(maps[0].id, maps[1].id);
        store
            .delete(&[format!(
                "game:{}",
                second.join("map.txt").to_string_lossy()
            )])
            .unwrap();
        assert!(store.game_dirs[0].join("map.txt").exists());
        assert!(!second.join("map.txt").exists());
    }
}
