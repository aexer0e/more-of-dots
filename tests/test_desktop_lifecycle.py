from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _desktop_source() -> str:
    return (ROOT / "src-tauri" / "src" / "lib.rs").read_text(encoding="utf-8")


def test_dynamic_replay_windows_have_ipc_capabilities() -> None:
    capability = json.loads(
        (ROOT / "src-tauri" / "capabilities" / "default.json").read_text(encoding="utf-8")
    )
    assert "replay-player-*" in capability["windows"]
    assert "dialog:allow-save" in capability["permissions"]


def test_retired_controls_cannot_be_invoked() -> None:
    handler = _desktop_source().split("tauri::generate_handler![", 1)[1].split("])", 1)[0]
    for command in (
        "region_status", "select_region", "capture_replay", "record_replays",
        "recorder_status", "install_recorder", "check_recorder_update",
    ):
        assert command not in handler
    assert "leaderboard_identity" in handler


def test_production_packages_only_the_independent_player() -> None:
    config = json.loads((ROOT / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8"))
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    workflow = (ROOT / ".github" / "workflows" / "release.yml").read_text(encoding="utf-8")
    assert "externalBin" not in config["bundle"]
    assert config["bundle"]["resources"] == ["resources/player/**/*"]
    assert "prepare:player" in config["build"]["beforeBuildCommand"]
    assert "build:recorder" not in package["scripts"]
    assert "recorder" not in workflow.lower()
    assert "vault" not in workflow.lower()
    assert not (ROOT / ".github" / "workflows" / "recorder.yml").exists()
    assert not (ROOT / "scripts" / "build-recorder.ps1").exists()
    frontend = (ROOT / "src" / "main.ts").read_text(encoding="utf-8")
    for retired in ("install_recorder", "check_recorder_update", "capture_replay", "record_replays"):
        assert retired not in frontend
