//! Troop lines for replay cards: each side's troops over the whole match,
//! simulated once per replay and kept in one append-only file, which the
//! library reads whole at startup.

use crate::player::{engine_name, hidden, resource};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::ffi::OsStr;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use tauri::AppHandle;

const CACHE: &str = "replay-troops";
const STORE: &str = "lines.jsonl";
/// Points kept per side, enough for a smooth line across a card.
const POINTS: usize = 30;
/// Replays simulated at once, so the library stays responsive.
const WORKERS: usize = 2;
const BATCH: usize = 8;

static STORE_WRITE: Mutex<()> = Mutex::new(());

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayTroopLines {
    file_path: String,
    /// Each side's troops in hundreds, evenly spaced over the match. Empty
    /// when the replay could not be simulated.
    sides: Vec<Vec<u32>>,
}

#[derive(Deserialize)]
struct EngineTroops {
    strength: Vec<Vec<i64>>,
}

/// Averages `values` into at most `POINTS` evenly spaced buckets.
fn downsample(values: &[i64]) -> Vec<u32> {
    let count = POINTS.min(values.len());
    (0..count)
        .map(|i| {
            let start = i * values.len() / count;
            let end = ((i + 1) * values.len() / count).max(start + 1);
            let bucket = &values[start..end];
            (bucket.iter().sum::<i64>() / bucket.len() as i64).max(0) as u32
        })
        .collect()
}

fn simulate(app: &AppHandle, replay: &Path) -> Result<Vec<Vec<u32>>, String> {
    let executable = resource(app, &engine_name())?;
    let game_dirs = crate::installed_game_dirs();
    let replay_dirs = crate::layout_replay_dirs(app);
    let mut command = Command::new(&executable);
    command
        .arg(replay)
        .args(["--format", "troops", "-o", "-"])
        .args(game_dirs.iter().flat_map(|root| [OsStr::new("--game-dir"), root.as_os_str()]))
        .args(replay_dirs.iter().flat_map(|dir| [OsStr::new("--replay-dir"), dir.as_os_str()]))
        .current_dir(executable.parent().unwrap())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hidden(&mut command);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // No console window, and below normal priority: this is background work.
        command.creation_flags(0x0800_0000 | 0x0000_4000);
    }
    let output = command.output().map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let troops: EngineTroops = serde_json::from_slice(&output.stdout).map_err(|error| error.to_string())?;
    Ok(troops.strength.iter().map(|side| downsample(side)).collect())
}

/// Adds one replay's line in a single write, so a crash can only damage the last line.
fn append_to_store(store: &Path, hash: &str, sides: &[Vec<u32>]) -> Result<(), String> {
    let mut line = serde_json::json!({ "h": hash, "s": sides }).to_string();
    line.push('\n');
    let _guard = STORE_WRITE.lock().map_err(|error| error.to_string())?;
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(store)
        .and_then(|mut file| file.write_all(line.as_bytes()))
        .map_err(|error| error.to_string())
}

fn troop_lines(app: &AppHandle, store: &Path, replay: &Path) -> Result<Vec<Vec<u32>>, String> {
    if !replay.is_file() || !crate::is_replay_file(replay) {
        return Err(format!("Replay file is not readable: {}", replay.display()));
    }
    let bytes = fs::read(replay).map_err(|error| error.to_string())?;
    let sides = simulate(app, replay)?;
    append_to_store(store, &format!("{:x}", Sha256::digest(&bytes)), &sides)?;
    Ok(sides)
}

/// Every stored line, as the file's own text for the library to parse.
#[tauri::command]
pub async fn replay_troop_store(app: AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = crate::media_cache_dir(&app, CACHE)?.join(STORE);
        match fs::read_to_string(store) {
            Ok(text) => Ok(text),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
            Err(error) => Err(error.to_string()),
        }
    })
    .await
    .map_err(|error| format!("Troop lines task failed: {error}"))?
}

#[tauri::command]
pub async fn replay_troop_lines(app: AppHandle, file_paths: Vec<String>) -> Result<Vec<ReplayTroopLines>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = crate::media_cache_dir(&app, CACHE)?.join(STORE);
        let paths = file_paths.into_iter().take(BATCH).collect::<Vec<_>>();
        let next = AtomicUsize::new(0);
        let results = Mutex::new(Vec::with_capacity(paths.len()));
        std::thread::scope(|scope| {
            for _ in 0..WORKERS.min(paths.len()) {
                scope.spawn(|| loop {
                    let Some(file_path) = paths.get(next.fetch_add(1, Ordering::Relaxed)) else { break };
                    // A replay that cannot be simulated gets no lines; its card still shows.
                    let sides = troop_lines(&app, &store, &PathBuf::from(file_path)).unwrap_or_else(|error| {
                        eprintln!("{error}");
                        Vec::new()
                    });
                    if let Ok(mut results) = results.lock() {
                        results.push(ReplayTroopLines { file_path: file_path.clone(), sides });
                    }
                });
            }
        });
        results.into_inner().map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("Troop lines task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downsample_averages_into_even_buckets() {
        let values = (0..60).collect::<Vec<i64>>();
        let points = downsample(&values);
        assert_eq!(points.len(), POINTS);
        assert_eq!(points[0], 0);
        assert_eq!(points[POINTS - 1], 58);
        assert_eq!(downsample(&[5, 7]), vec![5, 7]);
        assert!(downsample(&[]).is_empty());
    }

    #[test]
    fn the_store_gains_one_line_per_replay() {
        let folder = tempfile::tempdir().unwrap();
        let store = folder.path().join(STORE);
        append_to_store(&store, "a", &[vec![1, 2], vec![3, 4]]).unwrap();
        append_to_store(&store, "b", &[]).unwrap();
        assert_eq!(fs::read_to_string(&store).unwrap(), "{\"h\":\"a\",\"s\":[[1,2],[3,4]]}\n{\"h\":\"b\",\"s\":[]}\n");
    }
}
