use std::collections::{BTreeMap, HashMap, HashSet};
use std::env;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{self, Command};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use serde::de::{IgnoredAny, MapAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder,
    WindowEvent,
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

mod audio;
mod installed_maps;
mod maps;
mod export;
mod player;
mod video;
mod storage;
mod thumbnails;

use installed_maps::{InstalledMaps, SurfaceDigest};

const DEFAULT_STEAM_GAME_DIR: &str = r"C:\Program Files (x86)\Steam\steamapps\common\War of Dots";
const FPS: f64 = 30.0;
const GAME_DIR_NAME: &str = "War of Dots";
const DEFAULT_REPLAY_PAGE_SIZE: usize = 100;
const MAX_REPLAY_PAGE_SIZE: usize = 100;
const REPLAY_PLAYER_LABEL: &str = "replayPlayer";
const REPLAY_PLAYER_WIDTH: f64 = 960.0;
const REPLAY_PLAYER_HEIGHT: f64 = 540.0;
const REPLAY_BACKUP_DIR_NAME: &str = "replay-backups";
const REPLAY_INDEX_FILE_NAME: &str = "replay-index.json";
// Version 6 stores a digest of each embedded map instead of the image itself;
// version 7 records whether the replay carries the map deployment it needs.
const REPLAY_INDEX_VERSION: u32 = 7;
const REPLAY_THUMBNAIL_CACHE: &str = "replay-thumbnails";
// A listing prepared at startup is served to the window's first request.
const WARM_LISTING_LIFETIME: Duration = Duration::from_secs(20);

const CREATE_NO_WINDOW: u32 = 0x08000000;


#[derive(Default)]
struct ReplayMediaCatalog {
    thumbnails: Mutex<HashMap<String, ReplayThumbnailSource>>,
}

#[derive(Clone, Debug)]
enum ReplayThumbnailSource {
    // An embedded map, cached as `<key>.png` when the replay is indexed and
    // re-extracted from the replay if that file is gone.
    Embedded(PathBuf),
    File(PathBuf),
}

/// The replay index, kept in memory after the first listing so refreshes only
/// look at file metadata instead of re-reading the whole index file.
#[derive(Default)]
struct ReplayLibrary {
    index: Mutex<Option<ReplayIndexStore>>,
    warm: Mutex<Option<(Instant, ReplayListPayload)>>,
    // The latest indexing progress, for a window that starts listening late.
    progress: Mutex<Option<Value>>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CustomMapDigest {
    hash: String,
    #[serde(default)]
    decoded: bool,
}

impl CustomMapDigest {
    fn surface(&self) -> SurfaceDigest {
        SurfaceDigest { hash: self.hash.clone(), decoded: self.decoded }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlayerSummary {
    name: String,
    team_index: usize,
    winner: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReplaySummary {
    file_name: String,
    file_path: String,
    #[serde(default)]
    version: Option<String>,
    // The game's match format ("1v1", "2v2", "v3", "v4", "ffa", "experiment", "avalanche").
    #[serde(default)]
    mode: Option<String>,
    // Players per side; 2v2 replays list two usernames for each color.
    #[serde(default)]
    team_size: usize,
    players: Vec<PlayerSummary>,
    #[serde(default)]
    draw: bool,
    length: String,
    duration_seconds: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    thumbnail_data_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    thumbnail_key: Option<String>,
    modified: u64,
    score_delta: Option<i64>,
    #[serde(default)]
    event_label: Option<String>,
    #[serde(default)]
    map_key: Option<String>,
    #[serde(default)]
    map_label: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct ParsedReplay {
    summary: ReplaySummary,
    result: Option<Value>,
    map_id: Option<String>,
    // The embedded image is only held between parsing and indexing.
    #[serde(skip)]
    custom_map_surface: Option<String>,
    #[serde(default)]
    custom_map: Option<CustomMapDigest>,
    #[serde(default)]
    has_map: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GameMapRecord {
    id: String,
    file_name: String,
    file_path: String,
    name: String,
    data: Value,
    created_at: u64,
    updated_at: u64,
    width: u32,
    height: u32,
    team_count: usize,
    status: String,
    issue: Option<String>,
    game_file_path: Option<String>,
}

#[derive(Clone)]
struct ReplayCandidate {
    path: PathBuf,
    original_path: PathBuf,
    file_name: String,
    modified: u64,
    size: u64,
    known_hash: Option<String>,
    is_backup: bool,
    thumbnail_replay_dir: Option<PathBuf>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct ReplayIndexEntry {
    path_key: String,
    original_path: String,
    backup_path: String,
    file_name: String,
    modified: u64,
    size: u64,
    hash: String,
    parsed: Option<ParsedReplay>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct ReplayIndexStore {
    version: u32,
    entries: BTreeMap<String, ReplayIndexEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReplayListPayload {
    replays: Vec<ReplaySummary>,
    total_candidates: usize,
    has_more: bool,
    next_offset: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReplayThumbnailPath {
    thumbnail_key: String,
    file_path: String,
    data_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReplayUploadResult {
    file_name: String,
    replay_path: String,
    backup_path: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReplayLaunchRequest {
    file_name: String,
    file_path: String,
}

fn app_runtime_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    Ok(path)
}

fn system_time_millis(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn replay_backup_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let path = app_runtime_dir(app)?.join(REPLAY_BACKUP_DIR_NAME);
    fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    Ok(path)
}

fn replay_index_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_runtime_dir(app)?.join(REPLAY_INDEX_FILE_NAME))
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file =
        File::open(path).map_err(|error| format!("Could not open {}: {error}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];

    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }

    Ok(format!("{:x}", hasher.finalize()))
}

fn replay_backup_extension(path: &Path) -> String {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .filter(|extension| matches!(extension.as_str(), "rep" | "json"))
        .unwrap_or_else(|| "rep".to_string())
}

fn backup_path_for_hash(backup_dir: &Path, hash: &str, source_path: &Path) -> PathBuf {
    backup_dir.join(format!("{hash}.{}", replay_backup_extension(source_path)))
}

fn existing_backup_path(backup_dir: &Path, hash: &str) -> Option<PathBuf> {
    fs::read_dir(backup_dir)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .find(|path| {
            path.file_stem()
                .and_then(|stem| stem.to_str())
                .is_some_and(|stem| stem.eq_ignore_ascii_case(hash))
                && is_replay_file(path)
        })
}

/// Backup files by their lowercase hash, from one listing of the backup folder.
type BackupFiles = HashMap<String, PathBuf>;

fn backup_replay_file(
    source_path: &Path,
    hash: &str,
    backup_dir: &Path,
    known_backups: Option<&BackupFiles>,
) -> Result<PathBuf, String> {
    if source_path
        .parent()
        .is_some_and(|parent| path_key(parent) == path_key(backup_dir))
    {
        return Ok(source_path.to_path_buf());
    }

    let existing = match known_backups {
        Some(backups) => backups.get(&hash.to_ascii_lowercase()).cloned(),
        None => existing_backup_path(backup_dir, hash),
    };
    let target = existing.unwrap_or_else(|| backup_path_for_hash(backup_dir, hash, source_path));
    if !target.exists() {
        fs::copy(source_path, &target).map_err(|error| {
            format!(
                "Could not back up replay {} to {}: {error}",
                source_path.display(),
                target.display()
            )
        })?;
    }
    Ok(target)
}

fn candidate_file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("replay.rep")
        .to_string()
}

// Directory listings already carry size and times on Windows, so candidates are
// built from them instead of opening every replay.
fn replay_candidate_from_entry(
    entry: &fs::DirEntry,
    thumbnail_replay_dir: Option<PathBuf>,
    known_hash: Option<String>,
    is_backup: bool,
) -> Option<ReplayCandidate> {
    let path = entry.path();
    if !is_replay_file(&path) {
        return None;
    }
    let metadata = entry.metadata().ok()?;
    if !metadata.is_file() {
        return None;
    }
    Some(ReplayCandidate {
        path: path.clone(),
        original_path: path.clone(),
        file_name: candidate_file_name(&path),
        modified: metadata
            .modified()
            .ok()
            .and_then(system_time_to_secs)
            .unwrap_or(0),
        size: metadata.len(),
        known_hash,
        is_backup,
        thumbnail_replay_dir,
    })
}

fn replay_candidate_key(candidate: &ReplayCandidate) -> String {
    candidate
        .known_hash
        .as_deref()
        .map(|hash| format!("hash:{}", hash.to_ascii_lowercase()))
        .unwrap_or_else(|| format!("path:{}", path_key(&candidate.original_path)))
}

fn insert_candidate(
    candidates: &mut BTreeMap<String, ReplayCandidate>,
    candidate: ReplayCandidate,
) {
    let key = replay_candidate_key(&candidate);
    candidates
        .entry(key)
        .and_modify(|existing| {
            if existing.thumbnail_replay_dir.is_none() && candidate.thumbnail_replay_dir.is_some() {
                existing.thumbnail_replay_dir = candidate.thumbnail_replay_dir.clone();
            }
            if existing.is_backup && !candidate.is_backup {
                *existing = candidate.clone();
            } else if existing.is_backup == candidate.is_backup
                && candidate.modified > existing.modified
            {
                *existing = candidate.clone();
            }
        })
        .or_insert(candidate);
}

fn dedupe_replay_candidates_by_hash(
    candidates: Vec<ReplayCandidate>,
) -> (Vec<ReplayCandidate>, Vec<String>) {
    let mut deduped: BTreeMap<String, ReplayCandidate> = BTreeMap::new();
    let mut errors = Vec::new();

    for mut candidate in candidates {
        if candidate.known_hash.is_none() {
            match sha256_file(&candidate.path) {
                Ok(hash) => candidate.known_hash = Some(hash),
                Err(error) => {
                    errors.push(format!("Skipping {}: {error}", candidate.path.display()));
                    continue;
                }
            }
        }
        insert_candidate(&mut deduped, candidate);
    }

    let mut candidates = deduped.into_values().collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        right
            .modified
            .cmp(&left.modified)
            .then_with(|| left.file_name.cmp(&right.file_name))
    });
    (candidates, errors)
}

fn collect_replay_candidates(
    app: &AppHandle,
    replay_index: &ReplayIndexStore,
) -> Result<(Vec<ReplayCandidate>, BackupFiles), String> {
    let replay_dirs = discover_replay_dirs();
    let fallback_thumbnail_dir = replay_dirs.first().cloned();
    let mut candidates: BTreeMap<String, ReplayCandidate> = BTreeMap::new();

    for replay_dir in &replay_dirs {
        let entries = fs::read_dir(replay_dir).map_err(|error| {
            format!(
                "Could not read replay folder {}: {error}",
                replay_dir.display()
            )
        })?;

        for entry in entries.flatten() {
            if let Some(mut candidate) =
                replay_candidate_from_entry(&entry, Some(replay_dir.clone()), None, false)
            {
                if let Some(entry) = replay_index
                    .entries
                    .get(&path_key(&candidate.original_path))
                {
                    if replay_index_entry_matches_metadata(entry, &candidate) {
                        candidate.known_hash = Some(entry.hash.clone());
                    }
                }
                insert_candidate(&mut candidates, candidate);
            }
        }
    }

    let backup_dir = replay_backup_dir(app)?;
    let backup_entries = fs::read_dir(&backup_dir).map_err(|error| {
        format!(
            "Could not read replay backup folder {}: {error}",
            backup_dir.display()
        )
    })?;
    let mut backups = BackupFiles::new();
    for entry in backup_entries.flatten() {
        let backup_path = entry.path();
        let hash = backup_path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .filter(|stem| {
                stem.len() == 64 && stem.chars().all(|character| character.is_ascii_hexdigit())
            })
            .map(ToOwned::to_owned);
        if let Some(candidate) =
            replay_candidate_from_entry(&entry, fallback_thumbnail_dir.clone(), hash.clone(), true)
        {
            if let Some(hash) = hash {
                backups.entry(hash.to_ascii_lowercase()).or_insert(backup_path);
            }
            insert_candidate(&mut candidates, candidate);
        }
    }

    let mut candidates = candidates.into_values().collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        right
            .modified
            .cmp(&left.modified)
            .then_with(|| left.file_name.cmp(&right.file_name))
    });
    Ok((candidates, backups))
}

fn load_replay_index(path: &Path) -> ReplayIndexStore {
    let empty = || ReplayIndexStore {
        version: REPLAY_INDEX_VERSION,
        entries: BTreeMap::new(),
    };
    let Ok(bytes) = fs::read(path) else {
        return empty();
    };
    if let Ok(store) = serde_json::from_slice::<ReplayIndexStore>(&bytes) {
        if store.version == REPLAY_INDEX_VERSION {
            return store;
        }
    }
    // Summaries from another schema are rebuilt, but file hashes are still valid
    // and spare hashing every replay again.
    let Ok(mut value) = serde_json::from_slice::<Value>(&bytes) else {
        return empty();
    };
    let Some(entries) = value.get_mut("entries").and_then(Value::as_object_mut) else {
        return empty();
    };
    entries.retain(|_, entry| {
        entry.get("hash").and_then(Value::as_str).is_some_and(|hash| !hash.is_empty())
    });
    for entry in entries.values_mut() {
        if let Some(entry) = entry.as_object_mut() {
            entry.remove("parsed");
        }
    }
    value["version"] = json!(REPLAY_INDEX_VERSION);
    serde_json::from_value::<ReplayIndexStore>(value).unwrap_or_else(|_| empty())
}

fn write_replay_index(path: &Path, store: &ReplayIndexStore) -> Result<(), String> {
    let text = serde_json::to_vec(store).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, text)
        .map_err(|error| format!("Could not write {}: {error}", temporary.display()))?;
    fs::rename(&temporary, path)
        .map_err(|error| format!("Could not write {}: {error}", path.display()))
}

fn replay_index_entry_matches_metadata(
    entry: &ReplayIndexEntry,
    candidate: &ReplayCandidate,
) -> bool {
    entry.path_key == path_key(&candidate.original_path)
        && path_key_from_str(&entry.original_path) == path_key(&candidate.original_path)
        && entry.modified == candidate.modified
        && entry.size == candidate.size
}

fn replay_index_entry_matches(entry: &ReplayIndexEntry, candidate: &ReplayCandidate) -> bool {
    replay_index_entry_matches_metadata(entry, candidate)
        && entry
            .parsed
            .as_ref()
            .and_then(|parsed| parsed.summary.version.as_deref())
            .is_some_and(|version| !version.trim().is_empty())
}

fn parsed_replay_from_index(
    entry: &ReplayIndexEntry,
    candidate: &ReplayCandidate,
    backups: &BackupFiles,
) -> Option<ParsedReplay> {
    if !replay_index_entry_matches(entry, candidate) {
        return None;
    }

    let mut parsed = entry.parsed.clone()?;
    parsed.summary.file_name = candidate.file_name.clone();
    parsed.summary.modified = candidate.modified;
    parsed.summary.thumbnail_data_url = None;
    let backed_up = backups
        .get(&entry.hash.to_ascii_lowercase())
        .is_some_and(|path| path_key(path) == path_key_from_str(&entry.backup_path));
    parsed.summary.file_path = if backed_up {
        entry.backup_path.clone()
    } else {
        candidate.original_path.to_string_lossy().to_string()
    };
    Some(parsed)
}

fn parse_replay_candidate(
    candidate: &ReplayCandidate,
    backup_dir: &Path,
    backups: &BackupFiles,
) -> Result<(ParsedReplay, ReplayIndexEntry), String> {
    let hash = match candidate.known_hash.as_deref() {
        Some(hash) => hash.to_string(),
        None => sha256_file(&candidate.path)?,
    };
    let backup_path = backup_replay_file(&candidate.path, &hash, backup_dir, Some(backups))?;
    let mut parsed = parse_replay(&backup_path)?;
    // The index keeps only the embedded map's digest; thumbnails are made
    // from the replay when a card first needs one.
    parsed.custom_map_surface = None;
    parsed.summary.file_name = candidate.file_name.clone();
    parsed.summary.modified = candidate.modified;
    parsed.summary.file_path = backup_path.to_string_lossy().to_string();
    parsed.summary.thumbnail_data_url = None;

    let entry = ReplayIndexEntry {
        path_key: path_key(&candidate.original_path),
        original_path: candidate.original_path.to_string_lossy().to_string(),
        backup_path: backup_path.to_string_lossy().to_string(),
        file_name: candidate.file_name.clone(),
        modified: candidate.modified,
        size: candidate.size,
        hash,
        parsed: Some(parsed.clone()),
    };
    Ok((parsed, entry))
}

fn path_key_from_str(value: &str) -> String {
    value.replace('/', r"\").to_ascii_lowercase()
}

fn steam_game_dir() -> PathBuf {
    env::var_os("WOD_STEAM_GAME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(DEFAULT_STEAM_GAME_DIR))
}

#[cfg(test)]
fn png_data_url(path: &Path) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    Some(format!("data:image/png;base64,{}", BASE64.encode(bytes)))
}

fn sha256_text(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn media_cache_dir(app: &AppHandle, category: &str) -> Result<PathBuf, String> {
    let path = app_runtime_dir(app)?.join("media-cache").join(category);
    fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    Ok(path)
}

fn cache_media_file(app: &AppHandle, category: &str, source: &Path) -> Result<PathBuf, String> {
    let metadata = fs::metadata(source)
        .map_err(|error| format!("Could not inspect {}: {error}", source.display()))?;
    if !metadata.is_file() {
        return Err(format!("Media file does not exist: {}", source.display()));
    }
    let signature = format!(
        "{}|{}|{}",
        path_key(source),
        metadata.len(),
        metadata.modified().map(system_time_millis).unwrap_or(0)
    );
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| {
            value
                .chars()
                .all(|character| character.is_ascii_alphanumeric())
        })
        .unwrap_or("bin");
    let destination =
        media_cache_dir(app, category)?.join(format!("{}.{}", sha256_text(&signature), extension));
    let current_length = fs::metadata(&destination).ok().map(|value| value.len());
    if current_length != Some(metadata.len()) {
        fs::copy(source, &destination).map_err(|error| {
            format!(
                "Could not cache media {} as {}: {error}",
                source.display(),
                destination.display()
            )
        })?;
    }
    Ok(destination)
}

fn discover_replay_dirs() -> Vec<PathBuf> {
    let mut replay_dirs = discover_steamapps_dirs()
        .into_iter()
        .map(|steamapps| steamapps.join("common").join(GAME_DIR_NAME).join("replays"))
        .filter(|path| path.is_dir())
        .fold(Vec::new(), |mut replay_dirs, path| {
            push_unique_path(&mut replay_dirs, path);
            replay_dirs
        });
    let configured_replay_dir = steam_game_dir().join("replays");
    if configured_replay_dir.is_dir() {
        push_unique_path(&mut replay_dirs, configured_replay_dir);
    }
    replay_dirs
}

fn primary_replay_dir() -> Result<PathBuf, String> {
    if let Some(path) = discover_replay_dirs().into_iter().next() {
        return Ok(path);
    }

    let mut game_dirs = discover_steamapps_dirs()
        .into_iter()
        .map(|steamapps| steamapps.join("common").join(GAME_DIR_NAME))
        .filter(|path| path.is_dir())
        .collect::<Vec<_>>();
    let configured_game_dir = steam_game_dir();
    if configured_game_dir.is_dir()
        && !game_dirs
            .iter()
            .any(|path| path_key(path) == path_key(&configured_game_dir))
    {
        game_dirs.push(configured_game_dir);
    }

    let game_dir = game_dirs
        .into_iter()
        .next()
        .ok_or_else(|| "War of Dots installation folder was not found.".to_string())?;
    let replay_dir = game_dir.join("replays");
    fs::create_dir_all(&replay_dir).map_err(|error| {
        format!(
            "Could not create replay folder {}: {error}",
            replay_dir.display()
        )
    })?;
    Ok(replay_dir)
}

fn discover_map_editor_dirs() -> Vec<PathBuf> {
    let mut map_dirs = discover_steamapps_dirs()
        .into_iter()
        .map(|steamapps| {
            steamapps
                .join("common")
                .join(GAME_DIR_NAME)
                .join("map_editor")
        })
        .filter(|path| path.is_dir())
        .fold(Vec::new(), |mut map_dirs, path| {
            push_unique_path(&mut map_dirs, path);
            map_dirs
        });
    let configured_map_dir = steam_game_dir().join("map_editor");
    if configured_map_dir.is_dir() {
        push_unique_path(&mut map_dirs, configured_map_dir);
    }
    map_dirs
}

fn safe_map_file_name(file_name: &str) -> Result<String, String> {
    let name = file_name.trim();
    if name.is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name == "."
        || name == ".."
        || !name.to_ascii_lowercase().ends_with(".txt")
    {
        return Err("Map filename must be a .txt file in War of Dots map_editor.".to_string());
    }
    Ok(name.to_string())
}

fn read_gzip_json_file(path: &Path) -> Result<Value, String> {
    let file =
        File::open(path).map_err(|error| format!("Could not open {}: {error}", path.display()))?;
    let mut decoder = GzDecoder::new(file);
    let mut text = String::new();
    decoder
        .read_to_string(&mut text)
        .map_err(|error| format!("Could not decompress {}: {error}", path.display()))?;
    serde_json::from_str(&text)
        .map_err(|error| format!("Map JSON is invalid in {}: {error}", path.display()))
}

fn write_gzip_json_file(path: &Path, value: &Value) -> Result<(), String> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    let text = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    encoder
        .write_all(&text)
        .map_err(|error| format!("Could not compress map JSON: {error}"))?;
    let bytes = encoder
        .finish()
        .map_err(|error| format!("Could not finish map gzip stream: {error}"))?;
    maps::atomic_write(path, &bytes)
}

fn png_dimensions_from_base64(base64_png: &str) -> Option<(u32, u32)> {
    let bytes = BASE64.decode(base64_png.trim().as_bytes()).ok()?;
    if bytes.len() < 24 || bytes.get(0..8)? != b"\x89PNG\r\n\x1a\n" {
        return None;
    }
    let width = u32::from_be_bytes(bytes.get(16..20)?.try_into().ok()?);
    let height = u32::from_be_bytes(bytes.get(20..24)?.try_into().ok()?);
    (width > 0 && height > 0).then_some((width, height))
}

fn map_team_count(data: &Value) -> usize {
    let infantry = data
        .get("infantry")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    let tanks = data
        .get("tanks")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    let motorised = data.get("motorised").and_then(Value::as_array).map(Vec::len).unwrap_or(0);
    infantry.max(tanks).max(motorised).clamp(2, 4)
}

fn map_dimensions(data: &Value) -> (u32, u32) {
    data.get("map_surface")
        .and_then(Value::as_str)
        .and_then(png_dimensions_from_base64)
        .unwrap_or((960, 540))
}

fn mode_team_count(mode: &str) -> usize {
    match mode.trim().to_ascii_lowercase().as_str() {
        "v3" | "3pffa" | "3p ffa" => 3,
        "v4" | "4pffa" | "4p ffa" | "ffa" => 4,
        _ => 2,
    }
}

fn solid_map_surface_base64(width: u32, height: u32) -> Result<String, String> {
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, width, height);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .map_err(|error| format!("Could not create default map PNG: {error}"))?;
        let mut pixels = vec![0u8; (width as usize) * (height as usize) * 3];
        for chunk in pixels.chunks_exact_mut(3) {
            chunk[0] = 0xA1;
            chunk[1] = 0xC2;
            chunk[2] = 0x46;
        }
        writer
            .write_image_data(&pixels)
            .map_err(|error| format!("Could not write default map PNG: {error}"))?;
    }
    Ok(BASE64.encode(bytes))
}

fn default_game_map_value(mode: &str) -> Result<Value, String> {
    let mode = match mode.trim().to_ascii_lowercase().as_str() {
        "v3" => "v3",
        "v4" => "v4",
        _ => "1v1",
    };
    let team_count = mode_team_count(mode);
    Ok(json!({
        "map_surface": solid_map_surface_base64(960, 540)?,
        "mode": mode,
        "infantry": vec![Vec::<Value>::new(); team_count],
        "tanks": vec![Vec::<Value>::new(); team_count],
        "motorised": vec![Vec::<Value>::new(); team_count],
        "cities": Vec::<Value>::new(),
        "capitals": Vec::<Value>::new(),
        "bridges": Vec::<Value>::new(),
    }))
}

fn display_name_for_map_file(file_name: &str) -> String {
    file_name
        .strip_suffix(".txt")
        .unwrap_or(file_name)
        .replace('_', " ")
}

fn safe_map_name_slug(name: &str) -> String {
    let slug = name
        .trim()
        .chars()
        .filter_map(|character| {
            if character.is_ascii_alphanumeric() {
                Some(character.to_ascii_lowercase())
            } else if matches!(character, ' ' | '-' | '_') {
                Some('_')
            } else {
                None
            }
        })
        .collect::<String>();
    slug.trim_matches('_').chars().take(32).collect()
}

fn validate_game_map_value(value: &Value) -> Result<(), String> {
    if !value.is_object() {
        return Err("Map data must be a JSON object.".to_string());
    }
    for key in ["map_surface", "mode"] {
        if value.get(key).and_then(Value::as_str).is_none() {
            return Err(format!("Map data is missing string field {key}."));
        }
    }
    for key in ["infantry", "tanks", "cities", "capitals", "bridges"] {
        if value.get(key).and_then(Value::as_array).is_none() {
            return Err(format!("Map data is missing array field {key}."));
        }
    }
    if value
        .get("map_surface")
        .and_then(Value::as_str)
        .and_then(png_dimensions_from_base64)
        .is_none()
    {
        return Err("Map surface must be a base64 PNG image.".to_string());
    }
    Ok(())
}

fn discover_steamapps_dirs() -> Vec<PathBuf> {
    let mut steam_roots = discover_steam_roots();
    let mut steamapps_dirs = Vec::new();

    for root in &steam_roots {
        push_steamapps_candidate(&mut steamapps_dirs, root);
    }

    for root in steam_roots.drain(..) {
        let library_config = root.join("steamapps").join("libraryfolders.vdf");
        let Ok(config) = fs::read_to_string(library_config) else {
            continue;
        };

        for library_root in parse_steam_library_paths(&config) {
            push_steamapps_candidate(&mut steamapps_dirs, &library_root);
        }
    }

    for drive in b'A'..=b'Z' {
        let drive_root = format!("{}:\\", drive as char);
        for candidate in [
            PathBuf::from(&drive_root).join("Steam"),
            PathBuf::from(&drive_root).join("SteamLibrary"),
        ] {
            push_steamapps_candidate(&mut steamapps_dirs, &candidate);
        }
    }

    steamapps_dirs
}

fn discover_steam_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();

    #[cfg(windows)]
    for root in registry_steam_roots() {
        push_unique_path(&mut roots, root);
    }

    for var_name in ["STEAM_DIR", "STEAM_PATH", "SteamPath"] {
        if let Some(path) = env::var_os(var_name) {
            push_unique_path(&mut roots, PathBuf::from(path));
        }
    }

    for var_name in ["ProgramFiles(x86)", "ProgramFiles"] {
        if let Some(path) = env::var_os(var_name) {
            push_unique_path(&mut roots, PathBuf::from(path).join("Steam"));
        }
    }

    if let Some(system_drive) = env::var_os("SystemDrive") {
        push_unique_path(&mut roots, PathBuf::from(system_drive).join("Steam"));
    }

    push_unique_path(&mut roots, PathBuf::from(r"C:\Steam"));
    roots
}

#[cfg(windows)]
fn registry_steam_roots() -> Vec<PathBuf> {
    use winreg::{
        enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE},
        RegKey,
    };

    let mut roots = Vec::new();
    let probes = [
        (HKEY_CURRENT_USER, r"Software\Valve\Steam", "SteamPath"),
        (
            HKEY_LOCAL_MACHINE,
            r"SOFTWARE\WOW6432Node\Valve\Steam",
            "InstallPath",
        ),
        (HKEY_LOCAL_MACHINE, r"SOFTWARE\Valve\Steam", "InstallPath"),
    ];

    for (hive, key_path, value_name) in probes {
        let key = RegKey::predef(hive);
        let Ok(steam_key) = key.open_subkey(key_path) else {
            continue;
        };
        let Ok(value) = steam_key.get_value::<String, _>(value_name) else {
            continue;
        };

        push_unique_path(&mut roots, PathBuf::from(value.replace('/', r"\")));
    }

    roots
}

fn push_steamapps_candidate(steamapps_dirs: &mut Vec<PathBuf>, candidate: &Path) {
    if candidate
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("steamapps"))
        && candidate.is_dir()
    {
        push_unique_path(steamapps_dirs, candidate.to_path_buf());
        return;
    }

    let steamapps = candidate.join("steamapps");
    if steamapps.is_dir() {
        push_unique_path(steamapps_dirs, steamapps);
    }
}

fn parse_steam_library_paths(config: &str) -> Vec<PathBuf> {
    let mut paths = Vec::new();

    for line in config.lines() {
        let quoted = quoted_vdf_values(line);
        if quoted.len() < 2 {
            continue;
        }

        let path = if quoted[0] == "path" {
            Some(&quoted[1])
        } else if quoted[0].parse::<usize>().is_ok() && looks_like_path(&quoted[1]) {
            Some(&quoted[1])
        } else {
            None
        };

        if let Some(path) = path {
            push_unique_path(&mut paths, PathBuf::from(path.replace('/', r"\")));
        }
    }

    paths
}

fn quoted_vdf_values(line: &str) -> Vec<String> {
    line.split('"')
        .enumerate()
        .filter_map(|(index, value)| {
            (index % 2 == 1).then(|| value.replace(r"\\", r"\").replace(r#"\""#, r#"""#))
        })
        .collect()
}

fn looks_like_path(value: &str) -> bool {
    value.contains(":\\") || value.contains(":/") || value.starts_with(r"\\")
}

fn push_unique_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    let key = path_key(&path);
    if paths.iter().any(|existing| path_key(existing) == key) {
        return;
    }

    paths.push(path);
}

fn path_key(path: &Path) -> String {
    path.to_string_lossy()
        .replace('/', r"\")
        .to_ascii_lowercase()
}

#[derive(Clone, Debug)]
struct HomePlayerCandidate {
    normalized_name: String,
    replay_count: usize,
    first_seen: usize,
}

fn home_player_candidates(replays: &[ParsedReplay]) -> Vec<HomePlayerCandidate> {
    let mut counts: HashMap<String, HomePlayerCandidate> = HashMap::new();
    let mut next_first_seen = 0;

    for replay in replays {
        let mut seen_in_replay = HashSet::new();
        for player in &replay.summary.players {
            if is_fallback_player_name(&player.name) {
                continue;
            }

            let key = player.name.to_ascii_lowercase();
            if !seen_in_replay.insert(key.clone()) {
                continue;
            }

            let entry = counts.entry(key.clone()).or_insert_with(|| {
                let first_seen = next_first_seen;
                next_first_seen += 1;
                HomePlayerCandidate {
                    normalized_name: key,
                    replay_count: 0,
                    first_seen,
                }
            });
            entry.replay_count += 1;
        }
    }

    let mut candidates = counts.into_values().collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        right
            .replay_count
            .cmp(&left.replay_count)
            .then_with(|| left.first_seen.cmp(&right.first_seen))
    });
    candidates.truncate(3);
    candidates
}

fn replay_home_player(
    players: &[PlayerSummary],
    candidates: &[HomePlayerCandidate],
) -> Option<String> {
    if team_count(players) != 2 {
        return None;
    }

    let eligible = players
        .iter()
        .filter_map(|player| {
            candidates
                .iter()
                .find(|candidate| candidate.normalized_name.eq_ignore_ascii_case(&player.name))
                .map(|candidate| (player, candidate.replay_count))
        })
        .collect::<Vec<_>>();

    // The player seen in the most replays, when no one else ties.
    let most = eligible.iter().map(|(_, count)| *count).max()?;
    match eligible.iter().filter(|(_, count)| *count == most).collect::<Vec<_>>().as_slice() {
        [(player, _)] => Some(player.name.clone()),
        _ => None,
    }
}

fn team_count(players: &[PlayerSummary]) -> usize {
    players.iter().map(|player| player.team_index).collect::<HashSet<_>>().len()
}

fn is_fallback_player_name(name: &str) -> bool {
    let Some(number) = name.strip_prefix("Player ") else {
        return false;
    };

    number.parse::<usize>().is_ok()
}

/// Lists the home player's team first, with the home player first in it.
fn put_home_player_first(players: &mut [PlayerSummary], home_player: &str) {
    let Some(home_team) = home_team_index(players, Some(home_player)) else {
        return;
    };
    players.sort_by_key(|player| {
        (player.team_index != home_team, !player.name.eq_ignore_ascii_case(home_player))
    });
}

fn is_replay_file(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| matches!(extension.to_ascii_lowercase().as_str(), "rep" | "json"))
        .unwrap_or(false)
}

fn parse_replay(path: &Path) -> Result<ParsedReplay, String> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    let json_bytes = if bytes.starts_with(&[0x1f, 0x8b]) {
        let mut decoder = GzDecoder::new(bytes.as_slice());
        let mut decoded = Vec::new();
        decoder
            .read_to_end(&mut decoded)
            .map_err(|error| error.to_string())?;
        decoded
    } else {
        bytes
    };

    let (raw, end_frame) = match serde_json::from_slice::<ReplayHeader>(&json_bytes) {
        Ok(header) => {
            let raw = Value::Object(header.fields);
            let end_frame = raw.get("end").and_then(Value::as_f64).unwrap_or(header.last_frame);
            (raw, end_frame)
        }
        Err(_) => {
            let raw: Value = serde_json::from_slice(&json_bytes).map_err(|error| error.to_string())?;
            let end_frame = replay_end_frame(&raw);
            (raw, end_frame)
        }
    };
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("replay")
        .to_string();
    let modified = path
        .metadata()
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(system_time_to_secs)
        .unwrap_or(0);
    let players: Vec<PlayerSummary> = replay_players(&raw)
        .into_iter()
        .map(|(team_index, name)| PlayerSummary {
            name,
            team_index,
            winner: false,
        })
        .collect();

    let duration_seconds = duration_seconds(end_frame);
    let custom_map_surface = custom_map_surface(&raw);
    let custom_map = custom_map_surface.as_deref().map(|surface| {
        let digest = SurfaceDigest::of(surface);
        CustomMapDigest { hash: digest.hash, decoded: digest.decoded }
    });
    let result = raw.get("result").cloned();

    Ok(ParsedReplay {
        summary: ReplaySummary {
            file_name,
            file_path: path.to_string_lossy().to_string(),
            version: raw
                .get("version")
                .and_then(Value::as_str)
                .map(str::to_string),
            mode: raw.get("mode").and_then(Value::as_str).map(str::to_string),
            team_size: replay_team_size(&raw),
            players,
            draw: result.as_ref().is_some_and(replay_result_is_draw),
            length: format_duration_seconds(duration_seconds),
            duration_seconds,
            thumbnail_data_url: None,
            thumbnail_key: None,
            modified,
            score_delta: None,
            event_label: None,
            map_key: None,
            map_label: None,
        },
        result,
        map_id: replay_map_id(&raw),
        custom_map_surface,
        custom_map,
        has_map: raw.get("map").is_some(),
    })
}

/// The fields a replay summary needs. Replays are mostly per-frame orders
/// keyed by frame number; those are skipped without building values, and
/// only the highest frame number is kept.
struct ReplayHeader {
    fields: serde_json::Map<String, Value>,
    last_frame: f64,
}

impl<'de> Deserialize<'de> for ReplayHeader {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct HeaderVisitor;

        impl<'de> Visitor<'de> for HeaderVisitor {
            type Value = ReplayHeader;

            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("a replay object")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<ReplayHeader, A::Error> {
                let mut fields = serde_json::Map::new();
                let mut last_frame = 0.0;
                while let Some(key) = map.next_key::<String>()? {
                    match key.as_str() {
                        "version" | "mode" | "player_usernames" | "result" | "end" | "map"
                        | "custom_map" => {
                            fields.insert(key, map.next_value::<Value>()?);
                        }
                        _ => {
                            if let Ok(frame) = key.parse::<f64>() {
                                last_frame = f64::max(last_frame, frame);
                            }
                            map.next_value::<IgnoredAny>()?;
                        }
                    }
                }
                Ok(ReplayHeader { fields, last_frame })
            }
        }

        deserializer.deserialize_map(HeaderVisitor)
    }
}

fn installed_map_catalog() -> InstalledMaps {
    InstalledMaps::read(game_install_candidates())
}

fn game_install_candidates() -> Vec<PathBuf> {
    let mut roots = discover_steamapps_dirs().into_iter()
        .map(|steamapps| steamapps.join("common").join(GAME_DIR_NAME))
        .collect::<Vec<_>>();
    push_unique_path(&mut roots, steam_game_dir());
    roots
}

/// Installed game folders, used only to read official map images for replay simulation.
pub(crate) fn installed_game_dirs() -> Vec<PathBuf> {
    game_install_candidates().into_iter().filter(|root| root.join("assets").is_dir()).collect()
}

fn refresh_replay_map_label(replay: &mut ParsedReplay, maps: &InstalledMaps) {
    let surface = replay.custom_map.as_ref().map(CustomMapDigest::surface);
    replay.summary.event_label =
        maps.event_label_for(replay.map_id.as_deref(), surface.as_ref(), replay.has_map);
    let identity = maps.identity_for(replay.map_id.as_deref(), surface.as_ref());
    replay.summary.map_key = identity.as_ref().map(|(key, _)| key.clone());
    replay.summary.map_label = identity.map(|(_, label)| label);
}

#[cfg(test)]
fn replay_event_label(raw: &Value) -> Option<String> {
    InstalledMaps::default().event_label(
        replay_map_id(raw).as_deref(), custom_map_surface(raw).as_deref(), raw.get("map").is_some(),
    )
}

/// Every player with their team (side) index. Teams list their members
/// (`[[{username}, {username}], …]` in 2v2), so each teammate is a player of their own.
fn replay_players(raw: &Value) -> Vec<(usize, String)> {
    let mut players = Vec::new();
    let sides = raw.get("player_usernames").and_then(Value::as_array).cloned().unwrap_or_default();
    for (team, side) in sides.iter().take(4).enumerate() {
        let members = match side {
            Value::Array(members) if !members.is_empty() => members.iter().collect::<Vec<_>>(),
            _ => vec![side],
        };
        for member in members {
            let name = clean_player_name(&flatten_name(member), players.len());
            players.push((team, name));
        }
    }
    for team in sides.len().min(4)..2 {
        players.push((team, fallback_player_name(players.len())));
    }
    players
}

fn replay_team_size(raw: &Value) -> usize {
    raw.get("player_usernames")
        .and_then(Value::as_array)
        .map(|sides| {
            sides
                .iter()
                .map(|side| side.as_array().map_or(1, Vec::len))
                .max()
                .unwrap_or(1)
        })
        .unwrap_or(1)
        .max(1)
}

fn flatten_name(value: &Value) -> String {
    match value {
        Value::Array(values) => values
            .iter()
            .map(flatten_name)
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" / "),
        Value::Object(object) => ["username", "name", "display_name", "displayName"]
            .iter()
            .find_map(|key| object.get(*key).map(flatten_name))
            .filter(|part| !part.is_empty())
            .unwrap_or_default(),
        Value::String(text) => text.trim().to_string(),
        Value::Number(number) => number.to_string(),
        Value::Bool(flag) => flag.to_string(),
        Value::Null => String::new(),
    }
}

fn clean_player_name(name: &str, index: usize) -> String {
    let trimmed = name.trim();
    let without_badge = trimmed
        .rfind(" [")
        .filter(|_| trimmed.ends_with(']'))
        .map(|index| &trimmed[..index])
        .unwrap_or(trimmed)
        .trim();

    if without_badge.is_empty() {
        fallback_player_name(index)
    } else {
        without_badge.to_string()
    }
}

fn fallback_player_name(index: usize) -> String {
    format!("Player {}", index + 1)
}

/// Marks every player of the winning team.
fn mark_winner(players: &mut [PlayerSummary], winning_team: Option<usize>) {
    for player in players.iter_mut() {
        player.winner = winning_team == Some(player.team_index);
    }
}

fn replay_result_is_draw(result: &Value) -> bool {
    result.as_f64() == Some(0.5)
}

/// The winning team's index.
fn replay_winner_team(
    result: Option<&Value>,
    players: &[PlayerSummary],
    home_player: Option<&str>,
) -> Option<usize> {
    if let Some(result) = result {
        if replay_result_is_draw(result) {
            return None;
        }
        if let Some(index) = result_player_name_index(result, players) {
            return Some(index);
        }
        if let Some(index) = result_special_winner_index(result, players, home_player) {
            return Some(index);
        }
    }

    None
}

fn result_player_name_index(result: &Value, players: &[PlayerSummary]) -> Option<usize> {
    let text = result.as_str()?;
    let normalized = clean_player_name(text, 0).to_ascii_lowercase();

    players
        .iter()
        .find(|player| player.name.to_ascii_lowercase() == normalized)
        .map(|player| player.team_index)
}

fn result_special_winner_index(
    result: &Value,
    players: &[PlayerSummary],
    home_player: Option<&str>,
) -> Option<usize> {
    if let Some(flag) = result.as_bool() {
        return result_flag_winner_index(flag, players, home_player);
    }

    if result.is_number() {
        return match result.as_f64() {
            Some(1.0) => result_flag_winner_index(true, players, home_player),
            Some(0.0) => result_flag_winner_index(false, players, home_player),
            _ => None,
        };
    }

    let text = result.as_str()?;
    let index = text.parse::<i64>().ok()?;
    match index {
        1 => result_flag_winner_index(true, players, home_player),
        0 => result_flag_winner_index(false, players, home_player),
        _ => None,
    }
}

fn result_flag_winner_index(
    home_won: bool,
    players: &[PlayerSummary],
    home_player: Option<&str>,
) -> Option<usize> {
    if players.is_empty() {
        return None;
    }

    let home_team = home_team_index(players, home_player)?;

    if home_won {
        return Some(home_team);
    }

    // With two teams, the other one won.
    if team_count(players) == 2 {
        return players.iter().map(|player| player.team_index).find(|team| *team != home_team);
    }

    None
}

fn home_team_index(players: &[PlayerSummary], home_player: Option<&str>) -> Option<usize> {
    home_player.and_then(|home_player| {
        players
            .iter()
            .find(|player| player.name.eq_ignore_ascii_case(home_player))
            .map(|player| player.team_index)
    })
}

fn replay_end_frame(raw: &Value) -> f64 {
    raw.get("end").and_then(Value::as_f64).unwrap_or_else(|| {
        raw.as_object()
            .map(|object| {
                object
                    .keys()
                    .filter_map(|key| key.parse::<f64>().ok())
                    .fold(0.0, f64::max)
            })
            .unwrap_or(0.0)
    })
}

fn duration_seconds(frame: f64) -> u64 {
    (frame / FPS).floor().max(0.0) as u64
}

fn format_duration_seconds(total_seconds: u64) -> String {
    let minutes = total_seconds / 60;
    let seconds = total_seconds % 60;
    format!("{minutes:02}:{seconds:02}")
}

fn replay_map_id(raw: &Value) -> Option<String> {
    let map = raw.get("map")?;
    let id = match map {
        Value::String(text) => text.trim().to_string(),
        Value::Number(number) => number.to_string(),
        Value::Object(map) => map.get("path")?.as_str()?.trim().replace('\\', "/"),
        _ => return None,
    };

    (!id.is_empty() && id != "custom").then_some(id)
}

fn custom_map_surface(raw: &Value) -> Option<String> {
    raw.get("custom_map")
        .filter(|map| map.is_object())
        .or_else(|| raw.get("map").filter(|map| map.is_object()))
        .and_then(|custom_map| custom_map.get("map_surface"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|surface| !surface.is_empty())
        .map(ToOwned::to_owned)
}

fn thumbnail_source_for_replay(
    replay_dir: &Path,
    replay: &ParsedReplay,
) -> Option<(String, ReplayThumbnailSource)> {
    if let Some(custom) = replay.custom_map.as_ref() {
        // An embedded image that is not valid base64 has nothing to show.
        return custom.decoded.then(|| {
            (
                embedded_thumbnail_key(&custom.hash),
                ReplayThumbnailSource::Embedded(PathBuf::from(&replay.summary.file_path)),
            )
        });
    }

    let map_id = replay.map_id.as_deref()?;
    let game_root = replay_dir.parent()?;
    let path = map_image_path(game_root, map_id)?;
    let metadata = path.metadata().ok()?;
    let modified = metadata.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_nanos();
    let key = format!("map-{}", sha256_text(&format!("{}:{}:{modified}", path_key(&path), metadata.len())));
    Some((key, ReplayThumbnailSource::File(path)))
}

fn map_image_path(game_root: &Path, map_id: &str) -> Option<PathBuf> {
    let normalized = map_id.replace('\\', "/");
    if normalized.ends_with(".png") {
        // Replays are untrusted. Only relative map image paths within the game are allowed.
        if normalized.split('/').any(|part| part.is_empty() || part == "." || part == ".." || part.contains(':'))
            || !(normalized.starts_with("assets/") || normalized.starts_with("map_editor/")) {
            return None;
        }
        let root = game_root.canonicalize().ok()?;
        let path = root.join(normalized).canonicalize().ok()?;
        return (path.starts_with(&root) && path.is_file()).then_some(path);
    }
    if normalized.is_empty() || !normalized.chars().all(|c| c.is_ascii_digit()) { return None; }
    let file_name = format!("map{normalized}.png");
    let assets = game_root.join("assets");
    [assets.join("fahero_maps").join(&file_name),
     assets.join("zolamare_maps").join(&file_name),
     assets.join("eronion_maps").join(&file_name),
     game_root.join("map_editor").join(format!("generated_map{normalized}.png"))]
        .into_iter().find(|path| path.is_file())
}

#[cfg(test)]
fn map_image_data_url(game_root: &Path, map_id: &str) -> Option<String> {
    map_image_path(game_root, map_id).and_then(|path| png_data_url(&path))
}

fn system_time_to_secs(time: SystemTime) -> Option<u64> {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_secs())
}

fn launch_request_path(app: &AppHandle, launch_id: &str) -> Result<PathBuf, String> {
    if launch_id.is_empty()
        || !launch_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err("Invalid launch id.".to_string());
    }
    let root = app_runtime_dir(app)?.join("replay-launches");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root.join(format!("{launch_id}.json")))
}

fn current_launch_request_path(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app_runtime_dir(app)?.join("replay-launches");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root.join("current.json"))
}

#[tauri::command]
fn recording_default_directory(app: AppHandle) -> Result<PathBuf, String> {
    let videos_dir = app
        .path()
        .video_dir()
        .map_err(|error| format!("Windows Videos folder is unavailable: {error}"))?;
    fs::create_dir_all(&videos_dir)
        .map_err(|error| format!("Could not prepare {}: {error}", videos_dir.display()))?;
    Ok(videos_dir)
}

#[tauri::command]
fn open_recording_output_directory(output_path: String) -> Result<bool, String> {
    let output_path = PathBuf::from(output_path);
    if !output_path.is_file() {
        return Err(format!(
            "Recorded video was not found: {}",
            output_path.display()
        ));
    }
    let directory = output_path
        .parent()
        .ok_or_else(|| "Recorded video has no output folder.".to_string())?;
    let mut command = Command::new("explorer.exe");
    command.arg(directory);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
        .spawn()
        .map_err(|error| format!("Could not open {}: {error}", directory.display()))?;
    Ok(true)
}

/// Runs `work` over `items` on a few threads, keeping the order of results.
fn parallel_map<T: Sync, R: Send>(
    items: &[T],
    work: impl Fn(&T) -> R + Sync,
    progress: impl Fn(usize) + Sync,
) -> Vec<R> {
    let threads = std::thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(4)
        .clamp(1, 8)
        .min(items.len());
    if threads <= 1 {
        return items
            .iter()
            .enumerate()
            .map(|(index, item)| {
                let result = work(item);
                progress(index + 1);
                result
            })
            .collect();
    }
    let next = AtomicUsize::new(0);
    let done = AtomicUsize::new(0);
    let slots = items.iter().map(|_| Mutex::new(None)).collect::<Vec<_>>();
    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| loop {
                let index = next.fetch_add(1, Ordering::Relaxed);
                let Some(item) = items.get(index) else { break };
                let result = work(item);
                if let Ok(mut slot) = slots[index].lock() {
                    *slot = Some(result);
                }
                progress(done.fetch_add(1, Ordering::Relaxed) + 1);
            });
        }
    });
    slots
        .into_iter()
        .map(|slot| slot.into_inner().ok().flatten().expect("every item is processed"))
        .collect()
}

/// Reports indexing progress to the replay browser, at most every 60 ms.
struct IndexProgress<'a> {
    app: &'a AppHandle,
    phase: &'static str,
    total: usize,
    last: Mutex<Option<Instant>>,
}

impl<'a> IndexProgress<'a> {
    // Small batches finish before a progress bar would be readable.
    const MIN_TOTAL: usize = 24;

    fn new(app: &'a AppHandle, phase: &'static str, total: usize) -> Self {
        let progress = Self { app, phase, total, last: Mutex::new(None) };
        progress.report(0);
        progress
    }

    fn report(&self, done: usize) {
        if self.total < Self::MIN_TOTAL {
            return;
        }
        let Ok(mut last) = self.last.lock() else { return };
        let now = Instant::now();
        if done != 0 && done != self.total && last.is_some_and(|last| now - last < Duration::from_millis(60)) {
            return;
        }
        *last = Some(now);
        let payload = json!({ "phase": self.phase, "done": done, "total": self.total });
        if let Ok(mut current) = self.app.state::<ReplayLibrary>().progress.lock() {
            *current = Some(payload.clone());
        }
        let _ = self.app.emit("replay-index-progress", payload);
    }
}

fn embedded_thumbnail_key(hash: &str) -> String {
    format!("custom-{hash}")
}

/// Writes an embedded map image to the thumbnail cache, named by its digest.
fn cache_embedded_map(thumbnail_dir: &Path, hash: &str, surface: &str) -> Result<PathBuf, String> {
    let destination = thumbnail_dir.join(format!("{}.png", embedded_thumbnail_key(hash)));
    if destination.is_file() {
        return Ok(destination);
    }
    let (_, bytes) = SurfaceDigest::with_bytes(surface);
    let bytes = bytes.ok_or_else(|| "Embedded map image is not valid base64.".to_string())?;
    thumbnails::write_atomically(&bytes, &destination)?;
    Ok(destination)
}

/// Hashes new replays in parallel; known replays reuse the hash from the index.
fn hash_unknown_candidates(app: &AppHandle, candidates: &mut [ReplayCandidate]) {
    let unknown = candidates
        .iter()
        .enumerate()
        .filter(|(_, candidate)| candidate.known_hash.is_none())
        .map(|(index, candidate)| (index, candidate.path.clone()))
        .collect::<Vec<_>>();
    if unknown.is_empty() {
        return;
    }
    let progress = IndexProgress::new(app, "hash", unknown.len());
    let hashes = parallel_map(&unknown, |(_, path)| sha256_file(path).ok(), |done| progress.report(done));
    for ((index, _), hash) in unknown.into_iter().zip(hashes) {
        // Unreadable files stay unhashed and are reported by the dedupe step.
        candidates[index].known_hash = hash;
    }
}

fn list_replays_impl(
    app: &AppHandle,
    offset: usize,
    limit: usize,
) -> Result<ReplayListPayload, String> {
    let library = app.state::<ReplayLibrary>();
    let mut index = library
        .index
        .lock()
        .map_err(|_| "The replay index is unavailable.".to_string())?;
    if offset == 0 && limit == 0 {
        let warm = library.warm.lock().ok().and_then(|mut warm| warm.take());
        if let Some((prepared, payload)) = warm {
            if prepared.elapsed() < WARM_LISTING_LIFETIME {
                return Ok(payload);
            }
        }
    }
    let result = list_replays_locked(app, &mut index, offset, limit);
    if let Ok(mut progress) = library.progress.lock() {
        *progress = None;
    }
    result
}

/// Indexes the library while the window loads, so its first listing is ready.
fn warm_replay_listing(app: &AppHandle) {
    let library = app.state::<ReplayLibrary>();
    let Ok(mut index) = library.index.lock() else { return };
    if index.is_some() {
        return;
    }
    let result = list_replays_locked(app, &mut index, 0, 0);
    if let Ok(mut progress) = library.progress.lock() {
        *progress = None;
    }
    match result {
        Ok(payload) => {
            if let Ok(mut warm) = library.warm.lock() {
                *warm = Some((Instant::now(), payload));
            }
        }
        Err(error) => eprintln!("{error}"),
    }
}

/// Forgets a prepared listing after the library changes.
fn discard_warm_listing(app: &AppHandle) {
    if let Ok(mut warm) = app.state::<ReplayLibrary>().warm.lock() {
        *warm = None;
    }
}

fn list_replays_locked(
    app: &AppHandle,
    index_slot: &mut Option<ReplayIndexStore>,
    offset: usize,
    limit: usize,
) -> Result<ReplayListPayload, String> {
    let index_path = replay_index_path(app)?;
    let index = index_slot.get_or_insert_with(|| load_replay_index(&index_path));
    let (mut candidates, backups) = collect_replay_candidates(app, index)?;
    hash_unknown_candidates(app, &mut candidates);
    let (candidates, dedupe_errors) = dedupe_replay_candidates_by_hash(candidates);
    for error in dedupe_errors {
        eprintln!("{error}");
    }
    if candidates.is_empty() {
        if let Ok(mut thumbnails) = app.state::<ReplayMediaCatalog>().thumbnails.lock() {
            thumbnails.clear();
        }
        return Ok(ReplayListPayload {
            replays: Vec::new(),
            total_candidates: 0,
            has_more: false,
            next_offset: None,
        });
    }

    let backup_dir = replay_backup_dir(app)?;
    let installed_maps = installed_map_catalog();
    let mut thumbnail_sources = HashMap::new();
    let offset = offset.min(candidates.len());
    let limit = if limit == 0 {
        // Frontend sends 0 for the "All" items-per-page option.
        candidates.len().saturating_sub(offset)
    } else {
        limit.clamp(1, MAX_REPLAY_PAGE_SIZE)
    };
    let page_end = offset.saturating_add(limit).min(candidates.len());
    let page = &candidates[offset..page_end];

    let mut parsed_page = page
        .iter()
        .map(|candidate| {
            index
                .entries
                .get(&path_key(&candidate.original_path))
                .and_then(|entry| parsed_replay_from_index(entry, candidate, &backups))
        })
        .collect::<Vec<_>>();
    let pending = parsed_page
        .iter()
        .enumerate()
        .filter(|(_, parsed)| parsed.is_none())
        .map(|(position, _)| position)
        .collect::<Vec<_>>();
    let index_changed = !pending.is_empty();
    if index_changed {
        let progress = IndexProgress::new(app, "parse", pending.len());
        let results = parallel_map(
            &pending,
            |&position| parse_replay_candidate(&page[position], &backup_dir, &backups),
            |done| progress.report(done),
        );
        for (position, result) in pending.into_iter().zip(results) {
            let candidate = &page[position];
            match result {
                Ok((parsed, entry)) => {
                    index.entries.insert(path_key(&candidate.original_path), entry);
                    parsed_page[position] = Some(parsed);
                }
                Err(error) => eprintln!("Skipping {}: {error}", candidate.path.display()),
            }
        }
    }

    // Replays on the same official map share one image lookup.
    let mut map_thumbnails: HashMap<(String, String), Option<(String, ReplayThumbnailSource)>> =
        HashMap::new();
    let mut parsed_replays = Vec::with_capacity(page.len());
    for (candidate, parsed) in page.iter().zip(parsed_page) {
        let Some(mut parsed) = parsed else { continue };
        refresh_replay_map_label(&mut parsed, &installed_maps);
        parsed.summary.score_delta = None;
        parsed.summary.thumbnail_data_url = None;
        parsed.summary.thumbnail_key = None;
        if let Some(replay_dir) = candidate.thumbnail_replay_dir.as_deref() {
            let thumbnail = match (parsed.custom_map.is_none(), parsed.map_id.as_ref()) {
                (true, Some(map_id)) => map_thumbnails
                    .entry((path_key(replay_dir), map_id.clone()))
                    .or_insert_with(|| thumbnail_source_for_replay(replay_dir, &parsed))
                    .clone(),
                _ => thumbnail_source_for_replay(replay_dir, &parsed),
            };
            if let Some((thumbnail_key, source)) = thumbnail {
                thumbnail_sources
                    .entry(thumbnail_key.clone())
                    .or_insert(source);
                parsed.summary.thumbnail_key = Some(thumbnail_key);
            }
        }
        parsed_replays.push(parsed);
    }

    if index_changed {
        write_replay_index(&index_path, index)?;
    }
    if let Ok(mut thumbnails) = app.state::<ReplayMediaCatalog>().thumbnails.lock() {
        *thumbnails = thumbnail_sources;
    }

    let home_candidates = home_player_candidates(&parsed_replays);
    let replays = parsed_replays
        .into_iter()
        .map(|mut parsed| {
            let home_player = replay_home_player(&parsed.summary.players, &home_candidates);
            parsed.summary.draw = parsed.result.as_ref().is_some_and(replay_result_is_draw);
            let winning_team = replay_winner_team(
                parsed.result.as_ref(),
                &parsed.summary.players,
                home_player.as_deref(),
            );
            mark_winner(&mut parsed.summary.players, winning_team);

            if let Some(home_player) = home_player.as_deref() {
                put_home_player_first(&mut parsed.summary.players, home_player);
            }

            parsed.summary
        })
        .collect::<Vec<_>>();

    Ok(ReplayListPayload {
        replays,
        total_candidates: candidates.len(),
        has_more: page_end < candidates.len(),
        next_offset: (page_end < candidates.len()).then_some(page_end),
    })
}

fn select_replay_download_path(default_file_name: &str) -> Result<Option<PathBuf>, String> {
    let file_name = default_file_name.replace('\'', "''");
    let script = format!(
        r#"
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.SaveFileDialog
$dialog.AddExtension = $true
$dialog.DefaultExt = 'rep'
$dialog.FileName = '{file_name}'
$dialog.Filter = 'War of Dots replay (*.rep)|*.rep'
$dialog.OverwritePrompt = $true
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {{
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  [Console]::Write($dialog.FileName)
}}
"#
    );
    let encoded_script = BASE64.encode(
        script
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    );
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-STA", "-EncodedCommand", &encoded_script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|error| format!("Could not open the Save As dialog: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Could not open the Save As dialog: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let selected = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok((!selected.is_empty()).then(|| PathBuf::from(selected)))
}

fn select_replay_download_directory() -> Result<Option<PathBuf>, String> {
    let script = r#"
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Choose where to save the selected War of Dots replays'
$dialog.ShowNewFolderButton = $true
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  [Console]::Write($dialog.SelectedPath)
}
"#;
    let encoded_script = BASE64.encode(
        script
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    );
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-STA", "-EncodedCommand", &encoded_script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|error| format!("Could not open the folder picker: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Could not open the folder picker: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let selected = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok((!selected.is_empty()).then(|| PathBuf::from(selected)))
}

fn available_replay_download_path(directory: &Path, requested_name: &str) -> PathBuf {
    let requested = Path::new(requested_name)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("replay.rep");
    let mut base = PathBuf::from(requested);
    if !base
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("rep"))
    {
        base.set_extension("rep");
    }
    let stem = base
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("replay");
    let mut candidate = directory.join(&base);
    let mut suffix = 2;
    while candidate.exists() {
        candidate = directory.join(format!("{stem} ({suffix}).rep"));
        suffix += 1;
    }
    candidate
}

fn safe_replay_file_name(file_name: &str) -> Result<String, String> {
    let name = file_name.trim();
    if name.is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name.chars().any(|character| {
            character.is_control() || matches!(character, '<' | '>' | ':' | '"' | '|' | '?' | '*')
        })
        || name == "."
        || name == ".."
        || !name.to_ascii_lowercase().ends_with(".rep")
    {
        return Err("Replay filename must be a valid .rep filename.".to_string());
    }
    Ok(name.to_string())
}

fn replay_upload_destination(
    replay_dir: &Path,
    file_name: &str,
    hash: &str,
) -> Result<PathBuf, String> {
    let requested = replay_dir.join(file_name);
    if !requested.exists() || sha256_file(&requested).is_ok_and(|existing| existing == hash) {
        return Ok(requested);
    }

    let stem = Path::new(file_name)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("replay");
    for suffix in 2..=10_000 {
        let candidate = replay_dir.join(format!("{stem} ({suffix}).rep"));
        if !candidate.exists() || sha256_file(&candidate).is_ok_and(|existing| existing == hash) {
            return Ok(candidate);
        }
    }
    Err(format!(
        "Could not find an available filename in {}.",
        replay_dir.display()
    ))
}

fn upload_replay_impl(
    app: &AppHandle,
    file_name: String,
    replay_base64: String,
) -> Result<ReplayUploadResult, String> {
    let file_name = safe_replay_file_name(&file_name)?;
    let bytes = BASE64
        .decode(replay_base64.as_bytes())
        .map_err(|error| format!("Replay payload is not valid base64: {error}"))?;
    if bytes.is_empty() {
        return Err("Replay file is empty.".to_string());
    }

    let uploads_dir = app_runtime_dir(app)?.join("desktop-uploads");
    fs::create_dir_all(&uploads_dir).map_err(|error| error.to_string())?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let upload_path = uploads_dir.join(format!("upload-{now}.rep"));
    fs::write(&upload_path, bytes)
        .map_err(|error| format!("Could not stage replay {}: {error}", upload_path.display()))?;

    let result = (|| {
        parse_replay(&upload_path)
            .map_err(|error| format!("{file_name} is not a valid replay: {error}"))?;
        let hash = sha256_file(&upload_path)?;
        let backup_path = backup_replay_file(&upload_path, &hash, &replay_backup_dir(app)?, None)?;
        let replay_dir = primary_replay_dir()?;
        let replay_path = replay_upload_destination(&replay_dir, &file_name, &hash)?;
        if !replay_path.exists() {
            fs::copy(&upload_path, &replay_path).map_err(|error| {
                format!(
                    "Could not save replay to {}: {error}",
                    replay_path.display()
                )
            })?;
        }

        Ok(ReplayUploadResult {
            file_name: candidate_file_name(&replay_path),
            replay_path: replay_path.to_string_lossy().to_string(),
            backup_path: backup_path.to_string_lossy().to_string(),
        })
    })();
    let _ = fs::remove_file(&upload_path);
    discard_warm_listing(app);
    result
}

#[tauri::command]
async fn upload_replay(
    app: AppHandle,
    file_name: String,
    replay_base64: String,
) -> Result<ReplayUploadResult, String> {
    tauri::async_runtime::spawn_blocking(move || upload_replay_impl(&app, file_name, replay_base64))
        .await
        .map_err(|error| format!("Replay upload task failed: {error}"))?
}

fn delete_replay_impl(app: &AppHandle, file_path: String) -> Result<usize, String> {
    let source_path = PathBuf::from(file_path);
    if !source_path.is_file() || !is_replay_file(&source_path) {
        return Err(format!(
            "Replay file is not readable: {}",
            source_path.display()
        ));
    }

    let backup_dir = replay_backup_dir(app)?;
    let backup_dir_key = path_key(&backup_dir);
    let mut managed_dirs = discover_replay_dirs();
    push_unique_path(&mut managed_dirs, backup_dir);
    let source_path = fs::canonicalize(&source_path).map_err(|error| {
        format!(
            "Could not resolve replay path {}: {error}",
            source_path.display()
        )
    })?;
    let is_managed = source_path.parent().is_some_and(|source_parent| {
        managed_dirs.iter().any(|directory| {
            fs::canonicalize(directory)
                .is_ok_and(|managed| path_key(&managed) == path_key(source_parent))
        })
    });
    if !is_managed {
        return Err("Replay is outside the managed game and backup folders.".to_string());
    }

    let hash = sha256_file(&source_path)?;
    let source_size = fs::metadata(&source_path).map_err(|error| error.to_string())?.len();
    let mut targets = Vec::new();
    for directory in &managed_dirs {
        let Ok(entries) = fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            // Only same-size files can be copies, which spares hashing the library.
            if is_replay_file(&path)
                && entry.metadata().is_ok_and(|metadata| metadata.is_file() && metadata.len() == source_size)
                && sha256_file(&path).is_ok_and(|candidate_hash| candidate_hash == hash)
            {
                let is_backup = path
                    .parent()
                    .is_some_and(|parent| path_key(parent) == backup_dir_key);
                targets.push((path, is_backup));
            }
        }
    }
    if targets.is_empty() {
        return Err("No managed copies of this replay were found.".to_string());
    }

    let mut deleted = 0;
    let mut failures = Vec::new();
    for (target, is_backup) in targets {
        if is_backup && !failures.is_empty() {
            continue;
        }
        match fs::remove_file(&target) {
            Ok(()) => deleted += 1,
            Err(error) => failures.push(format!("{}: {error}", target.display())),
        }
    }

    if !failures.is_empty() {
        return Err(format!(
            "Deleted {deleted} replay copies, but could not delete:\n{}",
            failures.join("\n")
        ));
    }

    discard_warm_listing(app);
    let library = app.state::<ReplayLibrary>();
    let mut index = library
        .index
        .lock()
        .map_err(|_| "The replay index is unavailable.".to_string())?;
    let index_path = replay_index_path(app)?;
    let index = index.get_or_insert_with(|| load_replay_index(&index_path));
    let previous_entry_count = index.entries.len();
    index.entries.retain(|_, entry| entry.hash != hash);
    if index.entries.len() != previous_entry_count {
        write_replay_index(&index_path, index)?;
    }
    Ok(deleted)
}

#[tauri::command]
async fn delete_replay(app: AppHandle, file_path: String) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || delete_replay_impl(&app, file_path))
        .await
        .map_err(|error| format!("Replay deletion task failed: {error}"))?
}

#[tauri::command]
async fn download_replay(file_path: String, file_name: String) -> Result<bool, String> {
    let source_path = PathBuf::from(file_path);
    if !source_path.is_file() || !is_replay_file(&source_path) {
        return Err(format!(
            "Replay file is not readable: {}",
            source_path.display()
        ));
    }

    tauri::async_runtime::spawn_blocking(move || {
        let Some(mut destination_path) = select_replay_download_path(&file_name)? else {
            return Ok(false);
        };
        if !destination_path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("rep"))
        {
            destination_path.set_extension("rep");
        }
        fs::copy(&source_path, &destination_path).map_err(|error| {
            format!(
                "Could not save replay to {}: {error}",
                destination_path.display()
            )
        })?;
        Ok(true)
    })
    .await
    .map_err(|error| format!("Replay download task failed: {error}"))?
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReplayDownloadRequest {
    file_path: String,
    file_name: String,
}

#[tauri::command]
async fn download_replays(replays: Vec<ReplayDownloadRequest>) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if replays.is_empty() {
            return Ok(0);
        }
        let mut sources = Vec::with_capacity(replays.len());
        for replay in replays {
            let source_path = PathBuf::from(&replay.file_path);
            if !source_path.is_file() || !is_replay_file(&source_path) {
                return Err(format!(
                    "Replay file is not readable: {}",
                    source_path.display()
                ));
            }
            sources.push((source_path, replay.file_name));
        }

        let Some(destination_dir) = select_replay_download_directory()? else {
            return Ok(0);
        };
        if !destination_dir.is_dir() {
            return Err(format!(
                "Replay destination is not a folder: {}",
                destination_dir.display()
            ));
        }

        let mut saved = 0;
        for (source_path, file_name) in sources {
            let destination_path = available_replay_download_path(&destination_dir, &file_name);
            fs::copy(&source_path, &destination_path).map_err(|error| {
                format!(
                    "Saved {saved} replays, but could not save {}: {error}",
                    destination_path.display()
                )
            })?;
            saved += 1;
        }
        Ok(saved)
    })
    .await
    .map_err(|error| format!("Replay download task failed: {error}"))?
}

#[tauri::command]
async fn list_replays(
    app: AppHandle,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<ReplayListPayload, String> {
    let offset = offset.unwrap_or(0);
    let limit = limit.unwrap_or(DEFAULT_REPLAY_PAGE_SIZE);
    tauri::async_runtime::spawn_blocking(move || list_replays_impl(&app, offset, limit))
        .await
        .map_err(|error| format!("Replay loading task failed: {error}"))?
}

/// An embedded map's thumbnail, read from its replay the first time a card
/// needs it. Only the requested size is written.
fn embedded_thumbnail_path(thumbnail_dir: &Path, key: &str, replay_path: &Path, small: bool) -> Result<PathBuf, String> {
    let full = thumbnail_dir.join(format!("{key}.png"));
    let small_path = thumbnail_dir.join(format!("{key}.small.png"));
    let wanted = if small { &small_path } else { &full };
    if wanted.is_file() {
        return Ok(wanted.clone());
    }
    if small && full.is_file() {
        return small_thumbnail_path(&full);
    }
    let surface = parse_replay(replay_path)?
        .custom_map_surface
        .ok_or_else(|| format!("{} has no embedded map.", replay_path.display()))?;
    let hash = key.strip_prefix("custom-").unwrap_or(key);
    if !small {
        return cache_embedded_map(thumbnail_dir, hash, &surface);
    }
    let (_, png) = SurfaceDigest::with_bytes(&surface);
    let png = png.ok_or_else(|| "Embedded map image is not valid base64.".to_string())?;
    thumbnails::write_small_png(&png, &small_path)?;
    Ok(small_path)
}

/// The downscaled copy for small replay cards, made once next to the image.
fn small_thumbnail_path(full: &Path) -> Result<PathBuf, String> {
    let stem = full.file_stem().and_then(|stem| stem.to_str()).unwrap_or("thumbnail");
    let small = full.with_file_name(format!("{stem}.small.png"));
    if !small.is_file() {
        thumbnails::write_small_variant(full, &small)?;
    }
    Ok(small)
}

fn replay_thumbnail_paths_impl(
    app: &AppHandle,
    thumbnail_keys: Vec<String>,
    small: bool,
) -> Result<Vec<ReplayThumbnailPath>, String> {
    let keys = thumbnail_keys
        .into_iter()
        .filter(|key| {
            key.len() <= 80
                && key.chars().all(|character| {
                    character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
                })
        })
        .take(32)
        .collect::<Vec<_>>();
    let sources = {
        let catalog = app.state::<ReplayMediaCatalog>();
        let guard = catalog
            .thumbnails
            .lock()
            .map_err(|_| "Replay thumbnail catalog is unavailable.".to_string())?;
        keys.iter()
            .filter_map(|key| guard.get(key).cloned().map(|source| (key.clone(), source)))
            .collect::<Vec<_>>()
    };
    let thumbnail_dir = media_cache_dir(app, REPLAY_THUMBNAIL_CACHE)?;

    let results = parallel_map(
        &sources,
        |(thumbnail_key, source)| -> Result<ReplayThumbnailPath, String> {
            let path = match source {
                ReplayThumbnailSource::Embedded(replay) => {
                    embedded_thumbnail_path(&thumbnail_dir, thumbnail_key, replay, small)?
                }
                ReplayThumbnailSource::File(path) => {
                    let full = cache_media_file(app, REPLAY_THUMBNAIL_CACHE, path)?;
                    if small { small_thumbnail_path(&full)? } else { full }
                }
            };
            let bytes = fs::read(&path).map_err(|error| error.to_string())?;
            Ok(ReplayThumbnailPath {
                thumbnail_key: thumbnail_key.clone(),
                file_path: path.to_string_lossy().to_string(),
                data_url: format!("data:image/png;base64,{}", BASE64.encode(bytes)),
            })
        },
        |_| {},
    );
    // One unreadable map keeps its card's fallback image; the others still load.
    Ok(results
        .into_iter()
        .filter_map(|result| result.map_err(|error| eprintln!("{error}")).ok())
        .collect())
}

#[tauri::command]
async fn replay_thumbnail_paths(
    app: AppHandle,
    thumbnail_keys: Vec<String>,
    variant: Option<String>,
) -> Result<Vec<ReplayThumbnailPath>, String> {
    let small = variant.as_deref() == Some("small");
    tauri::async_runtime::spawn_blocking(move || replay_thumbnail_paths_impl(&app, thumbnail_keys, small))
        .await
        .map_err(|error| format!("Replay thumbnail task failed: {error}"))?
}

#[tauri::command]
fn replay_index_progress(app: AppHandle) -> Option<Value> {
    app.state::<ReplayLibrary>().progress.lock().ok().and_then(|progress| progress.clone())
}

fn map_store(app: &AppHandle) -> Result<maps::MapStore, String> {
    maps::MapStore::new(app_runtime_dir(app)?.join("map-drafts"), discover_map_editor_dirs())
}

#[tauri::command]
async fn list_maps(app: AppHandle) -> Result<Vec<GameMapRecord>, String> {
    tauri::async_runtime::spawn_blocking(move || map_store(&app)?.list())
        .await.map_err(|error| format!("Map loading task failed: {error}"))?
}

#[tauri::command]
fn read_map(app: AppHandle, file_name: String) -> Result<GameMapRecord, String> {
    map_store(&app)?.read(&file_name)
}

#[tauri::command]
fn save_map(app: AppHandle, file_name: String, data: Value, publish: Option<bool>) -> Result<GameMapRecord, String> {
    map_store(&app)?.save(&file_name, data, publish.unwrap_or(false))
}

#[tauri::command]
fn create_map(app: AppHandle, name: String, mode: String) -> Result<GameMapRecord, String> {
    map_store(&app)?.create(&name, &mode)
}

#[tauri::command]
fn delete_maps(app: AppHandle, file_names: Vec<String>) -> Result<Vec<String>, String> {
    map_store(&app)?.delete(&file_names)
}

#[tauri::command]
fn leaderboard_identity() -> Option<String> {
    let mut roots = vec![steam_game_dir()];
    roots.extend(discover_steamapps_dirs().into_iter().map(|dir| dir.join("common").join(GAME_DIR_NAME)));
    for root in roots {
        // Read settings locally and return only the account name. Passwords never cross IPC.
        let Ok(file) = File::open(root.join("config.txt")) else { continue; };
        let mut text = String::new();
        if GzDecoder::new(file).take(1024 * 1024).read_to_string(&mut text).is_err() { continue; }
        let Ok(config) = serde_json::from_str::<Value>(&text) else { continue; };
        if let Some(name) = config.get("login").and_then(|login| login.get("username")).and_then(Value::as_str) {
            let name = name.trim();
            if !name.is_empty() && name.chars().count() <= 100 { return Some(name.to_owned()); }
        }
    }
    None
}

#[tauri::command]
fn replay_launch_request(app: AppHandle, launch_id: String) -> Result<ReplayLaunchRequest, String> {
    let path = launch_request_path(&app, &launch_id)?;
    let text = fs::read_to_string(&path).map_err(|error| {
        format!(
            "Could not read replay launch request {}: {error}",
            path.display()
        )
    })?;
    serde_json::from_str(&text).map_err(|error| {
        format!(
            "Replay launch request {} is invalid: {error}",
            path.display()
        )
    })
}

#[tauri::command]
fn current_replay_launch_request(app: AppHandle) -> Result<ReplayLaunchRequest, String> {
    let path = current_launch_request_path(&app)?;
    let text = fs::read_to_string(&path).map_err(|error| {
        format!(
            "Could not read current replay launch request {}: {error}",
            path.display()
        )
    })?;
    serde_json::from_str(&text).map_err(|error| {
        format!(
            "Current replay launch request {} is invalid: {error}",
            path.display()
        )
    })
}

#[tauri::command]
async fn open_replay_window(
    app: AppHandle,
    file_name: String,
    file_path: String,
) -> Result<String, String> {
    let replay_path = PathBuf::from(&file_path);
    let simulated = replay_path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("repsim") || extension.eq_ignore_ascii_case("jsonl")
        });
    if !replay_path.is_file() || (!is_replay_file(&replay_path) && !simulated) {
        return Err(format!(
            "Replay file is not readable: {}",
            replay_path.display()
        ));
    }

    let launch_id = format!(
        "{}-{}",
        process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_nanos()
    );
    let request = ReplayLaunchRequest {
        file_name: if file_name.trim().is_empty() {
            replay_path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("replay.rep")
                .to_string()
        } else {
            file_name
        },
        file_path: replay_path.to_string_lossy().to_string(),
    };
    let request_path = launch_request_path(&app, &launch_id)?;
    let request_json = serde_json::to_string_pretty(&request).map_err(|error| error.to_string())?;
    fs::write(&request_path, request_json).map_err(|error| error.to_string())?;
    let current_path = current_launch_request_path(&app)?;
    let current_json = serde_json::to_string_pretty(&request).map_err(|error| error.to_string())?;
    fs::write(&current_path, current_json).map_err(|error| error.to_string())?;

    let label = format!("replay-player-{launch_id}");
    let title = format!("More of Dots - {}", request.file_name);
    let window = WebviewWindowBuilder::new(
        &app,
        label.clone(),
        WebviewUrl::App(format!("player.html?launch={launch_id}").into()),
    )
    .title(&title)
    .inner_size(REPLAY_PLAYER_WIDTH, REPLAY_PLAYER_HEIGHT)
    .min_inner_size(720.0, 520.0)
    .theme(Some(tauri::Theme::Dark))
    .additional_browser_args("--autoplay-policy=no-user-gesture-required --disk-cache-size=16777216 --media-cache-size=8388608 --disable-gpu-shader-disk-cache")
    .visible(true)
    .focused(true)
    .build()
    .map_err(|error| error.to_string())?;

    let player_app = app.clone();
    let player_label = label.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            player_app
                .state::<player::PlayerSessions>()
                .close(&player_label);
        }
    });

    window
        .set_title(&title)
        .map_err(|error| error.to_string())?;
    window
        .set_size(LogicalSize::new(REPLAY_PLAYER_WIDTH, REPLAY_PLAYER_HEIGHT))
        .map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.unminimize().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    Ok(label)
}

#[cfg(not(test))]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(ReplayMediaCatalog::default())
        .manage(ReplayLibrary::default())
        .manage(player::PlayerSessions::default())
        .manage(export::VideoExports::default())
        .setup(|app| {
            let local = app.path().app_cache_dir()?;
            let cache = storage::ReplayCache::new(local)?;
            app.manage(cache.clone());
            // Opening a replay prunes immediately; this also trims browser caches.
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(10));
                cache.maintain();
            });
            let warm_app = app.handle().clone();
            std::thread::spawn(move || warm_replay_listing(&warm_app));
            if let Some(window) = app.get_webview_window("main") {
                let app_handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        app_handle
                            .state::<player::PlayerSessions>()
                            .close_all();
                        app_handle.state::<export::VideoExports>().cancel_all();
                        app_handle.exit(0);
                    }
                });
            }
            let args: Vec<String> = env::args().skip(1).collect();
            let requested = args
                .iter()
                .position(|arg| arg == "--replay")
                .and_then(|index| args.get(index + 1))
                .or_else(|| args.first().filter(|path| Path::new(path).is_file()));
            if let Some(path) = requested {
                let path = path.clone();
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = open_replay_window(handle, String::new(), path).await {
                        eprintln!("{error}");
                    }
                });
            }
            if let Some(window) = app.get_webview_window(REPLAY_PLAYER_LABEL) {
                let player_window = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = player_window.hide();
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            recording_default_directory,
            open_recording_output_directory,
            list_replays,
            replay_thumbnail_paths,
            replay_index_progress,
            upload_replay,
            delete_replay,
            download_replay,
            download_replays,
            list_maps,
            read_map,
            save_map,
            create_map,
            delete_maps,
            leaderboard_identity,
            replay_launch_request,
            current_replay_launch_request,
            open_replay_window,
            player::open_replay,
            player::replay_frames,
            player::render_frame,
            export::export_replay_videos,
            export::cancel_replay_exports,
            player::replay_progress,
            player::game_audio,
            player::player_debug_options,
            player::save_player_snapshot,
            player::save_player_diagnostics
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn draw_result_suppresses_all_winner_detection() {
        let players = vec![
            PlayerSummary {
                name: "Player 1".to_string(),
                team_index: 0,
                winner: false,
            },
            PlayerSummary {
                name: "Player 2".to_string(),
                team_index: 1,
                winner: false,
            },
        ];
        let result = json!(0.5);

        assert!(replay_result_is_draw(&result));
        assert_eq!(replay_winner_team(Some(&result), &players, None), None);
    }

    #[test]
    fn flatten_name_reads_new_player_objects() {
        let value = json!([
            [
                {
                    "username": "thesavvyy",
                    "title": "Veteran"
                }
            ],
            [
                {
                    "username": "aexer0e",
                    "title": "Friend"
                }
            ]
        ]);

        let names = value
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
            .map(|(index, name)| clean_player_name(&flatten_name(name), index))
            .collect::<Vec<_>>();

        assert_eq!(names, vec!["thesavvyy", "aexer0e"]);
    }

    #[test]
    fn two_versus_two_replays_report_two_players_per_side() {
        let raw = json!({
            "mode": "2v2",
            "player_usernames": [
                [{ "username": "a" }, { "username": "b" }],
                [{ "username": "c" }, { "username": "d" }]
            ]
        });
        assert_eq!(replay_team_size(&raw), 2);
        let players: Vec<_> = replay_players(&raw)
            .into_iter()
            .map(|(team_index, name)| PlayerSummary { name, team_index, winner: false })
            .collect();
        let names = |players: &[PlayerSummary]| {
            players.iter().map(|p| format!("{}{}", p.team_index, p.name)).collect::<Vec<_>>()
        };
        assert_eq!(names(&players), ["0a", "0b", "1c", "1d"], "each teammate is a player");
        // The home player's team won: both teammates win, and that team is listed first.
        let candidates = vec![HomePlayerCandidate { normalized_name: "d".into(), replay_count: 3, first_seen: 0 }];
        let home = replay_home_player(&players, &candidates);
        assert_eq!(home.as_deref(), Some("d"));
        let mut players = players;
        let winning_team = replay_winner_team(Some(&json!(1)), &players, home.as_deref());
        mark_winner(&mut players, winning_team);
        put_home_player_first(&mut players, "d");
        assert_eq!(names(&players), ["1d", "1c", "0a", "0b"]);
        assert_eq!(players.iter().map(|p| p.winner).collect::<Vec<_>>(), [true, true, false, false]);
        let winning_team = replay_winner_team(Some(&json!(0)), &players, Some("d"));
        mark_winner(&mut players, winning_team);
        assert!(players[2].winner && players[3].winner && !players[0].winner, "a loss means the other team won");
        assert_eq!(replay_team_size(&json!({ "player_usernames": [[{ "username": "a" }], [{ "username": "b" }]] })), 1);
    }

    #[test]
    fn custom_map_surface_reads_new_map_location() {
        let raw = json!({
            "custom_map": null,
            "map": {
                "version": null,
                "map_surface": "iVBORw0KGgo="
            },
            "player_usernames": []
        });

        assert_eq!(custom_map_surface(&raw), Some("iVBORw0KGgo=".to_string()));
        assert_eq!(replay_map_id(&raw), None);
    }

    #[test]
    fn replay_summary_uses_a_thumbnail_key_without_embedding_image_data() {
        let mut replay = ParsedReplay {
            summary: ReplaySummary {
                file_name: "match.rep".to_string(),
                file_path: r"C:\replays\match.rep".to_string(),
                version: Some("1.2.18.3".to_string()),
                mode: None,
                team_size: 1,
                players: Vec::new(),
                draw: false,
                length: "0:00".to_string(),
                duration_seconds: 0,
                thumbnail_data_url: None,
                thumbnail_key: None,
                modified: 123,
                score_delta: None,
                event_label: None,
                map_key: None,
                map_label: None,
            },
            result: None,
            map_id: None,
            custom_map_surface: None,
            custom_map: Some(CustomMapDigest { hash: "abc123".to_string(), decoded: true }),
            has_map: true,
        };

        let (thumbnail_key, source) =
            thumbnail_source_for_replay(Path::new(r"C:\replays"), &replay).unwrap();
        assert_eq!(thumbnail_key, "custom-abc123");
        assert!(matches!(source, ReplayThumbnailSource::Embedded(path) if path == Path::new(r"C:\replays\match.rep")));

        replay.custom_map.as_mut().unwrap().decoded = false;
        assert!(thumbnail_source_for_replay(Path::new(r"C:\replays"), &replay).is_none());
        replay.custom_map.as_mut().unwrap().decoded = true;

        replay.summary.thumbnail_key = Some(thumbnail_key.clone());
        let serialized = serde_json::to_value(&replay.summary).unwrap();
        assert_eq!(serialized["thumbnailKey"], thumbnail_key);
        assert!(serialized.get("thumbnailDataUrl").is_none());
    }

    #[test]
    fn replay_header_skips_frames_and_keeps_summary_fields() {
        let root = tempfile::tempdir().unwrap();
        let surface = BASE64.encode(b"custom image");
        let replay = json!({
            "version": "1.4.1",
            "mode": "1v1",
            "player_usernames": [{"username": "ann"}, {"username": "bob [x]"}],
            "result": "ann",
            "0": [[1, 2, 3]],
            "3600": {"orders": [1, 2]},
            "120": [],
            "map": {"map_surface": surface, "infantry": [[[1, 2]]]}
        });
        let path = root.path().join("match.rep");
        let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
        encoder.write_all(&serde_json::to_vec(&replay).unwrap()).unwrap();
        fs::write(&path, encoder.finish().unwrap()).unwrap();

        let parsed = parse_replay(&path).unwrap();
        assert_eq!(parsed.summary.duration_seconds, 120);
        assert_eq!(parsed.summary.mode.as_deref(), Some("1v1"));
        let names = parsed.summary.players.iter().map(|player| player.name.as_str()).collect::<Vec<_>>();
        assert_eq!(names, ["ann", "bob"]);
        assert_eq!(parsed.result, Some(json!("ann")));
        assert_eq!(parsed.custom_map_surface.as_deref(), Some(surface.as_str()));
        let digest = parsed.custom_map.as_ref().unwrap();
        assert_eq!(digest.surface(), SurfaceDigest::of(&surface));
        assert!(digest.decoded);
        // The embedded image itself is never written to the index.
        let stored = serde_json::to_value(&parsed).unwrap();
        assert!(stored.get("custom_map_surface").is_none());

        fs::write(&path, br#"{"end": 90, "5000": []}"#).unwrap();
        assert_eq!(parse_replay(&path).unwrap().summary.duration_seconds, 3);

        // Indexing must not reject numbered maps before the engine resolves them.
        fs::write(&path, br#"{"map": "13", "mode": "2v2"}"#).unwrap();
        let numbered = parse_replay(&path).unwrap();
        assert!(serde_json::to_value(&numbered.summary).unwrap().get("playable").is_none());
        assert_eq!(numbered.map_id.as_deref(), Some("13"));
        fs::write(&path, br#"{"map": "custom", "custom_map": {"map_surface": "YWJj"}}"#).unwrap();
        assert!(parse_replay(&path).is_ok());
        // Existing indexes may contain the retired false flag. Discard it without
        // requiring users to clear their library or re-import their recordings.
        let mut cached = serde_json::to_value(&numbered).unwrap();
        cached["summary"]["playable"] = json!(false);
        let restored: ParsedReplay = serde_json::from_value(cached).unwrap();
        assert_eq!(restored.map_id.as_deref(), Some("13"));
        assert!(serde_json::to_value(restored).unwrap()["summary"].get("playable").is_none());
    }

    #[test]
    fn embedded_maps_are_cached_once_by_digest() {
        let root = tempfile::tempdir().unwrap();
        let surface = format!("data:image/png;base64,{}", BASE64.encode(b"png bytes"));
        let digest = SurfaceDigest::of(&surface);
        let first = cache_embedded_map(root.path(), &digest.hash, &surface).unwrap();
        let second = cache_embedded_map(root.path(), &digest.hash, &surface).unwrap();
        assert_eq!(first, second);
        assert_eq!(fs::read(&first).unwrap(), b"png bytes");
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
        assert!(cache_embedded_map(root.path(), "other", "not base64!").is_err());
    }

    #[test]
    fn parallel_map_keeps_order_and_reports_every_item() {
        let items = (0..200).collect::<Vec<_>>();
        let reported = AtomicUsize::new(0);
        let doubled = parallel_map(&items, |value| value * 2, |_| {
            reported.fetch_add(1, Ordering::Relaxed);
        });
        assert_eq!(doubled, items.iter().map(|value| value * 2).collect::<Vec<_>>());
        assert_eq!(reported.load(Ordering::Relaxed), 200);
        assert!(parallel_map(&Vec::<u8>::new(), |value| *value, |_| {}).is_empty());
    }

    #[test]
    fn procedural_map_is_custom() {
        let surface = solid_map_surface_base64(960, 540).unwrap();
        let infantry = vec![vec![json!([0, 0]); 16]; 2];
        let tanks = vec![vec![json!([0, 0]); 4]; 2];
        let raw = json!({
            "map": {
                "map_surface": surface,
                "mode": "1v1",
                "infantry": infantry,
                "tanks": tanks,
                "cities": vec![json!([0, 0]); 8],
                "capitals": [0, 7],
                "bridges": []
            }
        });

        assert_eq!(replay_event_label(&raw).as_deref(), Some("Custom"));
        assert_eq!(replay_event_label(&json!({ "map": "35" })), None);
    }

    #[test]
    fn arbitrary_custom_map_is_labeled_custom() {
        let raw = json!({
            "map": {
                "map_surface": solid_map_surface_base64(960, 540).unwrap(),
                "mode": "1v1",
                "infantry": [[], []],
                "tanks": [[], []],
                "cities": [],
                "capitals": [0, 1],
                "bridges": []
            }
        });

        assert_eq!(replay_event_label(&raw).as_deref(), Some("Custom"));
    }

    #[test]
    fn cached_replay_map_label_refreshes_from_installed_maps() {
        let root = tempfile::tempdir().unwrap();
        let replay_path = root.path().join("match.rep");
        fs::write(&replay_path, serde_json::to_vec(&json!({
            "version": "1.4.1", "map": { "path": "assets/zolamare_maps/map55.png" }
        })).unwrap()).unwrap();
        let mut replay = parse_replay(&replay_path).unwrap();
        refresh_replay_map_label(&mut replay, &InstalledMaps::read([root.path().to_path_buf()]));
        assert_eq!(replay.summary.event_label.as_deref(), Some("Custom"));
        let cached = serde_json::to_vec(&replay).unwrap();
        let map_path = root.path().join("assets/zolamare_maps/map55.png");
        fs::create_dir_all(map_path.parent().unwrap()).unwrap();
        fs::write(map_path, b"official image").unwrap();
        let mut replay: ParsedReplay = serde_json::from_slice(&cached).unwrap();
        refresh_replay_map_label(&mut replay, &InstalledMaps::read([root.path().to_path_buf()]));
        assert_eq!(replay.summary.event_label, None);
    }

    #[test]
    fn new_vanilla_paths_are_not_custom() {
        let root = tempfile::tempdir().unwrap();
        for path in ["assets/fahero_maps/map50.png", "assets/eronion_maps/azure_rivers.png", "assets/zolamare_maps/map45.png"] {
            let path = root.path().join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, b"map image").unwrap();
        }
        let maps = InstalledMaps::read([root.path().to_path_buf()]);
        for path in ["assets/fahero_maps/map50.png", "assets/eronion_maps/azure_rivers.png", "assets\\zolamare_maps\\map45.png"] {
            let raw = json!({ "mode": "experiment", "map": { "path": path, "motorised": [[], []] } });
            assert_eq!(replay_map_id(&raw), Some(path.replace('\\', "/")));
            assert_eq!(maps.event_label(replay_map_id(&raw).as_deref(), None, true), None);
        }
        assert_eq!(replay_event_label(&json!({"map": {"path": "assets/custom_maps/my_map.png"}})).as_deref(), Some("Custom"));
        assert_eq!(replay_event_label(&json!({"map": "custom", "custom_map": {"map_surface": "custom-png"}})).as_deref(), Some("Custom"));
    }

    #[test]
    fn new_map_paths_resolve_pngs_without_allowing_traversal() {
        let root = env::temp_dir().join(format!("mod-map-path-test-{}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        let directory = root.join("assets/eronion_maps");
        fs::create_dir_all(&directory).unwrap();
        let png = directory.join("azure_rivers.png");
        fs::write(&png, b"test-image").unwrap();
        assert_eq!(map_image_path(&root, "assets/eronion_maps/azure_rivers.png"), Some(png.canonicalize().unwrap()));
        for path in ["assets/../../private.png", "C:/private.png", "assets/C:/private.png", "assets/eronion_maps/missing.png", "abc50"] {
            assert!(map_image_path(&root, path).is_none());
        }
        assert!(root.starts_with(env::temp_dir()));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn map_filename_validation_stays_inside_map_editor() {
        assert_eq!(
            safe_map_file_name("generated_map1.txt").unwrap(),
            "generated_map1.txt"
        );
        assert!(safe_map_file_name("../config.txt").is_err());
        assert!(safe_map_file_name(r"..\config.txt").is_err());
        assert!(safe_map_file_name("map.json").is_err());
    }

    #[test]
    fn default_map_surface_is_current_png_shape() {
        let data = default_game_map_value("v4").unwrap();

        assert_eq!(map_team_count(&data), 4);
        assert_eq!(map_dimensions(&data), (960, 540));
        validate_game_map_value(&data).unwrap();
    }

    #[test]
    fn gzip_map_roundtrip_preserves_unknown_fields() {
        let root = env::temp_dir().join(format!(
            "more-of-dots-map-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("map_test.txt");
        let mut data = default_game_map_value("1v1").unwrap();
        data.as_object_mut()
            .unwrap()
            .insert("version".to_string(), Value::Null);
        data.as_object_mut()
            .unwrap()
            .insert("custom_unknown".to_string(), json!({"kept": true}));

        write_gzip_json_file(&path, &data).unwrap();
        let read = read_gzip_json_file(&path).unwrap();

        assert_eq!(read.get("version"), Some(&Value::Null));
        assert_eq!(
            read.pointer("/custom_unknown/kept"),
            Some(&Value::Bool(true))
        );
        assert_eq!(map_dimensions(&read), (960, 540));

        let _ = fs::remove_file(&path);
        let _ = fs::remove_dir(&root);
    }

    #[test]
    fn replay_index_entry_invalidates_on_path_size_or_mtime_change() {
        let path = PathBuf::from(r"C:\replays\match.rep");
        let candidate = ReplayCandidate {
            path: path.clone(),
            original_path: path.clone(),
            file_name: "match.rep".to_string(),
            modified: 123,
            size: 456,
            known_hash: None,
            is_backup: false,
            thumbnail_replay_dir: None,
        };
        let parsed = ParsedReplay {
            summary: ReplaySummary {
                file_name: "match.rep".to_string(),
                file_path: path.to_string_lossy().to_string(),
                version: Some("1.2.18.3".to_string()),
                mode: None,
                team_size: 1,
                players: Vec::new(),
                draw: false,
                length: "0:00".to_string(),
                duration_seconds: 0,
                thumbnail_data_url: None,
                thumbnail_key: None,
                modified: 123,
                score_delta: None,
                event_label: None,
                map_key: None,
                map_label: None,
            },
            result: None,
            map_id: None,
            custom_map_surface: None,
            custom_map: None,
            has_map: false,
        };
        let entry = ReplayIndexEntry {
            path_key: path_key(&path),
            original_path: path.to_string_lossy().to_string(),
            backup_path: path.to_string_lossy().to_string(),
            file_name: "match.rep".to_string(),
            modified: 123,
            size: 456,
            hash: "abc".to_string(),
            parsed: Some(parsed),
        };

        assert!(replay_index_entry_matches(&entry, &candidate));

        let mut missing_version = entry.clone();
        missing_version.parsed.as_mut().unwrap().summary.version = None;
        assert!(!replay_index_entry_matches(&missing_version, &candidate));

        let mut changed = candidate.clone();
        changed.size += 1;
        assert!(!replay_index_entry_matches(&entry, &changed));

        let mut changed = candidate.clone();
        changed.modified += 1;
        assert!(!replay_index_entry_matches(&entry, &changed));

        let mut changed = candidate;
        changed.original_path = PathBuf::from(r"C:\replays\other.rep");
        assert!(!replay_index_entry_matches(&entry, &changed));
    }

    #[test]
    fn replay_index_invalidates_entries_from_an_older_schema() {
        let root = env::temp_dir().join(format!(
            "more-of-dots-replay-index-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("replay-index.json");
        fs::write(
            &path,
            serde_json::to_vec(&json!({
                "version": REPLAY_INDEX_VERSION - 1,
                "entries": {
                    "stale": {"fileName": "stale.rep"},
                    "hashed": {"fileName": "hashed.rep", "hash": "abc", "size": 4, "parsed": {"old": "shape"}}
                }
            }))
            .unwrap(),
        )
        .unwrap();

        let store = load_replay_index(&path);

        assert_eq!(store.version, REPLAY_INDEX_VERSION);
        // Summaries are rebuilt, while file hashes are kept to spare re-hashing.
        assert_eq!(store.entries.len(), 1);
        let entry = &store.entries["hashed"];
        assert_eq!((entry.hash.as_str(), entry.size), ("abc", 4));
        assert!(entry.parsed.is_none());

        write_replay_index(&path, &store).unwrap();
        assert_eq!(load_replay_index(&path).entries.len(), 1);
        assert!(!path.with_extension("json.tmp").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn map_image_lookup_falls_back_to_zolamare_maps() {
        let root = env::temp_dir().join(format!(
            "more-of-dots-zolamare-map-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let map_dir = root.join("assets").join("zolamare_maps");
        fs::create_dir_all(&map_dir).unwrap();
        fs::write(map_dir.join("map33.png"), b"not-a-real-png-but-good-enough").unwrap();

        let data_url = map_image_data_url(&root, "33").unwrap();

        assert!(data_url.starts_with("data:image/png;base64,"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn replay_candidate_merge_prefers_live_file_for_same_hash() {
        let mut candidates = BTreeMap::new();
        let backup = ReplayCandidate {
            path: PathBuf::from(r"C:\runtime\replay-backups\abc.rep"),
            original_path: PathBuf::from(r"C:\runtime\replay-backups\abc.rep"),
            file_name: "abc.rep".to_string(),
            modified: 200,
            size: 10,
            known_hash: Some("abc".to_string()),
            is_backup: true,
            thumbnail_replay_dir: None,
        };
        let live = ReplayCandidate {
            path: PathBuf::from(r"C:\game\replays\replay.rep"),
            original_path: PathBuf::from(r"C:\game\replays\replay.rep"),
            file_name: "replay.rep".to_string(),
            modified: 100,
            size: 10,
            known_hash: Some("abc".to_string()),
            is_backup: false,
            thumbnail_replay_dir: Some(PathBuf::from(r"C:\game\replays")),
        };

        insert_candidate(&mut candidates, backup);
        insert_candidate(&mut candidates, live);

        assert_eq!(candidates.len(), 1);
        let candidate = candidates.values().next().unwrap();
        assert!(!candidate.is_backup);
        assert_eq!(candidate.file_name, "replay.rep");
        assert!(candidate.thumbnail_replay_dir.is_some());
    }

    #[test]
    fn replay_candidate_hash_dedupe_collapses_duplicate_files() {
        let root = env::temp_dir().join(format!(
            "more-of-dots-replay-dedupe-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let first_path = root.join("first.rep");
        let second_path = root.join("second.rep");
        let unique_path = root.join("unique.rep");
        fs::write(&first_path, b"same replay bytes").unwrap();
        fs::write(&second_path, b"same replay bytes").unwrap();
        fs::write(&unique_path, b"different replay bytes").unwrap();

        let candidates = vec![
            ReplayCandidate {
                path: first_path.clone(),
                original_path: first_path,
                file_name: "first.rep".to_string(),
                modified: 100,
                size: 17,
                known_hash: None,
                is_backup: false,
                thumbnail_replay_dir: None,
            },
            ReplayCandidate {
                path: second_path.clone(),
                original_path: second_path,
                file_name: "second.rep".to_string(),
                modified: 200,
                size: 17,
                known_hash: None,
                is_backup: false,
                thumbnail_replay_dir: None,
            },
            ReplayCandidate {
                path: unique_path.clone(),
                original_path: unique_path,
                file_name: "unique.rep".to_string(),
                modified: 150,
                size: 22,
                known_hash: None,
                is_backup: false,
                thumbnail_replay_dir: None,
            },
        ];

        let (deduped, errors) = dedupe_replay_candidates_by_hash(candidates);

        assert!(errors.is_empty());
        assert_eq!(deduped.len(), 2);
        assert!(deduped
            .iter()
            .any(|candidate| candidate.file_name == "second.rep"));
        assert!(deduped
            .iter()
            .any(|candidate| candidate.file_name == "unique.rep"));

        let _ = fs::remove_dir_all(&root);
    }
}
