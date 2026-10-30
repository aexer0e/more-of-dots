use replay_sim::output;
use replay_sim::replay::Replay;
use replay_sim::sim::{RunOptions, Simulator};
use replay_sim::surface::MapFiles;
use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;

struct Options {
    input: Option<String>,
    output: Option<String>,
    max_frame: Option<i32>,
    sample_every: i32,
    no_combat: bool,
    help: bool,
    export_terrain: Option<String>,
    export_contours: Option<String>,
    export_regions: Option<String>,
    binary_frames: bool,
    render_state: bool,
    game_dirs: Vec<PathBuf>,
    replay_dirs: Vec<PathBuf>,
    export_video: bool,
    width: i32,
    height: i32,
    step: i32,
    layers: HashSet<String>,
    assets: Option<String>,
    dump_draws: Option<String>,
    render_threads: i32,
}

const HELP: &str = "ReplaySim - offline War of Dots replay simulator

Usage:
  replay-sim input.rep [-o output.repsim]
  replay-sim input.rep --render-state -o -   (stream to stdout)

Options:
  --max-frame N       stop after frame N (development/parity probes)
  --sample-every N    write every Nth state frame (default: 1)
  --no-combat         disable combat while debugging movement
  --format F          jsonl (default) or binary: compact playback chunks with
                      render state (docs/replay-frames.md)
  --game-dir DIR      installed game folder for official maps (repeatable)
  --replay-dir DIR    replay folder with layouts for maps the catalog lacks (repeatable)
  --export-video      write raw RGB24 video frames to stdout, progress to stderr
    --width W --height H   frame size (default 1920x1080)
    --step N               draw every Nth simulated frame (playback speed)
    --layers a,b,...       orders,health,morale,flags,stats,icons,produce,players
    --assets DIR           unit artwork folder (default: player-assets)
    --render-threads N     frames drawn at once (default: half the cores, at most 4)
  -h, --help          show this help

The tool reads gzip or plain JSON .rep files and does not launch or require
the game. Full output is viewer-compatible JSONL (.repsim).";

fn parse_number(value: &str) -> Result<i32, String> {
    value.trim().parse().map_err(|_| "The input string was not in a correct format.".to_string())
}

impl Options {
    fn parse(args: &[String]) -> Result<Options, String> {
        let cores = std::thread::available_parallelism().map(|n| n.get() as i32).unwrap_or(2);
        let mut o = Options {
            input: None,
            output: None,
            max_frame: None,
            sample_every: 1,
            no_combat: false,
            help: false,
            export_terrain: None,
            export_contours: None,
            export_regions: None,
            binary_frames: false,
            render_state: false,
            game_dirs: Vec::new(),
            replay_dirs: Vec::new(),
            export_video: false,
            width: 1920,
            height: 1080,
            step: 1,
            layers: ["orders", "health", "morale", "flags", "icons", "stats", "players"].iter().map(|s| s.to_string()).collect(),
            assets: None,
            dump_draws: None,
            render_threads: (cores / 2).clamp(1, 4),
        };
        let mut i = 0;
        while i < args.len() {
            let arg = args[i].as_str();
            let mut next = || -> Result<String, String> {
                i += 1;
                args.get(i).cloned().ok_or_else(|| format!("Missing value for {arg}."))
            };
            match arg {
                "-h" | "--help" => o.help = true,
                "-o" | "--output" => o.output = Some(next()?),
                "--max-frame" => o.max_frame = Some(parse_number(&next()?)?),
                "--sample-every" => o.sample_every = parse_number(&next()?)?,
                "--no-combat" => o.no_combat = true,
                "--recovered-movement" => {}
                "--export-terrain" => o.export_terrain = Some(next()?),
                "--export-contours" => o.export_contours = Some(next()?),
                "--export-regions" => o.export_regions = Some(next()?),
                "--render-state" => o.render_state = true,
                "--format" => {
                    o.binary_frames = match next()?.as_str() {
                        "jsonl" => false,
                        "binary" => true,
                        format => return Err(format!("Unknown output format: {format}")),
                    };
                    // The player draws from render state, so binary frames always carry it.
                    o.render_state |= o.binary_frames;
                }
                "--game-dir" => o.game_dirs.push(next()?.into()),
                "--replay-dir" => o.replay_dirs.push(next()?.into()),
                "--export-video" => {
                    o.export_video = true;
                    o.render_state = true;
                }
                "--width" => o.width = parse_number(&next()?)?,
                "--height" => o.height = parse_number(&next()?)?,
                "--step" => o.step = parse_number(&next()?)?,
                "--layers" => o.layers = next()?.split(',').filter(|s| !s.is_empty()).map(str::to_string).collect(),
                "--assets" => o.assets = Some(next()?),
                "--dump-draws" => o.dump_draws = Some(next()?),
                "--render-threads" => o.render_threads = parse_number(&next()?)?,
                _ => {
                    if arg.starts_with('-') && arg != "-" {
                        return Err(format!("Unknown option: {arg}"));
                    }
                    if o.input.is_some() {
                        return Err("Only one input replay may be supplied.".into());
                    }
                    o.input = Some(arg.to_string());
                }
            }
            i += 1;
        }
        if o.max_frame.is_some_and(|m| m < 0) {
            return Err("--max-frame must be non-negative.".into());
        }
        if o.sample_every < 1 {
            return Err("--sample-every must be positive.".into());
        }
        if o.step < 1 {
            return Err("--step must be positive.".into());
        }
        if !(1..=64).contains(&o.render_threads) {
            return Err("--render-threads must be between 1 and 64.".into());
        }
        if !(2..=3840).contains(&o.width) || !(2..=2160).contains(&o.height) || o.width % 2 != 0 || o.height % 2 != 0 {
            return Err("Video size must be even and at most 3840x2160.".into());
        }
        Ok(o)
    }

    fn run_options(&self) -> RunOptions {
        RunOptions { max_frame: self.max_frame, sample_every: self.sample_every, no_combat: self.no_combat, render_state: self.render_state }
    }
}

/// The engine's own folder, where bundled maps and artwork are staged.
fn base_directory() -> PathBuf {
    std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf)).unwrap_or_default()
}

fn player_assets() -> PathBuf {
    let staged = base_directory().join("player-assets");
    if staged.is_dir() {
        return staged;
    }
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../public/player-assets");
    if source.is_dir() {
        source
    } else {
        staged
    }
}

fn bundled_maps() -> Option<PathBuf> {
    let staged = base_directory().join("maps");
    if staged.is_dir() {
        return Some(staged);
    }
    // Development builds run from target/, beside the repository's maps.
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../maps");
    source.is_dir().then_some(source)
}

fn panic_message(panic: &(dyn std::any::Any + Send)) -> String {
    panic.downcast_ref::<String>().cloned().or_else(|| panic.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_else(|| "The simulation failed.".into())
}

fn run(args: &[String]) -> Result<(), String> {
    let options = Options::parse(args)?;
    if options.help {
        println!("{HELP}");
        return Ok(());
    }
    let input = options.input.clone().filter(|s| !s.trim().is_empty()).ok_or("An input .rep file is required.")?;
    let mut files = MapFiles { game_dirs: options.game_dirs.clone(), replay_dirs: options.replay_dirs.clone(), bundled: bundled_maps(), ..Default::default() };
    let replay = Replay::read(Path::new(&input), &mut files)?;
    if options.export_video {
        let video = replay_sim::video::VideoOptions {
            width: options.width as usize,
            height: options.height as usize,
            step: options.step,
            layers: options.layers.clone(),
            assets: options.assets.clone().map(PathBuf::from).unwrap_or_else(player_assets),
            dump_draws: options.dump_draws.clone(),
            render_threads: options.render_threads as usize,
        };
        return replay_sim::video::export(Simulator::new(replay), &options.run_options(), &video);
    }
    if let Some(path) = &options.export_terrain {
        std::fs::write(path, replay.map.surface.terrain_ids().unwrap_or_default()).map_err(|e| e.to_string())?;
    }
    let run_options = options.run_options();
    let output = options.output.clone().unwrap_or_else(|| Path::new(&input).with_extension("repsim").to_string_lossy().into_owned());
    let labels: &output::LabelRenderer = &replay_sim::text::player_label;
    if output == "-" {
        // Streaming lets a viewer start on the first frames while later ones are simulated.
        let stdout = std::io::stdout();
        let mut stdout = stdout.lock();
        let mut simulator = Simulator::new(replay);
        let result = if options.binary_frames {
            output::write_chunks(&mut simulator, &run_options, labels, &mut stdout)
        } else {
            output::write_jsonl(&mut simulator, &run_options, labels, &mut stdout)
        };
        stdout.flush().ok();
        return result.map(|_| ()).map_err(|e| e.to_string());
    }
    let output_path = std::path::absolute(&output).map_err(|e| e.to_string())?;
    let input_path = std::path::absolute(&input).map_err(|e| e.to_string())?;
    if output_path.to_string_lossy().eq_ignore_ascii_case(&input_path.to_string_lossy()) {
        return Err("The output must be a different file from the input replay.".into());
    }
    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let (mode, end, units, orders, productions) = (replay.mode.clone(), replay.end_tick, replay.units.len(), replay.order_count(), replay.production_count());
    let mut simulator = Simulator::new(replay);
    let temporary = PathBuf::from(format!("{}.{}.tmp", output_path.display(), std::process::id()));
    let started = Instant::now();
    let written = (|| -> std::io::Result<u64> {
        let mut file = std::io::BufWriter::new(std::fs::File::create(&temporary)?);
        let frames = if options.binary_frames {
            output::write_chunks(&mut simulator, &run_options, labels, &mut file)?
        } else {
            output::write_jsonl(&mut simulator, &run_options, labels, &mut file)?
        };
        file.flush()?;
        Ok(frames)
    })();
    let elapsed = started.elapsed();
    let frames = match written {
        Ok(frames) => frames,
        Err(error) => {
            let _ = std::fs::remove_file(&temporary);
            return Err(error.to_string());
        }
    };
    std::fs::rename(&temporary, &output_path).map_err(|e| {
        let _ = std::fs::remove_file(&temporary);
        e.to_string()
    })?;
    if let Some(path) = &options.export_contours {
        let contours = simulator.territory.contours();
        let value: Vec<Vec<Vec<[f64; 2]>>> = contours.iter().map(|side| side.iter().map(|polygon| polygon.iter().map(|p| [p.x, p.y]).collect()).collect()).collect();
        std::fs::write(path, serde_json::to_string(&value).unwrap()).map_err(|e| e.to_string())?;
    }
    if let Some(path) = &options.export_regions {
        let regions = simulator.territory.regions.as_ref().ok_or("No territory update has occurred.")?;
        std::fs::write(path, regions).map_err(|e| e.to_string())?;
    }
    let bytes = std::fs::metadata(&output_path).map(|m| m.len()).unwrap_or(0);
    println!("Generated {}", output_path.display());
    println!("Replay: mode={mode} end={end} units={units} orders={orders} production={productions}");
    println!("Output: frames={frames} bytes={bytes} elapsed={:.0} ms rate={:.0} frames/s", elapsed.as_secs_f64() * 1000.0, frames as f64 / elapsed.as_secs_f64().max(0.001));
    Ok(())
}

fn main() -> ExitCode {
    // Failures are reported as one line the hosts show to the player.
    std::panic::set_hook(Box::new(|_| {}));
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--render-worker") {
        return ExitCode::from(replay_sim::render::run_worker() as u8);
    }
    match std::panic::catch_unwind(|| run(&args)) {
        Ok(Ok(())) => ExitCode::SUCCESS,
        Ok(Err(message)) => {
            eprintln!("replay-sim: {message}");
            ExitCode::from(2)
        }
        Err(panic) => {
            eprintln!("replay-sim: {}", panic_message(&*panic));
            ExitCode::from(2)
        }
    }
}
