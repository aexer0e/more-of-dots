from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


def test_sidecar_health_command_runs_without_http_server(tmp_path: Path) -> None:
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "wod_replay_server.sidecar",
            "--desktop-command",
            "health",
            "--runtime-dir",
            str(tmp_path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )

    payload = json.loads(result.stdout)
    assert payload["status"] == "ok"
    assert payload["runtime_dir"] == str(tmp_path.resolve())
    assert "runner" in payload


def test_stage_game_command_uses_cross_process_mutex() -> None:
    source = Path(__file__).resolve().parents[1] / "wod_replay_server" / "desktop_cli.py"
    content = source.read_text(encoding="utf-8")

    assert 'STAGE_GAME_MUTEX_NAME = "Global\\\\MoreOfDotsStageGame"' in content
    assert "def _stage_game_mutex" in content
    assert "kernel32.WaitForSingleObject" in content
    assert "with _stage_game_mutex():" in content
    assert "stage_game(ctx.settings.steam_game_dir, ctx.settings.staged_game_dir)" in content
