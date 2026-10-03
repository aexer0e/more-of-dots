//! Background MP4 export. Each job runs the replay converter, which simulates
//! and renders frames as fast as it can, and feeds them to the H.264 encoder.
//! The converter also reports each tick's sound cues, which the mixer turns into
//! the game's music and sound effects. Nothing plays in real time and no player
//! window opens.
use crate::audio::{Mixer, Sounds};
use crate::player::{hidden, resource, ProcessJob};
use crate::video::{AudioInput, VideoEncoder, FRAME_RATE};
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    ffi::OsStr,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};

const LAYERS: [&str; 8] = ["orders", "health", "morale", "flags", "stats", "icons", "produce", "players"];
const PROGRESS_EVENT: &str = "replay-export-progress";
// The last frame stays on screen while the victory or defeat sound plays.
const END_HOLD_SECONDS: u64 = 2;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportItem {
    file_path: String,
    file_name: String,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    destination_dir: String,
    concurrency: usize,
    playback_speed: u32,
    bitrate_kbps: u32,
    resolution_height: u32,
    layers: Vec<String>,
    // 0 to 1, as in the game's settings.
    music_volume: f32,
    sfx_volume: f32,
}

impl ExportOptions {
    fn has_audio(&self) -> bool {
        self.music_volume > 0.0 || self.sfx_volume > 0.0
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ExportProgress {
    source_path: String,
    step: &'static str,
    frame: u64,
    total: u64,
    output_path: Option<String>,
    message: Option<String>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExportSummary {
    completed: usize,
    failed: usize,
    cancelled: usize,
}

/// The running export batch, so it can be cancelled from the library.
#[derive(Default)]
pub struct VideoExports {
    cancel: Mutex<Option<Arc<AtomicBool>>>,
}

impl VideoExports {
    pub fn cancel_all(&self) {
        if let Ok(cancel) = self.cancel.lock() {
            if let Some(flag) = cancel.as_ref() {
                flag.store(true, Ordering::Release);
            }
        }
    }
}

#[tauri::command]
pub async fn export_replay_videos(
    items: Vec<ExportItem>,
    options: ExportOptions,
    app: AppHandle,
) -> Result<ExportSummary, String> {
    if items.is_empty() {
        return Ok(ExportSummary::default());
    }
    let destination = PathBuf::from(&options.destination_dir);
    std::fs::create_dir_all(&destination)
        .map_err(|e| format!("Could not prepare {}: {e}", destination.display()))?;
    if !matches!(options.resolution_height, 480 | 720 | 1080) {
        return Err("Choose 480p, 720p or 1080p.".into());
    }
    if !(1..=60).contains(&options.playback_speed) || !(250..=50_000).contains(&options.bitrate_kbps) {
        return Err("Invalid playback speed or bitrate.".into());
    }
    if options.layers.iter().any(|layer| !LAYERS.contains(&layer.as_str())) {
        return Err("Unknown layer.".into());
    }
    if !(0.0..=1.0).contains(&options.music_volume) || !(0.0..=1.0).contains(&options.sfx_volume) {
        return Err("Invalid volume.".into());
    }
    let game_dirs = crate::installed_game_dirs();
    // The sounds come from the installed game; without it videos are silent.
    let game_assets = if options.has_audio() { crate::audio::game_assets(&game_dirs) } else { None };
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let exports = app.state::<VideoExports>();
        let mut running = exports.cancel.lock().map_err(|e| e.to_string())?;
        if running.is_some() {
            return Err("Videos are already being exported.".into());
        }
        *running = Some(cancel.clone());
    }
    let events = app.clone();
    let context = Arc::new(Context {
        executable: resource(&app, "ReplaySim.Standalone.exe")?,
        game_dirs,
        job: ProcessJob::new()?,
        cancel,
        options,
        destination,
        game_assets,
        sounds: OnceLock::new(),
        report: Box::new(move |progress| {
            let _ = events.emit(PROGRESS_EVENT, progress);
        }),
    });
    for item in &items {
        context.emit(&item.file_path, "queued", 0, 0, None, None);
    }
    let queue = Arc::new(Mutex::new(items.into_iter().collect::<VecDeque<_>>()));
    let summary = Arc::new(Mutex::new(ExportSummary::default()));
    let workers = context.options.concurrency.clamp(1, 8);
    let result = tauri::async_runtime::spawn_blocking({
        let (context, queue, summary) = (context.clone(), queue.clone(), summary.clone());
        move || {
            std::thread::scope(|scope| {
                for _ in 0..workers {
                    scope.spawn(|| loop {
                        let Some(item) = queue.lock().ok().and_then(|mut queue| queue.pop_front()) else {
                            return;
                        };
                        let outcome = context.export(&item);
                        if let Ok(mut summary) = summary.lock() {
                            match outcome {
                                Outcome::Completed => summary.completed += 1,
                                Outcome::Failed => summary.failed += 1,
                                Outcome::Cancelled => summary.cancelled += 1,
                            }
                        }
                    });
                }
            });
        }
    })
    .await;
    if let Ok(mut running) = app.state::<VideoExports>().cancel.lock() {
        running.take();
    }
    result.map_err(|e| e.to_string())?;
    let summary = std::mem::take(&mut *summary.lock().map_err(|e| e.to_string())?);
    Ok(summary)
}

#[tauri::command]
pub fn cancel_replay_exports(app: AppHandle) {
    app.state::<VideoExports>().cancel_all();
}

enum Outcome {
    Completed,
    Failed,
    Cancelled,
}

struct Context {
    executable: PathBuf,
    game_dirs: Vec<PathBuf>,
    job: ProcessJob,
    cancel: Arc<AtomicBool>,
    options: ExportOptions,
    destination: PathBuf,
    game_assets: Option<PathBuf>,
    // Decoded once by the first job that needs them.
    sounds: OnceLock<Result<Arc<Sounds>, String>>,
    report: Box<dyn Fn(ExportProgress) + Send + Sync>,
}

impl Context {
    fn emit(&self, source: &str, step: &'static str, frame: u64, total: u64, output: Option<&Path>, message: Option<String>) {
        (self.report)(ExportProgress {
            source_path: source.into(),
            step,
            frame,
            total,
            output_path: output.map(|path| path.to_string_lossy().into_owned()),
            message,
        });
    }

    fn export(&self, item: &ExportItem) -> Outcome {
        if self.cancel.load(Ordering::Acquire) {
            self.emit(&item.file_path, "cancelled", 0, 0, None, None);
            return Outcome::Cancelled;
        }
        match self.convert(item) {
            Ok(output) => {
                self.emit(&item.file_path, "completed", 0, 0, Some(&output), None);
                Outcome::Completed
            }
            Err(_) if self.cancel.load(Ordering::Acquire) => {
                self.emit(&item.file_path, "cancelled", 0, 0, None, None);
                Outcome::Cancelled
            }
            Err(message) => {
                self.emit(&item.file_path, "failed", 0, 0, None, Some(message));
                Outcome::Failed
            }
        }
    }

    fn mixer(&self) -> Result<Option<Mixer>, String> {
        let Some(assets) = &self.game_assets else { return Ok(None) };
        let sounds = self.sounds.get_or_init(|| Sounds::load(assets).map(Arc::new)).clone()?;
        Mixer::new(sounds, self.options.music_volume, self.options.sfx_volume, self.options.playback_speed).map(Some)
    }

    fn convert(&self, item: &ExportItem) -> Result<PathBuf, String> {
        let height = self.options.resolution_height;
        // 16:9, rounded to an even width for H.264 (854×480).
        let width = (height * 16 / 9 + 1) & !1;
        self.emit(&item.file_path, "preparing", 0, 0, None, None);
        let temporary = tempfile::Builder::new()
            .prefix(".more-of-dots-")
            .suffix(".mp4")
            .tempfile_in(&self.destination)
            .map_err(|e| e.to_string())?
            .into_temp_path();
        let mut child = hidden(
            Command::new(&self.executable)
                .arg(&item.file_path)
                .arg("--export-video")
                .args(["--width", &width.to_string(), "--height", &height.to_string()])
                .args(["--step", &self.options.playback_speed.to_string()])
                .args(["--layers", &self.options.layers.join(",")])
                .args(self.game_dirs.iter().flat_map(|root| [OsStr::new("--game-dir"), root.as_os_str()]))
                .current_dir(self.executable.parent().unwrap())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped()),
        )
        .spawn()
        .map_err(|e| e.to_string())?;
        self.job.assign(&mut child)?;

        let mixer = self.mixer()?;
        let frame_size = (width * height * 3) as usize;
        let mut stdout = BufReader::with_capacity(frame_size, child.stdout.take().ok_or("Cannot read the converter.")?);
        let mut encoder = VideoEncoder::start(&temporary, width, height, self.options.bitrate_kbps * 1000, mixer.is_some());
        let audio = mixer.zip(encoder.as_ref().ok().and_then(VideoEncoder::audio_input));
        let with_audio = audio.is_some();

        // The converter reports "progress done total", "sound frame fighting sides"
        // and "result value" lines; anything else is an error message.
        let (done, total) = (Arc::new(AtomicU64::new(0)), Arc::new(AtomicU64::new(0)));
        let errors = Arc::new(Mutex::new(String::new()));
        let stderr = child.stderr.take().ok_or("Cannot read the converter.")?;
        let reporter = std::thread::spawn({
            let (done, total, errors) = (done.clone(), total.clone(), errors.clone());
            move || report_converter(stderr, audio, &done, &total, &errors)
        });
        let mut frames = 0u64;
        let mut last_frame = Vec::new();
        let mut last_report = Instant::now();
        let streamed: Result<(), String> = (|| {
            let encoder = encoder.as_mut().map_err(|e| e.clone())?;
            loop {
                if self.cancel.load(Ordering::Acquire) {
                    return Err("Cancelled.".into());
                }
                let mut frame = vec![0u8; frame_size];
                match stdout.read_exact(&mut frame) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(()),
                    Err(error) => return Err(error.to_string()),
                }
                if with_audio {
                    last_frame.clone_from(&frame);
                }
                encoder.push(frame)?;
                frames += 1;
                if last_report.elapsed() > Duration::from_millis(200) {
                    last_report = Instant::now();
                    self.emit(&item.file_path, "exporting", done.load(Ordering::Acquire), total.load(Ordering::Acquire), None, None);
                }
            }
        })();
        if streamed.is_err() {
            let _ = child.kill();
        }
        let status = child.wait().map_err(|e| e.to_string())?;
        let reported = reporter.join().unwrap_or_else(|_| Err("The sound mixer stopped.".into()));
        streamed?;
        if !status.success() || frames == 0 {
            let message = errors.lock().map(|e| e.trim().to_string()).unwrap_or_default();
            return Err(if message.is_empty() { "The replay could not be converted.".into() } else { message });
        }
        reported?;
        let mut encoder = encoder?;
        if with_audio {
            for _ in 0..END_HOLD_SECONDS * FRAME_RATE {
                encoder.push(last_frame.clone())?;
            }
        }
        encoder.finish()?;
        let output = unique_path(&self.destination, &item.file_name);
        temporary.persist_noclobber(&output).map_err(|e| e.to_string())?;
        Ok(output)
    }
}

/// Reads the converter's status lines. With audio, each tick's sound cues are
/// mixed and sent to the encoder, and the end sound follows the last tick.
fn report_converter(
    stderr: impl Read,
    audio: Option<(Mixer, AudioInput)>,
    done: &AtomicU64,
    total: &AtomicU64,
    errors: &Mutex<String>,
) -> Result<(), String> {
    let mut audio = audio;
    let mut result = None;
    for line in BufReader::new(stderr).lines().map_while(Result::ok) {
        let words: Vec<&str> = line.split_whitespace().collect();
        let number = |index: usize| words.get(index).and_then(|n| n.parse::<u64>().ok());
        match words.first().copied() {
            Some("progress") if number(1).is_some() && number(2).is_some() => {
                done.store(number(1).unwrap(), Ordering::Release);
                total.store(number(2).unwrap(), Ordering::Release);
            }
            Some("sound") => {
                if let (Some((mixer, input)), Some(fighting), Some(sides)) = (audio.as_mut(), number(2), number(3)) {
                    input.push(mixer.tick(fighting as u32, sides as u32))?;
                }
            }
            Some("result") => result = words.get(1).and_then(|value| value.parse::<f64>().ok()),
            _ => {
                if let Ok(mut errors) = errors.lock() {
                    errors.push_str(line.trim_start_matches("replay-sim: "));
                    errors.push('\n');
                }
            }
        }
    }
    if let Some((mut mixer, input)) = audio {
        input.push(mixer.finish(result, END_HOLD_SECONDS as f64))?;
    }
    Ok(())
}

/// `name.mp4`, or `name (2).mp4` and so on when the file already exists.
fn unique_path(directory: &Path, file_name: &str) -> PathBuf {
    let cleaned: String = file_name
        .chars()
        .map(|c| if c.is_control() || r#"<>:"/\|?*"#.contains(c) { '_' } else { c })
        .collect();
    let stem = Path::new(cleaned.trim()).file_stem().and_then(|s| s.to_str()).filter(|s| !s.is_empty()).unwrap_or("replay").to_string();
    let mut candidate = directory.join(format!("{stem}.mp4"));
    let mut index = 2;
    while candidate.exists() {
        candidate = directory.join(format!("{stem} ({index}).mp4"));
        index += 1;
    }
    candidate
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_names_are_sanitized_and_never_overwrite() {
        let directory = tempfile::tempdir().unwrap();
        assert_eq!(unique_path(directory.path(), "a:b vs c?.mp4"), directory.path().join("a_b vs c_.mp4"));
        std::fs::write(directory.path().join("game.mp4"), b"").unwrap();
        assert_eq!(unique_path(directory.path(), "game.mp4"), directory.path().join("game (2).mp4"));
        assert_eq!(unique_path(directory.path(), ""), directory.path().join("replay.mp4"));
    }
}

#[cfg(test)]
mod throughput {
    use super::*;

    /// Runs one export job end to end, as the library does:
    /// MOD_EXPORT_EXE=... MOD_EXPORT_REPLAY=... cargo test exports_a_replay -- --ignored
    #[test]
    #[ignore]
    fn exports_a_replay_through_the_queue() {
        let (Ok(exe), Ok(replay)) = (std::env::var("MOD_EXPORT_EXE"), std::env::var("MOD_EXPORT_REPLAY")) else { return };
        // MOD_EXPORT_KEEP=dir keeps the video for inspection.
        let destination = match std::env::var("MOD_EXPORT_KEEP") {
            Ok(keep) => tempfile::Builder::new().tempdir_in(keep).unwrap(),
            Err(_) => tempfile::tempdir().unwrap(),
        };
        let steps = Arc::new(Mutex::new(Vec::new()));
        let context = Context {
            executable: PathBuf::from(exe),
            game_dirs: crate::installed_game_dirs(),
            job: ProcessJob::new().unwrap(),
            cancel: Arc::new(AtomicBool::new(false)),
            options: ExportOptions {
                destination_dir: destination.path().to_string_lossy().into_owned(),
                concurrency: 1,
                playback_speed: 10,
                bitrate_kbps: 2500,
                resolution_height: 480,
                layers: vec!["orders".into(), "players".into()],
                music_volume: 0.3,
                sfx_volume: 0.3,
            },
            destination: destination.path().to_path_buf(),
            // The soundtrack needs War of Dots installed.
            game_assets: Some(crate::audio::game_assets(&crate::installed_game_dirs()).expect("War of Dots is installed")),
            sounds: OnceLock::new(),
            report: Box::new({
                let steps = steps.clone();
                move |progress| {
                    if let Some(message) = &progress.message {
                        eprintln!("{}: {message}", progress.step);
                    }
                    steps.lock().unwrap().push(progress.step)
                }
            }),
        };
        let item = ExportItem { file_path: replay, file_name: "game.mp4".into() };
        assert!(matches!(context.export(&item), Outcome::Completed));
        let bytes = std::fs::read(destination.path().join("game.mp4")).unwrap();
        assert_eq!(&bytes[4..8], b"ftyp");
        assert!(bytes.windows(4).any(|window| window == b"mp4a"), "the video has a soundtrack");
        let steps = steps.lock().unwrap();
        assert_eq!(steps.first(), Some(&"preparing"));
        assert_eq!(steps.last(), Some(&"completed"));
        // Nothing but the finished video is left behind.
        assert_eq!(std::fs::read_dir(destination.path()).unwrap().count(), 1);
        if std::env::var("MOD_EXPORT_KEEP").is_ok() {
            let _ = destination.keep();
        }
    }

    /// Times converter + encoder on a real replay:
    /// MOD_EXPORT_EXE=... MOD_EXPORT_REPLAY=... cargo test throughput -- --ignored --nocapture
    #[test]
    #[ignore]
    fn converts_a_replay_quickly() {
        let (Ok(exe), Ok(replay)) = (std::env::var("MOD_EXPORT_EXE"), std::env::var("MOD_EXPORT_REPLAY")) else { return };
        let height: u32 = std::env::var("MOD_EXPORT_HEIGHT").ok().and_then(|h| h.parse().ok()).unwrap_or(1080);
        let width = (height * 16 / 9 + 1) & !1;
        let output = std::env::var("MOD_EXPORT_OUTPUT").map(PathBuf::from).unwrap_or_else(|_| std::env::temp_dir().join("mod-export-test.mp4"));
        let started = Instant::now();
        let mut child = Command::new(&exe)
            .arg(&replay)
            .args(["--export-video", "--width", &width.to_string(), "--height", &height.to_string()])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let size = (width * height * 3) as usize;
        let mut stdout = BufReader::with_capacity(size, child.stdout.take().unwrap());
        let mut encoder = VideoEncoder::start(&output, width, height, 8_000_000, false).unwrap();
        let mut frames = 0;
        loop {
            let mut frame = vec![0u8; size];
            if stdout.read_exact(&mut frame).is_err() { break; }
            encoder.push(frame).unwrap();
            frames += 1;
        }
        assert!(child.wait().unwrap().success());
        encoder.finish().unwrap();
        let seconds = started.elapsed().as_secs_f64();
        println!("{frames} frames at {width}x{height} in {seconds:.1} s = {:.0} fps -> {}", frames as f64 / seconds, output.display());
    }
}
