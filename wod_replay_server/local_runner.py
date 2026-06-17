from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

from .config import AppSettings


def _run(args: list[str], *, timeout: int) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def _parse_json_result(stdout: str) -> dict[str, Any] | None:
    for line in reversed(stdout.splitlines()):
        line = line.strip()
        if not line:
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return parsed
    return None


class LocalSessionRunner:
    def __init__(self, settings: AppSettings):
        self.settings = settings

    @property
    def game_exe(self) -> Path:
        return self.settings.staged_game_dir / "game.exe"

    def describe(self) -> dict[str, Any]:
        game_python_probe = (
            self.settings.project_root
            / "tools"
            / "python-probe-dll"
            / "target"
            / "release"
            / "wod_python_probe.dll"
        )
        return {
            "available": self.settings.local_runner_script.exists() and self.game_exe.exists(),
            "mode": "local-session",
            "runner_script": str(self.settings.local_runner_script),
            "game_exe": str(self.game_exe),
            "game_exe_exists": self.game_exe.exists(),
            "game_live_capture_available": self.settings.local_runner_script.exists()
            and self.game_exe.exists()
            and game_python_probe.exists(),
            "game_python_capture_available": self.settings.local_runner_script.exists()
            and self.game_exe.exists()
            and game_python_probe.exists(),
            "window_title": self.settings.game_window_title,
            "desktop_strategy": self.settings.game_desktop_strategy,
            "window_strategy": self.settings.game_window_strategy,
        }

    def _runner_command(self, runner_args: list[str], *, timeout_ms: int) -> list[str]:
        script = self.settings.local_runner_script
        if not script.exists():
            raise FileNotFoundError(f"Local runner script does not exist: {script}")

        return [
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(script),
            "-ShareRoot",
            str(self.settings.runtime_dir),
            "-GameWindowTitle",
            self.settings.game_window_title,
            "-DesktopStrategy",
            self.settings.game_desktop_strategy,
            "-WindowStrategy",
            self.settings.game_window_strategy,
            *runner_args,
        ]

    def smoke_check(self) -> dict[str, Any]:
        try:
            command = self._runner_command(["-Smoke"], timeout_ms=20_000)
        except OSError as exc:
            return {"status": "failed", "message": str(exc)}

        result = _run(command, timeout=30)
        parsed = _parse_json_result(result.stdout)
        status = "succeeded" if result.returncode == 0 else "failed"
        return {
            "status": status,
            "returncode": result.returncode,
            "stdout": result.stdout.strip(),
            "stderr": result.stderr.strip(),
            **(parsed or {}),
        }

    def capture_replay(self, job_id: str, *, timeout_seconds: int) -> dict[str, Any]:
        try:
            command = self._runner_command(
                [
                    "-CaptureReplay",
                    "-JobId",
                    job_id,
                    "-SampleHz",
                    str(self.settings.capture_sample_hz),
                    "-MaxSeconds",
                    str(timeout_seconds),
                ],
                timeout_ms=max(30_000, timeout_seconds * 1000),
            )
        except (OSError, ValueError) as exc:
            return {"status": "failed", "phase": "local_runner", "message": str(exc)}

        result = _run(command, timeout=timeout_seconds + 30)
        parsed = _parse_json_result(result.stdout) or {}
        status = "succeeded" if result.returncode == 0 else "failed"
        capture: dict[str, Any] = {
            "status": status,
            "phase": "capture",
            "source": "memory",
            "returncode": result.returncode,
            "stdout": result.stdout.strip(),
            "stderr": result.stderr.strip(),
            "runner_result": parsed,
        }

        stats_path = self.settings.jobs_dir / job_id / "stats.json"
        if stats_path.exists():
            capture["stats"] = json.loads(stats_path.read_text(encoding="utf-8"))

        return capture

    def capture_replay_with_game_python(self, job_id: str, *, timeout_seconds: int) -> dict[str, Any]:
        return self.capture_live_replay(job_id, timeout_seconds=timeout_seconds)

    def capture_live_replay(self, job_id: str, *, timeout_seconds: int) -> dict[str, Any]:
        try:
            command = self._runner_command(
                [
                    "-CaptureLiveReplay",
                    "-JobId",
                    job_id,
                    "-SampleHz",
                    str(self.settings.capture_sample_hz),
                    "-MaxSeconds",
                    str(timeout_seconds),
                ],
                timeout_ms=max(30_000, timeout_seconds * 1000),
            )
        except (OSError, ValueError) as exc:
            return {"status": "failed", "phase": "game_live_python_capture", "source": "game-live-python", "message": str(exc)}

        result = _run(command, timeout=timeout_seconds + 30)
        parsed = _parse_json_result(result.stdout) or {}
        status = "succeeded" if result.returncode == 0 else "failed"
        capture: dict[str, Any] = {
            "status": status,
            "phase": "game_live_python_capture",
            "source": "game-live-python",
            "returncode": result.returncode,
            "stdout": result.stdout.strip(),
            "stderr": result.stderr.strip(),
            "runner_result": parsed,
        }

        stats_path = self.settings.jobs_dir / job_id / "stats.json"
        if stats_path.exists():
            capture["stats"] = json.loads(stats_path.read_text(encoding="utf-8"))

        return capture

    def probe_runtime(self, job_id: str | None = None, *, timeout_seconds: int = 90) -> dict[str, Any]:
        runner_args = ["-PythonProbe"]
        if job_id:
            runner_args.extend(["-JobId", job_id])
        return self._run_probe_command(runner_args, timeout_seconds=timeout_seconds)

    def probe_replay_state(self, job_id: str, *, timeout_seconds: int = 120) -> dict[str, Any]:
        return self._run_probe_command(["-ProbeReplayState", "-JobId", job_id], timeout_seconds=timeout_seconds)

    def sample_live_state(self, job_id: str, *, timeout_seconds: int = 120) -> dict[str, Any]:
        return self._run_probe_command(
            [
                "-SampleLiveState",
                "-JobId",
                job_id,
                "-SampleHz",
                str(self.settings.capture_sample_hz),
                "-MaxSeconds",
                str(timeout_seconds),
            ],
            timeout_seconds=timeout_seconds,
        )

    def _run_probe_command(self, runner_args: list[str], *, timeout_seconds: int) -> dict[str, Any]:
        try:
            command = self._runner_command(runner_args, timeout_ms=max(30_000, timeout_seconds * 1000))
        except (OSError, ValueError) as exc:
            return {"status": "failed", "phase": "probe", "message": str(exc)}

        result = _run(command, timeout=timeout_seconds + 30)
        parsed = _parse_json_result(result.stdout) or {}
        status = "succeeded" if result.returncode == 0 else "failed"
        return {
            "status": status,
            "returncode": result.returncode,
            "stdout": result.stdout.strip(),
            "stderr": result.stderr.strip(),
            "runner_result": parsed,
        }

    def calibrate_memory(self, *, timeout_seconds: int = 120) -> dict[str, Any]:
        try:
            command = self._runner_command(["-Calibrate"], timeout_ms=timeout_seconds * 1000)
        except (OSError, ValueError) as exc:
            return {"status": "failed", "phase": "local_runner", "message": str(exc)}

        result = _run(command, timeout=timeout_seconds + 30)
        parsed = _parse_json_result(result.stdout) or {}
        status = "succeeded" if result.returncode == 0 else "failed"
        return {
            "status": status,
            "phase": "calibration",
            "returncode": result.returncode,
            "stdout": result.stdout.strip(),
            "stderr": result.stderr.strip(),
            "runner_result": parsed,
        }
