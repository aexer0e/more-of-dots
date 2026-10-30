//! Converts a replay straight to raw video frames: simulate, build the player's
//! draw list, render offscreen and write top-down RGB24 frames to stdout.
//! Progress lines ("progress done total") and sound cues go to stderr.

use crate::frame_draws::{FrameDraws, Label};
use crate::output;
use crate::render::{rgb_to_pixmap, straight_to_pixmap, Request, Surface};
use crate::sim::{RunOptions, Simulator};
use crate::text;
use std::collections::{BTreeMap, HashSet};
use std::fmt::Write as _;
use std::io::Write;
use std::sync::{mpsc, Arc, Mutex};

pub struct VideoOptions {
    pub width: usize,
    pub height: usize,
    pub step: i32,
    pub layers: HashSet<String>,
    pub assets: std::path::PathBuf,
    pub dump_draws: Option<String>,
    pub render_threads: usize,
}

type Job = (u64, Request);

pub fn export(mut sim: Simulator, run: &RunOptions, options: &VideoOptions) -> Result<(), String> {
    sim.render_state = true;
    let world = [sim.replay.map.width as f64, sim.replay.map.height as f64];
    let mut artwork: Vec<(String, tiny_skia::Pixmap)> = Vec::new();
    let mut entries: Vec<_> = std::fs::read_dir(&options.assets).map_err(|e| format!("Could not find a part of the path '{}': {e}", options.assets.display()))?.flatten().map(|e| e.path()).collect();
    entries.sort();
    for path in entries {
        if path.extension().is_some_and(|e| e.eq_ignore_ascii_case("png")) {
            let name = path.file_stem().unwrap().to_string_lossy().into_owned();
            let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
            artwork.push((name, tiny_skia::Pixmap::decode_png(&bytes).map_err(|_| "Cannot decode artwork".to_string())?));
        }
    }
    let surface = &sim.replay.map.surface;
    // The player draws the map scaled to world size without smoothing; the rendered surface already is.
    artwork.push(("map".into(), rgb_to_pixmap(&surface.pixels, surface.width, surface.height)));
    let mut labels = Vec::new();
    for (side, team) in sim.replay.player_labels.iter().enumerate() {
        for (slot, label) in team.iter().enumerate() {
            let raster = text::player_name(label, side);
            let key = format!("player-{side}-{slot}");
            // One line per player, teams in order.
            labels.push(Label { key: key.clone(), width: raster.width as f64, height: raster.height as f64, line: labels.len() });
            artwork.push((key, straight_to_pixmap(&raster.rgba, raster.width, raster.height)));
        }
    }
    let artwork = Arc::new(artwork);
    let draws = FrameDraws { width: options.width, height: options.height, world, layers: options.layers.clone(), labels };
    let step = options.step;
    let end = sim.replay.end_tick.min(run.max_frame.unwrap_or(sim.replay.end_tick));
    let total = end / step + 1;
    let result = sim.replay.result;
    let frame_bytes = options.width * options.height * 3;

    // Frames are simulated in order and drawn on several surfaces at once, then written in order.
    let (jobs, job_queue) = mpsc::channel::<Job>();
    let job_queue = Arc::new(Mutex::new(job_queue));
    let (done, finished) = mpsc::channel::<(u64, Result<Vec<u8>, String>)>();
    let mut workers = Vec::new();
    for _ in 0..options.render_threads {
        let (queue, done, artwork) = (job_queue.clone(), done.clone(), artwork.clone());
        let (width, height) = (options.width, options.height);
        workers.push(std::thread::spawn(move || {
            let mut surface = Surface::new(width, height);
            for (name, pixmap) in artwork.iter() {
                surface.set_texture(name, pixmap.clone());
            }
            loop {
                let job = queue.lock().unwrap().recv();
                let Ok((index, request)) = job else { break };
                let frame = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| surface.render(&request).to_vec())).map_err(|_| "Drawing a frame failed.".to_string());
                if done.send((index, frame)).is_err() {
                    break;
                }
            }
        }));
    }
    drop(done);

    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let stderr = std::io::stderr();
    let mut err = stderr.lock();
    let _ = writeln!(err, "progress 0 {total}");
    let mut sent = 0u64;
    let mut written = 0u64;
    let mut ready: BTreeMap<u64, Vec<u8>> = BTreeMap::new();
    let mut cues = String::new();
    let mut dump = match &options.dump_draws {
        Some(path) => Some(std::fs::OpenOptions::new().create(true).append(true).open(path).map_err(|e| e.to_string())?),
        None => None,
    };
    let write = |keep: u64, out: &mut std::io::StdoutLock, err: &mut std::io::StderrLock, ready: &mut BTreeMap<u64, Vec<u8>>, sent: u64, written: &mut u64| -> Result<(), String> {
        while sent - *written > keep {
            while !ready.contains_key(written) {
                let (index, frame) = finished.recv().map_err(|_| "The renderer stopped.".to_string())?;
                ready.insert(index, frame?);
            }
            let frame = ready.remove(written).unwrap();
            out.write_all(&frame[..frame_bytes]).map_err(|e| e.to_string())?;
            *written += 1;
            if *written % 15 == 0 || *written == total as u64 {
                let _ = writeln!(err, "progress {written} {total}");
            }
        }
        Ok(())
    };
    let keep = options.render_threads as u64 * 2;
    let simulated = sim.run(run, |sim, frame| -> Result<(), String> {
        let produced = sim.take_produced_sides();
        let _ = writeln!(cues, "sound {frame} {} {produced}", sim.fight_count);
        if frame % step != 0 {
            return Ok(());
        }
        let _ = err.write_all(cues.as_bytes());
        cues.clear();
        let request = Request { width: options.width, height: options.height, map_size: world, draws: draws.build(sim, frame) };
        if let Some(file) = dump.as_mut() {
            let _ = writeln!(file, "{}", dump_request(&request));
        }
        jobs.send((sent, request)).map_err(|_| "The renderer stopped.".to_string())?;
        sent += 1;
        // Two frames per surface keep every surface busy while the oldest frame is written.
        write(keep, &mut out, &mut err, &mut ready, sent, &mut written)
    });
    let flushed = simulated.and_then(|_| write(0, &mut out, &mut err, &mut ready, sent, &mut written));
    drop(jobs);
    for worker in workers {
        let _ = worker.join();
    }
    flushed?;
    let _ = err.write_all(cues.as_bytes());
    let mut line = String::from("result ");
    match result {
        Some(value) => output::number(&mut line, value),
        None => line.push_str("none"),
    }
    let _ = writeln!(err, "{line}");
    out.flush().map_err(|e| e.to_string())
}

fn dump_request(request: &Request) -> String {
    use crate::render::Draw;
    let draws: Vec<serde_json::Value> = request
        .draws
        .iter()
        .map(|draw| match draw {
            Draw::Image { name, position, size, alpha, direction, screen, flip_y } => {
                serde_json::json!({"type":"image","name":name,"position":position,"size":size,"alpha":alpha,"direction":direction,"screen":screen,"flipY":flip_y})
            }
            Draw::Text { name, text, position, color, fix, font_size, outline } => {
                serde_json::json!({"type":"text","name":name,"text":text,"position":position,"color":color,"fix":fix,"fontSize":font_size,"outline":outline})
            }
            Draw::Circle { position, radius, color } => serde_json::json!({"type":"circle","position":position,"radius":radius,"color":color}),
            Draw::Polygon { points, color } => serde_json::json!({"type":"polygon","points":points,"color":color}),
            Draw::Line { points, color, width } => serde_json::json!({"type":"line","points":points,"color":color,"width":width}),
        })
        .collect();
    serde_json::json!({"kind":"render","width":request.width,"height":request.height,"mapSize":request.map_size,"draws":draws}).to_string()
}

