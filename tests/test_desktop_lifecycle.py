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



def test_retired_region_controls_cannot_be_invoked() -> None:
    source = _desktop_source()
    handler = source.split("tauri::generate_handler![", 1)[1].split("])", 1)[0]
    assert "region_status" not in handler
    assert "select_region" not in handler
    assert "region_selection_payload" not in source
    assert "leaderboard_identity" in handler


def test_recorder_payload_is_not_bundled_with_main_app() -> None:
    root = Path(__file__).resolve().parents[1]
    source = _desktop_source()
    tauri_config = json.loads((root / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8"))
    package = json.loads((root / "package.json").read_text(encoding="utf-8"))
    recorder_build = (root / "scripts" / "build-recorder.ps1").read_text(encoding="utf-8")
    recorder_installer = (root / "scripts" / "recorder-installer.nsi").read_text(encoding="utf-8")

    assert "fn resolve_recorder_path()" in source
    assert "externalBin" not in tauri_config["bundle"]
    assert "resources" not in tauri_config["bundle"]
    assert tauri_config["build"]["beforeBuildCommand"] == "npm run build:web"
    assert "build:sidecar" not in package["scripts"]
    assert "build:recorder" in package["scripts"]
    assert "--onedir" in recorder_build
    assert "wod_python_probe.dll" in recorder_build
    assert "invoke-python-probe.ps1" in recorder_build
    assert "DepotDownloader" not in recorder_build
    assert "BUNDLED_VERSIONS_DIR" in recorder_build
    assert "supported_versions.json" in recorder_build
    assert "recorder-installer.nsi" in recorder_build
    assert 'WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MoreOfDotsRecorder"' in recorder_installer
    assert 'RMDir /r "$INSTDIR"' in recorder_installer
    assert 'StrCmp $INSTDIR "$LOCALAPPDATA\\Programs\\More of Dots Recorder"' in recorder_installer
    assert package["scripts"]["build"] == "node scripts/version.mjs tauri build && npm run size:audit"
