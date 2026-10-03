//! Independent replay conversion, frame indexing, rendering and video encoding.
//! A session belongs to a webview, so opening another replay cannot replace it.
use crate::storage::{CacheLease, StorageBudget, CACHE_DIRECTORY};
use base64::Engine;
use flate2::{read::ZlibDecoder, write::ZlibEncoder, Compression};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    ffi::OsStr,
    fs::{self, File},
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
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
/// Frame offsets grow while the simulator streams, so playback can start on the
/// first frames. Readers only see offsets whose bytes are already on disk.
struct ReplayIndex {
    progress: Mutex<Progress>,
    changed: Condvar,
    cancelled: AtomicBool,
    packed: AtomicBool,
    budget: Option<Arc<StorageBudget>>,
    // Both the output and its temporary file stay protected until playback ends.
    _leases: Vec<CacheLease>,
}
#[derive(Default)]
struct Progress {
    path: PathBuf,
    offsets: Vec<(u64, u64)>,
    // Each frame's sound cues: units in combat and the sides that produced units.
    fighting: Vec<u32>,
    produced: Vec<u32>,
    static_record: Option<Value>,
    done: bool,
    error: Option<String>,
    // An unfinished conversion is deleted with its index.
    temporary: Option<tempfile::TempPath>,
}
impl ReplayIndex {
    fn new(path: PathBuf, temporary: Option<tempfile::TempPath>) -> Arc<Self> {
        Self::with_cache(path, temporary, None, Vec::new())
    }
    fn with_cache(
        path: PathBuf,
        temporary: Option<tempfile::TempPath>,
        budget: Option<Arc<StorageBudget>>,
        leases: Vec<CacheLease>,
    ) -> Arc<Self> {
        Arc::new(Self {
            progress: Mutex::new(Progress {
                path,
                temporary,
                ..Progress::default()
            }),
            changed: Condvar::new(),
            cancelled: AtomicBool::new(false),
            packed: AtomicBool::new(false),
            budget,
            _leases: leases,
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
    #[cfg(test)]
    fn offsets(&self) -> Vec<(u64, u64)> {
        self.progress.lock().unwrap().offsets.clone()
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
pub(crate) struct ProcessJob(windows_sys::Win32::Foundation::HANDLE);
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
            let job = Self(handle);
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
        }
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
const PACKED_MAGIC: &[u8; 8] = b"MODRPS2\n";
const MAX_CHUNK_BYTES: usize = 64 * 1024 * 1024;

fn read_chunk(source: &mut impl Read) -> Result<Option<Vec<u8>>, String> {
    let mut header = [0; 8];
    if source.read(&mut header[..1]).map_err(|e| e.to_string())? == 0 {
        return Ok(None);
    }
    source
        .read_exact(&mut header[1..])
        .map_err(|e| format!("Incomplete replay cache: {e}"))?;
    let packed = u32::from_le_bytes(header[..4].try_into().unwrap()) as usize;
    let raw = u32::from_le_bytes(header[4..].try_into().unwrap()) as usize;
    if packed == 0 || packed > MAX_CHUNK_BYTES || raw > MAX_CHUNK_BYTES {
        return Err("Invalid compressed replay chunk size.".into());
    }
    let mut bytes = vec![0; packed];
    source.read_exact(&mut bytes).map_err(|e| e.to_string())?;
    let mut decoded = Vec::with_capacity(raw);
    ZlibDecoder::new(bytes.as_slice())
        .take(raw as u64 + 1)
        .read_to_end(&mut decoded)
        .map_err(|e| e.to_string())?;
    if decoded.len() != raw {
        return Err("Invalid compressed replay chunk.".into());
    }
    Ok(Some(decoded))
}

struct IngestState {
    previous: Option<u64>,
    has_static: bool,
}
fn index_record(
    index: &ReplayIndex,
    record: &[u8],
    offset: u64,
    state: &mut IngestState,
) -> Result<(), String> {
    #[derive(Deserialize)]
    struct Header {
        kind: String,
        frame: Option<u64>,
        #[serde(default)]
        audio: [u32; 2],
    }
    let record = record.trim_ascii();
    if record.is_empty() {
        return Ok(());
    }
    let mut cues = (0, 0);
    let frame = if let Some(rest) = record.strip_prefix(STATE_PREFIX) {
        let digits = rest.iter().take_while(|b| b.is_ascii_digit()).count();
        // Newly generated frames keep audio beside the frame number for fast
        // indexing. Older caches can have metadata between them; JSON property
        // order must never determine whether their sound effects are audible.
        cues = match sound_cues(&rest[digits..]) {
            Some(cues) => cues,
            None => {
                let row: Header = serde_json::from_slice(record)
                    .map_err(|e| format!("Invalid replay at byte {offset}: {e}"))?;
                (row.audio[0], row.audio[1])
            }
        };
        Some(
            std::str::from_utf8(&rest[..digits])
                .ok()
                .and_then(|text| text.parse().ok())
                .ok_or("Missing replay frame")?,
        )
    } else {
        let row: Header = serde_json::from_slice(record)
            .map_err(|e| format!("Invalid replay at byte {offset}: {e}"))?;
        match row.kind.as_str() {
            "static" => {
                let metadata: Value = serde_json::from_slice(record).map_err(|e| e.to_string())?;
                if metadata.get("rendered_map_surface").is_none()
                    && metadata.get("source_map_surface").is_none()
                {
                    return Err("This repsim has no embedded map. Open its original .rep to generate a playable repsim.".into());
                }
                state.has_static = true;
                index.update(|progress| progress.static_record = Some(metadata));
                None
            }
            "state" => {
                cues = (row.audio[0], row.audio[1]);
                Some(row.frame.ok_or("Missing replay frame")?)
            }
            _ => None,
        }
    };
    if let Some(frame) = frame {
        if state.previous.is_some_and(|previous| frame <= previous) {
            return Err("Replay frames must increase.".into());
        }
        state.previous = Some(frame);
        index.update(|progress| {
            progress.offsets.push((frame, offset));
            progress.fighting.push(cues.0);
            progress.produced.push(cues.1);
        });
    }
    Ok(())
}

fn flush_chunk(
    index: &ReplayIndex,
    sink: &mut File,
    pending: &mut Vec<u8>,
    offset: &mut u64,
    state: &mut IngestState,
) -> Result<(), String> {
    if pending.is_empty() {
        return Ok(());
    }
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::new(3));
    encoder.write_all(pending).map_err(|e| e.to_string())?;
    let compressed = encoder.finish().map_err(|e| e.to_string())?;
    let mut block = Vec::with_capacity(compressed.len() + 8);
    block.extend_from_slice(&(compressed.len() as u32).to_le_bytes());
    block.extend_from_slice(&(pending.len() as u32).to_le_bytes());
    block.extend_from_slice(&compressed);
    if let Some(budget) = &index.budget {
        budget.write(sink, &block)?;
    } else {
        sink.write_all(&block).map_err(|e| e.to_string())?;
    }
    // Readers only see a chunk after every byte has reached the file.
    for record in pending.split(|&b| b == b'\n') {
        index_record(index, record, *offset, state)?;
    }
    *offset += block.len() as u64;
    pending.clear();
    Ok(())
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

/// Reads JSONL replay records, optionally copying them to `sink`, and publishes
/// each frame offset after its bytes are written.
fn ingest(
    index: &ReplayIndex,
    mut source: impl BufRead,
    mut sink: Option<File>,
    closed: &AtomicBool,
) -> Result<(), String> {
    let mut state = IngestState {
        previous: None,
        has_static: false,
    };
    let mut offset = 0;
    let mut line = Vec::with_capacity(1 << 16);
    let mut pending = Vec::new();
    let mut pending_rows = 0;
    if let Some(sink) = sink.as_mut() {
        index.packed.store(true, Ordering::Release);
        if let Some(budget) = &index.budget {
            budget.write(sink, PACKED_MAGIC)?;
        } else {
            sink.write_all(PACKED_MAGIC).map_err(|e| e.to_string())?;
        }
        offset = PACKED_MAGIC.len() as u64;
    }
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
        if line.len() > MAX_CHUNK_BYTES {
            return Err("Replay record exceeds the cache limit.".into());
        }
        if let Some(sink) = sink.as_mut() {
            if pending.len() + line.len() > MAX_CHUNK_BYTES {
                flush_chunk(index, sink, &mut pending, &mut offset, &mut state)?;
                pending_rows = 0;
            }
            pending.extend_from_slice(&line);
            // JSONL input may have no newline on its final record.
            if !line.ends_with(b"\n") {
                pending.push(b'\n');
            }
            pending_rows += 1;
            if pending_rows >= 120
                || pending.len() >= 4 * 1024 * 1024
                || (state.previous.is_none() && line.starts_with(STATE_PREFIX))
            {
                flush_chunk(index, sink, &mut pending, &mut offset, &mut state)?;
                pending_rows = 0;
            }
        } else {
            index_record(index, &line, offset, &mut state)?;
            offset += count as u64;
        }
    }
    if let Some(sink) = sink.as_mut() {
        flush_chunk(index, sink, &mut pending, &mut offset, &mut state)?;
    }
    if state.previous.is_none() || !state.has_static {
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
                let mut source = BufReader::with_capacity(1 << 20, file);
                if source
                    .fill_buf()
                    .map_err(|e| e.to_string())?
                    .starts_with(PACKED_MAGIC)
                {
                    ingest_packed(&index, source, &session.closed)
                } else {
                    ingest(&index, source, None, &session.closed)
                }
            });
        match result {
            Ok(()) => index.update(|progress| progress.done = true),
            Err(error) => index.fail(error),
        }
    });
}

fn ingest_packed(
    index: &ReplayIndex,
    mut source: impl Read,
    closed: &AtomicBool,
) -> Result<(), String> {
    let mut magic = [0; 8];
    source.read_exact(&mut magic).map_err(|e| e.to_string())?;
    if &magic != PACKED_MAGIC {
        return Err("Invalid replay cache format.".into());
    }
    index.packed.store(true, Ordering::Release);
    let mut state = IngestState {
        previous: None,
        has_static: false,
    };
    // Read offsets from the actual stream, including variable compressed sizes.
    let mut source = CountingReader {
        source,
        position: 8,
    };
    loop {
        if closed.load(Ordering::Acquire) || index.cancelled.load(Ordering::Acquire) {
            return Err("Player closed.".into());
        }
        let offset = source.position;
        let Some(chunk) = read_chunk(&mut source)? else {
            break;
        };
        for row in chunk.split(|&b| b == b'\n') {
            index_record(index, row, offset, &mut state)?;
        }
    }
    if !state.has_static || state.previous.is_none() {
        return Err("Incomplete replay cache.".into());
    }
    Ok(())
}
struct CountingReader<R> {
    source: R,
    position: u64,
}
impl<R: Read> Read for CountingReader<R> {
    fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
        let count = self.source.read(bytes)?;
        self.position += count as u64;
        Ok(count)
    }
}

fn spawn_conversion(
    index: &Arc<ReplayIndex>,
    session: &Arc<Session>,
    mut child: Child,
    sink: File,
    output: PathBuf,
    mut log: File,
) {
    let (index, session) = (index.clone(), session.clone());
    std::thread::spawn(move || {
        let result = child
            .stdout
            .take()
            .ok_or_else(|| "Cannot read the replay simulator.".to_string())
            .and_then(|stdout| {
                ingest(
                    &index,
                    BufReader::with_capacity(1 << 20, stdout),
                    Some(sink),
                    &session.closed,
                )
            });
        if result.is_err() {
            let _ = child.kill();
        }
        let status = child.wait();
        let result = result.and_then(|()| match status {
            Ok(status) if status.success() => Ok(()),
            _ if session.closed.load(Ordering::Acquire) => Err("Player closed.".into()),
            _ => {
                let mut text = String::new();
                let _ = log.seek(SeekFrom::Start(0));
                let _ = log.read_to_string(&mut text);
                Err(format!("Could not simulate this replay: {}", text.trim()))
            }
        });
        match result {
            Ok(()) => index.update(|progress| {
                // Keep the finished simulation for the next open. Another window may
                // have cached the same replay first; then this copy is discarded.
                if !output.is_file() {
                    if let Some(temporary) = progress.temporary.take() {
                        match temporary.persist(&output) {
                            Ok(()) => progress.path = output.clone(),
                            Err(error) => progress.temporary = Some(error.path),
                        }
                    }
                }
                progress.done = true;
            }),
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
    while !(progress.done || (progress.static_record.is_some() && !progress.offsets.is_empty())) {
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
    let available = progress.offsets.last().map_or(0, |(frame, _)| *frame);
    let expected = static_record["replay"]["end"].as_u64().unwrap_or(0);
    Ok(ReplayInfo {
        path,
        last_frame: if progress.done {
            available
        } else {
            expected.max(available)
        },
        frame_numbers: progress.offsets.iter().map(|(frame, _)| *frame).collect(),
        fighting: progress.fighting.clone(),
        produced: progress.produced.clone(),
        complete: progress.done,
        static_record,
    })
}

#[cfg(test)]
fn index_replay(path: &Path) -> Result<(Arc<ReplayIndex>, Value), String> {
    let index = ReplayIndex::new(path.into(), None);
    let file = File::open(path).map_err(|e| e.to_string())?;
    ingest(&index, BufReader::new(file), None, &AtomicBool::new(false))?;
    let metadata = index
        .progress
        .lock()
        .unwrap()
        .static_record
        .clone()
        .unwrap();
    Ok((index, metadata))
}

fn cache_key(
    source: &Path,
    bytes: &[u8],
    manifest: &[u8],
    resources: &Path,
    game_dirs: &[PathBuf],
) -> Result<String, String> {
    let mut hasher = Sha256::new();
    hasher.update(manifest);
    hasher.update(bytes);
    let decoded = if bytes.starts_with(&[0x1f, 0x8b]) {
        let mut decoded = Vec::new();
        flate2::read::GzDecoder::new(bytes)
            .read_to_end(&mut decoded)
            .map_err(|e| e.to_string())?;
        decoded
    } else {
        bytes.to_vec()
    };
    let replay: Value =
        serde_json::from_slice(&decoded).map_err(|e| format!("Invalid replay JSON: {e}"))?;
    let map = if replay["map"].is_object() {
        &replay["map"]
    } else {
        &replay["custom_map"]
    };
    // Numeric built-ins now resolve through the engine's deployment catalog.
    // Hash their installed terrain too, just as for an explicit map object.
    let numbered_id = replay["map"].as_u64().map(|id| id.to_string()).or_else(|| {
        replay["map"].as_str().map(str::trim).filter(|id| !id.is_empty() && id.bytes().all(|c| c.is_ascii_digit()))
            .and_then(|id| id.parse::<u64>().ok()).map(|id| id.to_string())
    });
    let numbered_path = numbered_id.filter(|_| !map.is_object())
        .map(|id| format!("assets/fahero_maps/map{id}.png"));
    if let Some(path) = map["path"].as_str().or(numbered_path.as_deref()) {
        let normalized = path.replace('\\', "/");
        let requested = PathBuf::from(&normalized);
        let filename = requested
            .file_name()
            .ok_or("Replay map path has no filename")?;
        let directory = source.parent().ok_or("Replay has no directory")?;
        let mut candidates = vec![
            if requested.is_absolute() {
                requested.clone()
            } else {
                directory.join(&requested)
            },
            directory.join("maps").join(filename),
        ];
        // Same lookup order as the simulator's --game-dir option.
        if normalized.to_ascii_lowercase().starts_with("assets/") && !normalized.contains("..") {
            candidates.extend(game_dirs.iter().map(|root| root.join(&normalized)));
        }
        if requested.components().count() == 1
            || normalized
                .to_ascii_lowercase()
                .starts_with("assets/fahero_maps/")
        {
            candidates.push(resources.join("maps").join(filename));
        }
        if let Some(map) = candidates.iter().find(|path| path.is_file()) {
            let mut file = File::open(map).map_err(|e| e.to_string())?;
            let mut buffer = [0u8; 65536];
            loop {
                let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
                if count == 0 {
                    break;
                }
                hasher.update(&buffer[..count]);
            }
        }
    }
    Ok(format!("{:x}", hasher.finalize()))
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
        let index = if extension == "repsim" || extension == "jsonl" {
            let index = ReplayIndex::new(supplied.clone(), None);
            spawn_ingest(&index, &session, supplied);
            index
        } else {
            let executable = resource(&app, "ReplaySim.Standalone.exe")?;
            let budget = app.state::<Arc<StorageBudget>>().inner().clone();
            let cache = budget.root().join(CACHE_DIRECTORY);
            fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
            budget.maintain();
            let bytes = fs::read(&supplied).map_err(|e| e.to_string())?;
            let manifest = fs::read(resource(&app, "manifest.json")?).map_err(|e| e.to_string())?;
            let game_dirs = crate::installed_game_dirs();
            let key = cache_key(
                &supplied,
                &bytes,
                &manifest,
                executable.parent().unwrap(),
                &game_dirs,
            )?;
            let output = cache.join(format!("{key}.rps2"));
            let output_lease = budget.protect(&output);
            if output.is_file() {
                // Recency is the last successful open, rather than creation.
                if let Ok(file) = fs::OpenOptions::new().write(true).open(&output) {
                    let _ = file.set_modified(std::time::SystemTime::now());
                }
                let index =
                    ReplayIndex::with_cache(output.clone(), None, Some(budget), vec![output_lease]);
                spawn_ingest(&index, &session, output);
                index
            } else {
                // The simulator streams to stdout; frames are playable as soon as they
                // reach the temporary cache file.
                let temporary = tempfile::Builder::new()
                    .suffix(".rps2")
                    .tempfile_in(&cache)
                    .map_err(|e| e.to_string())?;
                let sink = temporary.as_file().try_clone().map_err(|e| e.to_string())?;
                let temporary = temporary.into_temp_path();
                let log = tempfile::tempfile().map_err(|e| e.to_string())?;
                let mut child = hidden(
                    Command::new(&executable)
                        .arg(&supplied)
                        .args(["--render-state", "-o", "-"])
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
                let temporary_lease = budget.protect(&temporary);
                let index = ReplayIndex::with_cache(
                    temporary.to_path_buf(),
                    Some(temporary),
                    Some(budget),
                    vec![output_lease, temporary_lease],
                );
                spawn_conversion(&index, &session, child, sink, output, log);
                index
            }
        };
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
        "frameNumbers": progress.offsets.iter().skip(since).map(|(frame, _)| *frame).collect::<Vec<_>>(),
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

fn read_frames(
    index: &ReplayIndex,
    start: usize,
    count: usize,
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    let (file, offsets) = {
        let progress = index.progress.lock().map_err(|e| e.to_string())?;
        let offsets: Vec<(u64, u64)> = progress
            .offsets
            .iter()
            .skip(start)
            .take(count.min(120))
            .copied()
            .collect();
        // Open while holding the progress lock. Completing a conversion can
        // rename its temporary file immediately after this lock is released.
        let file = File::open(&progress.path).map_err(|e| e.to_string())?;
        (file, offsets)
    };
    let mut stream = BufReader::new(file);
    let mut bytes = Vec::new();
    bytes.push(b'[');
    let mut line = Vec::new();
    let mut previous_chunk = None;
    let mut chunk = Vec::new();
    for (frame, offset) in offsets {
        line.clear();
        if index.packed.load(Ordering::Acquire) {
            if previous_chunk != Some(offset) {
                stream
                    .seek(SeekFrom::Start(offset))
                    .map_err(|e| e.to_string())?;
                chunk = read_chunk(&mut stream)?.ok_or("Replay cache changed. Reopen it.")?;
                previous_chunk = Some(offset);
            }
            let row = chunk
                .split(|&b| b == b'\n')
                .find(|row| {
                    if let Some(rest) = row.strip_prefix(STATE_PREFIX) {
                        let digits = rest.iter().take_while(|b| b.is_ascii_digit()).count();
                        std::str::from_utf8(&rest[..digits])
                            .ok()
                            .and_then(|s| s.parse::<u64>().ok())
                            == Some(frame)
                    } else {
                        false
                    }
                })
                .ok_or("Replay cache frame is missing.")?;
            line.extend_from_slice(row);
        } else {
            stream
                .seek(SeekFrom::Start(offset))
                .map_err(|e| e.to_string())?;
            if stream
                .read_until(b'\n', &mut line)
                .map_err(|e| e.to_string())?
                == 0
            {
                return Err("Replay file changed. Reopen it.".into());
            }
        }
        let row = line.trim_ascii();
        if row.len() + 2 > max_bytes {
            return Err("This replay frame exceeds the playback buffer limit.".into());
        }
        if bytes.len() + row.len() + 2 > max_bytes {
            break;
        }
        if bytes.len() > 1 {
            bytes.push(b',');
        }
        bytes.extend_from_slice(row);
    }
    bytes.push(b']');
    Ok(bytes)
}
#[tauri::command]
pub async fn replay_frames(
    start: usize,
    count: usize,
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<tauri::ipc::Response, String> {
    let session = app.state::<PlayerSessions>().session(window.label())?;
    tauri::async_runtime::spawn_blocking(move || {
        let index = session
            .replay
            .lock()
            .map_err(|e| e.to_string())?
            .clone()
            .ok_or("Open a replay first.")?;
        read_frames(&index, start, count, 8 * 1024 * 1024).map(tauri::ipc::Response::new)
    })
    .await
    .map_err(|e| e.to_string())?
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
    fn fixture(text: &str) -> tempfile::NamedTempFile {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(text.as_bytes()).unwrap();
        file
    }
    #[test]
    fn binary_frame_batches_preserve_rows_and_bound_payloads() {
        let file = fixture("{\"kind\":\"static\",\"source_map_surface\":\"embedded\"}\n{\"kind\":\"state\",\"frame\":0,\"dots\":[{\"name\":\"العراق\"}]}\n{\"kind\":\"state\",\"frame\":30}\n");
        let (index, _) = index_replay(file.path()).unwrap();
        let all = read_frames(&index, 0, 120, 1024).unwrap();
        let rows: Vec<Value> = serde_json::from_slice(&all).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["dots"][0]["name"], "العراق");
        let partial = read_frames(&index, 0, 120, all.len() - 1).unwrap();
        assert_eq!(
            serde_json::from_slice::<Vec<Value>>(&partial)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(read_frames(&index, 99, 10, 1024).unwrap(), b"[]");
        assert!(read_frames(&index, 0, 1, 10).is_err());
    }
    #[test]
    fn reading_frames_does_not_wait_for_the_encoder_lock() {
        let sessions = PlayerSessions::default();
        let session = sessions.session("replay-player-buffer").unwrap();
        let file = fixture("{\"kind\":\"static\",\"source_map_surface\":\"embedded\"}\n{\"kind\":\"state\",\"frame\":0}\n");
        let (index, _) = index_replay(file.path()).unwrap();
        *session.replay.lock().unwrap() = Some(index);
        let _encoder_busy = session.data.lock().unwrap();
        let index = session.replay.lock().unwrap().clone().unwrap();
        assert!(!read_frames(&index, 0, 1, 1024).unwrap().is_empty());
    }
    #[test]
    fn frame_offsets_skip_empty_and_non_state_records() {
        let file=fixture("{\"kind\":\"static\",\"source_map_surface\":\"embedded\"}\n\n{\"kind\":\"state\",\"frame\":0}\n{\"kind\":\"other\"}\n{\"kind\":\"state\",\"frame\":30}\n");
        let (index, _) = index_replay(file.path()).unwrap();
        assert_eq!(
            index.offsets().iter().map(|(f, _)| *f).collect::<Vec<_>>(),
            vec![0, 30]
        );
        let mut file = File::open(file.path()).unwrap();
        file.seek(SeekFrom::Start(index.offsets()[1].1)).unwrap();
        let mut line = String::new();
        BufReader::new(file).read_line(&mut line).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&line).unwrap()["frame"], 30);
    }
    #[test]
    fn sound_cues_follow_each_frame_and_default_to_silence() {
        let file = fixture("{\"kind\":\"static\",\"source_map_surface\":\"embedded\"}\n{\"kind\":\"state\",\"frame\":0,\"audio\":[0,0],\"dots\":[]}\n{\"kind\":\"state\",\"frame\":1,\"audio\":[12,3],\"dots\":[]}\n{\"kind\":\"state\",\"frame\":2,\"dots\":[]}\n");
        let (index, _) = index_replay(file.path()).unwrap();
        let progress = index.progress.lock().unwrap();
        assert_eq!(progress.fighting, vec![0, 12, 0]);
        assert_eq!(progress.produced, vec![0, 3, 0]);
    }
    #[test]
    fn sound_cues_survive_metadata_field_order_and_cached_frames() {
        let text = concat!(
            "{\"kind\":\"static\",\"source_map_surface\":\"embedded\"}\n",
            // The compatibility reader's former output, already present in caches.
            "{\"kind\":\"state\",\"frame\":0,\"compatibility\":{\"deferred_orders\":0,\"pending_orders\":0},\"audio\":[12,3],\"dots\":[]}\n",
            "{\"audio\": [8, 2], \"kind\": \"state\", \"frame\": 1, \"dots\": []}\n",
            // Nested keys must not be mistaken for the frame's audio cues.
            "{\"kind\":\"state\",\"frame\":2,\"compatibility\":{\"audio\":[99,99]},\"audio\":[4,1]}\n",
            "{\"kind\":\"state\",\"frame\":3,\"dots\":[]}\n",
        );
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("sound.rps2");
        let live = ReplayIndex::new(path.clone(), None);
        ingest(&live, std::io::Cursor::new(text), Some(File::create(&path).unwrap()), &AtomicBool::new(false)).unwrap();
        let cached = ReplayIndex::new(path.clone(), None);
        ingest_packed(&cached, File::open(&path).unwrap(), &AtomicBool::new(false)).unwrap();
        for index in [live, cached] {
            let progress = index.progress.lock().unwrap();
            assert_eq!(progress.fighting, vec![12, 8, 4, 0]);
            assert_eq!(progress.produced, vec![3, 2, 1, 0]);
        }
    }
    #[test]
    fn rejects_duplicate_frames_and_incomplete_files() {
        for text in ["{\"kind\":\"state\",\"frame\":0}\n", "{\"kind\":\"static\",\"source_map_surface\":\"embedded\"}\n{\"kind\":\"state\",\"frame\":1}\n{\"kind\":\"state\",\"frame\":1}\n"] {assert!(index_replay(fixture(text).path()).is_err());}
    }
    #[test]
    fn streamed_frames_are_read_from_the_copied_file() {
        let text = "{\"kind\":\"static\",\"source_map_surface\":\"embedded\"}
{\"kind\":\"state\",\"frame\":0}
{\"kind\":\"state\",\"frame\":30,\"dots\":[]}
";
        let copy = tempfile::NamedTempFile::new().unwrap();
        let index = ReplayIndex::new(copy.path().into(), None);
        ingest(
            &index,
            text.as_bytes(),
            Some(copy.reopen().unwrap()),
            &AtomicBool::new(false),
        )
        .unwrap();
        let rows: Vec<Value> =
            serde_json::from_slice(&read_frames(&index, 1, 1, 1024).unwrap()).unwrap();
        assert_eq!(rows[0]["frame"], 30);
        assert_eq!(index.offsets().len(), 2);
    }
    #[test]
    fn packed_cache_reopens_and_seeks_across_chunk_boundaries() {
        let mut text = String::from("{\"kind\":\"static\",\"source_map_surface\":\"embedded\"}\n");
        for frame in 0..127 {
            text.push_str(&format!("{{\"kind\":\"state\",\"frame\":{frame},\"audio\":[{frame},1],\"dots\":[{{\"name\":\"العراق\",\"path\":[1,2,3,4,5]}}]}}\n"));
        }
        let copy = tempfile::NamedTempFile::new().unwrap();
        let streamed = ReplayIndex::new(copy.path().into(), None);
        ingest(
            &streamed,
            text.as_bytes(),
            Some(copy.reopen().unwrap()),
            &AtomicBool::new(false),
        )
        .unwrap();
        assert!(copy.as_file().metadata().unwrap().len() < text.len() as u64 / 2);
        assert_eq!(streamed.offsets()[1].1, streamed.offsets()[29].1);
        let reopened = ReplayIndex::new(copy.path().into(), None);
        ingest_packed(&reopened, copy.reopen().unwrap(), &AtomicBool::new(false)).unwrap();
        assert_eq!(reopened.offsets(), streamed.offsets());
        for start in [0, 1, 29, 30, 59, 126] {
            let rows: Vec<Value> =
                serde_json::from_slice(&read_frames(&reopened, start, 9, 100_000).unwrap())
                    .unwrap();
            assert_eq!(rows.len(), 9.min(127 - start));
            for (n, row) in rows.iter().enumerate() {
                assert_eq!(row["frame"], start + n);
                assert_eq!(row["dots"][0]["name"], "العراق");
            }
        }
        let progress = reopened.progress.lock().unwrap();
        assert_eq!(progress.fighting[126], 126);
        assert_eq!(progress.produced[126], 1);
    }
    #[test]
    fn packed_cache_rejects_truncation_and_excessive_chunk_sizes() {
        for bytes in [
            vec![1],
            [u32::MAX.to_le_bytes(), 1u32.to_le_bytes()].concat(),
            [1u32.to_le_bytes(), u32::MAX.to_le_bytes()].concat(),
        ] {
            assert!(read_chunk(&mut bytes.as_slice()).is_err());
        }
        assert!(read_chunk(&mut &b""[..]).unwrap().is_none());
    }
    #[test]
    #[ignore = "requires WOD_STORAGE_FIXTURE pointing to a real cached simulation"]
    fn real_simulation_compresses_within_budget_and_preserves_seeks() {
        let source = PathBuf::from(std::env::var("WOD_STORAGE_FIXTURE").unwrap());
        let (original, _) = index_replay(&source).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let budget = StorageBudget::new(dir.path().into(), 200_000_000).unwrap();
        let cache = dir.path().join(CACHE_DIRECTORY);
        fs::create_dir(&cache).unwrap();
        let path = cache.join("real.rps2");
        let lease = budget.protect(&path);
        let packed = ReplayIndex::with_cache(path.clone(), None, Some(budget.clone()), vec![lease]);
        let started = std::time::Instant::now();
        ingest(
            &packed,
            BufReader::new(File::open(&source).unwrap()),
            Some(File::create(&path).unwrap()),
            &AtomicBool::new(false),
        )
        .unwrap();
        let reopened = ReplayIndex::new(path.clone(), None);
        ingest_packed(
            &reopened,
            File::open(&path).unwrap(),
            &AtomicBool::new(false),
        )
        .unwrap();
        let count = original.offsets().len();
        assert_eq!(reopened.offsets().len(), count);
        let mut expected_fighting = Vec::new();
        let mut expected_produced = Vec::new();
        for line in BufReader::new(File::open(&source).unwrap()).lines() {
            let row: Value = serde_json::from_str(&line.unwrap()).unwrap();
            if row["kind"] == "state" {
                expected_fighting.push(row["audio"][0].as_u64().unwrap_or(0) as u32);
                expected_produced.push(row["audio"][1].as_u64().unwrap_or(0) as u32);
            }
        }
        for index in [&original, &packed, &reopened] {
            let progress = index.progress.lock().unwrap();
            assert_eq!(progress.fighting, expected_fighting);
            assert_eq!(progress.produced, expected_produced);
        }
        println!("Real audio cues: {} fighting ticks, {} producing-side cues",
            expected_fighting.iter().filter(|&&count| count > 0).count(),
            expected_produced.iter().map(|mask| mask.count_ones()).sum::<u32>());
        for frame in [0, 1, 999.min(count - 1), count / 2, count - 1] {
            assert_eq!(
                read_frames(&original, frame, 1, MAX_CHUNK_BYTES).unwrap(),
                read_frames(&reopened, frame, 1, MAX_CHUNK_BYTES).unwrap()
            );
        }
        let size = path.metadata().unwrap().len();
        assert!(size + 200_000_000 < crate::storage::LOCAL_LIMIT);
        println!(
            "Real simulation: {} -> {} bytes; {} frames; {:.1}s; seek rows match exactly",
            source.metadata().unwrap().len(),
            size,
            count,
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
    #[test]
    fn external_map_and_engine_changes_invalidate_cache() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("replay.rep");
        let map = dir.path().join("custom.png");
        let bytes = br#"{"map":{"path":"custom.png"}}"#;
        fs::write(&map, b"first-map").unwrap();
        let first = cache_key(&source, bytes, b"engine-a", dir.path(), &[]).unwrap();
        assert_eq!(
            first,
            cache_key(&source, bytes, b"engine-a", dir.path(), &[]).unwrap()
        );
        fs::write(map, b"changed-map").unwrap();
        assert_ne!(
            first,
            cache_key(&source, bytes, b"engine-a", dir.path(), &[]).unwrap()
        );
        assert_ne!(
            first,
            cache_key(&source, bytes, b"engine-b", dir.path(), &[]).unwrap()
        );
    }

    #[test]
    fn legacy_custom_map_changes_invalidate_cache() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("replay.rep");
        let map = dir.path().join("custom.png");
        let bytes = br#"{"map":"custom","custom_map":{"path":"custom.png"}}"#;
        fs::write(&map, b"first-map").unwrap();
        let first = cache_key(&source, bytes, b"engine", dir.path(), &[]).unwrap();
        fs::write(&map, b"changed-map").unwrap();
        assert_ne!(first, cache_key(&source, bytes, b"engine", dir.path(), &[]).unwrap());
    }

    #[test]
    fn numbered_map_terrain_changes_invalidate_cache() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("assets/fahero_maps");
        fs::create_dir_all(&folder).unwrap();
        let terrain = folder.join("map24.png");
        let source = dir.path().join("replay.rep");
        for bytes in [br#"{"map":24,"mode":"1v1"}"#.as_slice(), br#"{"map":"24","mode":"experiment"}"#.as_slice(), br#"{"map":" 024 ","mode":"2v2"}"#.as_slice()] {
            fs::write(&terrain, b"first terrain").unwrap();
            let first = cache_key(&source, bytes, b"engine", dir.path(), &[dir.path().to_path_buf()]).unwrap();
            fs::write(&terrain, b"changed terrain").unwrap();
            assert_ne!(first, cache_key(&source, bytes, b"engine", dir.path(), &[dir.path().to_path_buf()]).unwrap());
        }
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
