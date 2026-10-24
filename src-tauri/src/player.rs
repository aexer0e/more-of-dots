//! Independent replay conversion, frame indexing, rendering and video encoding.
//! A session belongs to a webview, so opening another replay cannot replace it.
use base64::Engine;
use flate2::{write::DeflateEncoder, Compression};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    ffi::OsStr,
    fs::{self, File},
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    path::PathBuf,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    time::Duration,
};
use tauri::{Manager, WebviewWindow};

#[derive(Default)]
pub struct PlayerSessions {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}
struct Session {
    closed: AtomicBool,
    replay: Mutex<Option<Arc<ReplayIndex>>>,
    data: Mutex<SessionData>,
    job: ProcessJob,
}
#[derive(Default)]
struct SessionData {
    renderer: Option<RenderWorker>,
}
/// Frames arrive in chunks while the simulator streams, so playback can start on
/// the first ones. Chunks stay in memory as written (docs/replay-frames.md).
struct ReplayIndex {
    progress: Mutex<Progress>,
    changed: Condvar,
    cancelled: AtomicBool,
}
#[derive(Default)]
struct Progress {
    frames: Vec<u64>,
    // Each frame's sound cues: units in combat and the sides that produced units.
    fighting: Vec<u32>,
    produced: Vec<u32>,
    // Each chunk after the index of its first frame.
    chunks: Vec<(usize, Arc<[u8]>)>,
    static_record: Option<Value>,
    done: bool,
    error: Option<String>,
}
impl ReplayIndex {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            progress: Mutex::default(),
            changed: Condvar::new(),
            cancelled: AtomicBool::new(false),
        })
    }
    fn update(&self, change: impl FnOnce(&mut Progress)) {
        if let Ok(mut progress) = self.progress.lock() {
            change(&mut progress);
        }
        self.changed.notify_all();
    }
    fn fail(&self, error: String) {
        self.update(|progress| {
            progress.error.get_or_insert(error);
            progress.done = true;
        });
    }
}
struct RenderWorker {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}
impl Drop for RenderWorker {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
impl RenderWorker {
    fn pixels(&mut self, request: &Value, expected: usize) -> Result<Vec<u8>, String> {
        let header = self.request(request)?;
        if header["bytes"].as_u64() != Some(expected as u64) {
            return Err("Renderer returned an invalid frame size.".into());
        }
        let mut pixels = vec![0; expected];
        self.output
            .read_exact(&mut pixels)
            .map_err(|e| format!("Incomplete replay image: {e}"))?;
        Ok(pixels)
    }
    fn request(&mut self, request: &Value) -> Result<Value, String> {
        serde_json::to_writer(&mut self.input, request).map_err(|e| e.to_string())?;
        self.input
            .write_all(b"\n")
            .and_then(|_| self.input.flush())
            .map_err(|e| e.to_string())?;
        let mut line = String::new();
        if self
            .output
            .read_line(&mut line)
            .map_err(|e| e.to_string())?
            == 0
        {
            return Err("The replay renderer stopped. Reopen the replay to restart it.".into());
        }
        let result: Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
        if result["ok"] != true {
            return Err(result["error"]
                .as_str()
                .unwrap_or("Rendering failed")
                .into());
        }
        Ok(result)
    }
}

impl PlayerSessions {
    fn session(&self, label: &str) -> Result<Arc<Session>, String> {
        if !label.starts_with("replay-player-") && label != "replayPlayer" {
            return Err("Open a replay player window first.".into());
        }
        let mut sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        if let Some(session) = sessions.get(label) {
            return Ok(session.clone());
        }
        let session = Arc::new(Session {
            closed: AtomicBool::new(false),
            replay: Mutex::new(None),
            data: Mutex::new(SessionData::default()),
            job: ProcessJob::new()?,
        });
        sessions.insert(label.into(), session.clone());
        Ok(session)
    }
    pub fn close(&self, label: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            if let Some(session) = sessions.remove(label) {
                session.closed.store(true, Ordering::Release);
                session.job.terminate();
                tauri::async_runtime::spawn_blocking(move || {
                    if let Ok(mut data) = session.data.lock() {
                        *data = SessionData::default();
                    }
                    if let Ok(mut replay) = session.replay.lock() {
                        replay.take();
                    }
                });
            }
        }
    }
    pub fn close_all(&self) {
        let sessions = self
            .sessions
            .lock()
            .map(|mut s| s.drain().map(|(_, session)| session).collect::<Vec<_>>())
            .unwrap_or_default();
        for session in &sessions {
            session.closed.store(true, Ordering::Release);
            session.job.terminate();
        }
        for session in sessions {
            tauri::async_runtime::spawn_blocking(move || {
                if let Ok(mut data) = session.data.lock() {
                    *data = SessionData::default();
                }
            });
        }
    }
}
pub(crate) fn hidden(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}
// Windows owns these handles and terminates workers if the app crashes or exits.
#[cfg(windows)]
pub(crate) struct ProcessJob(
    windows_sys::Win32::Foundation::HANDLE,
    // Children Wine refused to put in the job, stopped one by one instead.
    std::sync::Mutex<Vec<u32>>,
);
#[cfg(windows)]
unsafe impl Send for ProcessJob {}
#[cfg(windows)]
unsafe impl Sync for ProcessJob {}
#[cfg(windows)]
impl ProcessJob {
    pub(crate) fn new() -> Result<Self, String> {
        use windows_sys::Win32::System::JobObjects::*;
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return Err(std::io::Error::last_os_error().to_string());
            }
            let job = Self(handle, Default::default());
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as _,
                std::mem::size_of_val(&limits) as u32,
            ) == 0
            {
                return Err(std::io::Error::last_os_error().to_string());
            }
            Ok(job)
        }
    }
    pub(crate) fn assign(&self, child: &mut Child) -> Result<(), String> {
        use std::os::windows::io::AsRawHandle;
        unsafe {
            if windows_sys::Win32::System::JobObjects::AssignProcessToJobObject(
                self.0,
                child.as_raw_handle(),
            ) == 0
            {
                let error = std::io::Error::last_os_error().to_string();
                // Wine and Proton can refuse this (the process is already in a
                // job). The engine then runs outside the job and is stopped by id.
                if is_wine() {
                    if let Ok(mut loose) = self.1.lock() {
                        loose.push(child.id());
                    }
                    return Ok(());
                }
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
            Ok(())
        }
    }
    pub(crate) fn terminate(&self) {
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0, 1);
            use windows_sys::Win32::{Foundation::CloseHandle, System::Threading::*};
            for id in self.1.lock().map(|mut l| std::mem::take(&mut *l)).unwrap_or_default() {
                let process = OpenProcess(PROCESS_TERMINATE, 0, id);
                if !process.is_null() {
                    TerminateProcess(process, 1);
                    CloseHandle(process);
                }
            }
        }
    }
}
/// Wine's ntdll exports `wine_get_version`; Windows' does not.
#[cfg(windows)]
fn is_wine() -> bool {
    use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleA, GetProcAddress};
    unsafe {
        let ntdll = GetModuleHandleA(b"ntdll.dll\0".as_ptr());
        !ntdll.is_null() && GetProcAddress(ntdll, b"wine_get_version\0".as_ptr()).is_some()
    }
}
#[cfg(windows)]
impl Drop for ProcessJob {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}
#[cfg(not(windows))]
pub(crate) struct ProcessJob;
#[cfg(not(windows))]
impl ProcessJob {
    pub(crate) fn new() -> Result<Self, String> {
        Ok(Self)
    }
    pub(crate) fn assign(&self, _: &mut Child) -> Result<(), String> {
        Ok(())
    }
    pub(crate) fn terminate(&self) {}
}
pub(crate) fn resource(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    let bundled = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("resources/player")
        .join(name);
    if bundled.is_file() {
        return Ok(bundled);
    }
    #[cfg(debug_assertions)]
    {
        let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources/player")
            .join(name);
        if dev.is_file() {
            return Ok(dev);
        }
    }
    Err(format!(
        "The replay engine is incomplete ({name}). Repair More of Dots."
    ))
}
fn start_renderer(app: &tauri::AppHandle, job: &ProcessJob) -> Result<RenderWorker, String> {
    let executable = resource(app, "ReplaySim.Standalone.exe")?;
    let mut child = hidden(
        Command::new(&executable)
            .arg("--render-worker")
            .current_dir(executable.parent().unwrap())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null()),
    )
    .spawn()
    .map_err(|e| e.to_string())?;
    job.assign(&mut child)?;
    Ok(RenderWorker {
        input: child.stdin.take().ok_or("Cannot connect renderer input")?,
        output: BufReader::new(
            child
                .stdout
                .take()
                .ok_or("Cannot connect renderer output")?,
        ),
        child,
    })
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayInfo {
    path: String,
    last_frame: u64,
    frame_numbers: Vec<u64>,
    fighting: Vec<u32>,
    produced: Vec<u32>,
    complete: bool,
    static_record: Value,
}

const STATE_PREFIX: &[u8] = b"{\"kind\":\"state\",\"frame\":";
const AUDIO_PREFIX: &[u8] = b",\"audio\":[";
// The engine's chunk stream (docs/replay-frames.md).
const FRAME_MAGIC: &[u8; 8] = b"WODFRM1\n";
const STATIC_RECORD: u8 = 1;
const CHUNK_RECORD: u8 = 2;
const JSON_LINES: u8 = 2;
const CHUNK_FRAMES: usize = 60;
const MAX_RECORD_BYTES: usize = 64 * 1024 * 1024;

fn add_static(index: &ReplayIndex, record: &[u8]) -> Result<(), String> {
    let metadata: Value =
        serde_json::from_slice(record).map_err(|e| format!("Invalid replay metadata: {e}"))?;
    if metadata.get("rendered_map_surface").is_none()
        && metadata.get("source_map_surface").is_none()
    {
        return Err("This repsim has no embedded map. Open its original .rep to generate a playable repsim.".into());
    }
    index.update(|progress| progress.static_record = Some(metadata));
    Ok(())
}

/// Indexes a chunk's frame numbers and sound cues. Its frames stay compressed
/// until the player asks for them.
fn add_chunk(index: &ReplayIndex, payload: Vec<u8>) -> Result<(), String> {
    let word = |at: usize| {
        payload
            .get(at..at + 4)
            .map(|bytes| u32::from_le_bytes(bytes.try_into().unwrap()))
    };
    let count = word(1).ok_or("Incomplete replay chunk.")? as usize;
    if count == 0 || payload.len() < 5 + 12 * count {
        return Err("Incomplete replay chunk.".into());
    }
    let column = |c: usize| -> Vec<u32> {
        (0..count)
            .map(|i| word(5 + 4 * (c * count + i)).unwrap())
            .collect()
    };
    let (frames, fighting, produced) = (column(0), column(1), column(2));
    let mut progress = index.progress.lock().map_err(|e| e.to_string())?;
    let mut previous = progress.frames.last().copied();
    for &frame in &frames {
        if previous.is_some_and(|previous| u64::from(frame) <= previous) {
            return Err("Replay frames must increase.".into());
        }
        previous = Some(frame.into());
    }
    let start = progress.frames.len();
    progress.frames.extend(frames.into_iter().map(u64::from));
    progress.fighting.extend(fighting);
    progress.produced.extend(produced);
    progress.chunks.push((start, payload.into()));
    drop(progress);
    index.changed.notify_all();
    Ok(())
}

/// Reads the engine's output: the static record, then chunks as they are written.
fn read_stream(index: &ReplayIndex, mut source: impl Read, closed: &AtomicBool) -> Result<(), String> {
    let mut magic = [0; 8];
    source
        .read_exact(&mut magic)
        .map_err(|_| "The replay engine wrote no frames.".to_string())?;
    if &magic != FRAME_MAGIC {
        return Err("The replay engine wrote an unknown format.".into());
    }
    loop {
        if closed.load(Ordering::Acquire) || index.cancelled.load(Ordering::Acquire) {
            return Err("Player closed.".into());
        }
        let mut header = [0; 5];
        if source.read(&mut header[..1]).map_err(|e| e.to_string())? == 0 {
            return Ok(());
        }
        source
            .read_exact(&mut header[1..])
            .map_err(|e| format!("Incomplete replay output: {e}"))?;
        let length = u32::from_le_bytes(header[1..].try_into().unwrap()) as usize;
        if length > MAX_RECORD_BYTES {
            return Err("Replay record exceeds the size limit.".into());
        }
        let mut payload = vec![0; length];
        source
            .read_exact(&mut payload)
            .map_err(|e| format!("Incomplete replay output: {e}"))?;
        match header[0] {
            STATIC_RECORD => add_static(index, &payload)?,
            CHUNK_RECORD => add_chunk(index, payload)?,
            _ => {}
        }
    }
}

/// A state record's frame number and sound cues, or None for other records. The
/// static record is indexed on the way.
fn state_header(
    index: &ReplayIndex,
    record: &[u8],
    offset: u64,
) -> Result<Option<(u32, (u32, u32))>, String> {
    #[derive(Deserialize)]
    struct Header {
        kind: String,
        frame: Option<u32>,
        #[serde(default)]
        audio: [u32; 2],
    }
    if record.is_empty() {
        return Ok(None);
    }
    if let Some(rest) = record.strip_prefix(STATE_PREFIX) {
        let digits = rest.iter().take_while(|b| b.is_ascii_digit()).count();
        let frame = std::str::from_utf8(&rest[..digits])
            .ok()
            .and_then(|text| text.parse().ok())
            .ok_or("Missing replay frame")?;
        // Newly generated frames keep audio beside the frame number for fast
        // indexing. Older files can have metadata between them; JSON property
        // order must never determine whether their sound effects are audible.
        let cues = match sound_cues(&rest[digits..]) {
            Some(cues) => cues,
            None => {
                let row: Header = serde_json::from_slice(record)
                    .map_err(|e| format!("Invalid replay at byte {offset}: {e}"))?;
                (row.audio[0], row.audio[1])
            }
        };
        return Ok(Some((frame, cues)));
    }
    let row: Header = serde_json::from_slice(record)
        .map_err(|e| format!("Invalid replay at byte {offset}: {e}"))?;
    match row.kind.as_str() {
        "static" => add_static(index, record).map(|()| None),
        "state" => Ok(Some((
            row.frame.ok_or("Missing replay frame")?,
            (row.audio[0], row.audio[1]),
        ))),
        _ => Ok(None),
    }
}

/// Fast path for the simulator's compact header. Other field orders and JSON
/// whitespace fall back to the normal header reader, rather than silent cues.
fn sound_cues(rest: &[u8]) -> Option<(u32, u32)> {
    let cues = rest.strip_prefix(AUDIO_PREFIX)?;
    let end = cues.iter().position(|&b| b == b']')?;
    let mut values = std::str::from_utf8(&cues[..end]).ok()?.split(',');
    let result = (values.next()?.trim().parse().ok()?, values.next()?.trim().parse().ok()?);
    values.next().is_none().then_some(result)
}

fn json_chunk(rows: &[u8], header: &[(u32, (u32, u32))]) -> Result<Vec<u8>, String> {
    let mut payload = vec![JSON_LINES];
    payload.extend((header.len() as u32).to_le_bytes());
    for column in 0..3 {
        for &(frame, (fighting, produced)) in header {
            payload.extend([frame, fighting, produced][column].to_le_bytes());
        }
    }
    let mut encoder = DeflateEncoder::new(payload, Compression::fast());
    encoder.write_all(rows).map_err(|e| e.to_string())?;
    encoder.finish().map_err(|e| e.to_string())
}

/// Groups the state records of a .repsim or .jsonl file into chunks of JSON lines.
fn read_jsonl(index: &ReplayIndex, mut source: impl BufRead, closed: &AtomicBool) -> Result<(), String> {
    let mut line = Vec::with_capacity(1 << 16);
    let (mut rows, mut header) = (Vec::new(), Vec::new());
    let mut offset = 0;
    let mut sent = false;
    loop {
        if closed.load(Ordering::Acquire) || index.cancelled.load(Ordering::Acquire) {
            return Err("Player closed.".into());
        }
        line.clear();
        let count = source
            .read_until(b'\n', &mut line)
            .map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        if line.len() > MAX_RECORD_BYTES {
            return Err("Replay record exceeds the size limit.".into());
        }
        let record = line.trim_ascii();
        if let Some(state) = state_header(index, record, offset)? {
            header.push(state);
            rows.extend_from_slice(record);
            rows.push(b'\n');
            // The first frame goes out alone so playback can start at once.
            if !sent || header.len() == CHUNK_FRAMES {
                add_chunk(index, json_chunk(&rows, &header)?)?;
                rows.clear();
                header.clear();
                sent = true;
            }
        }
        offset += count as u64;
    }
    if !header.is_empty() {
        add_chunk(index, json_chunk(&rows, &header)?)?;
    }
    Ok(())
}

fn playable(index: &ReplayIndex) -> Result<(), String> {
    let progress = index.progress.lock().map_err(|e| e.to_string())?;
    if progress.static_record.is_none() || progress.frames.is_empty() {
        return Err("This file has no playable frames or map metadata.".into());
    }
    Ok(())
}

fn spawn_ingest(index: &Arc<ReplayIndex>, session: &Arc<Session>, path: PathBuf) {
    let (index, session) = (index.clone(), session.clone());
    std::thread::spawn(move || {
        let result = File::open(&path)
            .map_err(|e| e.to_string())
            .and_then(|file| {
                read_jsonl(&index, BufReader::with_capacity(1 << 20, file), &session.closed)
            })
            .and_then(|()| playable(&index));
        match result {
            Ok(()) => index.update(|progress| progress.done = true),
            Err(error) => index.fail(error),
        }
    });
}

fn spawn_conversion(index: &Arc<ReplayIndex>, session: &Arc<Session>, mut child: Child, mut log: File) {
    let (index, session) = (index.clone(), session.clone());
    std::thread::spawn(move || {
        let result = child
            .stdout
            .take()
            .ok_or_else(|| "Cannot read the replay simulator.".to_string())
            .and_then(|stdout| {
                read_stream(&index, BufReader::with_capacity(1 << 20, stdout), &session.closed)
            });
        if result.is_err() {
            let _ = child.kill();
        }
        let status = child.wait();
        let result = result.and_then(|()| match status {
            Ok(status) if status.success() => playable(&index),
            _ if session.closed.load(Ordering::Acquire) => Err("Player closed.".into()),
            _ => {
                let mut text = String::new();
                let _ = log.seek(SeekFrom::Start(0));
                let _ = log.read_to_string(&mut text);
                Err(format!("Could not simulate this replay: {}", text.trim()))
            }
        });
        match result {
            Ok(()) => index.update(|progress| progress.done = true),
            Err(error) => index.fail(error),
        }
    });
}

/// Waits until the map and first frame exist, then describes what is ready.
fn first_frames(
    index: &ReplayIndex,
    session: &Session,
    path: String,
) -> Result<ReplayInfo, String> {
    let mut progress = index.progress.lock().map_err(|e| e.to_string())?;
    while !(progress.done || (progress.static_record.is_some() && !progress.frames.is_empty())) {
        if session.closed.load(Ordering::Acquire) {
            return Err("Player closed.".into());
        }
        progress = index
            .changed
            .wait_timeout(progress, Duration::from_millis(100))
            .map_err(|e| e.to_string())?
            .0;
    }
    if let Some(error) = &progress.error {
        return Err(error.clone());
    }
    let static_record = progress
        .static_record
        .clone()
        .ok_or("This file has no map metadata.")?;
    let available = progress.frames.last().copied().unwrap_or(0);
    let expected = static_record["replay"]["end"].as_u64().unwrap_or(0);
    Ok(ReplayInfo {
        path,
        last_frame: if progress.done {
            available
        } else {
            expected.max(available)
        },
        frame_numbers: progress.frames.clone(),
        fighting: progress.fighting.clone(),
        produced: progress.produced.clone(),
        complete: progress.done,
        static_record,
    })
}

#[tauri::command]
pub async fn open_replay(
    path: String,
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<ReplayInfo, String> {
    let session = app.state::<PlayerSessions>().session(window.label())?;
    tauri::async_runtime::spawn_blocking(move || {
        let supplied = PathBuf::from(&path);
        if !supplied.is_file() {
            return Err("Replay file is no longer available.".into());
        }
        let extension = supplied
            .extension()
            .and_then(|x| x.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if session.closed.load(Ordering::Acquire) {
            return Err("Player closed.".into());
        }
        let index = ReplayIndex::new();
        if extension == "repsim" || extension == "jsonl" {
            spawn_ingest(&index, &session, supplied);
        } else {
            // The simulator streams chunks; frames are playable as soon as one arrives.
            let executable = resource(&app, "ReplaySim.Standalone.exe")?;
            let game_dirs = crate::installed_game_dirs();
            let log = tempfile::tempfile().map_err(|e| e.to_string())?;
            let mut child = hidden(
                Command::new(&executable)
                    .arg(&supplied)
                    .args(["--format", "binary", "-o", "-"])
                    .args(
                        game_dirs
                            .iter()
                            .flat_map(|root| [OsStr::new("--game-dir"), root.as_os_str()]),
                    )
                    .current_dir(executable.parent().unwrap())
                    .stdout(Stdio::piped())
                    .stderr(log.try_clone().map_err(|e| e.to_string())?),
            )
            .spawn()
            .map_err(|e| e.to_string())?;
            session.job.assign(&mut child)?;
            spawn_conversion(&index, &session, child, log);
        }
        let previous = session
            .replay
            .lock()
            .map_err(|e| e.to_string())?
            .replace(index.clone());
        if let Some(previous) = previous {
            previous.cancelled.store(true, Ordering::Release);
        }
        session.data.lock().map_err(|e| e.to_string())?.renderer = None;
        first_frames(&index, &session, path)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Frames simulated since `since`, for the player's prepared range.
#[tauri::command]
pub fn replay_progress(
    since: usize,
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let session = app.state::<PlayerSessions>().session(window.label())?;
    let index = session
        .replay
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or("Open a replay first.")?;
    let progress = index.progress.lock().map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "frameNumbers": progress.frames.get(since..).unwrap_or_default(),
        "fighting": progress.fighting.get(since..).unwrap_or_default(),
        "produced": progress.produced.get(since..).unwrap_or_default(),
        "complete": progress.done,
        "error": progress.error,
    }))
}

/// The installed game's sounds and the volumes saved in its settings:
/// `{ files: { music, fighting, … } | null, music, sfx }`. The sound files are
/// read in place through the asset protocol; nothing is copied or bundled.
#[tauri::command]
pub fn game_audio(app: tauri::AppHandle) -> Value {
    let game_dirs = crate::installed_game_dirs();
    let files = crate::audio::game_assets(&game_dirs).map(|assets| {
        crate::audio::GAME_SOUNDS
            .iter()
            .filter_map(|(name, file)| {
                let path = assets.join(file);
                app.asset_protocol_scope().allow_file(&path).ok()?;
                Some((
                    name.to_string(),
                    Value::from(path.to_string_lossy().into_owned()),
                ))
            })
            .collect::<serde_json::Map<_, _>>()
    });
    // Only the two volumes are read: the rest of the game's settings stay private.
    let volumes = game_dirs.iter().find_map(|root| {
        let bytes = fs::read(root.join("config.txt")).ok()?;
        let mut text = Vec::new();
        flate2::read::GzDecoder::new(bytes.as_slice())
            .read_to_end(&mut text)
            .ok()?;
        let config: Value = serde_json::from_slice(&text).ok()?;
        let volume = |key: &str| {
            config
                .get(key)?
                .as_f64()
                .filter(|v| (0.0..=1.0).contains(v))
        };
        Some((volume("music_volume")?, volume("sfx_volume")?))
    });
    serde_json::json!({
        "files": files,
        "music": volumes.map(|(music, _)| music),
        "sfx": volumes.map(|(_, sfx)| sfx),
    })
}

/// The chunk that holds frame `index`, after the index of its first frame.
fn chunk_at(replay: &ReplayIndex, index: usize) -> Result<Vec<u8>, String> {
    let progress = replay.progress.lock().map_err(|e| e.to_string())?;
    if index >= progress.frames.len() {
        return Err("This replay frame is not available yet.".into());
    }
    let position = progress.chunks.partition_point(|(start, _)| *start <= index);
    let (start, payload) = &progress.chunks[position - 1];
    let mut bytes = Vec::with_capacity(4 + payload.len());
    bytes.extend((*start as u32).to_le_bytes());
    bytes.extend_from_slice(payload);
    Ok(bytes)
}
#[tauri::command]
pub fn replay_chunk(
    index: usize,
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<tauri::ipc::Response, String> {
    let session = app.state::<PlayerSessions>().session(window.label())?;
    let replay = session
        .replay
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or("Open a replay first.")?;
    chunk_at(&replay, index).map(tauri::ipc::Response::new)
}
#[tauri::command]
pub async fn render_frame(
    mut request: Value,
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<tauri::ipc::Response, String> {
    let session = app.state::<PlayerSessions>().session(window.label())?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut data = session.data.lock().map_err(|e| e.to_string())?;
        if session.closed.load(Ordering::Acquire) {
            return Err("Player closed.".into());
        }
        let (width, height) = (
            request["width"].as_u64().ok_or("Missing width")?,
            request["height"].as_u64().ok_or("Missing height")?,
        );
        if !(1..=3840).contains(&width) || !(1..=2160).contains(&height) {
            return Err("Unsupported render size.".into());
        }
        if data.renderer.is_none() {
            data.renderer = Some(start_renderer(&app, &session.job)?);
        }
        let worker = data.renderer.as_mut().unwrap();
        if let Some(textures) = request.as_object_mut().and_then(|r| r.remove("textures")) {
            for texture in textures.as_array().ok_or("Invalid artwork request")? {
                worker.request(texture)?;
            }
        }
        request["transport"] = Value::String("rgb".into());
        let pixels = worker.pixels(&request, (width * height * 3) as usize)?;
        Ok(tauri::ipc::Response::new(pixels))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
    use flate2::read::DeflateDecoder;
    const STATIC: &str = "{\"kind\":\"static\",\"source_map_surface\":\"embedded\"}\n";
    fn jsonl(text: &str) -> Result<Arc<ReplayIndex>, String> {
        let index = ReplayIndex::new();
        read_jsonl(&index, text.as_bytes(), &AtomicBool::new(false))?;
        playable(&index)?;
        Ok(index)
    }
    /// The chunk's start, frame numbers and inflated rows.
    fn chunk(index: &ReplayIndex, frame: usize) -> (u32, Vec<u32>, Vec<Value>) {
        let bytes = chunk_at(index, frame).unwrap();
        let start = u32::from_le_bytes(bytes[..4].try_into().unwrap());
        let payload = &bytes[4..];
        assert_eq!(payload[0], JSON_LINES);
        let count = u32::from_le_bytes(payload[1..5].try_into().unwrap()) as usize;
        let frames = (0..count)
            .map(|i| u32::from_le_bytes(payload[5 + 4 * i..9 + 4 * i].try_into().unwrap()))
            .collect();
        let mut text = String::new();
        DeflateDecoder::new(&payload[5 + 12 * count..])
            .read_to_string(&mut text)
            .unwrap();
        let rows = text.lines().map(|line| serde_json::from_str(line).unwrap()).collect();
        (start, frames, rows)
    }
    fn record(kind: u8, payload: &[u8]) -> Vec<u8> {
        [&[kind][..], &(payload.len() as u32).to_le_bytes(), payload].concat()
    }
    fn binary_chunk(frames: &[u32]) -> Vec<u8> {
        let mut payload = vec![1];
        payload.extend((frames.len() as u32).to_le_bytes());
        for column in 0..3 {
            for &frame in frames {
                payload.extend([frame, frame * 2, column as u32][column].to_le_bytes());
            }
        }
        payload.extend(b"compressed frames");
        payload
    }

    #[test]
    fn reading_chunks_does_not_wait_for_the_encoder_lock() {
        let sessions = PlayerSessions::default();
        let session = sessions.session("replay-player-buffer").unwrap();
        let index = jsonl(&format!("{STATIC}{{\"kind\":\"state\",\"frame\":0}}\n")).unwrap();
        *session.replay.lock().unwrap() = Some(index);
        let _encoder_busy = session.data.lock().unwrap();
        let index = session.replay.lock().unwrap().clone().unwrap();
        assert!(!chunk_at(&index, 0).unwrap().is_empty());
    }
    #[test]
    fn json_lines_skip_empty_and_non_state_records() {
        let index = jsonl(&format!("{STATIC}\n{{\"kind\":\"state\",\"frame\":0}}\n{{\"kind\":\"other\"}}\n{{\"kind\":\"state\",\"frame\":30}}\n")).unwrap();
        assert_eq!(index.progress.lock().unwrap().frames, vec![0, 30]);
        let (start, frames, rows) = chunk(&index, 1);
        assert_eq!((start, frames), (1, vec![30]));
        assert_eq!(rows[0]["frame"], 30);
    }
    #[test]
    fn json_lines_form_a_first_frame_chunk_then_chunks_of_sixty() {
        let mut text = String::from(STATIC);
        for frame in 0..127 {
            text.push_str(&format!("{{\"kind\":\"state\",\"frame\":{frame},\"audio\":[{frame},1],\"dots\":[{{\"name\":\"العراق\"}}]}}\n"));
        }
        let index = jsonl(&text).unwrap();
        let starts: Vec<usize> = index.progress.lock().unwrap().chunks.iter().map(|(start, _)| *start).collect();
        assert_eq!(starts, vec![0, 1, 61, 121]);
        for frame in [0, 1, 60, 61, 120, 126] {
            let (start, frames, rows) = chunk(&index, frame);
            assert!(start as usize <= frame && frame < start as usize + frames.len());
            for (n, row) in rows.iter().enumerate() {
                assert_eq!(row["frame"], start + n as u32);
                assert_eq!(row["dots"][0]["name"], "العراق");
            }
        }
        assert!(chunk_at(&index, 127).is_err());
        let progress = index.progress.lock().unwrap();
        assert_eq!(progress.fighting[126], 126);
        assert_eq!(progress.produced[126], 1);
    }
    #[test]
    fn sound_cues_follow_each_frame_and_default_to_silence() {
        let index = jsonl(&format!("{STATIC}{{\"kind\":\"state\",\"frame\":0,\"audio\":[0,0],\"dots\":[]}}\n{{\"kind\":\"state\",\"frame\":1,\"audio\":[12,3],\"dots\":[]}}\n{{\"kind\":\"state\",\"frame\":2,\"dots\":[]}}\n")).unwrap();
        let progress = index.progress.lock().unwrap();
        assert_eq!(progress.fighting, vec![0, 12, 0]);
        assert_eq!(progress.produced, vec![0, 3, 0]);
    }
    #[test]
    fn sound_cues_survive_metadata_field_order() {
        let text = concat!(
            "{\"kind\":\"static\",\"source_map_surface\":\"embedded\"}\n",
            // The compatibility reader's former output.
            "{\"kind\":\"state\",\"frame\":0,\"compatibility\":{\"deferred_orders\":0,\"pending_orders\":0},\"audio\":[12,3],\"dots\":[]}\n",
            "{\"audio\": [8, 2], \"kind\": \"state\", \"frame\": 1, \"dots\": []}\n",
            // Nested keys must not be mistaken for the frame's audio cues.
            "{\"kind\":\"state\",\"frame\":2,\"compatibility\":{\"audio\":[99,99]},\"audio\":[4,1]}\n",
            "{\"kind\":\"state\",\"frame\":3,\"dots\":[]}\n",
        );
        let index = jsonl(text).unwrap();
        let progress = index.progress.lock().unwrap();
        assert_eq!(progress.fighting, vec![12, 8, 4, 0]);
        assert_eq!(progress.produced, vec![3, 2, 1, 0]);
    }
    #[test]
    fn rejects_duplicate_frames_and_incomplete_files() {
        for text in [
            "{\"kind\":\"state\",\"frame\":0}\n".to_string(),
            format!("{STATIC}{{\"kind\":\"state\",\"frame\":1}}\n{{\"kind\":\"state\",\"frame\":1}}\n"),
            STATIC.to_string(),
            "{\"kind\":\"static\"}\n{\"kind\":\"state\",\"frame\":0}\n".to_string(),
        ] {
            assert!(jsonl(&text).is_err(), "{text}");
        }
    }
    #[test]
    fn engine_stream_is_indexed_without_inflating_frames() {
        let stream = [
            &FRAME_MAGIC[..],
            &record(STATIC_RECORD, STATIC.trim().as_bytes()),
            &record(CHUNK_RECORD, &binary_chunk(&[0])),
            &record(9, b"a later record kind"),
            &record(CHUNK_RECORD, &binary_chunk(&[1, 2, 3])),
        ]
        .concat();
        let index = ReplayIndex::new();
        read_stream(&index, stream.as_slice(), &AtomicBool::new(false)).unwrap();
        playable(&index).unwrap();
        {
            let progress = index.progress.lock().unwrap();
            assert_eq!(progress.frames, vec![0, 1, 2, 3]);
            assert_eq!(progress.fighting, vec![0, 2, 4, 6]);
            assert_eq!(progress.produced, vec![2, 2, 2, 2]);
        }
        let bytes = chunk_at(&index, 2).unwrap();
        assert_eq!(bytes[..4], 1u32.to_le_bytes());
        assert_eq!(bytes[4..], binary_chunk(&[1, 2, 3]));
    }
    #[test]
    fn engine_stream_rejects_damage() {
        let good = [&FRAME_MAGIC[..], &record(STATIC_RECORD, STATIC.trim().as_bytes())].concat();
        let oversized = [&good[..], &[CHUNK_RECORD], &u32::MAX.to_le_bytes()].concat();
        let truncated = [&good[..], &record(CHUNK_RECORD, &binary_chunk(&[0]))[..12]].concat();
        let repeated = [&good[..], &record(CHUNK_RECORD, &binary_chunk(&[4])), &record(CHUNK_RECORD, &binary_chunk(&[4]))].concat();
        let empty = [&good[..], &record(CHUNK_RECORD, &[1, 0, 0, 0, 0])].concat();
        for stream in [&b"MODRPS2\n"[..], &b""[..], &oversized, &truncated, &repeated, &empty] {
            assert!(read_stream(&ReplayIndex::new(), stream, &AtomicBool::new(false)).is_err());
        }
    }
    #[test]
    fn closing_the_player_stops_reading() {
        let stream = [&FRAME_MAGIC[..], &record(STATIC_RECORD, STATIC.trim().as_bytes())].concat();
        assert_eq!(
            read_stream(&ReplayIndex::new(), stream.as_slice(), &AtomicBool::new(true)),
            Err("Player closed.".into())
        );
    }
    #[test]
    #[ignore = "requires WOD_REPLAY_FIXTURE pointing to a .rep file, and npm run prepare:player"]
    fn real_engine_output_is_indexed() {
        let replay = PathBuf::from(std::env::var("WOD_REPLAY_FIXTURE").unwrap());
        let engine = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources/player/ReplaySim.Standalone.exe");
        let started = std::time::Instant::now();
        let mut child = Command::new(&engine)
            .arg(&replay)
            .args(["--format", "binary", "-o", "-"])
            .current_dir(engine.parent().unwrap())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let index = ReplayIndex::new();
        read_stream(&index, BufReader::new(child.stdout.take().unwrap()), &AtomicBool::new(false)).unwrap();
        assert!(child.wait().unwrap().success());
        playable(&index).unwrap();
        let progress = index.progress.lock().unwrap();
        let end = progress.static_record.as_ref().unwrap()["replay"]["end"].as_u64().unwrap();
        assert_eq!(progress.frames, (0..=end).collect::<Vec<_>>());
        let bytes: usize = progress.chunks.iter().map(|(_, chunk)| chunk.len()).sum();
        println!(
            "{} frames in {} chunks, {bytes} bytes in memory, {:.1}s",
            progress.frames.len(),
            progress.chunks.len(),
            started.elapsed().as_secs_f64()
        );
    }
    #[test]
    fn windows_do_not_share_state() {
        let sessions = PlayerSessions::default();
        let a = sessions.session("replay-player-a").unwrap();
        let b = sessions.session("replay-player-b").unwrap();
        assert!(!Arc::ptr_eq(&a, &b));
        sessions.close("replay-player-a");
        assert!(a.closed.load(Ordering::Acquire));
        assert!(!b.closed.load(Ordering::Acquire));
    }
}

#[tauri::command]
pub fn player_debug_options() -> Vec<String> {
    if cfg!(debug_assertions) {
        std::env::args().skip(1).collect()
    } else {
        Vec::new()
    }
}
#[tauri::command]
pub fn save_player_snapshot(path: String, png: String) -> Result<(), String> {
    if !cfg!(debug_assertions) {
        return Err("Snapshot validation is available only in development.".into());
    }
    let data = base64::engine::general_purpose::STANDARD
        .decode(
            png.strip_prefix("data:image/png;base64,")
                .ok_or("Expected a PNG snapshot")?,
        )
        .map_err(|e| e.to_string())?;
    fs::write(path, data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_player_diagnostics(path: String, report: Value) -> Result<(), String> {
    if !cfg!(debug_assertions) {
        return Err("Diagnostics are available only in development.".into());
    }
    fs::write(
        path,
        serde_json::to_vec(&report).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}
