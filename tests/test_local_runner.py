from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from wod_replay_server.local_runner import LocalSessionRunner


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
