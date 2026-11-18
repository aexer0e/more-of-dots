//! Maps in the game's map folder. Only maps the game can load are ever written there.
use super::{
    blank_game_map_value, default_game_map_value, display_name_for_map_file, map_dimensions,
    map_file_stem, map_team_count, read_gzip_json_file, safe_map_file_name,
    validate_game_map_value, write_gzip_json_file, GameMapRecord,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::Deserialize;
use serde_json::Value;
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

/// Removes the fields older versions of More of Dots added and the game never
/// reads. `mode` goes: the game counts teams from the unit lists. Placed
/// `motorised` units go back into each team's infantry at the places the engine
/// turns infantry into shock units in experiment matches
/// (`replay_sim::deployments::try_convert`), so they play as shocks there.
/// When the counts do not fit that rule they are added after the infantry.
pub(super) fn to_game_format(data: &mut Value) {
    let Some(object) = data.as_object_mut() else { return };
    object.remove("mode");
    let Some(motorised) = object.remove("motorised") else { return };
    let placed = motorised.as_array().is_some_and(|sides| sides.iter().any(|side| side.as_array().is_some_and(|units| !units.is_empty())));
    if !placed || !object.get("infantry").is_some_and(Value::is_array) {
        return;
    }
    let mut layout = object.clone();
    layout.insert("motorised".into(), motorised.clone());
    let entry = serde_json::json!({ "experiment": Value::Object(layout) });
    let merged = replay_sim::deployments::try_convert(&entry, "classic")
        .and_then(|classic| classic.get("infantry").cloned())
        .filter(|infantry| infantry.as_array().is_some_and(|sides| sides.iter().flat_map(|side| side.as_array().into_iter().flatten()).all(|unit| !unit.is_null())));
    let infantry = object.get_mut("infantry").unwrap();
    match merged {
        Some(merged) => *infantry = merged,
        None => {
            let sides = infantry.as_array_mut().unwrap();
            for (side, units) in motorised.as_array().unwrap().iter().enumerate() {
                if let (Some(list), Some(units)) = (sides.get_mut(side).and_then(Value::as_array_mut), units.as_array()) {
                    list.extend(units.iter().cloned());
                }
            }
        }
    }
}

pub(super) fn validate_publish(data: &Value) -> Result<(), String> {
    validate_game_map_value(data)?;
    validate_terrain(data)?;
    validate_content(data)
}

fn validate_content(data: &Value) -> Result<(), String> {
    // The game has no map mode: the unit lists give the number of teams.
    let teams = data["infantry"].as_array().map(Vec::len).unwrap_or(0);
    if !(2..=4).contains(&teams) {
        return Err("A map needs 2 to 4 teams.".into());
    }
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
    for key in ["infantry", "tanks"] {
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
        return Err(format!("Team {} needs at least one unit before the map can be saved to the game.", team + 1));
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

/// A draft from an older version of More of Dots, which kept maps outside the
/// game until they were published. Read once, to move it into the game folder.
#[derive(Deserialize)]
struct LegacyDraft {
    file_name: String,
    source: Option<PathBuf>,
    data: Value,
}

/// Maps live in the game's map folder only. Every write is checked first
/// (`validate_publish`) and replaces the file atomically, so the game never sees
/// a map it cannot load. A new map has no file until its first valid save: until
/// then it exists only in the editor, under a `new:` id.
pub(super) struct MapStore {
    /// Where older versions kept drafts; read once to move them into the game.
    legacy_drafts: PathBuf,
    game_dirs: Vec<PathBuf>,
}

impl MapStore {
    pub fn new(legacy_drafts: PathBuf, game_dirs: Vec<PathBuf>) -> Result<Self, String> {
        Ok(Self { legacy_drafts, game_dirs })
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

    fn game_root(&self) -> Result<&PathBuf, String> {
        self.game_dirs
            .first()
            .ok_or_else(|| "The War of Dots map folder was not found. Install War of Dots to save maps.".to_string())
    }

    fn game_id(path: &Path) -> String {
        format!("game:{}", path.to_string_lossy())
    }

    /// A file name for `name` that no map in the game's folders has yet: the
    /// name itself, or the name with a number added.
    fn free_file_name(&self, name: &str) -> String {
        let stem = map_file_stem(name).unwrap_or_else(|_| "Untitled map".into());
        (1..)
            .map(|n| if n == 1 { format!("{stem}.txt") } else { format!("{stem} {n}.txt") })
            .find(|candidate| self.name_is_free(candidate))
            .unwrap()
    }

    /// Whether no map in the game's folders has this file name. Names differing
    /// only in case count as taken.
    fn name_is_free(&self, file_name: &str) -> bool {
        !self.game_dirs.iter().any(|root| {
            fs::read_dir(root).is_ok_and(|entries| {
                entries.flatten().any(|entry| entry.file_name().to_string_lossy().eq_ignore_ascii_case(file_name))
            })
        })
    }

    /// Checks a map and writes it to a new file in the game's map folder.
    fn write_new(&self, name: &str, mut data: Value) -> Result<GameMapRecord, String> {
        to_game_format(&mut data);
        validate_publish(&data)?;
        let target = self.game_root()?.join(safe_map_file_name(&self.free_file_name(name))?);
        write_gzip_json_file(&target, &data)?;
        self.read(&Self::game_id(&target))
    }

    /// A new empty map: 960 x 540 terrain, or 1920 x 1080 when `large`. It has
    /// no file: a map without units cannot be loaded by the game, so the first
    /// save that passes the check creates the file.
    pub fn create(&self, name: &str, teams: usize, large: bool) -> Result<GameMapRecord, String> {
        let (width, height) = if large { (1920, 1080) } else { (960, 540) };
        let data = blank_game_map_value(teams, width, height)?;
        let file_name = self.free_file_name(name);
        Ok(Self::unsaved_record(&file_name, data))
    }

    /// The record of a new map that has no file yet.
    fn unsaved_record(file_name: &str, data: Value) -> GameMapRecord {
        let (width, height) = map_dimensions(&data);
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|t| t.as_millis() as u64).unwrap_or(0);
        GameMapRecord {
            id: format!("new:{file_name}"),
            file_name: file_name.into(),
            file_path: String::new(),
            name: display_name_for_map_file(file_name),
            team_count: map_team_count(&data),
            data,
            created_at: now,
            updated_at: now,
            width,
            height,
            status: "unsaved".into(),
            issue: None,
            game_file_path: None,
        }
    }

    /// A map from a map file or a replay's map, saved to the game.
    pub fn import(&self, name: &str, data: Value) -> Result<GameMapRecord, String> {
        self.write_new(name, data)
    }

    /// A copy of a map in the game, named "<name> copy" (with a number added
    /// when that name is taken). The map itself is left as it is.
    pub fn duplicate(&self, id: &str) -> Result<GameMapRecord, String> {
        let record = self.read(id)?;
        if record.status == "invalid" {
            return Err(record.issue.unwrap_or_else(|| "This map cannot be read, so it cannot be duplicated.".into()));
        }
        self.write_new(&format!("{} copy", record.name), record.data)
    }

    /// Renames a map file in a game folder, with the preview image the game keeps
    /// beside it.
    fn rename_game_file(&self, source: &Path, file_name: &str) -> Result<PathBuf, String> {
        let source = self.game_path(&Self::game_id(source))?;
        let target = source.with_file_name(safe_map_file_name(file_name)?);
        let same = |a: &Path, b: &Path| a.canonicalize().ok().is_some_and(|a| b.canonicalize().ok() == Some(a));
        if target.exists() && !same(&source, &target) {
            return Err(format!("A map named {} already exists.", display_name_for_map_file(file_name)));
        }
        fs::rename(&source, &target).map_err(|e| format!("Could not rename the map: {e}"))?;
        let (png, png_target) = (source.with_extension("png"), target.with_extension("png"));
        if png.is_file() && (!png_target.exists() || same(&png, &png_target)) {
            let _ = fs::rename(&png, &png_target);
        }
        Ok(target)
    }

    /// Gives a map a new name, which is its file name, so the returned record has
    /// a new id. A new map without a file only takes the name; `data` is its map.
    pub fn rename(&self, id: &str, name: &str, data: Option<Value>) -> Result<GameMapRecord, String> {
        let file_name = format!("{}.txt", map_file_stem(name)?);
        if let Some(current) = id.strip_prefix("new:") {
            if !current.eq_ignore_ascii_case(&file_name) && !self.name_is_free(&file_name) {
                return Err(format!("A map named {} already exists.", display_name_for_map_file(&file_name)));
            }
            let data = data.ok_or("The new map's contents are missing.")?;
            return Ok(Self::unsaved_record(&file_name, data));
        }
        let source = self.game_path(id)?;
        let current = source.file_name().unwrap().to_string_lossy().to_string();
        if current == file_name {
            return self.read(id);
        }
        if !current.eq_ignore_ascii_case(&file_name) && !self.name_is_free(&file_name) {
            return Err(format!("A map named {} already exists.", display_name_for_map_file(&file_name)));
        }
        let target = self.rename_game_file(&source, &file_name)?;
        self.read(&Self::game_id(&target))
    }

    pub fn read(&self, id: &str) -> Result<GameMapRecord, String> {
        let path = self.game_path(id)?;
        let file_name = path.file_name().unwrap().to_string_lossy().to_string();
        let result = read_gzip_json_file(&path).and_then(|mut data| {
            to_game_format(&mut data);
            validate_game_map_value(&data)?;
            validate_terrain(&data)?;
            Ok(data)
        });
        // A map the game can open but would refuse to play (a team without
        // units, say) is listed with what to fix.
        let (data, status, issue) = match result {
            Ok(data) => {
                let issue = validate_content(&data).err();
                (data, "published", issue)
            }
            Err(error) => (default_game_map_value(2)?, "invalid", Some(error)),
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
            game_file_path: path.is_file().then(|| path.to_string_lossy().into()),
        })
    }

    pub fn list(&self) -> Result<Vec<GameMapRecord>, String> {
        self.move_legacy_drafts();
        let mut maps = Vec::new();
        for root in &self.game_dirs {
            for entry in fs::read_dir(root).map_err(|e| e.to_string())?.flatten() {
                let path = entry.path();
                if !path.is_file()
                    || !path
                        .extension()
                        .and_then(|e| e.to_str())
                        .is_some_and(|e| e.eq_ignore_ascii_case("txt"))
                {
                    continue;
                }
                maps.push(self.read(&Self::game_id(&path))?);
            }
        }
        maps.sort_by(|a, b| {
            b.updated_at
                .cmp(&a.updated_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        Ok(maps)
    }

    /// Saves a map to the game. The editor sends the map's fields; fields it does
    /// not know about stay as the file has them. A new map (`new:` id) gets its
    /// file here. Nothing is written unless the whole map passes the check.
    pub fn save(&self, id: &str, data: Value) -> Result<GameMapRecord, String> {
        validate_game_map_value(&data)?;
        if let Some(file_name) = id.strip_prefix("new:") {
            return self.write_new(&display_name_for_map_file(file_name), data);
        }
        let target = self.game_path(id)?;
        let mut stored = read_gzip_json_file(&target).unwrap_or_else(|_| Value::Object(Default::default()));
        // The editor was given the stored map in the game's format, so the stored
        // copy is brought to it before the edits replace its fields; otherwise an
        // older `motorised` list would be added to the infantry a second time.
        to_game_format(&mut stored);
        let mut data = data;
        to_game_format(&mut data);
        if let (Some(existing), Some(incoming)) = (stored.as_object_mut(), data.as_object()) {
            existing.extend(incoming.clone());
        } else {
            stored = data;
        }
        validate_publish(&stored)?;
        write_gzip_json_file(&target, &stored)?;
        self.read(id)
    }

    pub fn delete(&self, ids: &[String]) -> Result<Vec<String>, String> {
        let mut paths = Vec::new();
        for id in ids {
            if id.starts_with("new:") {
                continue;
            }
            let game = self.game_path(id)?;
            if !game.exists() {
                continue;
            }
            let png = game.with_extension("png");
            if png.exists() {
                Self::check_parent(&png, game.parent().unwrap())?;
                paths.push(png);
            }
            paths.push(game);
        }
        for path in paths {
            fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
        Ok(ids.to_vec())
    }

    /// Moves drafts left by older versions into the game's map folder, once.
    /// A draft of a game map replaces that map; any other becomes a new map. Only
    /// drafts that pass the check are written. Each draft file is then moved into
    /// `moved` (written to the game) or `not-moved` (the game could not load it)
    /// beside it, so nothing is lost and none is moved twice.
    fn move_legacy_drafts(&self) {
        let Ok(entries) = fs::read_dir(&self.legacy_drafts) else { return };
        if self.game_dirs.is_empty() {
            return;
        }
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() || path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let moved = self.move_legacy_draft(&path);
            let folder = self.legacy_drafts.join(if moved { "moved" } else { "not-moved" });
            if fs::create_dir_all(&folder).is_ok() {
                let _ = fs::rename(&path, folder.join(entry.file_name()));
            }
        }
    }

    fn move_legacy_draft(&self, path: &Path) -> bool {
        let Some(mut draft) = fs::read(path).ok().and_then(|bytes| serde_json::from_slice::<LegacyDraft>(&bytes).ok()) else {
            return false;
        };
        to_game_format(&mut draft.data);
        if validate_publish(&draft.data).is_err() {
            return false;
        }
        let source = draft.source.filter(|source| source.is_file()).and_then(|source| self.game_path(&Self::game_id(&source)).ok());
        match source {
            Some(source) => {
                if read_gzip_json_file(&source).ok().as_ref() == Some(&draft.data) {
                    return true;
                }
                write_gzip_json_file(&source, &draft.data).is_ok()
            }
            None => self.write_new(&display_name_for_map_file(&draft.file_name), draft.data).is_ok(),
        }
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
        let mut map = default_game_map_value(2).unwrap();
        map["infantry"] = json!([[[100, 100]], [[1400, 800]]]);
        map["cities"] = json!([[200, 200], [1300, 700]]);
        map["capitals"] = json!([0, 1]);
        map["future_field"] = json!({"keep": true});
        map
    }

    fn game_files(store: &MapStore) -> usize {
        fs::read_dir(&store.game_dirs[0]).unwrap().count()
    }

    #[test]
    fn new_maps_have_no_file_until_a_valid_save() {
        let (_root, store) = store();
        let new = store.create("Island war", 2, false).unwrap();
        assert_eq!((new.status.as_str(), new.file_name.as_str()), ("unsaved", "Island war.txt"));
        assert!(new.id.starts_with("new:"));
        assert_eq!(game_files(&store), 0);
        // A map the game cannot play is refused and nothing is written.
        assert!(store.save(&new.id, new.data.clone()).unwrap_err().contains("needs at least one unit"));
        assert_eq!(game_files(&store), 0);
        let saved = store.save(&new.id, playable()).unwrap();
        assert_eq!(saved.status, "published");
        assert!(saved.id.starts_with("game:") && saved.file_path.ends_with("Island war.txt"));
        assert_eq!(read_gzip_json_file(Path::new(&saved.file_path)).unwrap(), playable());
        let large = store.create("Island war", 3, true).unwrap();
        assert_eq!(large.file_name, "Island war 2.txt");
        assert_eq!((large.width, large.height, large.team_count), (1920, 1080, 3));
    }

    #[test]
    fn saving_without_a_game_installation_fails_cleanly() {
        let root = tempfile::tempdir().unwrap();
        let store = MapStore::new(root.path().join("drafts"), vec![]).unwrap();
        let new = store.create("offline", 2, false).unwrap();
        assert!(store.save(&new.id, playable()).unwrap_err().contains("map folder was not found"));
        assert!(store.list().unwrap().is_empty());
    }

    #[test]
    fn invalid_edits_never_replace_the_game_file() {
        let (_root, store) = store();
        let saved = store.save(&store.create("test", 2, false).unwrap().id, playable()).unwrap();
        let path = PathBuf::from(&saved.file_path);
        let bytes = fs::read(&path).unwrap();
        let mut incomplete = playable();
        incomplete["infantry"] = json!([[], [[1400, 800]]]);
        assert!(store.save(&saved.id, incomplete).is_err());
        let mut outside = playable();
        outside["cities"] = json!([[5000, 5000]]);
        assert!(store.save(&saved.id, outside).is_err());
        assert_eq!(fs::read(&path).unwrap(), bytes);
        let mut changed = playable();
        changed["infantry"][0][0] = json!([250, 100]);
        store.save(&saved.id, changed.clone()).unwrap();
        assert_eq!(read_gzip_json_file(&path).unwrap(), changed);
        assert_eq!(store.list().unwrap().len(), 1);
    }

    #[test]
    fn saving_keeps_fields_the_editor_does_not_know() {
        let (_root, store) = store();
        let path = store.game_dirs[0].join("old.txt");
        write_gzip_json_file(&path, &playable()).unwrap();
        let mut edited = playable();
        edited.as_object_mut().unwrap().remove("future_field");
        edited["infantry"][0][0] = json!([300, 300]);
        store.save(&MapStore::game_id(&path), edited).unwrap();
        let written = read_gzip_json_file(&path).unwrap();
        assert_eq!(written["future_field"], json!({"keep": true}));
        assert_eq!(written["infantry"][0][0], json!([300, 300]));
    }

    #[test]
    fn imports_and_duplicates_go_to_the_game_only_when_valid() {
        let (_root, store) = store();
        let imported = store.import("Coast", playable()).unwrap();
        assert_eq!((imported.status.as_str(), imported.name.as_str()), ("published", "Coast"));
        let copy = store.duplicate(&imported.id).unwrap();
        assert_eq!(copy.file_name, "Coast copy.txt");
        assert_eq!(copy.data, imported.data);
        assert_eq!(store.duplicate(&imported.id).unwrap().file_name, "Coast copy 2.txt");
        let mut empty = playable();
        empty["infantry"] = json!([[], []]);
        assert!(store.import("Empty", empty).is_err());
        assert_eq!(game_files(&store), 3);
        assert_eq!(store.read(&imported.id).unwrap().data, playable());
    }

    #[test]
    fn malformed_and_unfinished_game_maps_are_listed_and_can_be_deleted() {
        let (_root, store) = store();
        for (name, malformed) in [("broken", true), ("empty", false)] {
            let path = store.game_dirs[0].join(format!("{name}.txt"));
            if malformed {
                fs::write(&path, b"broken gzip").unwrap();
            } else {
                write_gzip_json_file(&path, &default_game_map_value(2).unwrap()).unwrap();
            }
            let png = path.with_extension("png");
            fs::write(&png, b"original thumbnail").unwrap();
            let id = MapStore::game_id(&path);
            let entry = store.list().unwrap().into_iter().find(|m| m.id == id).unwrap();
            assert!(entry.issue.is_some());
            assert_eq!(entry.status == "invalid", malformed);
            assert!(store.duplicate(&id).is_err() || !malformed);
            store.delete(&[id]).unwrap();
            assert!(!path.exists());
            assert!(!png.exists());
        }
        assert!(store.list().unwrap().is_empty());
        assert_eq!(game_files(&store), 0);
    }

    #[test]
    fn publishing_rejects_bad_geometry_teams_capitals_and_png() {
        validate_publish(&playable()).unwrap();
        let mut legacy = playable();
        legacy["bridges"] = json!([[10, 10, 20, 20]]);
        validate_publish(&legacy).unwrap();
        for (key, value) in [
            ("infantry", json!([[], []])),
            ("tanks", json!([[]])),
            ("infantry", json!([[[100, 100]]])),
            ("tanks", json!([[], [], []])),
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
    fn maps_keep_only_fields_the_game_reads_and_shock_units_rejoin_the_infantry() {
        let (_root, store) = store();
        let mut old = playable();
        old["mode"] = json!("v4");
        // Five infantry and one shock unit: the shock unit becomes the last infantry,
        // which experiment matches turn back into a shock unit.
        old["infantry"] = json!([(0..5).map(|i| json!([100 + i, 100])).collect::<Vec<_>>(), [[1400, 800]]]);
        old["motorised"] = json!([[[50, 50]], []]);
        let path = store.game_dirs[0].join("old.txt");
        write_gzip_json_file(&path, &old).unwrap();
        let read = store.read(&MapStore::game_id(&path)).unwrap();
        assert!(read.data.get("mode").is_none() && read.data.get("motorised").is_none());
        assert_eq!(read.data["infantry"][0].as_array().unwrap().len(), 6);
        assert_eq!(read.data["infantry"][0][5], json!([50, 50]));
        assert_eq!(read.data["future_field"], json!({"keep": true}));
        // Saving the map as the editor read it does not add the shock unit again.
        let saved = store.save(&read.id, read.data.clone()).unwrap();
        let written = read_gzip_json_file(&path).unwrap();
        assert_eq!(written["infantry"], read.data["infantry"]);
        assert!(written.get("mode").is_none() && written.get("motorised").is_none());
        assert_eq!(saved.team_count, 2);
        // Counts that do not fit the rule add the shock units after the infantry.
        let mut uneven = playable();
        uneven["motorised"] = json!([[[1, 1], [2, 2]], []]);
        to_game_format(&mut uneven);
        assert_eq!(uneven["infantry"][0], json!([[100, 100], [1, 1], [2, 2]]));
    }

    #[test]
    fn ids_cannot_escape_storage_or_overwrite_an_unrelated_map() {
        let (root, store) = store();
        let outside = root.path().join("outside.txt");
        fs::write(&outside, b"keep").unwrap();
        let id = MapStore::game_id(&outside);
        assert!(store.delete(&[id.clone()]).is_err());
        assert!(store.save(&id, playable()).is_err());
        // A new map never takes the name of a map that appeared after it was made.
        let new = store.create("test", 2, false).unwrap();
        let taken = store.game_dirs[0].join(&new.file_name);
        fs::write(&taken, b"another map").unwrap();
        let saved = store.save(&new.id, playable()).unwrap();
        assert!(saved.file_path.ends_with("test 2.txt"));
        assert_eq!(fs::read(&taken).unwrap(), b"another map");
        assert_eq!(fs::read(&outside).unwrap(), b"keep");
    }

    #[test]
    fn renaming_moves_game_files_and_names_new_maps() {
        let (_root, store) = store();
        let new = store.create("test", 2, false).unwrap();
        let renamed = store.rename(&new.id, "  Coast / line  ", Some(new.data.clone())).unwrap();
        assert_eq!((renamed.id.as_str(), renamed.name.as_str()), ("new:Coast line.txt", "Coast line"));
        assert_eq!(game_files(&store), 0);
        let saved = store.save(&renamed.id, playable()).unwrap();
        let path = PathBuf::from(&saved.file_path);
        assert!(path.ends_with("Coast line.txt"));
        fs::write(path.with_extension("png"), b"thumbnail").unwrap();
        let moved = store.rename(&saved.id, "Coast", None).unwrap();
        let moved_path = PathBuf::from(&moved.file_path);
        assert!(moved_path.ends_with("Coast.txt") && !path.exists());
        assert_eq!(fs::read(moved_path.with_extension("png")).unwrap(), b"thumbnail");
        // Taken names and empty names are refused.
        store.import("Other", playable()).unwrap();
        assert!(store.rename(&moved.id, "other", None).unwrap_err().contains("already exists"));
        assert!(store.rename(&moved.id, "  ///  ", None).is_err());
        assert!(store.rename(&store.create("x", 2, false).unwrap().id, "Other", Some(playable())).is_err());
        assert_eq!(store.list().unwrap().len(), 2);
    }

    #[test]
    fn atomic_replacement_leaves_no_scanable_temporary_maps() {
        let (_root, store) = store();
        let path = store.game_dirs[0].join("map.txt");
        atomic_write(&path, b"old").unwrap();
        atomic_write(&path, b"new").unwrap();
        assert_eq!(fs::read(path).unwrap(), b"new");
        assert_eq!(game_files(&store), 1);
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
        store.delete(&[MapStore::game_id(&second.join("map.txt"))]).unwrap();
        assert!(store.game_dirs[0].join("map.txt").exists());
        assert!(!second.join("map.txt").exists());
    }

    #[test]
    fn old_drafts_move_into_the_game_once_and_invalid_ones_are_set_aside() {
        let (root, store) = store();
        let drafts = root.path().join("drafts");
        fs::create_dir(&drafts).unwrap();
        let game_map = store.game_dirs[0].join("Edited.txt");
        write_gzip_json_file(&game_map, &playable()).unwrap();
        let mut edit = playable();
        edit["infantry"][0][0] = json!([600, 600]);
        let write = |name: &str, value: Value| fs::write(drafts.join(name), serde_json::to_vec(&value).unwrap()).unwrap();
        write("map_edit.json", json!({"file_name": "Edited.txt", "source": game_map, "data": edit, "published": false}));
        write("map_new.json", json!({"file_name": "Fresh.txt", "source": null, "data": playable(), "published": false}));
        write("map_empty.json", json!({"file_name": "Empty.txt", "source": null, "data": default_game_map_value(2).unwrap(), "published": false}));
        fs::write(drafts.join("map_broken.json"), b"not json").unwrap();
        let maps = store.list().unwrap();
        assert_eq!(maps.len(), 2);
        assert_eq!(read_gzip_json_file(&game_map).unwrap()["infantry"][0][0], json!([600, 600]));
        assert!(store.game_dirs[0].join("Fresh.txt").is_file());
        assert!(!store.game_dirs[0].join("Empty.txt").exists());
        let names = |folder: &str| {
            let mut names: Vec<String> = fs::read_dir(drafts.join(folder)).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into()).collect();
            names.sort();
            names
        };
        assert_eq!(names("moved"), ["map_edit.json", "map_new.json"]);
        assert_eq!(names("not-moved"), ["map_broken.json", "map_empty.json"]);
        // Listing again moves nothing twice.
        assert_eq!(store.list().unwrap().len(), 2);
        assert_eq!(game_files(&store), 2);
    }
}
