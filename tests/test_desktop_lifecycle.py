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
