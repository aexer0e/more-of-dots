from __future__ import annotations

import json
from pathlib import Path


def _desktop_source() -> str:
    return (Path(__file__).resolve().parents[1] / "src-tauri" / "src" / "lib.rs").read_text(
        encoding="utf-8"
    )


def test_replay_windows_use_unique_labels_without_owner_shutdown_on_window_close() -> None:
    source = _desktop_source()
    open_replay_window = source.split("async fn open_replay_window", 1)[1].split(
        "#[tauri::command]\nasync fn capture_sample_delta", 1
    )[0]

    assert 'let label = format!("replay-player-{launch_id}")' in open_replay_window
    assert "WebviewWindowBuilder::new" in open_replay_window
    assert "WindowEvent::CloseRequested" not in open_replay_window
    assert "stop_all_owner_processes" not in open_replay_window


def test_dynamic_replay_windows_have_ipc_capabilities() -> None:
    root = Path(__file__).resolve().parents[1]
    capability = json.loads((root / "src-tauri" / "capabilities" / "default.json").read_text(encoding="utf-8"))
    source = _desktop_source()

    assert 'let label = format!("replay-player-{launch_id}")' in source
    assert "replay-player-*" in capability["windows"]


def test_main_window_close_exits_app_and_drains_replay_owners() -> None:
    source = _desktop_source()
    main_close = source.split('if let Some(window) = app.get_webview_window("main")', 1)[1].split(
        "if let Some(window) = app.get_webview_window(REPLAY_PLAYER_LABEL)", 1
    )[0]

    assert "api.prevent_close();" in main_close
    assert "stop_all_owner_processes(&app_handle);" in main_close
    assert "app_handle.exit(0);" in main_close


def test_owner_process_registry_is_drained_when_app_state_drops() -> None:
    source = _desktop_source()

    assert "fn stop_all_owner_processes(app: &AppHandle)" in source
    assert "impl Drop for WindowOwnerProcesses" in source
    assert "children.drain()" in source
    assert "child.kill()" in source


def test_job_local_game_processes_are_not_treated_as_real_user_game() -> None:
    source = _desktop_source()
    staged_check = source.split("fn is_staged_game_process", 1)[1].split("fn real_game_processes", 1)[0]

    assert r"\staged-game\game.exe" in staged_check
    assert "\\jobs\\" in staged_check
    assert r"\game-runtime\game.exe" in staged_check


def test_region_selection_uses_latency_steering_without_static_fallbacks() -> None:
    source = _desktop_source()
    region_payload = source.split("fn region_selection_payload", 1)[1].split("fn user_data_export_payload", 1)[0]
    region_status = source.split("fn region_status_value", 1)[1].split("fn sample_delta_max_bytes", 1)[0]
    select_region = source.split("fn select_region", 1)[1].split("#[tauri::command]\nasync fn get_job", 1)[0]

    assert "fn fetch_game_servers_from_socket()" not in source
    assert "fn run_game_server_lookup_flow" not in source
    assert "GAME_SERVER_LOOKUP_WAIT" not in source
    assert "def extract_gameservers" in source
    assert "_codex_original_get_gameservers" in source
    assert "collect_server_manager_classes" in source
    assert "getattr(cls, 'get_gameservers', None)" in source
    assert "return value" in region_payload
    assert "def patch_create_connection" in source
    assert "measure_ws_latency" in source
    assert "Region steering made this latency probe unreachable." in source
    assert "Region steering active. Queue normally." in source
    assert "region_status" in source
    assert "select_region" in source
    assert "fetch_game_servers_from_socket" not in region_status
    assert "fetch_game_servers_from_socket" not in select_region
    assert "let selected = if game_running" in region_status
    assert "None" in region_status
    assert "inject_region_selection_into_game(&app, region)?" in select_region
    assert "manualReconnectRequired" not in region_payload
    assert "def patch_object" not in region_payload
    assert "def maybe_reconnect" not in region_payload
    assert "patch_module_lists" not in region_payload
    assert "connect()" not in region_payload
    assert "34.228.56.15" not in source
    assert "3.64.57.116" not in source
    assert "13.212.239.74" not in source


def test_region_commands_are_registered_with_tauri() -> None:
    source = _desktop_source()
    handler = source.split("tauri::generate_handler![", 1)[1].split("])", 1)[0]

    assert "region_status" in handler
    assert "select_region" in handler
    assert "leaderboard_status" in handler
    assert "leaderboard_submit" in handler
    assert "leaderboard_list" in handler


def test_packaged_python_probe_resources_are_discoverable() -> None:
    root = Path(__file__).resolve().parents[1]
    source = _desktop_source()
    tauri_config = json.loads((root / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8"))
    package = json.loads((root / "package.json").read_text(encoding="utf-8"))

    assert "_up_" in source
    assert 'join("python-probe-dll")' in source
    assert 'find_file_by_name(&resource_dir, "wod_python_probe.dll", 8)' in source
    assert 'find_file_by_name(&resource_dir, "invoke-python-probe.ps1", 8)' in source
    assert "../tools/python-probe-dll/target/release/wod_python_probe.dll" in tauri_config["bundle"]["resources"]
    assert "../scripts/invoke-python-probe.ps1" in tauri_config["bundle"]["resources"]
    assert "npm run build:sidecar" in tauri_config["build"]["beforeBuildCommand"]
    assert package["scripts"]["build"] == "node scripts/version.mjs tauri build && npm run size:audit"


def test_frontend_has_region_browser_page() -> None:
    frontend = (Path(__file__).resolve().parents[1] / "src" / "main.ts").read_text(encoding="utf-8")

    assert 'type BrowserPage = "replays" | "leaderboard" | "region" | "mapEditor";' in frontend
    assert 'data-browser-page="leaderboard">Leaderboard' in frontend
    assert 'invoke<LeaderboardStatusPayload>("leaderboard_status")' in frontend
    assert 'invoke<{ lastSync?: LeaderboardSyncState }>("leaderboard_submit")' in frontend
    assert 'invoke<LeaderboardListPayload>("leaderboard_list")' in frontend
    assert "renderLeaderboardRows" in frontend
    assert "score-chart-area" in frontend
    assert "score-chart-callout" in frontend
    assert "is-current" in frontend
    assert "<span>Rank</span>" in frontend
    assert "<span>WIN RATE</span>" in frontend
    assert "win-rate-ring" in frontend
    assert "leaderboardSubmitError" in frontend
    assert "War of Dots is probably still running in another installation or session" in frontend
    assert "Public rank" not in frontend
    assert 'data-browser-page="region"' in frontend
    assert 'invoke<RegionStatusPayload>("region_status")' in frontend
    assert 'invoke<RegionStatusPayload>("select_region", { region })' in frontend
    assert "const selectedRegion = gameRunning ? regionStatusPayload?.selectedRegion ?? null : null;" in frontend
    assert "User data" not in frontend
    assert "Waiting for live server list" not in frontend
    assert "North America" in frontend
    assert "Europe" in frontend
    assert "Asia" in frontend
    assert '"34.228.56.15"' not in frontend
    assert '"3.64.57.116"' not in frontend
    assert '"13.212.239.74"' not in frontend
