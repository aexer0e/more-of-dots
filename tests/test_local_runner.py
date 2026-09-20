from __future__ import annotations

import sys
import gzip
import json
import io
import os
import shutil
import subprocess
import threading
import traceback
from pathlib import Path
from types import SimpleNamespace

import pytest

from wod_replay_server.local_runner import LocalSessionRunner


def test_replay_setup_overrides_new_game_offline_defaults() -> None:
    content = (Path(__file__).resolve().parents[1] / "scripts/local-runner.ps1").read_text(encoding="utf-8")
    source = "def prepare_play_scene_for_replay" + content.split(
        "def prepare_play_scene_for_replay", 1
    )[1].split("\ndef get_game_scene_objects", 1)[0]
    namespace = {"attrs_of": vars, "summarize_obj": vars}
    exec(source, namespace)
    scene = SimpleNamespace(
        game_type="offline", game_mode="solo", instant_start=True,
        game_setup={"type": "offline", "mode": "solo", "campaign": False},
    )
    namespace["prepare_play_scene_for_replay"](scene, {"map": {"path": "assets/fahero_maps/map20.png"}})
    assert scene.game_type == scene.game_setup["type"] == "replay"
    assert scene.game_mode == scene.game_setup["mode"] == "replay"
    assert scene.instant_start is False
    assert scene.game_setup["replay_file"] == "replay1"
    assert scene.game_setup["room"] is False


@pytest.mark.skipif(shutil.which("powershell.exe") is None, reason="Windows PowerShell required")
@pytest.mark.parametrize("recording,music,sfx", [(False, 0, 0), (True, 35, 70), (True, 0, 60)])
def test_staged_config_acknowledges_target_game_not_old_replay(tmp_path: Path, recording: bool, music: int, sfx: int) -> None:
    root = Path(__file__).resolve().parents[1]
    game = tmp_path / "game"
    job = tmp_path / "job"
    game.mkdir()
    job.mkdir()
    old_config = gzip.compress(b'{"welcome":true,"version":"1.3.4"}')
    (game / "config.txt").write_bytes(old_config)
    (job / "input.rep").write_bytes(b"test replay")
    (job / "capture-request.json").write_text(json.dumps({
        "replay_metadata": {"version": "1.3.4", "target_game_version": "1.4.1"},
    }), encoding="utf-8")
    script = tmp_path / "test-config.ps1"
    script.write_text(r'''
param($Runner, $Game, $Job, $Recording, [int]$MusicVolume, [int]$SfxVolume)
$RecordReplay = $Recording -eq 'True'
$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Runner, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
# Load only file/config helpers. Never execute the runner or launch the game.
$allowed = @('New-AutomationGameConfig', 'Prepare-ReplaySlot', 'Write-GzipJsonFile', 'ConvertTo-JsonBytes', 'Read-JsonFile', 'Backup-FileIfExists', 'Restore-FileBackup', 'Restore-ReplaySlot')
foreach ($statement in $ast.EndBlock.Statements) {
    if ($statement -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $statement.Name -in $allowed) {
        Invoke-Expression $statement.Extent.Text
    }
}
function Get-GameDir { return $Game }
function Get-JobRoot($Id) { return $Job }
$state = Prepare-ReplaySlot -Id 'test'
Copy-Item -LiteralPath (Join-Path $Game 'config.txt') -Destination (Join-Path $Job 'prepared-config.gz')
Restore-ReplaySlot $state
''', encoding="utf-8")
    subprocess.run([
        "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script),
        str(root / "scripts/local-runner.ps1"), str(game), str(job), str(recording), str(music), str(sfx),
    ], check=True, capture_output=True, text=True)
    config = json.loads(gzip.decompress((job / "prepared-config.gz").read_bytes()))
    assert config["music_volume"] == (music / 100 if recording else 0)
    assert config["sfx_volume"] == (sfx / 100 if recording else 0)
    assert config["version"] == "1.4.1"
    assert config["welcome"] is False
    assert config["login"] == {"username": None, "password": None}
    assert config["replays"]["saved_replays"] == [1]
    assert (game / "config.txt").read_bytes() == old_config
    assert not (game / "replays/replay1.rep").exists()


def test_runner_command_contains_local_capture_arguments(tmp_path: Path) -> None:
    runner_script = tmp_path / "local-runner.ps1"
    runner_script.write_text("param()", encoding="utf-8")
    runtime_dir = tmp_path / "runtime"
    staged_game_dir = runtime_dir / "staged-game"
    staged_game_dir.mkdir(parents=True)

    settings = SimpleNamespace(
        local_runner_script=runner_script,
        runtime_dir=runtime_dir,
        staged_game_dir=staged_game_dir,
        game_window_title="War of Dots",
        game_desktop_strategy="automation-desktop",
        game_window_strategy="offscreen",
    )
    runner = LocalSessionRunner(settings, owner_pid=4321)

    command = runner._runner_command(  # noqa: SLF001
        ["-CaptureReplay", "-JobId", "abc123", "-SampleHz", "10"],
        timeout_ms=5000,
    )

    assert "powershell.exe" in command
    assert str(runner_script) in command
    assert "-CaptureReplay" in command
    assert "-DesktopStrategy" in command
    assert "automation-desktop" in command
    assert "-OwnerProcessId" in command
    assert "4321" in command
    assert "-GameSourceDir" in command
    assert str(staged_game_dir) in command
    assert "abc123" in command
    assert str(runtime_dir) in command


def test_component_fast_forward_steps_economy() -> None:
    runner_script = Path(__file__).resolve().parents[1] / "scripts" / "local-runner.ps1"
    content = runner_script.read_text(encoding="utf-8")

    assert "'pay_turn'," in content
    assert "'dot_production_new'," in content
    assert "FULL_CAPTURE_COMPONENT_STEP_METHODS = (" in content
    assert "default_component_step_methods = FULL_CAPTURE_COMPONENT_STEP_METHODS if CAPTURE_UNTIL_END else DEFAULT_COMPONENT_STEP_METHODS" in content
    assert "default_fast_forward_step_method = 'manual' if CAPTURE_UNTIL_END else 'game-update'" in content
    assert "WOD_LIVE_FAST_FORWARD_COMPONENT_METHODS" in content
    assert "FAST_FORWARD_COMPONENT_STEP_METHODS" in content
    assert "'fast_forward_component_methods': list(FAST_FORWARD_COMPONENT_STEP_METHODS)" in content
    assert "def can_step_game_frame" in content
    assert "if not can_step_game_frame(game):" in content


def test_city_owner_polling_does_not_treat_encirclement_as_direct_owner() -> None:
    runner_script = Path(__file__).resolve().parents[1] / "scripts" / "local-runner.ps1"
    content = runner_script.read_text(encoding="utf-8")
    city_source_block = content.split("def city_control_sources", 1)[1].split("def authoritative_city_owner_source", 1)[0]

    assert "'city_enc'" not in city_source_block
    assert "def authoritative_city_owner_source" in content
    assert "if authoritative_city_owner_source(city.get('owner_source')):" in content


def test_live_capture_validation_requires_city_polling_when_city_counters_exist() -> None:
    runner_script = Path(__file__).resolve().parents[1] / "scripts" / "local-runner.ps1"
    content = runner_script.read_text(encoding="utf-8")

    assert "def city_stats_from_samples" in content
    assert "live city polling did not expose city objects" in content
    assert "live city owner totals did not match city counters" in content
    assert "'transient_mismatch_count': len(transient_mismatches)" in content
    assert "city owner changed before aggregate counter caught up" in content


def test_city_owner_progress_diagnostics_are_emitted() -> None:
    runner_script = Path(__file__).resolve().parents[1] / "scripts" / "local-runner.ps1"
    content = runner_script.read_text(encoding="utf-8")

    assert "def city_owner_summary" in content
    assert "def city_owner_transitions" in content
    assert "'city_owner_counts': city_summary.get('owner_counts')" in content
    assert "'city_owner_source_counts': city_summary.get('owner_source_counts')" in content
    assert "'city_owner_count_mismatch': city_summary.get('owner_count_mismatch')" in content
    assert "'city_owner_transitions': city_owner_changes" in content
    assert "'city_owner_transitions': city_owner_changes," in content
    assert "artifact['city_owner_transition_count'] = city_owner_transition_total" in content


def test_frontend_uses_funds_metric_fallback_for_capture_progress() -> None:
    frontend = Path(__file__).resolve().parents[1] / "src" / "main.ts"
    content = frontend.read_text(encoding="utf-8")

    assert "const funds = formatStat(fundsMetricValue(team));" in content
    assert "owner_source?: string | null;" in content
    assert "city_owner_count_mismatch?: boolean;" in content


def test_frontend_tracks_browser_replay_launches_per_path() -> None:
    frontend = Path(__file__).resolve().parents[1] / "src" / "main.ts"
    content = frontend.read_text(encoding="utf-8")

    assert "let browserOpeningPaths = new Set<string>();" in content
    assert "browserOpeningPaths.has(replay.filePath)" in content
    assert "browserOpeningPaths.add(replay.filePath)" in content
    assert "browserOpeningPaths.delete(replay.filePath)" in content
    assert "let browserOpeningPath = \"\";" not in content
    assert "if (browserOpeningPath) return;" not in content


def test_live_capture_polls_game_lines_and_bridges() -> None:
    runner_script = Path(__file__).resolve().parents[1] / "scripts" / "local-runner.ps1"
    content = runner_script.read_text(encoding="utf-8")

    assert "RECENT_RENDER_BRIDGE_LINES = []" in content
    assert "TERRAIN_BRIDGE_LINE_CACHE = {}" in content
    assert "BRIDGE_FIELD_LINE_CACHE = {}" in content
    assert "default_fast_forward_step_method = 'manual' if CAPTURE_UNTIL_END else 'game-update'" in content
    assert "READ_SCENE_PROJECTION_LINES = os.environ.get('WOD_LIVE_READ_SCENE_PROJECTION_LINES', '1')" in content
    assert "remember_render_lines(lines, 'bridge' if meth_name == 'draw_textured_line_ingame' else 'projection')" in content
    assert "'render_line', 'line', 'lines', 'projection'" in content
    assert "def normalize_line(points, max_points=2048)" in content
    assert "point_sequence(value, limit=2048" in content
    assert "def filter_projection_boundary_lines" in content
    assert "def terrain_bridge_lines_from_game" in content
    assert "if cache_key in TERRAIN_BRIDGE_LINE_CACHE:" in content
    assert "def bridge_lines_from_entries" in content
    assert "def static_bridge_lines_from_replay" in content
    assert "generated_map%s.txt" in content
    assert "read_sample_bridges(replay, games, game_scenes)" in content
    assert "to_int(attrs.get('BRIDGE_IDX'))" in content
    assert "def read_sample_bridges" in content
    assert "if bridge_field_key in BRIDGE_FIELD_LINE_CACHE:" in content
    assert "'4' if CAPTURE_UNTIL_END else '12'" in content
    assert "if not refresh and TROOP_SOURCE_CACHE:" in content
    assert "'bridges': sample_bridges" in content
    assert "'bridge_count': len(sample_bridges)" in content
    assert "'sample_bridge_counts'" in content


def test_capture_uses_job_local_game_runtime_without_global_mutex() -> None:
    runner_script = Path(__file__).resolve().parents[1] / "scripts" / "local-runner.ps1"
    content = runner_script.read_text(encoding="utf-8")
    live_capture = content.split("function Invoke-GamePythonCapture", 1)[1].split(
        "function Invoke-LiveStateExperiment", 1
    )[0]
    live_experiment = content.split("function Invoke-LiveStateExperiment", 1)[1].split(
        "if ($Calibrate)", 1
    )[0]

    assert "function Use-JobGameRuntime" in content
    assert "Join-Path (Get-JobRoot -Id $Id) 'game-runtime'" in content
    assert "[void](Use-JobGameRuntime -Id $Id)" in content
    assert "Invoke-WithStageGameLock -Action" in content
    assert "function Write-TextUtf8NoBom" in content
    assert "New-Object System.Text.UTF8Encoding($false)" in content
    assert "$StageGameMutexName = 'Global\\MoreOfDotsStageGame'" in content
    assert "Clear-JobGameRuntime -Id $Id" in content
    assert "Join-Path $jobRoot 'probe\\game-live-python-capture'" in content
    assert "Join-Path $jobRoot \"probe\\$Mode\"" in content
    assert "Stop-NewGameProcesses" not in live_capture
    assert "Stop-NewGameProcesses" not in live_experiment
    assert "function Publish-PartialStatsIfAvailable" in content
    assert "if (-not (Publish-PartialStatsIfAvailable -StatsPath $statsPath))" in live_capture
    assert "Set-JsonProperty -Object $stats.summary -Name 'partial' -Value $true" in content
    assert "Global\\WodReplayCapture" not in content
    assert "Wait-CaptureMutex -Mutex" not in content


def test_frontend_prefers_direct_power_lines_and_draws_bridges() -> None:
    frontend = Path(__file__).resolve().parents[1] / "src" / "main.ts"
    content = frontend.read_text(encoding="utf-8")

    assert "bridges?: Array<Array<{ x: number; y: number }>>;" in content
    assert "function drawBridgeLines" in content
    assert "const lines = cleanProjectionLines(sample.bridges);" in content
    assert "ctx.lineWidth = Math.max(7, 13 * Math.max(0.82, fit));" in content
    assert "const directLines = cleanProjectionLines(sample.projection_lines);" in content
    assert "if (directLines.length) {" in content
    assert "drawBridgeLines(ctx, sample, toScreen, fit);" in content


def test_video_recording_starts_replay_on_main_thread_with_watchdogs() -> None:
    runner_script = Path(__file__).resolve().parents[1] / "scripts" / "local-runner.ps1"
    content = runner_script.read_text(encoding="utf-8")

    assert "$ReplayStartupMutexName = 'Global\\MoreOfDotsReplayStartup'" in content
    assert "function Wait-ReplayStartupLock" in content
    assert "def install_main_thread_replay_start_hook" in content
    assert "'strategy': 'main-thread-scene-state-machine'" in content
    assert "setattr(home, 'change_scene', 'play')" in content
    assert "prepare_play_scene_for_replay(play_scene, replay, 'replay1')" in content
    assert "setattr(play_scene, 'change_scene', 'game')" in content
    assert "'phase': 'home-to-play'" in content
    assert "'phase': 'play-to-game'" in content
    assert "Replay startup produced no first video frame within 30 seconds." in content
    assert "Replay recording made no frame or status progress for 45 seconds." in content
    assert "if ($CancelPath -and (Test-Path -LiteralPath $CancelPath))" in content


@pytest.mark.skipif(shutil.which("powershell.exe") is None, reason="Windows PowerShell required")
def test_recording_reports_game_exception_with_last_progress(tmp_path: Path) -> None:
    root = Path(__file__).resolve().parents[1]
    script = tmp_path / "game-error.ps1"
    script.write_text(r'''
param($Runner, $ErrorLog)
$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Runner, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($statement in $ast.EndBlock.Statements) {
    if ($statement -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $statement.Name -in @('Get-RecordingGameFailure', 'Set-JsonProperty')) {
        Invoke-Expression $statement.Extent.Text
    }
}
$status = [pscustomobject]@{ status = 'recording'; tick = 2991; frame_count = 300 }
if ($null -ne (Get-RecordingGameFailure $status $ErrorLog)) { throw 'Missing log is not a crash' }
New-Item -ItemType File -Path $ErrorLog | Out-Null
if ($null -ne (Get-RecordingGameFailure $status $ErrorLog)) { throw 'Empty log is not a crash' }
Set-Content -LiteralPath $ErrorLog -Value '[GL: NVIDIA]'
if ($null -ne (Get-RecordingGameFailure $status $ErrorLog)) { throw 'GPU banner is not a crash' }
Set-Content -LiteralPath $ErrorLog -Value "Traceback (most recent call last):`nIndexError: index 51 is out of bounds"
Get-RecordingGameFailure $status $ErrorLog | ConvertTo-Json -Compress
''', encoding="utf-8")
    result = subprocess.run([
        "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script),
        str(root / "scripts/local-runner.ps1"), str(tmp_path / "error_log.txt"),
    ], check=True, capture_output=True, text=True)
    status = json.loads(result.stdout)
    assert status["status"] == "failed"
    assert status["phase"] == "game-error"
    assert status["tick"] == 2991
    assert status["frame_count"] == 300
    assert "IndexError: index 51" in status["error"]


@pytest.mark.parametrize("speed", [1, 2, 4, 6, 10, 15, 20, 30])
@pytest.mark.parametrize("audio_enabled", [False, True])
@pytest.mark.parametrize("finish", ["end", "cancel", "frame-limit"])
def test_video_speed_batches_complete_updates_and_preserves_end_hold(monkeypatch, tmp_path: Path, speed: int, finish: str, audio_enabled: bool) -> None:
    content = (Path(__file__).resolve().parents[1] / "scripts/local-runner.ps1").read_text(encoding="utf-8")
    source = "def install_main_thread_frame_hook" + content.split(
        "def install_main_thread_frame_hook", 1
    )[1].split("\ndef pump_live_scene_updates", 1)[0]
    frames = []
    audio_frames = []
    audio_closed = []
    audio_muxed = []
    statuses = []
    wall_time = [0.0]
    cancel = tmp_path / "cancel"

    class Scene:
        def __init__(self):
            self.ips = 1
            self.core = SimpleNamespace(frame=0)
            self.renders = 0
            self.updates = []

        def update(self):
            assert self.ips == 1
            if self.core.frame < 60:
                self.core.frame += 1
                self.updates.append(self.core.frame)
                if finish == "cancel" and self.core.frame == 3:
                    cancel.touch()
            wall_time[0] += 1.1

        def render(self):
            self.renders += 1

    scene = Scene()
    surface = SimpleNamespace(get_size=lambda: (2, 2))
    monkeypatch.setitem(sys.modules, "__main__", SimpleNamespace(aaadaa=Scene))
    monkeypatch.setitem(sys.modules, "pygame", SimpleNamespace(
        mixer=SimpleNamespace(__file__="pygame/mixer.pyd"),
        display=SimpleNamespace(get_surface=lambda: surface),
        image=SimpleNamespace(fromstring=lambda *args: surface, tostring=lambda *args: bytes([scene.core.frame])),
    ))
    monkeypatch.setitem(sys.modules, "OpenGL", SimpleNamespace())
    monkeypatch.setitem(sys.modules, "OpenGL.GL", SimpleNamespace(
        GL_RGB=1, GL_UNSIGNED_BYTE=2, glReadPixels=lambda *args: b"pixels",
    ))
    encoder = SimpleNamespace(
        stdin=SimpleNamespace(write=frames.append, close=lambda: None),
        stderr=io.BytesIO(), wait=lambda **kwargs: 0,
    )
    output = tmp_path / "test.mp4"
    output.touch()
    namespace = {
        "sys": sys, "os": os,
        "time": SimpleNamespace(monotonic=lambda: wall_time[0], time=lambda: wall_time[0]),
        "subprocess": SimpleNamespace(Popen=lambda *args, **kwargs: encoder, PIPE=-1, DEVNULL=-3),
        "VIDEO_AUDIO_ENABLED": audio_enabled,
        "ReplayAudioCapture": lambda *args: SimpleNamespace(
            path="audio.pcm", rate=44100, channels=2, capture_frame=lambda: audio_frames.append(len(frames)), close=lambda: audio_closed.append(True)),
        "mux_replay_audio": lambda *args: audio_muxed.append(args),
        "INSTALL_VIDEO_HOOK": True, "VIDEO_OUTPUT_PATH": str(output),
        "VIDEO_STATUS_PATH": "status.json", "VIDEO_CANCEL_PATH": str(cancel),
        "VIDEO_FFMPEG_PATH": "ffmpeg", "VIDEO_PLAYBACK_SPEED": speed,
        "VIDEO_WIDTH": 2, "VIDEO_HEIGHT": 2, "VIDEO_FPS": 30,
        "VIDEO_END_HOLD_SECONDS": 2, "VIDEO_BITRATE_KBPS": 5000, "VIDEO_MAX_FRAMES": 2 if finish == "frame-limit" else 0,
        "REPLAY_TICKS_PER_SECOND": 30, "request": {"replay_metadata": {"end": 60}},
        "to_int": int, "to_float": float, "attrs_of": vars,
        "read_tick": lambda candidates: candidates[0].core.frame,
        "write_video_status": statuses.append,
    }
    exec(source, namespace)
    namespace["install_main_thread_frame_hook"]()
    for _ in range(160):
        scene.update()
        scene.render()
        if statuses[-1]["status"] in ("completed", "cancelled"):
            break

    assert statuses[-1]["status"] in ("completed", "cancelled"), statuses[-1]
    assert len(audio_frames) == (len(frames) if audio_enabled else 0)
    assert bool(audio_closed) == audio_enabled
    assert bool(audio_muxed) == (audio_enabled and finish != "cancel")
    if finish == "cancel":
        assert statuses[-1]["status"] == "cancelled"
        assert scene.updates == [1, 2, 3]
        assert all(frame[0] < 3 for frame in frames)
        return
    if finish == "frame-limit":
        assert statuses[-1]["completion_reason"] == "frame-limit"
        assert frames == [bytes([1]), bytes([1 + speed])]
        assert scene.updates == list(range(1, 2 + speed))
        return

    expected_ticks = list(range(1, 60, speed)) + [60] * 61
    assert scene.updates == list(range(1, 61))
    assert scene.renders == len(expected_ticks)
    assert frames == [bytes([tick]) for tick in expected_ticks]
    # A slow simulation still emits heartbeats within a batch of updates.
    if speed > 1:
        assert any(status.get("tick") == 3 for status in statuses)
    assert statuses[-1]["status"] == "completed"
    assert statuses[-1]["end_hold_frames"] == 61
    assert statuses[-1]["speed_after"] == speed
    assert any(status.get("simulation_speed") == 1 for status in statuses)


def test_main_thread_replay_start_advances_one_scene_per_update(monkeypatch) -> None:
    runner_script = Path(__file__).resolve().parents[1] / "scripts" / "local-runner.ps1"
    content = runner_script.read_text(encoding="utf-8")
    function_source = "def install_main_thread_replay_start_hook" + content.split(
        "def install_main_thread_replay_start_hook", 1
    )[1].split("\ndef get_game_objects", 1)[0]
    statuses: list[dict[str, object]] = []
    game_objects: list[object] = []

    class HomeScene:
        def update(self) -> str:
            return "home-updated"

    class PlayScene:
        def __init__(self) -> None:
            self.game_setup: dict[str, object] = {}

        def update(self) -> str:
            game_objects.append(object())
            return "play-updated"

    fake_main = SimpleNamespace(HomeScene=HomeScene, PlayScene=PlayScene)
    monkeypatch.setitem(sys.modules, "__main__", fake_main)
    namespace = {
        "sys": sys,
        "threading": threading,
        "traceback": traceback,
        "ARTIFACT_PATH": "unused.json",
        "write_video_status": lambda payload: statuses.append(payload),
        "write_json_atomic": lambda _path, _value: True,
        "force_server_ready": lambda attempts: attempts.append({"method": "force-ready"}),
        "prepare_play_scene_for_replay": lambda scene, _replay, _name: {"id": id(scene)},
        "get_game_objects": lambda: game_objects,
        "get_game_scene_objects": lambda: [],
    }
    exec(function_source, namespace)

    result = namespace["install_main_thread_replay_start_hook"]([], {"map": "world"}, {})
    home = HomeScene()
    play = PlayScene()

    assert result["strategy"] == "main-thread-scene-state-machine"
    assert home.update() == "home-updated"
    assert home.change_scene == "play"
    assert play.update() == "play-updated"
    assert play.change_scene == "game"
    assert statuses[-1]["status"] == "replay-started"


def test_recording_progress_counts_all_terminal_replays() -> None:
    root = Path(__file__).resolve().parents[1]
    frontend = (root / "src" / "main.ts").read_text(encoding="utf-8")
    styles = (root / "src" / "styles.css").read_text(encoding="utf-8")
    desktop = (root / "src-tauri" / "src" / "lib.rs").read_text(encoding="utf-8")

    assert "progress.processed ?? progress.current" in frontend
    assert "function mergeReplayRecordingProgress" in frontend
    assert "Math.max(replayRecordingProcessed(previous), replayRecordingProcessed(next))" in frontend
    assert "function updateRecordingQueueRow" in frontend
    assert 'data-recording-action="clear"' in frontend
    assert 'data-recording-action="open"' in frontend
    assert 'role="progressbar"' in frontend
    assert 'setAttribute(track, "aria-valuenow", String(Math.round(percent)))' in frontend
    # The queue is patched in place; rebuilding it made the panel flash.
    assert "root.innerHTML = renderReplayRecordingQueue()" not in frontend
    assert ".recording-queue-list.is-scrollable" in styles
    assert "max-height: 310px" in styles
    assert "let processed = processed_count.fetch_add(1, Ordering::Relaxed) + 1;" in desktop
    assert "let failed = failed_count.fetch_add(1, Ordering::Relaxed) + 1;" in desktop
    assert '"percent": processed.saturating_mul(100) / total.max(1)' in desktop
    assert "const MAX_ATTEMPTS: usize = 3;" in desktop


def test_recording_supports_high_resolution_exports() -> None:
    root = Path(__file__).resolve().parents[1]
    frontend = (root / "src" / "main.ts").read_text(encoding="utf-8")
    desktop = (root / "src-tauri" / "src" / "lib.rs").read_text(encoding="utf-8")
    recorder = (root / "wod_replay_server" / "desktop_cli.py").read_text(encoding="utf-8")
    runner = (root / "scripts" / "local-runner.ps1").read_text(encoding="utf-8")

    assert "[480, 720, 1080]" in frontend
    assert "RECORDING_DEFAULT_RESOLUTION_INDEX = 2" in frontend
    assert "[480, 720, 1080]" in desktop
    assert "{480, 720, 1080}" in recorder
    assert "480 { 854 } 1080 { 1920 } default { 1280 }" in runner
