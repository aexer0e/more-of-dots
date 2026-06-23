use std::collections::{BTreeMap, HashMap};
use std::env;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, ErrorKind, Read, Seek, SeekFrom, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{self, Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{
    AppHandle, LogicalSize, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_shell::ShellExt;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const DEFAULT_STEAM_GAME_DIR: &str = r"C:\Program Files (x86)\Steam\steamapps\common\War of Dots";
const FPS: f64 = 30.0;
const GAME_DIR_NAME: &str = "War of Dots";
const DEFAULT_SAMPLE_DELTA_MAX_BYTES: usize = 2 * 1024 * 1024;
const DEFAULT_SAMPLE_DELTA_MAX_RECORD_BYTES: usize = 8 * 1024 * 1024;
const MAX_SAMPLE_DELTA_RECORDS: usize = 600;
const MAX_STATS_META_BYTES: u64 = 8 * 1024 * 1024;
const REPLAY_PLAYER_LABEL: &str = "replayPlayer";
const REPLAY_PLAYER_WIDTH: f64 = 960.0;
const REPLAY_PLAYER_HEIGHT: f64 = 540.0;
const REPLAY_BACKUP_DIR_NAME: &str = "replay-backups";
const USER_DATA_CHECKPOINT_FILE_NAME: &str = "user-data-checkpoints.json";
const DEFAULT_USER_DATA_URL: &str = "ws://cs.war-of-dots.com:9056";
const DEFAULT_USER_DATA_VERSION: &str = "1.2.18.3";
const USER_DATA_WAIT: Duration = Duration::from_millis(700);
const USER_DATA_CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const USER_DATA_EXPORT_WAIT: Duration = Duration::from_secs(8);
const USER_DATA_PERMISSIONS: &[&str] = &[
    "authorize",
    "registration_emailverification",
    "registration_emailconfirmation",
    "registration_steamid",
    "login_emailverification",
    "login_emailconfirmation",
    "login_steamid",
];

const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Default)]
struct WindowOwnerProcesses {
    children: Mutex<HashMap<String, Child>>,
}

fn spawn_owner_process(label: &str) -> Result<Child, String> {
    let mut command = Command::new("powershell.exe");
    command
        .arg("-NoProfile")
        .arg("-WindowStyle")
        .arg("Hidden")
        .arg("-Command")
        .arg(format!(
            "$Host.UI.RawUI.WindowTitle = 'More of Dots owner {label}'; Start-Sleep -Seconds 2147483"
        ))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
        .spawn()
        .map_err(|error| format!("Could not start replay window owner process: {error}"))
}

fn owner_pid_for_window(app: &AppHandle, label: &str) -> Result<u32, String> {
    let owners = app.state::<WindowOwnerProcesses>();
    let mut children = owners
        .children
        .lock()
        .map_err(|_| "Replay owner process registry is unavailable.".to_string())?;

    let needs_spawn = match children.get_mut(label) {
        Some(child) => child
            .try_wait()
            .map_err(|error| format!("Could not inspect replay owner process: {error}"))?
            .is_some(),
        None => true,
    };
    if needs_spawn {
        children.insert(label.to_string(), spawn_owner_process(label)?);
    }

    children
        .get(label)
        .map(Child::id)
        .ok_or_else(|| "Replay owner process was not registered.".to_string())
}

fn stop_all_owner_processes(app: &AppHandle) {
    let owners = app.state::<WindowOwnerProcesses>();
    let Ok(mut children) = owners.children.lock() else {
        return;
    };

    for (_, mut child) in children.drain() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

impl Drop for WindowOwnerProcesses {
    fn drop(&mut self) {
        let Ok(children) = self.children.get_mut() else {
            return;
        };

        for (_, mut child) in children.drain() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

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
    score_delta: Option<i64>,
}

struct ParsedReplay {
    summary: ReplaySummary,
    result: Option<Value>,
    event_winner_index: Option<usize>,
    map_id: Option<String>,
    custom_map_surface: Option<String>,
}

#[derive(Clone)]
struct ReplayCandidate {
    hash: String,
    path: PathBuf,
    original_path: PathBuf,
    file_name: String,
    modified: u64,
    thumbnail_replay_dir: Option<PathBuf>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct UserDataCheckpoint {
    fetched_at: u64,
    username: Option<String>,
    source: String,
    fields: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct UserDataCheckpointStore {
    version: u32,
    initialized_at: u64,
    checkpoints: Vec<UserDataCheckpoint>,
}

struct UserScoreLookup {
    score: i64,
    username: Option<String>,
    user_data: Value,
    messages: Vec<Value>,
    source: String,
}

struct GameLogin {
    username: Option<String>,
    password: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct WindowsGameProcess {
    process_id: Option<u32>,
    executable_path: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum UserDataLookupMode {
    Automatic,
    Manual,
}

#[derive(Clone, Copy)]
enum UserDataFrameFormat {
    Wrapped,
    Binary,
    Text,
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

fn now_unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn replay_backup_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let path = app_runtime_dir(app)?.join(REPLAY_BACKUP_DIR_NAME);
    fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    Ok(path)
}

fn user_data_checkpoint_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_runtime_dir(app)?.join(USER_DATA_CHECKPOINT_FILE_NAME))
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

fn backup_replay_file(
    source_path: &Path,
    hash: &str,
    backup_dir: &Path,
) -> Result<PathBuf, String> {
    if source_path
        .parent()
        .is_some_and(|parent| path_key(parent) == path_key(backup_dir))
    {
        return Ok(source_path.to_path_buf());
    }

    let target = existing_backup_path(backup_dir, hash)
        .unwrap_or_else(|| backup_path_for_hash(backup_dir, hash, source_path));
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

fn insert_candidate(candidates: &mut HashMap<String, ReplayCandidate>, candidate: ReplayCandidate) {
    candidates
        .entry(candidate.hash.clone())
        .and_modify(|existing| {
            if existing.thumbnail_replay_dir.is_none() && candidate.thumbnail_replay_dir.is_some() {
                existing.thumbnail_replay_dir = candidate.thumbnail_replay_dir.clone();
            }
            if candidate.modified > existing.modified {
                existing.modified = candidate.modified;
                existing.file_name = candidate.file_name.clone();
                existing.original_path = candidate.original_path.clone();
            }
        })
        .or_insert(candidate);
}

fn collect_replay_candidates(app: &AppHandle) -> Result<Vec<ReplayCandidate>, String> {
    let backup_dir = replay_backup_dir(app)?;
    let replay_dirs = discover_replay_dirs();
    let fallback_thumbnail_dir = replay_dirs.first().cloned();
    let mut candidates: HashMap<String, ReplayCandidate> = HashMap::new();

    for replay_dir in &replay_dirs {
        let entries = fs::read_dir(replay_dir).map_err(|error| {
            format!(
                "Could not read replay folder {}: {error}",
                replay_dir.display()
            )
        })?;

        for entry in entries.flatten() {
            let source_path = entry.path();
            if !source_path.is_file() || !is_replay_file(&source_path) {
                continue;
            }

            let hash = sha256_file(&source_path)?;
            let backup_path = backup_replay_file(&source_path, &hash, &backup_dir)?;
            let modified = source_path
                .metadata()
                .and_then(|metadata| metadata.modified())
                .ok()
                .and_then(system_time_to_secs)
                .unwrap_or(0);
            insert_candidate(
                &mut candidates,
                ReplayCandidate {
                    hash,
                    path: backup_path,
                    original_path: source_path.clone(),
                    file_name: candidate_file_name(&source_path),
                    modified,
                    thumbnail_replay_dir: Some(replay_dir.clone()),
                },
            );
        }
    }

    let backup_entries = fs::read_dir(&backup_dir).map_err(|error| {
        format!(
            "Could not read replay backup folder {}: {error}",
            backup_dir.display()
        )
    })?;
    for entry in backup_entries.flatten() {
        let backup_path = entry.path();
        if !backup_path.is_file() || !is_replay_file(&backup_path) {
            continue;
        }

        let hash = backup_path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .filter(|stem| {
                stem.len() == 64 && stem.chars().all(|character| character.is_ascii_hexdigit())
            })
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| sha256_file(&backup_path).unwrap_or_default());
        if hash.is_empty() {
            continue;
        }

        let modified = backup_path
            .metadata()
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(system_time_to_secs)
            .unwrap_or(0);
        insert_candidate(
            &mut candidates,
            ReplayCandidate {
                hash,
                path: backup_path.clone(),
                original_path: backup_path.clone(),
                file_name: candidate_file_name(&backup_path),
                modified,
                thumbnail_replay_dir: fallback_thumbnail_dir.clone(),
            },
        );
    }

    let mut candidates = candidates.into_values().collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        right
            .modified
            .cmp(&left.modified)
            .then_with(|| left.file_name.cmp(&right.file_name))
    });
    Ok(candidates)
}

fn load_user_data_checkpoint_store(path: &Path) -> UserDataCheckpointStore {
    let Some(value) = read_json_file(path) else {
        return UserDataCheckpointStore {
            version: 1,
            initialized_at: now_unix_secs(),
            checkpoints: Vec::new(),
        };
    };

    let mut store = serde_json::from_value::<UserDataCheckpointStore>(value).unwrap_or_default();
    if store.version == 0 {
        store.version = 1;
    }
    if store.initialized_at == 0 {
        store.initialized_at = now_unix_secs();
    }
    store
}

fn write_user_data_checkpoint_store(
    path: &Path,
    store: &UserDataCheckpointStore,
) -> Result<(), String> {
    let text = serde_json::to_string_pretty(store).map_err(|error| error.to_string())?;
    fs::write(path, text).map_err(|error| format!("Could not write {}: {error}", path.display()))
}

fn latest_checkpoint_score(store: &UserDataCheckpointStore) -> Option<i64> {
    store
        .checkpoints
        .iter()
        .rev()
        .find_map(|checkpoint| checkpoint.fields.get("score").and_then(value_as_i64))
}

fn checkpoint_field_is_interesting(path: &str) -> bool {
    let path = path.to_ascii_lowercase();
    [
        "score",
        "elo",
        "rating",
        "rank",
        "win",
        "loss",
        "game",
        "match",
        "played",
        "dev",
        "beat",
        "beaten",
        "achievement",
        "badge",
        "medal",
        "streak",
        "tournament",
        "level",
        "xp",
    ]
    .iter()
    .any(|word| path.contains(word))
}

fn checkpoint_value(value: &Value) -> Option<Value> {
    match value {
        Value::Bool(_) | Value::Number(_) => Some(value.clone()),
        Value::String(text) if text.len() <= 128 => Some(Value::String(text.clone())),
        _ => None,
    }
}

fn collect_checkpoint_fields(
    value: &Value,
    prefix: &str,
    depth: usize,
    fields: &mut BTreeMap<String, Value>,
) {
    if depth > 5 || fields.len() >= 80 {
        return;
    }

    match value {
        Value::Object(object) => {
            for (key, child) in object {
                if matches!(
                    key.to_ascii_lowercase().as_str(),
                    "password" | "token" | "session" | "cookie" | "auth"
                ) {
                    continue;
                }
                let path = if prefix.is_empty() {
                    key.clone()
                } else {
                    format!("{prefix}.{key}")
                };
                collect_checkpoint_fields(child, &path, depth + 1, fields);
                if fields.len() >= 80 {
                    break;
                }
            }
        }
        Value::Array(items) => {
            for (index, child) in items.iter().take(20).enumerate() {
                collect_checkpoint_fields(child, &format!("{prefix}.{index}"), depth + 1, fields);
                if fields.len() >= 80 {
                    break;
                }
            }
        }
        _ if checkpoint_field_is_interesting(prefix) => {
            if let Some(value) = checkpoint_value(value) {
                fields.insert(prefix.to_string(), value);
            }
        }
        _ => {}
    }
}

fn user_data_checkpoint_fields(lookup: &UserScoreLookup) -> BTreeMap<String, Value> {
    let mut fields = BTreeMap::new();
    fields.insert("score".to_string(), json!(lookup.score));
    collect_checkpoint_fields(&lookup.user_data, "", 0, &mut fields);
    fields
}

fn append_user_data_checkpoint_if_changed(
    store: &mut UserDataCheckpointStore,
    lookup: &UserScoreLookup,
    fetched_at: u64,
) {
    let fields = user_data_checkpoint_fields(lookup);
    if fields.is_empty() {
        return;
    }
    if store.checkpoints.last().is_some_and(|checkpoint| {
        checkpoint.username == lookup.username && checkpoint.fields == fields
    }) {
        return;
    }

    store.checkpoints.push(UserDataCheckpoint {
        fetched_at,
        username: lookup.username.clone(),
        source: lookup.source.clone(),
        fields,
    });

    if store.checkpoints.len() > 200 {
        let drain_count = store.checkpoints.len() - 200;
        store.checkpoints.drain(0..drain_count);
    }
}

fn checkpoint_json(checkpoint: &UserDataCheckpoint) -> Value {
    json!({
        "fetchedAt": checkpoint.fetched_at,
        "username": checkpoint.username,
        "source": checkpoint.source,
        "fields": checkpoint.fields,
        "score": checkpoint.fields.get("score").and_then(value_as_i64),
    })
}

fn env_flag(name: &str) -> bool {
    env::var(name).ok().is_some_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

fn env_flag_disabled(name: &str) -> bool {
    env::var(name).ok().is_some_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "0" | "false" | "no" | "off"
        )
    })
}

fn run_hidden_powershell(script: &str) -> Result<std::process::Output, String> {
    let mut command = Command::new("powershell.exe");
    command
        .arg("-NoProfile")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-Command")
        .arg(script)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
        .spawn()
        .and_then(|child| child.wait_with_output())
        .map_err(|error| format!("Could not run PowerShell helper: {error}"))
}

fn parse_game_processes_json(text: &str) -> Vec<WindowsGameProcess> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }

    let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
        return Vec::new();
    };
    match value {
        Value::Array(items) => items
            .into_iter()
            .filter_map(|item| serde_json::from_value(item).ok())
            .collect(),
        Value::Object(_) => serde_json::from_value(value).ok().into_iter().collect(),
        _ => Vec::new(),
    }
}

fn game_processes() -> Vec<WindowsGameProcess> {
    if !cfg!(windows) {
        return Vec::new();
    }

    let output = run_hidden_powershell(
        "Get-CimInstance Win32_Process -Filter \"Name = 'game.exe'\" | \
         Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Depth 4 -Compress",
    );
    let Ok(output) = output else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    parse_game_processes_json(&String::from_utf8_lossy(&output.stdout))
}

fn is_staged_game_process(process: &WindowsGameProcess) -> bool {
    process
        .executable_path
        .as_deref()
        .map(path_key_from_str)
        .is_some_and(|path| {
            path.contains(r"\staged-game\game.exe")
                || path.contains(r"\jobs\") && path.contains(r"\game-runtime\game.exe")
        })
}

fn real_game_processes() -> Vec<WindowsGameProcess> {
    game_processes()
        .into_iter()
        .filter(|process| process.process_id.unwrap_or(0) > 0)
        .filter(|process| !is_staged_game_process(process))
        .collect()
}

fn real_game_is_running() -> bool {
    !real_game_processes().is_empty()
}

fn path_key_from_str(value: &str) -> String {
    value.replace('/', r"\").to_ascii_lowercase()
}

fn repo_root_from_cwd() -> Option<PathBuf> {
    let mut path = env::current_dir().ok()?;
    loop {
        if path
            .join("scripts")
            .join("invoke-python-probe.ps1")
            .is_file()
            && path
                .join("tools")
                .join("python-probe-dll")
                .join("target")
                .join("release")
                .join("wod_python_probe.dll")
                .is_file()
        {
            return Some(path);
        }
        if !path.pop() {
            return None;
        }
    }
}

fn find_file_by_name(root: &Path, file_name: &str, max_depth: usize) -> Option<PathBuf> {
    if max_depth == 0 || !root.is_dir() {
        return None;
    }
    let entries = fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case(file_name))
            && path.is_file()
        {
            return Some(path);
        }
        if path.is_dir() {
            if let Some(found) = find_file_by_name(&path, file_name, max_depth - 1) {
                return Some(found);
            }
        }
    }
    None
}

fn find_python_probe_dll(app: &AppHandle) -> Option<PathBuf> {
    if let Some(path) = env::var_os("WOD_PYTHON_PROBE_DLL").map(PathBuf::from) {
        if path.is_file() {
            return Some(path);
        }
    }

    let mut candidates = Vec::new();
    if let Ok(exe) = env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("wod_python_probe.dll"));
        }
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("wod_python_probe.dll"));
        if let Some(path) = find_file_by_name(&resource_dir, "wod_python_probe.dll", 4) {
            candidates.push(path);
        }
    }
    if let Some(root) = repo_root_from_cwd() {
        candidates.push(
            root.join("tools")
                .join("python-probe-dll")
                .join("target")
                .join("release")
                .join("wod_python_probe.dll"),
        );
    }

    candidates.into_iter().find(|path| path.is_file())
}

fn find_python_probe_injector(app: &AppHandle) -> Option<PathBuf> {
    if let Some(path) = env::var_os("WOD_PYTHON_PROBE_INJECTOR").map(PathBuf::from) {
        if path.is_file() {
            return Some(path);
        }
    }

    let mut candidates = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("scripts").join("invoke-python-probe.ps1"));
        candidates.push(resource_dir.join("invoke-python-probe.ps1"));
        if let Some(path) = find_file_by_name(&resource_dir, "invoke-python-probe.ps1", 4) {
            candidates.push(path);
        }
    }
    if let Some(root) = repo_root_from_cwd() {
        candidates.push(root.join("scripts").join("invoke-python-probe.ps1"));
    }
    candidates.into_iter().find(|path| path.is_file())
}

fn quote_ps_arg(value: &Path) -> String {
    format!("'{}'", value.to_string_lossy().replace('\'', "''"))
}

fn user_data_export_payload(output_path: &Path) -> String {
    let escaped_output = output_path
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('\'', "\\'");
    format!(
        r#"
import gc
import json
import os
import time
import traceback

OUTPUT_PATH = r'''{escaped_output}'''

INTERESTING_KEYS = {{
    'username', 'user_name', 'name', 'score', 'elo', 'rating', 'rank',
    'wins', 'losses', 'games', 'stats', 'userstats', 'profile', 'account',
    'authorized', 'access', 'steamid', 'steam_id'
}}

def jsonable(value, depth=4, seen=None):
    if seen is None:
        seen = set()
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    ident = id(value)
    if ident in seen:
        return '<cycle>'
    seen.add(ident)
    if depth <= 0:
        return repr(value)[:160]
    if isinstance(value, dict):
        out = {{}}
        for index, (key, child) in enumerate(value.items()):
            if index >= 80:
                out['...'] = 'truncated'
                break
            try:
                out[str(key)] = jsonable(child, depth - 1, seen)
            except Exception as exc:
                out[str(key)] = '<failed: %r>' % exc
        return out
    if isinstance(value, (list, tuple, set)):
        return [jsonable(child, depth - 1, seen) for child in list(value)[:80]]
    attrs = getattr(value, '__dict__', None)
    if isinstance(attrs, dict):
        return jsonable(attrs, depth - 1, seen)
    return repr(value)[:160]

def value_as_int(value):
    try:
        if isinstance(value, bool):
            return None
        if isinstance(value, int):
            return value
        if isinstance(value, float):
            return int(round(value))
        if isinstance(value, str) and value.strip():
            return int(float(value.strip()))
    except Exception:
        return None
    return None

def find_score(value, depth=4):
    if depth <= 0:
        return None
    if isinstance(value, dict):
        for key in ('score', 'elo', 'rating'):
            if key in value:
                parsed = value_as_int(value.get(key))
                if parsed is not None:
                    return parsed
        for child in value.values():
            found = find_score(child, depth - 1)
            if found is not None:
                return found
    elif isinstance(value, (list, tuple)):
        for child in value[:40]:
            found = find_score(child, depth - 1)
            if found is not None:
                return found
    return None

def candidate_weight(value):
    try:
        data = value if isinstance(value, dict) else getattr(value, '__dict__', {{}})
        if not isinstance(data, dict):
            return 0
        keys = {{str(key).lower() for key in data.keys()}}
        weight = len(keys & INTERESTING_KEYS)
        if any(key in keys for key in ('score', 'elo', 'rating')):
            weight += 8
        if any(key in keys for key in ('username', 'user_name', 'name')):
            weight += 4
        if any(key in keys for key in ('stats', 'userstats', 'profile', 'account')):
            weight += 3
        return weight
    except Exception:
        return 0

def summarize_candidate(value):
    data = value if isinstance(value, dict) else getattr(value, '__dict__', {{}})
    if not isinstance(data, dict):
        data = {{}}
    payload = jsonable(data, depth=4)
    username = None
    if isinstance(payload, dict):
        for key in ('username', 'user_name', 'name'):
            item = payload.get(key)
            if isinstance(item, str) and item.strip():
                username = item.strip()
                break
    return {{
        'class': getattr(type(value), '__name__', str(type(value))),
        'score': find_score(payload),
        'username': username,
        'data': payload,
    }}

def main():
    ranked = []
    for value in gc.get_objects():
        weight = candidate_weight(value)
        if weight >= 8:
            ranked.append((weight, id(value), value))
    ranked.sort(key=lambda item: item[0], reverse=True)
    candidates = [summarize_candidate(value) for weight, ident, value in ranked[:12]]
    best = next((candidate for candidate in candidates if candidate.get('score') is not None), None)
    result = {{
        'source': 'game-json',
        'exportedAt': int(time.time()),
        'status': 'ok' if best else 'no_score_candidate',
        'candidateCount': len(ranked),
        'best': best,
        'candidates': candidates,
    }}
    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    temp_path = OUTPUT_PATH + '.tmp'
    with open(temp_path, 'w', encoding='utf-8') as handle:
        json.dump(result, handle, indent=2, default=str)
    os.replace(temp_path, OUTPUT_PATH)

try:
    main()
except Exception as exc:
    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH + '.error.txt', 'w', encoding='utf-8') as handle:
        handle.write(repr(exc) + '\n' + traceback.format_exc())
"#,
        escaped_output = escaped_output
    )
}

fn export_user_data_from_game_json(app: &AppHandle) -> Result<UserScoreLookup, String> {
    let process = real_game_processes().into_iter().next().ok_or_else(|| {
        "War of Dots is not running, so game-json export has no live cache to read.".to_string()
    })?;
    let process_id = process
        .process_id
        .ok_or_else(|| "War of Dots process id was unavailable.".to_string())?;

    let source_dll = find_python_probe_dll(app).ok_or_else(|| {
        "Python probe DLL is missing; build tools\\python-probe-dll first.".to_string()
    })?;
    let injector = find_python_probe_injector(app)
        .ok_or_else(|| "Python probe injector script is missing.".to_string())?;

    let probe_root = app_runtime_dir(app)?.join("probes").join("user-data-json");
    fs::create_dir_all(&probe_root).map_err(|error| error.to_string())?;
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let probe_dll = probe_root.join(format!("wod_python_probe_{unique}.dll"));
    let payload_path = probe_root.join("wod_python_probe_payload.py");
    let output_path = probe_root.join("user-data.json");
    let status_path = probe_root.join("wod_python_probe.status.json");
    let _ = fs::remove_file(&output_path);
    let _ = fs::remove_file(output_path.with_extension("json.error.txt"));
    let _ = fs::remove_file(&status_path);
    fs::copy(&source_dll, &probe_dll).map_err(|error| {
        format!(
            "Could not stage Python probe DLL {} to {}: {error}",
            source_dll.display(),
            probe_dll.display()
        )
    })?;
    fs::write(&payload_path, user_data_export_payload(&output_path))
        .map_err(|error| format!("Could not write {}: {error}", payload_path.display()))?;

    let script = format!(
        "& {} -ProcessId {} -ProbeDll {} -TimeoutSeconds 10",
        quote_ps_arg(&injector),
        process_id,
        quote_ps_arg(&probe_dll)
    );
    let output = run_hidden_powershell(&script)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "Game JSON probe injection failed: {}",
            if stderr.trim().is_empty() {
                stdout.trim()
            } else {
                stderr.trim()
            }
        ));
    }

    let deadline = Instant::now() + USER_DATA_EXPORT_WAIT;
    while Instant::now() < deadline {
        if output_path.is_file() {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    let value = read_json_file(&output_path).ok_or_else(|| {
        let status = read_json_file(&status_path)
            .map(|value| value.to_string())
            .unwrap_or_else(|| "no probe status".to_string());
        format!("Game JSON export did not produce user-data.json ({status}).")
    })?;
    let score = find_user_score(&value).ok_or_else(|| {
        "Game JSON export completed but no score/elo was found in the live cache.".to_string()
    })?;
    let username = value
        .get("best")
        .and_then(|best| best.get("username"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .or_else(|| game_login().username);
    let user_data = value
        .get("best")
        .and_then(|best| best.get("data"))
        .cloned()
        .unwrap_or_else(|| value.clone());

    Ok(UserScoreLookup {
        score,
        username,
        user_data,
        messages: vec![value],
        source: "game-json".to_string(),
    })
}

fn fetch_current_user_score_direct() -> Result<UserScoreLookup, String> {
    if real_game_is_running() && !env_flag("WOD_USER_DATA_ALLOW_LIVE_DIRECT") {
        return Err(
            "Direct user-data lookup is disabled while War of Dots is running; using cached/game-json data protects the live client."
                .to_string(),
        );
    }

    fetch_current_user_score_from_socket()
}

fn lookup_current_user_score(
    app: &AppHandle,
    mode: UserDataLookupMode,
) -> Result<UserScoreLookup, String> {
    if mode == UserDataLookupMode::Automatic && env_flag_disabled("WOD_USER_DATA_AUTOMATIC_LOOKUP")
    {
        return Err("Automatic user-data lookup is disabled.".to_string());
    }

    let provider = env::var("WOD_USER_DATA_PROVIDER")
        .unwrap_or_else(|_| "game-json".to_string())
        .trim()
        .to_ascii_lowercase();
    match provider.as_str() {
        "cache" | "cached" | "off" | "disabled" => Err("User-data lookup is disabled.".to_string()),
        "direct" | "direct-ws" | "ws" => fetch_current_user_score_direct(),
        "game-json" | "game_json" | "auto" => match export_user_data_from_game_json(app) {
            Ok(lookup) => Ok(lookup),
            Err(game_json_error) => {
                if real_game_is_running() {
                    Err(game_json_error)
                } else {
                    fetch_current_user_score_direct().map_err(|direct_error| {
                        format!("{game_json_error}; direct lookup also failed: {direct_error}")
                    })
                }
            }
        },
        other => Err(format!(
            "Unsupported WOD_USER_DATA_PROVIDER value: {other}."
        )),
    }
}

struct PseudoRandom {
    state: u64,
}

impl PseudoRandom {
    fn new() -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos() as u64)
            .unwrap_or(0);
        Self {
            state: nanos ^ ((process::id() as u64) << 32) ^ 0x9e37_79b9_7f4a_7c15,
        }
    }

    fn next_u8(&mut self) -> u8 {
        self.state ^= self.state << 7;
        self.state ^= self.state >> 9;
        self.state ^= self.state << 8;
        self.state as u8
    }

    fn fill_bytes(&mut self, bytes: &mut [u8]) {
        for byte in bytes {
            *byte = self.next_u8();
        }
    }
}

fn load_game_config(path: &Path) -> Option<Value> {
    let bytes = fs::read(path).ok()?;
    if bytes.starts_with(&[0x1f, 0x8b]) {
        let mut decoder = GzDecoder::new(bytes.as_slice());
        let mut decoded = Vec::new();
        decoder.read_to_end(&mut decoded).ok()?;
        serde_json::from_slice(&decoded).ok()
    } else {
        serde_json::from_slice(&bytes).ok()
    }
}

fn game_login() -> GameLogin {
    let mut candidates = Vec::new();
    if let Some(path) = env::var_os("WOD_USER_CONFIG") {
        candidates.push(PathBuf::from(path));
    }
    candidates.push(steam_game_dir().join("config.txt"));

    for candidate in candidates {
        let Some(config) = load_game_config(&candidate) else {
            continue;
        };
        let login = config.get("login").unwrap_or(&Value::Null);
        let username = login
            .get("username")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned);
        let password = login
            .get("password")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned);
        if username.is_some() || password.is_some() {
            return GameLogin { username, password };
        }
    }

    GameLogin {
        username: None,
        password: None,
    }
}

fn json_login_value(value: Option<&String>) -> Value {
    value
        .map(|value| Value::String(value.clone()))
        .unwrap_or(Value::Null)
}

fn permissions_value() -> Value {
    Value::Array(
        USER_DATA_PERMISSIONS
            .iter()
            .map(|permission| Value::String((*permission).to_string()))
            .collect(),
    )
}

fn make_user_data_request(message_type: &str, content: Value) -> Value {
    json!({ "type": message_type, "content": content })
}

fn make_user_data_access_request(message_type: &str, content: Value, access: Value) -> Value {
    json!({ "type": message_type, "access": access, "content": content })
}

fn build_user_data_flows(login: &GameLogin, version: &str) -> Vec<Vec<Value>> {
    let username = json_login_value(login.username.as_ref());
    let password = json_login_value(login.password.as_ref());
    let steam_id = 0u64;
    let startup_auth = json!({
        "username": username.clone(),
        "password": password.clone(),
        "steamid": steam_id.to_string(),
    });
    let auth = json!({
        "username": username.clone(),
        "password": password.clone(),
        "version": version,
        "steamid": steam_id,
    });
    let permissions = permissions_value();

    let mut flows = vec![
        vec![
            make_user_data_request("access", json!({ "version": version })),
            make_user_data_request("authorize", startup_auth),
            make_user_data_request("get_userstats", json!({})),
        ],
        vec![make_user_data_access_request(
            "get_userstats",
            json!({}),
            Value::String("authorize".to_string()),
        )],
        vec![make_user_data_access_request(
            "get_userstats",
            json!({}),
            permissions.clone(),
        )],
        vec![
            json!({ "access": permissions.clone() }),
            make_user_data_access_request("get_userstats", json!({}), permissions.clone()),
        ],
    ];

    if login.username.is_some() && login.password.is_some() {
        flows.extend([
            vec![
                make_user_data_request("authorize", auth.clone()),
                make_user_data_request("get_userstats", json!({})),
            ],
            vec![
                make_user_data_access_request("authorize", auth.clone(), permissions.clone()),
                make_user_data_access_request("get_userstats", json!({}), permissions.clone()),
            ],
            vec![
                json!({ "access": permissions.clone() }),
                make_user_data_request("authorize", auth.clone()),
                make_user_data_request("get_userstats", json!({})),
            ],
            vec![
                make_user_data_request("login_steamid", auth),
                make_user_data_request("get_userstats", json!({})),
            ],
        ]);
    }

    flows
}

fn xor_repeating(data: &[u8], key: &[u8; 4]) -> Vec<u8> {
    data.iter()
        .enumerate()
        .map(|(index, byte)| byte ^ key[index % 4])
        .collect()
}

fn bake_cake(payload: &[u8], random: &mut PseudoRandom) -> Result<Vec<u8>, String> {
    if payload.len() > 0x4000 {
        return Err("User-data request payload is too large.".to_string());
    }

    let mut key = [0u8; 4];
    let mut noise = [0u8; 2];
    random.fill_bytes(&mut key);
    random.fill_bytes(&mut noise);

    let length = payload.len();
    let (first_index, second_index) = if length < 4 {
        (1usize, 2usize)
    } else {
        (
            7usize.min(1usize.max(length.saturating_sub(3))),
            13usize.min(
                (7usize.min(1usize.max(length.saturating_sub(3))) + 1)
                    .max(length.saturating_sub(1)),
            ),
        )
    };
    let mut body = xor_repeating(payload, &key);
    body.insert(first_index, noise[0]);
    body.insert(second_index, noise[1]);
    body.insert(
        0,
        payload
            .iter()
            .fold(0u8, |sum, byte| sum.wrapping_add(*byte)),
    );

    let mut wrapped = Vec::with_capacity(16 + body.len());
    wrapped.extend(key);
    wrapped.extend((first_index as u32).to_be_bytes());
    wrapped.extend((second_index as u32).to_be_bytes());
    wrapped.extend((length as u32).to_be_bytes());
    wrapped.extend(body);
    Ok(wrapped)
}

fn decode_cake_candidate(
    body: &[u8],
    key: &[u8; 4],
    length: usize,
    remove_indexes: &[usize],
) -> Option<Value> {
    if remove_indexes.len() != 3 || remove_indexes.iter().any(|index| *index >= body.len()) || {
        let mut sorted = remove_indexes.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        sorted.len() != 3
    } {
        return None;
    }

    let stripped = body
        .iter()
        .enumerate()
        .filter_map(|(index, byte)| (!remove_indexes.contains(&index)).then_some(*byte))
        .collect::<Vec<_>>();
    if stripped.len() != length {
        return None;
    }

    let payload = xor_repeating(&stripped, key);
    if body[0]
        != payload
            .iter()
            .fold(0u8, |sum, byte| sum.wrapping_add(*byte))
    {
        return None;
    }
    serde_json::from_slice(&payload).ok()
}

fn eat_cake(message: &[u8]) -> Option<Value> {
    if message.len() < 19 {
        return None;
    }

    let key = [message[0], message[1], message[2], message[3]];
    let first_index = u32::from_be_bytes([message[4], message[5], message[6], message[7]]) as usize;
    let second_index =
        u32::from_be_bytes([message[8], message[9], message[10], message[11]]) as usize;
    let length = u32::from_be_bytes([message[12], message[13], message[14], message[15]]) as usize;
    let body = &message[16..];
    if length + 3 != body.len() {
        return None;
    }

    let low = first_index.min(second_index);
    let high = first_index.max(second_index);
    let candidates = [
        vec![0, first_index + 1, second_index + 1],
        vec![0, low + 1, high + 2],
        vec![0, low + 1, high + 1],
        vec![0, first_index, second_index],
    ];
    let mut seen = Vec::<Vec<usize>>::new();
    for mut indexes in candidates {
        indexes.sort_unstable();
        if seen.contains(&indexes) {
            continue;
        }
        seen.push(indexes.clone());
        if let Some(decoded) = decode_cake_candidate(body, &key, length, &indexes) {
            return Some(decoded);
        }
    }

    for first in 1..body.len() {
        for second in (first + 1)..body.len() {
            if let Some(decoded) = decode_cake_candidate(body, &key, length, &[0, first, second]) {
                return Some(decoded);
            }
        }
    }
    None
}

fn parse_user_data_message(payload: Vec<u8>, binary: bool) -> Value {
    if binary {
        if let Some(decoded) = eat_cake(&payload) {
            return decoded;
        }
    }
    match serde_json::from_slice::<Value>(&payload) {
        Ok(value) => value,
        Err(_) => Value::String(String::from_utf8_lossy(&payload).to_string()),
    }
}

fn parse_ws_url(url: &str) -> Result<(String, u16, String), String> {
    let rest = url
        .strip_prefix("ws://")
        .ok_or_else(|| "Only ws:// user-data URLs are supported.".to_string())?;
    let (host_port, path) = rest
        .split_once('/')
        .map(|(host_port, path)| (host_port, format!("/{path}")))
        .unwrap_or((rest, "/".to_string()));
    let (host, port) = host_port
        .rsplit_once(':')
        .and_then(|(host, port)| port.parse::<u16>().ok().map(|port| (host, port)))
        .unwrap_or((host_port, 80));
    if host.is_empty() {
        return Err("User-data WebSocket URL is missing a host.".to_string());
    }
    Ok((host.to_string(), port, path))
}

fn connect_user_data_socket(url: &str, random: &mut PseudoRandom) -> Result<TcpStream, String> {
    let (host, port, path) = parse_ws_url(url)?;
    let address = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|error| format!("Could not resolve {host}:{port}: {error}"))?
        .next()
        .ok_or_else(|| format!("Could not resolve {host}:{port}."))?;
    let mut stream = TcpStream::connect_timeout(&address, USER_DATA_CONNECT_TIMEOUT)
        .map_err(|error| format!("Could not connect to {host}:{port}: {error}"))?;
    stream
        .set_read_timeout(Some(USER_DATA_CONNECT_TIMEOUT))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(USER_DATA_CONNECT_TIMEOUT))
        .map_err(|error| error.to_string())?;

    let mut key_bytes = [0u8; 16];
    random.fill_bytes(&mut key_bytes);
    let key = BASE64.encode(key_bytes);
    let request = format!(
        "GET {path} HTTP/1.1\r\n\
         Host: {host}:{port}\r\n\
         Upgrade: websocket\r\n\
         Connection: Upgrade\r\n\
         Sec-WebSocket-Version: 13\r\n\
         Sec-WebSocket-Key: {key}\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("Could not send WebSocket handshake: {error}"))?;

    let mut response = Vec::new();
    let mut byte = [0u8; 1];
    while response.len() < 8192 && !response.ends_with(b"\r\n\r\n") {
        stream
            .read_exact(&mut byte)
            .map_err(|error| format!("Could not read WebSocket handshake: {error}"))?;
        response.push(byte[0]);
    }
    let response_text = String::from_utf8_lossy(&response);
    if !response_text.starts_with("HTTP/1.1 101") && !response_text.starts_with("HTTP/1.0 101") {
        return Err(format!(
            "User-data WebSocket handshake failed: {}",
            response_text.lines().next().unwrap_or("empty response")
        ));
    }

    Ok(stream)
}

fn send_ws_frame(
    stream: &mut TcpStream,
    opcode: u8,
    payload: &[u8],
    random: &mut PseudoRandom,
) -> Result<(), String> {
    let mut frame = Vec::with_capacity(payload.len() + 16);
    frame.push(0x80 | (opcode & 0x0f));
    if payload.len() <= 125 {
        frame.push(0x80 | payload.len() as u8);
    } else if payload.len() <= u16::MAX as usize {
        frame.push(0x80 | 126);
        frame.extend((payload.len() as u16).to_be_bytes());
    } else {
        frame.push(0x80 | 127);
        frame.extend((payload.len() as u64).to_be_bytes());
    }

    let mut mask = [0u8; 4];
    random.fill_bytes(&mut mask);
    frame.extend(mask);
    frame.extend(
        payload
            .iter()
            .enumerate()
            .map(|(index, byte)| byte ^ mask[index % 4]),
    );
    stream
        .write_all(&frame)
        .map_err(|error| format!("Could not send WebSocket frame: {error}"))
}

fn read_ws_payload(stream: &mut TcpStream) -> Result<Option<(u8, Vec<u8>)>, String> {
    let mut header = [0u8; 2];
    match stream.read_exact(&mut header) {
        Ok(()) => {}
        Err(error) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
            return Ok(None);
        }
        Err(error) => return Err(format!("Could not read WebSocket frame header: {error}")),
    }

    let opcode = header[0] & 0x0f;
    let masked = (header[1] & 0x80) != 0;
    let mut length = u64::from(header[1] & 0x7f);
    if length == 126 {
        let mut extended = [0u8; 2];
        stream
            .read_exact(&mut extended)
            .map_err(|error| format!("Could not read WebSocket frame length: {error}"))?;
        length = u64::from(u16::from_be_bytes(extended));
    } else if length == 127 {
        let mut extended = [0u8; 8];
        stream
            .read_exact(&mut extended)
            .map_err(|error| format!("Could not read WebSocket frame length: {error}"))?;
        length = u64::from_be_bytes(extended);
    }
    if length > 2 * 1024 * 1024 {
        return Err("User-data WebSocket frame is too large.".to_string());
    }

    let mut mask = [0u8; 4];
    if masked {
        stream
            .read_exact(&mut mask)
            .map_err(|error| format!("Could not read WebSocket frame mask: {error}"))?;
    }

    let mut payload = vec![0u8; length as usize];
    stream
        .read_exact(&mut payload)
        .map_err(|error| format!("Could not read WebSocket frame payload: {error}"))?;
    if masked {
        for (index, byte) in payload.iter_mut().enumerate() {
            *byte ^= mask[index % 4];
        }
    }
    Ok(Some((opcode, payload)))
}

fn receive_user_data_messages(
    stream: &mut TcpStream,
    wait: Duration,
    random: &mut PseudoRandom,
) -> Result<Vec<Value>, String> {
    let deadline = Instant::now() + wait;
    let mut messages = Vec::new();
    while Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(Instant::now());
        stream
            .set_read_timeout(Some(remaining.max(Duration::from_millis(25))))
            .map_err(|error| error.to_string())?;
        let Some((opcode, payload)) = read_ws_payload(stream)? else {
            break;
        };
        match opcode {
            0x1 => messages.push(parse_user_data_message(payload, false)),
            0x2 => messages.push(parse_user_data_message(payload, true)),
            0x8 => break,
            0x9 => {
                let _ = send_ws_frame(stream, 0xA, &payload, random);
            }
            _ => {}
        }
    }
    Ok(messages)
}

fn run_user_data_flow(
    url: &str,
    frames: &[Value],
    frame_format: UserDataFrameFormat,
    random: &mut PseudoRandom,
) -> Result<Option<(i64, Value, Vec<Value>)>, String> {
    let mut stream = connect_user_data_socket(url, random)?;
    let mut received_messages = Vec::new();

    for frame in frames {
        let json = serde_json::to_vec(frame).map_err(|error| error.to_string())?;
        match frame_format {
            UserDataFrameFormat::Wrapped => {
                let payload = bake_cake(&json, random)?;
                send_ws_frame(&mut stream, 0x2, &payload, random)?;
            }
            UserDataFrameFormat::Binary => {
                send_ws_frame(&mut stream, 0x2, &json, random)?;
            }
            UserDataFrameFormat::Text => {
                send_ws_frame(&mut stream, 0x1, &json, random)?;
            }
        }

        for message in receive_user_data_messages(&mut stream, USER_DATA_WAIT, random)? {
            if let Some(score) = find_user_score(&message) {
                received_messages.push(message.clone());
                let user_data = find_user_data_value(&message).unwrap_or(message);
                return Ok(Some((score, user_data, received_messages)));
            }
            received_messages.push(message);
        }
    }

    Ok(None)
}

fn value_as_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|number| i64::try_from(number).ok()))
        .or_else(|| value.as_f64().map(|number| number.round() as i64))
        .or_else(|| value.as_str()?.trim().parse::<i64>().ok())
}

fn find_user_score(value: &Value) -> Option<i64> {
    match value {
        Value::Object(object) => {
            for key in ["score", "elo"] {
                if let Some(score) = object.get(key).and_then(value_as_i64) {
                    return Some(score);
                }
            }

            for key in [
                "content", "data", "user", "stats", "response", "result", "payload",
            ] {
                if let Some(score) = object.get(key).and_then(find_user_score) {
                    return Some(score);
                }
            }

            object.values().find_map(find_user_score)
        }
        Value::Array(items) => items.iter().find_map(find_user_score),
        _ => None,
    }
}

fn find_user_data_value(value: &Value) -> Option<Value> {
    match value {
        Value::Object(object) => {
            if object.get("score").and_then(value_as_i64).is_some()
                || object.get("elo").and_then(value_as_i64).is_some()
            {
                return Some(value.clone());
            }

            for key in [
                "content", "data", "user", "stats", "response", "result", "payload",
            ] {
                if let Some(found) = object.get(key).and_then(find_user_data_value) {
                    return Some(found);
                }
            }

            object.values().find_map(find_user_data_value)
        }
        Value::Array(items) => items.iter().find_map(find_user_data_value),
        _ => None,
    }
}

fn fetch_current_user_score_from_socket() -> Result<UserScoreLookup, String> {
    let login = game_login();
    if login.username.is_none() || login.password.is_none() {
        return Err("War of Dots config login is missing.".to_string());
    }

    let url = env::var("WOD_USER_DATA_URL").unwrap_or_else(|_| DEFAULT_USER_DATA_URL.to_string());
    let version =
        env::var("WOD_USER_DATA_VERSION").unwrap_or_else(|_| DEFAULT_USER_DATA_VERSION.to_string());
    let flows = build_user_data_flows(&login, &version);
    let exhaustive = env::var("WOD_USER_DATA_EXHAUSTIVE")
        .ok()
        .is_some_and(|value| matches!(value.as_str(), "1" | "true" | "yes"));
    let formats = if exhaustive {
        vec![
            UserDataFrameFormat::Wrapped,
            UserDataFrameFormat::Binary,
            UserDataFrameFormat::Text,
        ]
    } else {
        vec![UserDataFrameFormat::Wrapped]
    };
    let mut random = PseudoRandom::new();
    let mut last_error = None;

    for format in formats {
        for frames in &flows {
            match run_user_data_flow(&url, frames, format, &mut random) {
                Ok(Some((score, user_data, messages))) => {
                    return Ok(UserScoreLookup {
                        score,
                        username: login.username.clone(),
                        user_data,
                        messages,
                        source: "direct-ws".to_string(),
                    });
                }
                Ok(None) => {}
                Err(error) => {
                    if error.starts_with("Could not connect")
                        || error.starts_with("Could not resolve")
                        || error.starts_with("User-data WebSocket handshake failed")
                    {
                        return Err(error);
                    }
                    last_error = Some(error);
                }
            }
        }
    }

    Err(last_error.unwrap_or_else(|| "User-data lookup returned no score.".to_string()))
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
            score_delta: None,
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
    home_player: Option<&str>,
) -> Option<usize> {
    if let Some(result) = result {
        if let Some(index) = result_player_name_index(result, players) {
            return Some(index);
        }
        if let Some(index) = result_special_winner_index(result, players, home_player) {
            return Some(index);
        }
    }

    if let Some(index) = event_winner_index {
        return Some(index);
    }

    None
}

fn result_player_name_index(result: &Value, players: &[PlayerSummary]) -> Option<usize> {
    let text = result.as_str()?;
    let normalized = clean_player_name(text, 0).to_ascii_lowercase();

    players
        .iter()
        .position(|player| player.name.to_ascii_lowercase() == normalized)
}

fn result_special_winner_index(
    result: &Value,
    players: &[PlayerSummary],
    home_player: Option<&str>,
) -> Option<usize> {
    if let Some(flag) = result.as_bool() {
        return result_flag_winner_index(flag, players, home_player);
    }

    if let Some(index) = result.as_i64() {
        if index == -1 && players.len() == 2 {
            return Some(1);
        }

        return match index {
            0 | 1 => result_index_or_home_flag_winner_index(index, players, home_player),
            _ => None,
        };
    }

    let text = result.as_str()?;
    let index = text.parse::<i64>().ok()?;
    if index == -1 && players.len() == 2 {
        return Some(1);
    }

    match index {
        0 | 1 => result_index_or_home_flag_winner_index(index, players, home_player),
        _ => None,
    }
}

fn result_index_or_home_flag_winner_index(
    index: i64,
    players: &[PlayerSummary],
    home_player: Option<&str>,
) -> Option<usize> {
    if home_player_index(players, home_player).is_some() {
        return result_flag_winner_index(index != 0, players, home_player);
    }

    let index = usize::try_from(index).ok()?;
    (index < players.len()).then_some(index)
}

fn result_flag_winner_index(
    home_won: bool,
    players: &[PlayerSummary],
    home_player: Option<&str>,
) -> Option<usize> {
    if players.is_empty() {
        return None;
    }

    let perspective_index = home_player_index(players, home_player).unwrap_or(0);

    if home_won {
        return Some(perspective_index);
    }

    if players.len() == 2 {
        return Some(if perspective_index == 0 { 1 } else { 0 });
    }

    None
}

fn home_player_index(players: &[PlayerSummary], home_player: Option<&str>) -> Option<usize> {
    home_player.and_then(|home_player| {
        players
            .iter()
            .position(|player| player.name.eq_ignore_ascii_case(home_player))
    })
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
    run_backend_with_owner(app, command, extra_args, process::id()).await
}

async fn run_backend_for_window(
    app: &AppHandle,
    window_label: &str,
    command: &str,
    extra_args: Vec<String>,
) -> Result<Value, String> {
    let owner_pid = owner_pid_for_window(app, window_label)?;
    run_backend_with_owner(app, command, extra_args, owner_pid).await
}

async fn run_backend_with_owner(
    app: &AppHandle,
    command: &str,
    extra_args: Vec<String>,
    owner_pid: u32,
) -> Result<Value, String> {
    let runtime_dir = app_runtime_dir(app)?;
    let mut args = vec![
        "--desktop-command".to_string(),
        command.to_string(),
        "--runtime-dir".to_string(),
        runtime_dir.to_string_lossy().to_string(),
        "--owner-pid".to_string(),
        owner_pid.to_string(),
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
async fn release_job_artifacts(app: AppHandle, job_id: String) -> Result<Value, String> {
    run_backend(
        &app,
        "release-job-artifacts",
        vec!["--job-id".to_string(), job_id],
    )
    .await
}

fn list_replays_impl(app: &AppHandle) -> Result<Vec<ReplaySummary>, String> {
    let candidates = collect_replay_candidates(&app)?;
    if candidates.is_empty() {
        return Ok(Vec::new());
    }

    let mut map_cache = HashMap::new();
    let mut parsed_replays = Vec::new();

    for candidate in &candidates {
        match parse_replay(&candidate.path) {
            Ok(mut parsed) => {
                parsed.summary.file_name = candidate.file_name.clone();
                parsed.summary.modified = candidate.modified;
                parsed.summary.score_delta = None;
                parsed.summary.file_path = candidate.path.to_string_lossy().to_string();
                if let Some(replay_dir) = candidate.thumbnail_replay_dir.as_deref() {
                    parsed.summary.thumbnail_data_url =
                        thumbnail_for_replay(replay_dir, &parsed, &mut map_cache);
                }
                parsed_replays.push(parsed);
            }
            Err(error) => {
                eprintln!("Skipping {}: {error}", candidate.path.display());
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
                home_player.as_deref(),
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
async fn list_replays(app: AppHandle) -> Result<Vec<ReplaySummary>, String> {
    tauri::async_runtime::spawn_blocking(move || list_replays_impl(&app))
        .await
        .map_err(|error| format!("Replay loading task failed: {error}"))?
}

#[tauri::command]
fn fetch_user_data(app: AppHandle) -> Result<Value, String> {
    let checkpoint_path = user_data_checkpoint_path(&app)?;
    let mut store = load_user_data_checkpoint_store(&checkpoint_path);
    let fetched_at = now_unix_secs();
    let lookup = lookup_current_user_score(&app, UserDataLookupMode::Manual);
    let (username, score, user_data, messages, source, lookup_error) = match lookup {
        Ok(lookup) => {
            append_user_data_checkpoint_if_changed(&mut store, &lookup, fetched_at);
            write_user_data_checkpoint_store(&checkpoint_path, &store)?;
            (
                lookup.username,
                Some(lookup.score),
                lookup.user_data,
                lookup.messages,
                lookup.source,
                Value::Null,
            )
        }
        Err(error) => {
            let latest_fields = store
                .checkpoints
                .last()
                .map(|checkpoint| checkpoint.fields.clone())
                .unwrap_or_default();
            let user_data = json!({
                "source": "cached",
                "status": "lookup-failed",
                "error": error.clone(),
                "fields": latest_fields,
            });
            (
                None,
                latest_checkpoint_score(&store),
                user_data,
                Vec::new(),
                "cached".to_string(),
                json!(error),
            )
        }
    };
    let checkpoints = store
        .checkpoints
        .iter()
        .map(checkpoint_json)
        .collect::<Vec<_>>();

    Ok(json!({
        "fetchedAt": fetched_at,
        "username": username,
        "score": score,
        "source": source,
        "lookupError": lookup_error,
        "userData": user_data,
        "messages": messages,
        "checkpoints": checkpoints,
        "checkpointFile": checkpoint_path.to_string_lossy(),
    }))
}

#[tauri::command]
async fn get_job(app: AppHandle, job_id: String) -> Result<Value, String> {
    run_backend(&app, "job", vec!["--job-id".to_string(), job_id]).await
}

#[tauri::command]
async fn capture_replay(
    app: AppHandle,
    window: WebviewWindow,
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

    let result = run_backend_for_window(
        &app,
        window.label(),
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
    window: WebviewWindow,
    filename: String,
    path: String,
) -> Result<Value, String> {
    let input_path = PathBuf::from(&path);
    if !input_path.is_file() || !is_replay_file(&input_path) {
        return Err(format!(
            "Replay file is not readable: {}",
            input_path.display()
        ));
    }

    run_backend_for_window(
        &app,
        window.label(),
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
    if !replay_path.is_file() || !is_replay_file(&replay_path) {
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
        WebviewUrl::App(format!("index.html?mode=player&launch={launch_id}").into()),
    )
    .title(&title)
    .inner_size(REPLAY_PLAYER_WIDTH, REPLAY_PLAYER_HEIGHT)
    .min_inner_size(720.0, 520.0)
    .visible(true)
    .focused(true)
    .build()
    .map_err(|error| error.to_string())?;

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

#[tauri::command]
async fn capture_sample_delta(
    app: AppHandle,
    job_id: String,
    offset: u64,
) -> Result<Value, String> {
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
    let mut file = File::open(&sample_path)
        .map_err(|error| format!("Could not open {}: {error}", sample_path.display()))?;
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
        if !line.ends_with('\n')
            && start
                .saturating_add(consumed)
                .saturating_add(bytes_read as u64)
                >= len
        {
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
    window: WebviewWindow,
    filename: String,
    started_after_ms: u64,
) -> Result<Value, String> {
    let runtime_dir = app_runtime_dir(&app)?;
    let owner_pid = owner_pid_for_window(&app, window.label())?;
    let jobs_dir = runtime_dir.join("jobs");
    let mut best: Option<(u64, PathBuf, Value)> = None;
    let cutoff = started_after_ms.saturating_sub(250);

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
        let filename_matches =
            job.get("filename").and_then(Value::as_str) == Some(filename.as_str());
        let owner_matches = job
            .get("owner_pid")
            .and_then(Value::as_u64)
            .is_some_and(|pid| pid == u64::from(owner_pid));
        if !filename_matches || !owner_matches {
            continue;
        }
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
        if best
            .as_ref()
            .map(|(mtime, _, _)| latest_mtime > *mtime)
            .unwrap_or(true)
        {
            best = Some((latest_mtime, root, job));
        }
    }

    let Some((latest_mtime_ms, root, job)) = best else {
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
            .or_else(|| {
                value
                    .get("samples")
                    .and_then(Value::as_array)
                    .map(|items| items.len() as u64)
            })
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
            .or_else(|| {
                value
                    .get("samples")
                    .and_then(Value::as_array)
                    .map(|items| items.len() as u64)
            })
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
        .manage(WindowOwnerProcesses::default())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let app_handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        stop_all_owner_processes(&app_handle);
                        app_handle.exit(0);
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
            backend_status,
            stage_game,
            list_jobs,
            list_replays,
            fetch_user_data,
            get_job,
            capture_replay,
            capture_replay_path,
            release_job_artifacts,
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
