//! The browser entry points. The page supplies the replay and any official map it
//! names, then receives the same chunk stream the desktop player reads from stdout.
//! The module exports plain functions; src/player/wasm-engine.js wraps them.

use replay_sim::output::{self, LabelRenderer};
use replay_sim::replay::{parse_replay_bytes, Replay};
use replay_sim::sim::{RunOptions, Simulator};
use replay_sim::surface::MapFiles;
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::Path;

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "env")]
extern "C" {
    /// Receives each piece of output as it is written.
    fn write(ptr: *const u8, len: usize);
}

/// Native builds of this crate only exist for workspace checks; output goes nowhere.
#[cfg(not(target_arch = "wasm32"))]
unsafe fn write(_ptr: *const u8, _len: usize) {}

struct State {
    files: MapFiles,
    replay: Option<Replay>,
    message: Vec<u8>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State {
        files: MapFiles { memory: Some(HashMap::new()), ..Default::default() },
        replay: None,
        message: Vec::new(),
    });
}

fn set_message(text: &str) {
    STATE.with(|state| state.borrow_mut().message = text.as_bytes().to_vec());
}

/// A failure traps the module; its message stays readable for the page.
fn install_panic_message() {
    std::panic::set_hook(Box::new(|info| {
        let text = info
            .payload()
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| info.payload().downcast_ref::<&str>().map(|s| s.to_string()))
            .unwrap_or_else(|| "The simulation failed.".into());
        let _ = STATE.try_with(|state| {
            if let Ok(mut state) = state.try_borrow_mut() {
                state.message = text.into_bytes();
            }
        });
    }));
}

/// Takes ownership of a buffer the page filled after `alloc`.
unsafe fn take(ptr: *mut u8, len: usize) -> Vec<u8> {
    Vec::from_raw_parts(ptr, len, len)
}

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut buffer = std::mem::ManuallyDrop::new(vec![0u8; len]);
    buffer.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn message_ptr() -> *const u8 {
    STATE.with(|state| state.borrow().message.as_ptr())
}

#[no_mangle]
pub extern "C" fn message_len() -> usize {
    STATE.with(|state| state.borrow().message.len())
}

/// Stores a map where the engine looks for bundled maps.
///
/// # Safety
/// Both buffers come from `alloc` with these lengths; the module takes them.
#[no_mangle]
pub unsafe extern "C" fn add_map(path_ptr: *mut u8, path_len: usize, data_ptr: *mut u8, data_len: usize) {
    let path = String::from_utf8_lossy(&take(path_ptr, path_len)).into_owned();
    let data = take(data_ptr, data_len);
    STATE.with(|state| state.borrow_mut().files.add_memory(&path, data));
}

/// Reads the replay. Returns 0 when it is ready, 1 when the page still has to
/// supply the official map named by the message, 2 on an error in the message.
///
/// # Safety
/// The buffer comes from `alloc` with this length; the module takes it.
#[no_mangle]
pub unsafe extern "C" fn open(data_ptr: *mut u8, data_len: usize) -> i32 {
    install_panic_message();
    let data = take(data_ptr, data_len);
    STATE.with(|state| {
        let mut state = state.borrow_mut();
        state.replay = None;
        state.files.unresolved = None;
        let result = parse_replay_bytes(&data).and_then(|root| Replay::from_json(&root, Path::new(""), &mut state.files));
        match result {
            Ok(replay) => {
                state.replay = Some(replay);
                0
            }
            Err(error) => match state.files.unresolved.clone() {
                Some(missing) => {
                    state.message = missing.into_bytes();
                    1
                }
                None => {
                    state.message = error.into_bytes();
                    2
                }
            },
        }
    })
}

struct Host;

impl std::io::Write for Host {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        unsafe { write(buf.as_ptr(), buf.len()) };
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn text_label(label: &str, _side: usize) -> Value {
    // The page draws the names itself; the browser has no text renderer here.
    json!({ "text": label })
}

/// Simulates the opened replay, passing playback chunks (docs/replay-frames.md)
/// to the page as they are written. Mode 1 writes the desktop engine's JSONL
/// output for parity checks instead, and mode 2 only each side's troops. Returns
/// 0, or 2 with an error in the message.
#[no_mangle]
pub extern "C" fn run(mode: i32) -> i32 {
    let Some(replay) = STATE.with(|state| state.borrow_mut().replay.take()) else {
        set_message("Open a replay first.");
        return 2;
    };
    let mut simulator = Simulator::new(replay);
    let options = RunOptions { max_frame: None, sample_every: 1, no_combat: false, render_state: true };
    let labels: &LabelRenderer = &text_label;
    let result = match mode {
        1 => output::write_jsonl(&mut simulator, &options, labels, &mut Host),
        2 => output::write_troops(&mut simulator, &RunOptions { sample_every: 30, render_state: false, ..options }, &mut Host),
        _ => output::write_chunks(&mut simulator, &options, labels, &mut Host),
    };
    match result {
        Ok(_) => 0,
        Err(error) => {
            set_message(&error.to_string());
            2
        }
    }
}
