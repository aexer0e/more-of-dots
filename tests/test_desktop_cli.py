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
