from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from wod_replay_server import desktop_cli
from wod_replay_server.storage import JobStore


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


def test_desktop_commands_do_not_stage_the_users_live_game() -> None:
    source = Path(__file__).resolve().parents[1] / "wod_replay_server" / "desktop_cli.py"
    content = source.read_text(encoding="utf-8")

    assert "def command_stage_game" not in content
    assert 'args.desktop_command == "stage-game"' not in content
    assert "metadata.get(\"target_game_version\") or metadata.get(\"version\")" in content
    assert "document.recording_bytes" in content


def test_health_skips_runtime_cleanup(monkeypatch, tmp_path: Path) -> None:
    def fail_prune(*args, **kwargs):
        raise AssertionError("startup health must not prune jobs")

    monkeypatch.setattr(JobStore, "prune_finished_jobs", fail_prune)

    payload = desktop_cli.command_health(tmp_path)

    assert payload["status"] == "ok"
    assert payload["runtime_cleanup"]["skipped"] is True


def test_list_jobs_skips_runtime_cleanup(monkeypatch, tmp_path: Path) -> None:
    store = JobStore(tmp_path / "jobs")
    paths = store.create_job("recent.rep")
    store.update_job(paths, status="captured")

    def fail_prune(*args, **kwargs):
        raise AssertionError("list-jobs must not prune jobs")

    monkeypatch.setattr(JobStore, "prune_finished_jobs", fail_prune)

    payload = desktop_cli.command_list_jobs(tmp_path, 20)

    assert [job["job_id"] for job in payload["jobs"]] == [paths.job_id]


def test_recording_status_finishes_with_protocol_step(tmp_path: Path) -> None:
    status_path = tmp_path / "recording.status.json"
    status_path.write_text(
        json.dumps({"status": "recording", "step": "recording", "current_seconds": 50, "total_seconds": 180}),
        encoding="utf-8",
    )

    desktop_cli._finish_recording_status(status_path, step="completed", status="succeeded")

    payload = json.loads(status_path.read_text(encoding="utf-8"))
    assert payload["protocol_version"] == 1
    assert payload["status"] == "succeeded"
    assert payload["step"] == "completed"
    assert payload["current_seconds"] == 50
    assert payload["total_seconds"] == 180
