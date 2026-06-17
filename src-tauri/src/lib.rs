use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::ShellExt;

#[derive(Serialize)]
struct ArtifactPayload {
    filename: String,
    mime_type: String,
    base64: String,
    bytes: u64,
}

fn app_runtime_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let path = app.path().app_data_dir().map_err(|error| error.to_string())?;
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

async fn run_backend(app: &AppHandle, command: &str, extra_args: Vec<String>) -> Result<Value, String> {
    let runtime_dir = app_runtime_dir(app)?;
    let mut args = vec![
        "--desktop-command".to_string(),
        command.to_string(),
        "--runtime-dir".to_string(),
        runtime_dir.to_string_lossy().to_string(),
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
    run_backend(&app, "list-jobs", vec!["--limit".to_string(), "20".to_string()]).await
}

#[tauri::command]
async fn get_job(app: AppHandle, job_id: String) -> Result<Value, String> {
    run_backend(&app, "job", vec!["--job-id".to_string(), job_id]).await
}

#[tauri::command]
async fn capture_replay(app: AppHandle, filename: String, replay_base64: String) -> Result<Value, String> {
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

fn artifact_path(runtime_dir: &Path, job_id: &str, kind: &str) -> Result<(PathBuf, String, String), String> {
    if job_id.is_empty() || !job_id.chars().all(|char| char.is_ascii_hexdigit()) {
        return Err("Invalid job id.".to_string());
    }

    let (file_name, download_name, mime_type) = match kind {
        "simulated-replay" => ("simulated.rep", format!("{job_id}-simulated.rep"), "application/gzip"),
        "stats" => ("stats.json", format!("{job_id}-stats.json"), "application/json"),
        "logs" => ("logs.txt", format!("{job_id}-logs.txt"), "text/plain"),
        _ => return Err(format!("Unknown artifact kind: {kind}")),
    };
    Ok((
        runtime_dir.join("jobs").join(job_id).join(file_name),
        download_name,
        mime_type.to_string(),
    ))
}

#[tauri::command]
async fn read_artifact(app: AppHandle, job_id: String, kind: String) -> Result<ArtifactPayload, String> {
    let runtime_dir = app_runtime_dir(&app)?;
    let (path, filename, mime_type) = artifact_path(&runtime_dir, &job_id, &kind)?;
    let bytes = fs::read(&path).map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    Ok(ArtifactPayload {
        filename,
        mime_type,
        bytes: bytes.len() as u64,
        base64: BASE64.encode(bytes),
    })
}

#[tauri::command]
async fn capture_progress(app: AppHandle, filename: String, started_after_ms: u64) -> Result<Value, String> {
    let runtime_dir = app_runtime_dir(&app)?;
    let jobs_dir = runtime_dir.join("jobs");
    let mut best: Option<(u64, PathBuf, Value)> = None;
    let cutoff = started_after_ms.saturating_sub(15_000);

    let entries = fs::read_dir(&jobs_dir).map_err(|error| format!("Could not read {}: {error}", jobs_dir.display()))?;
    for entry in entries.flatten() {
        let root = entry.path();
        if !root.is_dir() {
            continue;
        }
        let job_path = root.join("job.json");
        let Some(job) = read_json_file(&job_path) else {
            continue;
        };
        if job.get("filename").and_then(Value::as_str) != Some(filename.as_str()) {
            continue;
        }
        let progress_path = root.join("live-capture-artifact.json.progress.jsonl");
        let stats_path = root.join("stats.json");
        let artifact_path = root.join("live-capture-artifact.json");
        let latest_mtime = [
            file_modified_millis(&job_path),
            file_modified_millis(&progress_path),
            file_modified_millis(&stats_path),
            file_modified_millis(&artifact_path),
        ]
        .into_iter()
        .max()
        .unwrap_or(0);
        if latest_mtime < cutoff {
            continue;
        }
        if best.as_ref().map(|(mtime, _, _)| latest_mtime > *mtime).unwrap_or(true) {
            best = Some((latest_mtime, root, job));
        }
    }

    let Some((latest_mtime_ms, root, job)) = best else {
        return Ok(json!({ "found": false }));
    };

    let progress_path = root.join("live-capture-artifact.json.progress.jsonl");
    let artifact_path = root.join("live-capture-artifact.json");
    let stats_path = root.join("stats.json");
    let (event, event_count) = latest_progress_event(&progress_path);
    let artifact = read_json_file(&artifact_path);
    let stats = read_json_file(&stats_path);
    let stats_summary = stats.as_ref().and_then(|value| {
        let samples = value.get("samples").and_then(Value::as_array).map(|items| items.len()).unwrap_or(0);
        Some(json!({
            "source": value.get("source"),
            "sample_rate_hz": value.get("sample_rate_hz"),
            "sample_count": samples,
            "summary": value.get("summary").cloned().unwrap_or(Value::Null),
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
    }))
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--background"]),
        ))
        .invoke_handler(tauri::generate_handler![
            backend_status,
            stage_game,
            list_jobs,
            get_job,
            capture_replay,
            read_artifact,
            capture_progress
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tauri application");
}
