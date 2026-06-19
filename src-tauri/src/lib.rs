use std::collections::{BTreeMap, HashMap};
use std::env;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_shell::ShellExt;

const DEFAULT_STEAM_GAME_DIR: &str = r"C:\Program Files (x86)\Steam\steamapps\common\War of Dots";
const FPS: f64 = 30.0;
const GAME_DIR_NAME: &str = "War of Dots";
const DEFAULT_SAMPLE_DELTA_MAX_BYTES: usize = 2 * 1024 * 1024;
const DEFAULT_SAMPLE_DELTA_MAX_RECORD_BYTES: usize = 8 * 1024 * 1024;
const MAX_SAMPLE_DELTA_RECORDS: usize = 600;
const MAX_STATS_META_BYTES: u64 = 8 * 1024 * 1024;
const REPLAY_PLAYER_LABEL: &str = "replayPlayer";

#[derive(Serialize)]
struct UnitAssetsPayload {
    asset_dir: String,
    assets: BTreeMap<String, String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlayerSummary {
    name: String,
    team_index: usize,
    winner: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReplaySummary {
    file_name: String,
    file_path: String,
    players: Vec<PlayerSummary>,
    length: String,
    duration_seconds: u64,
    thumbnail_data_url: Option<String>,
    modified: u64,
}

struct ParsedReplay {
    summary: ReplaySummary,
    result: Option<Value>,
    event_winner_index: Option<usize>,
    map_id: Option<String>,
    custom_map_surface: Option<String>,
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

fn file_modified_millis(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .map(system_time_millis)
        .unwrap_or(0)
}

fn read_json_file(path: &Path) -> Option<Value> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn sample_delta_max_bytes() -> usize {
    env::var("WOD_SAMPLE_DELTA_MAX_BYTES")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(DEFAULT_SAMPLE_DELTA_MAX_BYTES)
        .clamp(64 * 1024, 8 * 1024 * 1024)
}

fn sample_delta_max_record_bytes() -> usize {
    env::var("WOD_SAMPLE_DELTA_MAX_RECORD_BYTES")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(DEFAULT_SAMPLE_DELTA_MAX_RECORD_BYTES)
        .clamp(256 * 1024, 16 * 1024 * 1024)
}

fn read_stats_meta_file(path: &Path) -> Option<Value> {
    let metadata = fs::metadata(path).ok()?;
    if metadata.len() > MAX_STATS_META_BYTES {
        return None;
    }
    let mut value = read_json_file(path)?;
    if let Value::Object(object) = &mut value {
        let embedded_sample_count = object
            .get("samples")
            .and_then(Value::as_array)
            .map(|samples| samples.len());
        object.insert("samples".to_string(), Value::Array(Vec::new()));
        if let Some(summary) = object.get_mut("summary").and_then(Value::as_object_mut) {
            if let Some(count) = embedded_sample_count {
                summary
                    .entry("embedded_sample_count".to_string())
                    .or_insert_with(|| json!(count));
                summary
                    .entry("sample_count".to_string())
                    .or_insert_with(|| json!(count));
            }
        }
    }
    Some(value)
}

fn latest_progress_event(path: &Path) -> (Option<Value>, usize) {
    let Ok(text) = fs::read_to_string(path) else {
        return (None, 0);
    };
    let mut latest = None;
    let mut count = 0;
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        if let Ok(value) = serde_json::from_str::<Value>(line) {
            latest = Some(value);
            count += 1;
        }
    }
    (latest, count)
}

fn steam_game_dir() -> PathBuf {
    env::var_os("WOD_STEAM_GAME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(DEFAULT_STEAM_GAME_DIR))
}

fn png_data_url(path: &Path) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    Some(format!("data:image/png;base64,{}", BASE64.encode(bytes)))
}

fn discover_replay_dirs() -> Vec<PathBuf> {
    discover_steamapps_dirs()
        .into_iter()
        .map(|steamapps| steamapps.join("common").join(GAME_DIR_NAME).join("replays"))
        .filter(|path| path.is_dir())
        .fold(Vec::new(), |mut replay_dirs, path| {
            push_unique_path(&mut replay_dirs, path);
            replay_dirs
        })
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

fn detect_home_player(replays: &[ParsedReplay]) -> Option<String> {
    let mut counts: HashMap<String, (usize, String)> = HashMap::new();

    for replay in replays {
        for player in &replay.summary.players {
            if is_fallback_player_name(&player.name) {
                continue;
            }

            let key = player.name.to_ascii_lowercase();
            let entry = counts.entry(key).or_insert((0, player.name.clone()));
            entry.0 += 1;
        }
    }

    let mut counts = counts.into_iter().collect::<Vec<_>>();
    counts.sort_by(
        |(_, (left_count, left_name)), (_, (right_count, right_name))| {
            right_count
                .cmp(left_count)
                .then_with(|| left_name.cmp(right_name))
        },
    );

    counts.into_iter().next().map(|(key, _)| key)
}

fn is_fallback_player_name(name: &str) -> bool {
    let Some(number) = name.strip_prefix("Player ") else {
        return false;
    };

    number.parse::<usize>().is_ok()
}

fn put_home_player_first(players: &mut [PlayerSummary], home_player: &str) {
    if let Some(index) = players
        .iter()
        .position(|player| player.name.eq_ignore_ascii_case(home_player))
    {
        players.swap(0, index);
    }
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

    let raw: Value = serde_json::from_slice(&json_bytes).map_err(|error| error.to_string())?;
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
    let names = replay_player_names(&raw);
    let players: Vec<PlayerSummary> = names
        .into_iter()
        .enumerate()
        .map(|(team_index, name)| PlayerSummary {
            name,
            team_index,
            winner: false,
        })
        .collect();

    let end_frame = replay_end_frame(&raw);
    let duration_seconds = duration_seconds(end_frame);
    let event_winner_index = replay_event_winner_index(&raw, players.len());

    Ok(ParsedReplay {
        summary: ReplaySummary {
            file_name,
            file_path: path.to_string_lossy().to_string(),
            players,
            length: format_duration_seconds(duration_seconds),
            duration_seconds,
            thumbnail_data_url: None,
            modified,
        },
        result: raw.get("result").cloned(),
        event_winner_index,
        map_id: replay_map_id(&raw),
        custom_map_surface: custom_map_surface(&raw),
    })
}

fn replay_player_names(raw: &Value) -> Vec<String> {
    let mut names = raw
        .get("player_usernames")
        .and_then(Value::as_array)
        .map(|players| {
            players
                .iter()
                .take(4)
                .enumerate()
                .map(|(index, name)| clean_player_name(&flatten_name(name), index))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    while names.len() < 2 {
        names.push(fallback_player_name(names.len()));
    }

    names
}

fn flatten_name(value: &Value) -> String {
    match value {
        Value::Array(values) => values
            .iter()
            .map(flatten_name)
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" / "),
        Value::String(text) => text.trim().to_string(),
        Value::Number(number) => number.to_string(),
        Value::Bool(flag) => flag.to_string(),
        Value::Null | Value::Object(_) => String::new(),
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

fn mark_winner(players: &mut [PlayerSummary], winner_index: Option<usize>) {
    for (index, player) in players.iter_mut().enumerate() {
        player.winner = winner_index == Some(index);
    }
}

fn replay_winner_index(
    result: Option<&Value>,
    players: &[PlayerSummary],
    event_winner_index: Option<usize>,
) -> Option<usize> {
    if let Some(result) = result {
        if let Some(index) = result_player_name_index(result, players) {
            return Some(index);
        }
    }

    if let Some(index) = event_winner_index {
        return Some(index);
    }

    result.and_then(|result| result_special_winner_index(result, players))
}

fn result_player_name_index(result: &Value, players: &[PlayerSummary]) -> Option<usize> {
    let text = result.as_str()?;
    let normalized = clean_player_name(text, 0).to_ascii_lowercase();

    players
        .iter()
        .position(|player| player.name.to_ascii_lowercase() == normalized)
}

fn result_special_winner_index(result: &Value, players: &[PlayerSummary]) -> Option<usize> {
    if let Some(index) = result.as_i64() {
        if index == -1 && players.len() == 2 {
            return Some(1);
        }

        return None;
    }

    let text = result.as_str()?;
    let index = text.parse::<i64>().ok()?;
    if index == -1 && players.len() == 2 {
        return Some(1);
    }

    None
}

fn replay_event_winner_index(raw: &Value, player_count: usize) -> Option<usize> {
    if player_count != 2 {
        return None;
    }

    production_zone_winner_index(raw, player_count)
}

fn production_zone_winner_index(raw: &Value, player_count: usize) -> Option<usize> {
    let end_frame = replay_end_frame(raw);
    let mut candidates = vec![None; player_count];

    let Some(object) = raw.as_object() else {
        return None;
    };

    for (frame_key, frame_value) in object {
        let Ok(frame) = frame_key.parse::<f64>() else {
            continue;
        };
        let Some(frame_events) = frame_value.as_object() else {
            continue;
        };

        for (event_key, event_value) in frame_events {
            let Some(index) = production_player_index(event_key, player_count) else {
                continue;
            };
            let Some(zones) = event_value
                .get("zone")
                .and_then(Value::as_array)
                .map(Vec::len)
                .filter(|zones| *zones > 0)
            else {
                continue;
            };

            let candidate = ProductionZoneCandidate {
                index,
                frame,
                zones,
            };

            if end_frame <= 0.0 || end_frame - frame <= FPS * 90.0 {
                push_better_zone_candidate(&mut candidates[index], candidate);
            }
        }
    }

    production_zone_candidate_winner(&candidates)
}

#[derive(Clone, Copy)]
struct ProductionZoneCandidate {
    index: usize,
    frame: f64,
    zones: usize,
}

fn production_player_index(key: &str, player_count: usize) -> Option<usize> {
    let index = key.strip_prefix("production")?.parse::<usize>().ok()?;
    (index < player_count).then_some(index)
}

fn push_better_zone_candidate(
    best: &mut Option<ProductionZoneCandidate>,
    candidate: ProductionZoneCandidate,
) {
    let is_better = match best {
        Some(current) => {
            candidate.zones > current.zones
                || (candidate.zones == current.zones && candidate.frame > current.frame)
        }
        None => true,
    };

    if is_better {
        *best = Some(candidate);
    }
}

fn production_zone_candidate_winner(
    candidates: &[Option<ProductionZoneCandidate>],
) -> Option<usize> {
    let mut best: Option<ProductionZoneCandidate> = None;
    let mut tied = false;

    for candidate in candidates.iter().flatten().copied() {
        match best {
            Some(current) if candidate.zones > current.zones => {
                best = Some(candidate);
                tied = false;
            }
            Some(current) if candidate.zones == current.zones => {
                tied = true;
            }
            None => {
                best = Some(candidate);
                tied = false;
            }
            _ => {}
        }
    }

    (!tied).then_some(best?.index)
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
        _ => return None,
    };

    (!id.is_empty() && id != "custom").then_some(id)
}

fn custom_map_surface(raw: &Value) -> Option<String> {
    raw.get("custom_map")
        .and_then(|custom_map| custom_map.get("map_surface"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|surface| !surface.is_empty())
        .map(ToOwned::to_owned)
}

fn thumbnail_for_replay(
    replay_dir: &Path,
    replay: &ParsedReplay,
    map_cache: &mut HashMap<String, Option<String>>,
) -> Option<String> {
    if let Some(surface) = replay.custom_map_surface.as_deref() {
        if surface.starts_with("data:image/") {
            return Some(surface.to_string());
        }

        return Some(format!("data:image/png;base64,{surface}"));
    }

    let map_id = replay.map_id.as_deref()?;
    let game_root = replay_dir.parent()?;
    let cache_key = format!("{}|{map_id}", path_key(game_root));
    if let Some(cached) = map_cache.get(&cache_key) {
        return cached.clone();
    }

    let data_url = map_image_data_url(game_root, map_id);
    map_cache.insert(cache_key, data_url.clone());
    data_url
}

fn map_image_data_url(game_root: &Path, map_id: &str) -> Option<String> {
    let safe_map_id = map_id
        .chars()
        .filter(|character| character.is_ascii_digit())
        .collect::<String>();
    if safe_map_id.is_empty() {
        return None;
    }

    let file_name = format!("map{safe_map_id}.png");
    let path = game_root.join("assets").join("fahero_maps").join(file_name);
    png_data_url(&path)
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

async fn run_backend(
    app: &AppHandle,
    command: &str,
    extra_args: Vec<String>,
) -> Result<Value, String> {
    let runtime_dir = app_runtime_dir(app)?;
    let mut args = vec![
        "--desktop-command".to_string(),
        command.to_string(),
        "--runtime-dir".to_string(),
        runtime_dir.to_string_lossy().to_string(),
        "--owner-pid".to_string(),
        process::id().to_string(),
    ];
    args.extend(extra_args);

    let output = app
        .shell()
        .sidecar("wod-replay-server")
        .map_err(|error| error.to_string())?
        .args(args)
        .output()
        .await
        .map_err(|error| error.to_string())?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() {
        let message = if stdout.trim().is_empty() {
            stderr.trim().to_string()
        } else {
            stdout.trim().to_string()
        };
        return Err(if message.is_empty() {
            "Backend command failed without output.".to_string()
        } else {
            message
        });
    }

    serde_json::from_str(stdout.trim()).map_err(|error| {
        format!(
            "Backend returned invalid JSON: {error}. stdout={:?} stderr={:?}",
            stdout.trim(),
            stderr.trim()
        )
    })
}

#[tauri::command]
async fn backend_status(app: AppHandle) -> Result<Value, String> {
    run_backend(&app, "health", Vec::new()).await
}

#[tauri::command]
async fn stage_game(app: AppHandle) -> Result<Value, String> {
    run_backend(&app, "stage-game", Vec::new()).await
}

#[tauri::command]
async fn list_jobs(app: AppHandle) -> Result<Value, String> {
    run_backend(
        &app,
        "list-jobs",
        vec!["--limit".to_string(), "20".to_string()],
    )
    .await
}

#[tauri::command]
fn list_replays(_app: AppHandle) -> Result<Vec<ReplaySummary>, String> {
    let replay_dirs = discover_replay_dirs();
    if replay_dirs.is_empty() {
        return Ok(Vec::new());
    }

    let mut map_cache = HashMap::new();
    let mut parsed_replays = Vec::new();

    for replay_dir in replay_dirs {
        let entries = fs::read_dir(&replay_dir).map_err(|error| {
            format!(
                "Could not read replay folder {}: {error}",
                replay_dir.display()
            )
        })?;

        for entry in entries.flatten() {
            let path = entry.path();
            if !is_replay_file(&path) {
                continue;
            }

            match parse_replay(&path) {
                Ok(mut parsed) => {
                    parsed.summary.thumbnail_data_url =
                        thumbnail_for_replay(&replay_dir, &parsed, &mut map_cache);
                    parsed_replays.push(parsed);
                }
                Err(error) => {
                    eprintln!("Skipping {}: {error}", path.display());
                }
            }
        }
    }

    let home_player = detect_home_player(&parsed_replays);
    let mut replays = parsed_replays
        .into_iter()
        .map(|mut parsed| {
            let winner_index = replay_winner_index(
                parsed.result.as_ref(),
                &parsed.summary.players,
                parsed.event_winner_index,
            );
            mark_winner(&mut parsed.summary.players, winner_index);

            if let Some(home_player) = home_player.as_deref() {
                put_home_player_first(&mut parsed.summary.players, home_player);
            }
            parsed.summary
        })
        .collect::<Vec<_>>();

    replays.sort_by(|a, b| {
        b.modified
            .cmp(&a.modified)
            .then_with(|| a.file_name.cmp(&b.file_name))
    });

    Ok(replays)
}

#[tauri::command]
async fn get_job(app: AppHandle, job_id: String) -> Result<Value, String> {
    run_backend(&app, "job", vec!["--job-id".to_string(), job_id]).await
}

#[tauri::command]
async fn capture_replay(
    app: AppHandle,
    filename: String,
    replay_base64: String,
) -> Result<Value, String> {
    let runtime_dir = app_runtime_dir(&app)?;
    let uploads_dir = runtime_dir.join("desktop-uploads");
    fs::create_dir_all(&uploads_dir).map_err(|error| error.to_string())?;

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let upload_path = uploads_dir.join(format!("{now}.rep"));
    let bytes = BASE64
        .decode(replay_base64.as_bytes())
        .map_err(|error| format!("Replay payload is not valid base64: {error}"))?;
    fs::write(&upload_path, bytes).map_err(|error| error.to_string())?;

    let result = run_backend(
        &app,
        "capture-file",
        vec![
            "--input".to_string(),
            upload_path.to_string_lossy().to_string(),
            "--filename".to_string(),
            filename,
        ],
    )
    .await;

    let _ = fs::remove_file(&upload_path);
    result
}

#[tauri::command]
async fn capture_replay_path(
    app: AppHandle,
    filename: String,
    path: String,
) -> Result<Value, String> {
    let input_path = PathBuf::from(&path);
    if !input_path.is_file() || !is_replay_file(&input_path) {
        return Err(format!("Replay file is not readable: {}", input_path.display()));
    }

    run_backend(
        &app,
        "capture-file",
        vec![
            "--input".to_string(),
            input_path.to_string_lossy().to_string(),
            "--filename".to_string(),
            filename,
        ],
    )
    .await
}

#[tauri::command]
fn replay_launch_request(
    app: AppHandle,
    launch_id: String,
) -> Result<ReplayLaunchRequest, String> {
    let path = launch_request_path(&app, &launch_id)?;
    let text = fs::read_to_string(&path)
        .map_err(|error| format!("Could not read replay launch request {}: {error}", path.display()))?;
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
fn open_replay_window(
    app: AppHandle,
    file_name: String,
    file_path: String,
) -> Result<String, String> {
    let replay_path = PathBuf::from(&file_path);
    if !replay_path.is_file() || !is_replay_file(&replay_path) {
        return Err(format!("Replay file is not readable: {}", replay_path.display()));
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

    let window = app
        .get_webview_window(REPLAY_PLAYER_LABEL)
        .ok_or_else(|| "Replay player window is not available. Restart the app and try again.".to_string())?;
    window
        .set_title(&format!("War of Dots Replay - {}", request.file_name))
        .map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.unminimize().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    let _ = window.emit("replay-launch", request);
    Ok(REPLAY_PLAYER_LABEL.to_string())
}

#[tauri::command]
async fn capture_sample_delta(app: AppHandle, job_id: String, offset: u64) -> Result<Value, String> {
    if job_id.is_empty() || !job_id.chars().all(|char| char.is_ascii_hexdigit()) {
        return Err("Invalid job id.".to_string());
    }
    let runtime_dir = app_runtime_dir(&app)?;
    let root = runtime_dir.join("jobs").join(job_id);
    let sample_path = root.join("stats.json.samples.jsonl");
    let meta_path = root.join("stats.json.partial.meta.json");
    let final_stats_path = root.join("stats.json");
    let meta = read_json_file(&meta_path);
    let final_stats = read_stats_meta_file(&final_stats_path);

    let Ok(metadata) = fs::metadata(&sample_path) else {
        return Ok(json!({
            "found": false,
            "offset": 0u64,
            "samples": [],
            "meta": meta,
            "final_stats": final_stats,
        }));
    };

    let len = metadata.len();
    let start = offset.min(len);
    let mut file = File::open(&sample_path).map_err(|error| format!("Could not open {}: {error}", sample_path.display()))?;
    file.seek(SeekFrom::Start(start))
        .map_err(|error| format!("Could not seek {}: {error}", sample_path.display()))?;

    let max_bytes = sample_delta_max_bytes();
    let max_record_bytes = sample_delta_max_record_bytes();
    let mut reader = BufReader::new(file);
    let mut consumed = 0u64;
    let mut samples = Vec::new();
    let mut largest_record_bytes = 0usize;

    loop {
        if samples.len() >= MAX_SAMPLE_DELTA_RECORDS {
            break;
        }
        if consumed as usize >= max_bytes && !samples.is_empty() {
            break;
        }

        let mut line = String::new();
        let bytes_read = reader
            .read_line(&mut line)
            .map_err(|error| format!("Could not read {}: {error}", sample_path.display()))?;
        if bytes_read == 0 {
            break;
        }
        if bytes_read > max_record_bytes {
            return Err(format!(
                "Sample stream record is too large: {} bytes at offset {} in {}. Increase WOD_SAMPLE_DELTA_MAX_RECORD_BYTES if this replay is expected.",
                bytes_read,
                start.saturating_add(consumed),
                sample_path.display()
            ));
        }
        if !line.ends_with('\n') && start.saturating_add(consumed).saturating_add(bytes_read as u64) >= len {
            break;
        }

        consumed = consumed.saturating_add(bytes_read as u64);
        largest_record_bytes = largest_record_bytes.max(bytes_read);
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
            samples.push(value);
        }
    }
    let next_offset = start.saturating_add(consumed).min(len);

    Ok(json!({
        "found": true,
        "offset": next_offset,
        "samples": samples,
        "meta": meta,
        "final_stats": final_stats,
        "stream_bytes": len,
        "read_bytes": consumed,
        "record_bytes": largest_record_bytes,
        "records_read": samples.len(),
    }))
}

#[tauri::command]
async fn unit_assets() -> Result<UnitAssetsPayload, String> {
    let asset_dir = steam_game_dir().join("assets");
    let colors = ["blue", "red", "purple", "orange"];
    let mut names = Vec::new();
    for color in colors {
        for suffix in [
            "inf1",
            "inf2",
            "inf3",
            "tank1",
            "tank2",
            "tank3",
            "ship",
            "heavy_ship",
        ] {
            names.push(format!("{color}_{suffix}"));
        }
    }
    names.push("black_ship".to_string());
    names.push("capital".to_string());
    names.push("city_icon".to_string());
    for color in colors {
        names.push(format!("{color}_flag"));
    }

    let mut assets = BTreeMap::new();
    for name in names {
        let path = asset_dir.join(format!("{name}.png"));
        if let Some(data_url) = png_data_url(&path) {
            assets.insert(name, data_url);
        }
    }

    Ok(UnitAssetsPayload {
        asset_dir: asset_dir.to_string_lossy().to_string(),
        assets,
    })
}

#[tauri::command]
async fn capture_progress(
    app: AppHandle,
    filename: String,
    started_after_ms: u64,
) -> Result<Value, String> {
    let runtime_dir = app_runtime_dir(&app)?;
    let jobs_dir = runtime_dir.join("jobs");
    let mut best: Option<(u64, PathBuf, Value)> = None;
    let mut fallback_best: Option<(u64, PathBuf, Value)> = None;
    let cutoff = started_after_ms.saturating_sub(15_000);

    let entries = fs::read_dir(&jobs_dir)
        .map_err(|error| format!("Could not read {}: {error}", jobs_dir.display()))?;
    for entry in entries.flatten() {
        let root = entry.path();
        if !root.is_dir() {
            continue;
        }
        let job_path = root.join("job.json");
        let Some(job) = read_json_file(&job_path) else {
            continue;
        };
        let filename_matches = job.get("filename").and_then(Value::as_str) == Some(filename.as_str());
        let progress_path = root.join("live-capture-artifact.json.progress.jsonl");
        let stats_path = root.join("stats.json");
        let partial_meta_path = root.join("stats.json.partial.meta.json");
        let sample_stream_path = root.join("stats.json.samples.jsonl");
        let artifact_path = root.join("live-capture-artifact.json");
        let latest_mtime = [
            file_modified_millis(&job_path),
            file_modified_millis(&progress_path),
            file_modified_millis(&stats_path),
            file_modified_millis(&partial_meta_path),
            file_modified_millis(&sample_stream_path),
            file_modified_millis(&artifact_path),
        ]
        .into_iter()
        .max()
        .unwrap_or(0);
        if latest_mtime < cutoff {
            continue;
        }
        if filename_matches {
            if best
                .as_ref()
                .map(|(mtime, _, _)| latest_mtime > *mtime)
                .unwrap_or(true)
            {
                best = Some((latest_mtime, root, job));
            }
        } else if fallback_best
            .as_ref()
            .map(|(mtime, _, _)| latest_mtime > *mtime)
            .unwrap_or(true)
        {
            fallback_best = Some((latest_mtime, root, job));
        }
    }

    let Some((latest_mtime_ms, root, job)) = best.or(fallback_best) else {
        return Ok(json!({ "found": false }));
    };

    let progress_path = root.join("live-capture-artifact.json.progress.jsonl");
    let artifact_path = root.join("live-capture-artifact.json");
    let stats_path = root.join("stats.json");
    let partial_meta_path = root.join("stats.json.partial.meta.json");
    let (event, event_count) = latest_progress_event(&progress_path);
    let artifact = read_json_file(&artifact_path);
    let stats = read_stats_meta_file(&stats_path);
    let partial_stats = read_json_file(&partial_meta_path);
    let stats_summary = stats.as_ref().and_then(|value| {
        let summary = value.get("summary").cloned().unwrap_or(Value::Null);
        let samples = summary
            .get("sample_count")
            .and_then(Value::as_u64)
            .or_else(|| value.get("samples").and_then(Value::as_array).map(|items| items.len() as u64))
            .unwrap_or(0);
        Some(json!({
            "source": value.get("source"),
            "sample_rate_hz": value.get("sample_rate_hz"),
            "sample_count": samples,
            "summary": summary,
            "replay_metadata": value.get("replay_metadata").cloned().unwrap_or(Value::Null),
        }))
    });
    let partial_stats_summary = partial_stats.as_ref().and_then(|value| {
        let summary = value.get("summary").cloned().unwrap_or(Value::Null);
        let samples = summary
            .get("sample_count")
            .and_then(Value::as_u64)
            .or_else(|| value.get("samples").and_then(Value::as_array).map(|items| items.len() as u64))
            .unwrap_or(0);
        Some(json!({
            "source": value.get("source"),
            "sample_rate_hz": value.get("sample_rate_hz"),
            "sample_count": samples,
            "summary": summary,
            "replay_metadata": value.get("replay_metadata").cloned().unwrap_or(Value::Null),
        }))
    });
    let artifact_summary = artifact.as_ref().map(|value| {
        json!({
            "status": value.get("status"),
            "completion": value.get("completion").cloned().unwrap_or(Value::Null),
            "validation": value.get("validation").cloned().unwrap_or(Value::Null),
            "capture_config": value.get("capture_config").cloned().unwrap_or(Value::Null),
        })
    });

    Ok(json!({
        "found": true,
        "latest_mtime_ms": latest_mtime_ms,
        "job": job,
        "event": event,
        "event_count": event_count,
        "artifact": artifact_summary,
        "stats": stats_summary,
        "partial_stats": partial_stats_summary,
    }))
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
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
            backend_status,
            stage_game,
            list_jobs,
            list_replays,
            get_job,
            capture_replay,
            capture_replay_path,
            replay_launch_request,
            current_replay_launch_request,
            open_replay_window,
            capture_sample_delta,
            unit_assets,
            capture_progress
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tauri application");
}
