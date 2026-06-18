from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any

from .config import AppSettings


def _setting_int(settings: AppSettings, name: str, default: int) -> int:
    try:
        return int(getattr(settings, name, default))
    except (TypeError, ValueError):
        return default


def _hidden_process_kwargs() -> dict[str, Any]:
    kwargs: dict[str, Any] = {}
    if os.name == "nt":
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    return kwargs


def _run(args: list[str], *, timeout: int) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
        **_hidden_process_kwargs(),
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


def _stats_summary(stats: dict[str, Any]) -> dict[str, Any]:
    samples = stats.get("samples")
    summary = stats.get("summary", {})
    sample_count = summary.get("sample_count") if isinstance(summary, dict) else None
    if not isinstance(sample_count, int):
        sample_count = len(samples) if isinstance(samples, list) else 0
    return {
        "source": stats.get("source"),
        "sample_rate_hz": stats.get("sample_rate_hz"),
        "sample_count": sample_count,
        "summary": summary if isinstance(summary, dict) else {},
        "replay_metadata": stats.get("replay_metadata", {}),
    }


def _stats_summary_from_path(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        if path.stat().st_size > 16 * 1024 * 1024:
            return {
                "source": None,
                "sample_rate_hz": None,
                "sample_count": 0,
                "summary": {"stats_omitted_for_memory": True, "bytes": path.stat().st_size},
                "replay_metadata": {},
            }
        stats = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(stats, dict):
        return None
    return _stats_summary(stats)


class LocalSessionRunner:
    def __init__(self, settings: AppSettings):
        self.settings = settings

    @property
    def game_exe(self) -> Path:
        return self.settings.staged_game_dir / "game.exe"

    def cleanup_game_processes(self, job_id: str | None) -> dict[str, Any]:
        if not job_id:
            return {"status": "skipped", "message": "No job id supplied."}
        try:
            command = self._runner_command(["-CleanupJob", "-JobId", job_id], timeout_ms=15_000)
        except (OSError, ValueError) as exc:
            return {"status": "failed", "message": str(exc)}
        try:
            result = _run(command, timeout=20)
        except subprocess.TimeoutExpired:
            return {"status": "failed", "message": "Timed out while cleaning staged game process."}
        parsed = _parse_json_result(result.stdout) or {}
        return {
            "status": "succeeded" if result.returncode == 0 else "failed",
            "returncode": result.returncode,
            "stdout": result.stdout.strip(),
            "stderr": result.stderr.strip(),
            **parsed,
        }

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

    def _runner_env(self) -> dict[str, str]:
        env = os.environ.copy()
        env.setdefault(
            "WOD_CAPTURE_IN_PROCESS_SAMPLE_LIMIT",
            str(_setting_int(self.settings, "capture_in_process_sample_limit", 900)),
        )
        env.setdefault("WOD_UI_SAMPLE_WINDOW", str(_setting_int(self.settings, "ui_sample_window", 2400)))
        env.setdefault("WOD_SAMPLE_DELTA_MAX_BYTES", str(_setting_int(self.settings, "sample_delta_max_bytes", 2 * 1024 * 1024)))
        return env

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

    def _run_owned_runner_command(
        self,
        command: list[str],
        *,
        job_id: str,
        timeout_seconds: int,
    ) -> tuple[subprocess.CompletedProcess[str], list[dict[str, Any]]]:
        cleanup_events: list[dict[str, Any]] = []
        cleanup_events.append({"phase": "before_start", **self.cleanup_game_processes(job_id)})

        process = subprocess.Popen(  # noqa: S603 - arguments are constructed internally and shell=False.
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=self._runner_env(),
            **_hidden_process_kwargs(),
        )
        try:
            stdout, stderr = process.communicate(timeout=timeout_seconds)
            return subprocess.CompletedProcess(command, process.returncode, stdout, stderr), cleanup_events
        except subprocess.TimeoutExpired:
            try:
                process.kill()
            except OSError:
                pass
            try:
                stdout, stderr = process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                stdout, stderr = "", ""
            timeout_cleanup = self.cleanup_game_processes(job_id)
            cleanup_events.append({"phase": "timeout", **timeout_cleanup})
            message = f"Local runner timed out after {timeout_seconds}s; staged game cleanup was requested."
            stderr = "\n".join(part for part in [stderr.strip(), message] if part)
            return subprocess.CompletedProcess(command, 124, stdout, stderr), cleanup_events
        finally:
            cleanup_events.append({"phase": "after_finish", **self.cleanup_game_processes(job_id)})

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

        result, cleanup_events = self._run_owned_runner_command(command, job_id=job_id, timeout_seconds=timeout_seconds + 30)
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
            "process_cleanup": cleanup_events,
        }

        stats_path = self.settings.jobs_dir / job_id / "stats.json"
        stats_summary = _stats_summary_from_path(stats_path)
        if stats_summary:
            capture["stats_summary"] = stats_summary

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

        result, cleanup_events = self._run_owned_runner_command(command, job_id=job_id, timeout_seconds=timeout_seconds + 30)
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
            "process_cleanup": cleanup_events,
        }

        stats_path = self.settings.jobs_dir / job_id / "stats.json"
        stats_summary = _stats_summary_from_path(stats_path)
        if stats_summary:
            capture["stats_summary"] = stats_summary

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

        job_id = ""
        for index, item in enumerate(runner_args[:-1]):
            if item == "-JobId":
                job_id = runner_args[index + 1]
                break
        if job_id:
            result, cleanup_events = self._run_owned_runner_command(command, job_id=job_id, timeout_seconds=timeout_seconds + 30)
        else:
            result = _run(command, timeout=timeout_seconds + 30)
            cleanup_events = []
        parsed = _parse_json_result(result.stdout) or {}
        status = "succeeded" if result.returncode == 0 else "failed"
        return {
            "status": status,
            "returncode": result.returncode,
            "stdout": result.stdout.strip(),
            "stderr": result.stderr.strip(),
            "runner_result": parsed,
            "process_cleanup": cleanup_events,
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
