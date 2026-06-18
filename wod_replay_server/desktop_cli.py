from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
from threading import Lock
from types import SimpleNamespace
from typing import Any

from .address_profiles import AddressProfile, MissingAddressProfile, load_matching_profile
from .config import get_settings
from .local_runner import LocalSessionRunner
from .replay import ReplayValidationError, validate_replay
from .replay_simulator import simulate_replay_file
from .stage_game import stage_game
from .storage import JobPaths, JobStore
from .synthesis import synthesize_replay


AUTHORITATIVE_CAPTURE_SOURCES = {"game-live-python", "memory", "local-session-memory-capture"}


def _json_default(value: Any) -> str:
    return str(value)


def _load_backend(runtime_dir: Path | None):
    if runtime_dir is not None:
        os.environ["WOD_RUNTIME_DIR"] = str(runtime_dir.expanduser().resolve())

    get_settings.cache_clear()
    settings = get_settings()
    settings.ensure_runtime_dirs()
    return SimpleNamespace(
        settings=settings,
        store=JobStore(settings.jobs_dir),
        replay_runner=LocalSessionRunner(settings),
        capture_lock=Lock(),
        stage_lock=Lock(),
    )


def _job_response(job: dict[str, Any]) -> dict[str, Any]:
    return {
        "job_id": job["job_id"],
        "status": job["status"],
        "metadata": job.get("metadata"),
        "runner_smoke": job.get("runner_smoke"),
        "capture": job.get("capture"),
        "synthesis": job.get("synthesis"),
        "address_profile": job.get("address_profile"),
        "error": job.get("error"),
        "links": job["links"],
    }


def _debug_tool_inventory(settings) -> dict[str, Any]:
    candidates = {
        "cheat_engine": [
            r"C:\Program Files\Cheat Engine 7.5\Cheat Engine.exe",
            r"C:\Program Files (x86)\Cheat Engine 7.5\Cheat Engine.exe",
        ],
        "ghidra": [
            r"C:\ProgramData\chocolatey\lib\ghidra\tools\ghidra_12.1_PUBLIC\ghidraRun.bat",
        ],
        "x64dbg": [
            str(settings.project_root / "runtime" / "debug-tools" / "x64dbg" / "release" / "x64" / "x64dbg.exe"),
            str(settings.runtime_dir / "debug-tools" / "x64dbg" / "release" / "x64" / "x64dbg.exe"),
        ],
        "windbg": [
            r"C:\Program Files (x86)\Windows Kits\10\Debuggers\x64\windbg.exe",
        ],
        "cdb": [
            r"C:\Program Files (x86)\Windows Kits\10\Debuggers\x64\cdb.exe",
        ],
    }
    tools: dict[str, Any] = {}
    for name, paths in candidates.items():
        found = next((path for path in paths if Path(path).exists()), None)
        tools[name] = {"available": found is not None, "path": found}
    return tools


def _write_capture_request(ctx, paths: JobPaths, metadata: dict[str, Any], profile: AddressProfile | None) -> None:
    request = {
        "job_id": paths.job_id,
        "input_replay": str(paths.input_replay_path),
        "stats_output": str(paths.stats_path),
        "profile": profile.public_summary() if profile is not None else None,
        "sample_rate_hz": ctx.settings.capture_sample_hz,
        "replay_metadata": metadata,
    }
    paths.capture_request_path.write_text(json.dumps(request, indent=2), encoding="utf-8")


def _run_replay_file_capture(ctx, paths: JobPaths) -> dict[str, Any]:
    stats = simulate_replay_file(
        input_replay_path=paths.input_replay_path,
        stats_path=paths.stats_path,
        max_json_bytes=ctx.settings.max_replay_json_bytes,
    )
    return {
        "status": "succeeded",
        "phase": "replay_file_simulation",
        "source": "replay-file-derived",
        "stats": stats,
    }


def _run_game_python_capture(ctx, paths: JobPaths, metadata: dict[str, Any]) -> dict[str, Any]:
    _write_capture_request(ctx, paths, metadata, None)
    return ctx.replay_runner.capture_live_replay(
        paths.job_id,
        timeout_seconds=ctx.settings.capture_timeout_seconds,
    )


def _cleanup_capture_processes(ctx, paths: JobPaths, reason: str) -> None:
    cleanup = ctx.replay_runner.cleanup_game_processes(paths.job_id)
    ctx.store.append_log(paths, f"{reason} staged game process cleanup: {cleanup}")


def _capture_error(capture: dict[str, Any]) -> str:
    return (
        capture.get("message")
        or capture.get("stderr")
        or capture.get("stdout")
        or capture.get("runner_result", {}).get("message")
        or "Capture failed."
    )


def _has_authoritative_samples(capture: dict[str, Any]) -> bool:
    stats = capture.get("stats")
    if not isinstance(stats, dict):
        return False
    source = capture.get("source") or stats.get("source")
    samples = stats.get("samples")
    return source in AUTHORITATIVE_CAPTURE_SOURCES and isinstance(samples, list) and len(samples) > 0


def _stats_public_summary(stats: dict[str, Any]) -> dict[str, Any]:
    samples = stats.get("samples")
    return {
        "source": stats.get("source"),
        "sample_rate_hz": stats.get("sample_rate_hz"),
        "sample_count": len(samples) if isinstance(samples, list) else 0,
        "summary": stats.get("summary", {}),
        "replay_metadata": stats.get("replay_metadata", {}),
    }


def _capture_public_summary(capture: dict[str, Any]) -> dict[str, Any]:
    public = {key: value for key, value in capture.items() if key != "stats"}
    stats = capture.get("stats")
    if isinstance(stats, dict):
        public["stats_summary"] = _stats_public_summary(stats)
    return public


def _finalize_capture(ctx, paths: JobPaths, capture: dict[str, Any]) -> None:
    if capture.get("stats"):
        paths.stats_path.write_text(
            json.dumps(capture["stats"], indent=2),
            encoding="utf-8",
        )

    public_capture = _capture_public_summary(capture)
    paths.capture_result_path.write_text(json.dumps(public_capture, indent=2), encoding="utf-8")
    ctx.store.append_log(paths, f"Capture result {capture['status']}: {public_capture}")
    ctx.store.update_job(paths, status="finalizing", capture=public_capture)

    if capture.get("status") != "succeeded":
        message = _capture_error(capture)
        ctx.store.update_job(paths, status="failed", capture=public_capture, error=message)
        return

    source = capture.get("source") or capture.get("stats", {}).get("source")
    if source not in AUTHORITATIVE_CAPTURE_SOURCES and source != "replay-file-derived":
        ctx.store.update_job(
            paths,
            status="failed",
            capture=public_capture,
            error=f"Capture produced unsupported source {source!r}.",
        )
        return

    if not paths.stats_path.exists():
        ctx.store.update_job(
            paths,
            status="failed",
            capture=public_capture,
            error="Capture completed without producing stats.json.",
        )
        return

    stats = capture.get("stats")
    if isinstance(stats, dict):
        samples = stats.get("samples")
        if source in AUTHORITATIVE_CAPTURE_SOURCES and (not isinstance(samples, list) or not samples):
            ctx.store.update_job(
                paths,
                status="failed",
                capture=public_capture,
                error="Authoritative game-backed capture produced no playable samples.",
            )
            return

    ctx.store.update_job(paths, status="synthesizing_replay")
    synthesis = synthesize_replay(
        input_replay_path=paths.input_replay_path,
        stats_path=paths.stats_path,
        output_replay_path=paths.simulated_replay_path,
        max_json_bytes=ctx.settings.max_replay_json_bytes,
    )
    ctx.store.append_log(paths, f"Synthesized replay: {synthesis}")
    ctx.store.update_job(paths, status="captured", capture=public_capture, synthesis=synthesis, error=None)


def _run_capture_job(ctx, job_id: str) -> None:
    paths = ctx.store.paths_for(job_id)

    with ctx.capture_lock:
        try:
            ctx.store.update_job(paths, status="cleaning_stale_game_processes")
            _cleanup_capture_processes(ctx, paths, "Pre-capture")
            job = ctx.store.update_job(paths, status="local_runner_starting")
            capture_source = ctx.settings.capture_source.lower()
            if capture_source == "game-python":
                capture_source = "game-live-python"
            if capture_source == "replay-file":
                capture_source = "replay-file-dev"
            if capture_source not in {"auto", "memory", "game-live-python", "replay-file-dev"}:
                raise ValueError("WOD_CAPTURE_SOURCE must be auto, game-live-python, memory, or replay-file-dev.")

            if capture_source == "replay-file-dev":
                ctx.store.append_log(paths, "Using explicit dev-only replay-file-derived capture.")
                ctx.store.update_job(paths, status="simulating_from_replay_dev")
                _finalize_capture(ctx, paths, _run_replay_file_capture(ctx, paths))
                return

            if capture_source == "game-live-python":
                ctx.store.update_job(paths, status="spawning_hidden_game_process")
                ctx.store.update_job(paths, status="launching_hidden_game")
                ctx.store.update_job(paths, status="running_hidden_game_capture")
                _finalize_capture(ctx, paths, _run_game_python_capture(ctx, paths, job["metadata"]))
                return

            live_capture_error = None
            if capture_source == "auto":
                runner_state = ctx.replay_runner.describe()
                if runner_state.get("game_live_capture_available"):
                    ctx.store.append_log(paths, "Trying live Python capture from hidden game.")
                    ctx.store.update_job(paths, status="spawning_hidden_game_process", error=None)
                    ctx.store.update_job(paths, status="launching_hidden_game", error=None)
                    ctx.store.update_job(paths, status="running_hidden_game_capture", error=None)
                    live_capture = _run_game_python_capture(ctx, paths, job["metadata"])
                    if live_capture.get("status") == "succeeded" and _has_authoritative_samples(live_capture):
                        _finalize_capture(ctx, paths, live_capture)
                        return
                    live_capture_error = _capture_error(live_capture)
                    ctx.store.append_log(paths, f"Live Python capture unavailable: {live_capture_error}")
                else:
                    live_capture_error = "Live Python capture is unavailable; staged game, runner script, or probe DLL is missing."
                    ctx.store.append_log(paths, live_capture_error)

            try:
                profile = load_matching_profile(ctx.settings.address_profile_dir, ctx.settings.staged_game_dir / "game.exe")
            except MissingAddressProfile as exc:
                if capture_source == "memory":
                    raise
                message = (
                    "Accurate game-backed capture is unavailable. "
                    f"Live Python capture: {live_capture_error or 'not attempted'}. "
                    f"Memory capture: {exc}"
                )
                ctx.store.append_log(paths, message)
                ctx.store.update_job(paths, status="failed", error=message)
                return

            ctx.store.update_job(paths, address_profile=profile.public_summary())
            ctx.store.append_log(paths, f"Using address profile {profile.name}.")
            _write_capture_request(ctx, paths, job["metadata"], profile)

            ctx.store.update_job(paths, status="starting_game")
            ctx.store.update_job(paths, status="spawning_hidden_game_process")
            ctx.store.update_job(paths, status="opening_replay")
            ctx.store.update_job(paths, status="sampling_memory")
            capture = ctx.replay_runner.capture_replay(job_id, timeout_seconds=ctx.settings.capture_timeout_seconds)
            _finalize_capture(ctx, paths, capture)
        except MissingAddressProfile as exc:
            ctx.store.append_log(paths, f"Address profile missing: {exc}")
            ctx.store.update_job(paths, status="failed", error=str(exc))
        except Exception as exc:
            ctx.store.append_log(paths, f"Capture failed unexpectedly: {exc}")
            ctx.store.update_job(paths, status="failed", error=str(exc))
        finally:
            _cleanup_capture_processes(ctx, paths, "Post-capture")


def command_health(runtime_dir: Path | None) -> dict[str, Any]:
    ctx = _load_backend(runtime_dir)
    settings = ctx.settings
    runner = ctx.replay_runner.describe()
    return {
        "status": "ok",
        "runtime_dir": str(settings.runtime_dir),
        "jobs_dir": str(settings.jobs_dir),
        "staged_game_dir": str(settings.staged_game_dir),
        "steam_game_dir": str(settings.steam_game_dir),
        "steam_game_exists": (settings.steam_game_dir / "game.exe").exists(),
        "address_profile_dir": str(settings.address_profile_dir),
        "capture_sample_hz": settings.capture_sample_hz,
        "capture_source": settings.capture_source,
        "runner": runner,
        "debug_tools": _debug_tool_inventory(settings),
    }


def command_stage_game(runtime_dir: Path | None) -> dict[str, Any]:
    ctx = _load_backend(runtime_dir)
    with ctx.stage_lock:
        result = stage_game(ctx.settings.steam_game_dir, ctx.settings.staged_game_dir)
    return {"status": "staged", **result}


def command_list_jobs(runtime_dir: Path | None, limit: int) -> dict[str, Any]:
    ctx = _load_backend(runtime_dir)
    bounded_limit = min(max(limit, 1), 100)
    return {"jobs": [_job_response(job) for job in ctx.store.list_jobs(limit=bounded_limit)]}


def command_job(runtime_dir: Path | None, job_id: str) -> dict[str, Any]:
    ctx = _load_backend(runtime_dir)
    paths = ctx.store.paths_for(job_id)
    return _job_response(ctx.store.read_job(paths))


def command_capture_file(runtime_dir: Path | None, input_path: Path, filename: str | None) -> dict[str, Any]:
    ctx = _load_backend(runtime_dir)
    raw = input_path.read_bytes()
    paths = ctx.store.create_job(filename or input_path.name)
    ctx.store.append_log(paths, f"Created desktop capture job for {filename or input_path.name!r}.")

    if len(raw) > ctx.settings.max_replay_bytes:
        message = f"Replay exceeds max upload size of {ctx.settings.max_replay_bytes} bytes."
        ctx.store.append_log(paths, message)
        job = ctx.store.update_job(paths, status="failed", error=message)
        return _job_response(job)

    try:
        document = validate_replay(raw, max_json_bytes=ctx.settings.max_replay_json_bytes)
    except ReplayValidationError as exc:
        ctx.store.append_log(paths, f"Replay validation failed: {exc}")
        job = ctx.store.update_job(paths, status="failed", error=str(exc))
        return _job_response(job)

    paths.replay_path.write_bytes(raw)
    paths.input_replay_path.write_bytes(raw)
    ctx.store.append_log(paths, "Replay gzip and JSON structure validated.")
    ctx.store.update_job(paths, metadata=document.metadata)

    _run_capture_job(ctx, paths.job_id)
    return _job_response(ctx.store.read_job(paths))


def _create_capture_job(ctx, input_path: Path, filename: str | None):
    raw = input_path.read_bytes()
    paths = ctx.store.create_job(filename or input_path.name)
    ctx.store.append_log(paths, f"Created desktop probe job for {filename or input_path.name!r}.")

    if len(raw) > ctx.settings.max_replay_bytes:
        message = f"Replay exceeds max upload size of {ctx.settings.max_replay_bytes} bytes."
        ctx.store.append_log(paths, message)
        ctx.store.update_job(paths, status="failed", error=message)
        return paths, None

    document = validate_replay(raw, max_json_bytes=ctx.settings.max_replay_json_bytes)
    paths.replay_path.write_bytes(raw)
    paths.input_replay_path.write_bytes(raw)
    ctx.store.append_log(paths, "Replay gzip and JSON structure validated for probe.")
    ctx.store.update_job(paths, status="probe_queued", metadata=document.metadata)
    _write_capture_request(ctx, paths, document.metadata, None)
    return paths, document


def command_probe_runtime(runtime_dir: Path | None, job_id: str | None = None) -> dict[str, Any]:
    ctx = _load_backend(runtime_dir)
    return ctx.replay_runner.probe_runtime(job_id)


def command_probe_file(
    runtime_dir: Path | None,
    input_path: Path,
    filename: str | None,
    mode: str,
) -> dict[str, Any]:
    ctx = _load_backend(runtime_dir)
    paths, document = _create_capture_job(ctx, input_path, filename)
    if document is None:
        return _job_response(ctx.store.read_job(paths))

    if mode == "probe-replay-state":
        ctx.store.update_job(paths, status="probing_replay_state")
        result = ctx.replay_runner.probe_replay_state(paths.job_id)
    elif mode == "sample-live-state":
        ctx.store.update_job(paths, status="sampling_live_state")
        result = ctx.replay_runner.sample_live_state(paths.job_id)
    elif mode == "capture-live-replay":
        ctx.store.update_job(paths, status="launching_hidden_game")
        capture = ctx.replay_runner.capture_live_replay(
            paths.job_id,
            timeout_seconds=ctx.settings.capture_timeout_seconds,
        )
        _finalize_capture(ctx, paths, capture)
        result = _capture_public_summary(capture)
    else:
        raise ValueError(f"Unknown probe mode: {mode}")

    ctx.store.append_log(paths, f"{mode} result: {result}")
    job = ctx.store.read_job(paths)
    return {"job": _job_response(job), "result": result}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="War of Dots replay desktop backend command mode.")
    parser.add_argument("--desktop-command", required=True)
    parser.add_argument("--runtime-dir", type=Path, default=None)
    parser.add_argument("--limit", type=int, default=25)
    parser.add_argument("--input", type=Path, default=None)
    parser.add_argument("--filename", default=None)
    parser.add_argument("--job-id", default=None)
    return parser


def run(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    try:
        if args.desktop_command == "health":
            payload = command_health(args.runtime_dir)
        elif args.desktop_command == "stage-game":
            payload = command_stage_game(args.runtime_dir)
        elif args.desktop_command == "list-jobs":
            payload = command_list_jobs(args.runtime_dir, args.limit)
        elif args.desktop_command == "job":
            if not args.job_id:
                raise ValueError("--job-id is required for job.")
            payload = command_job(args.runtime_dir, args.job_id)
        elif args.desktop_command == "capture-file":
            if args.input is None:
                raise ValueError("--input is required for capture-file.")
            payload = command_capture_file(args.runtime_dir, args.input, args.filename)
        elif args.desktop_command == "probe-runtime":
            payload = command_probe_runtime(args.runtime_dir, args.job_id)
        elif args.desktop_command in {"probe-replay-state", "sample-live-state", "capture-live-replay"}:
            if args.input is None:
                raise ValueError(f"--input is required for {args.desktop_command}.")
            payload = command_probe_file(args.runtime_dir, args.input, args.filename, args.desktop_command)
        else:
            raise ValueError(f"Unknown desktop command: {args.desktop_command}")
    except Exception as exc:
        print(json.dumps({"status": "error", "error": str(exc)}, default=_json_default))
        return 1

    print(json.dumps(payload, default=_json_default))
    return 0


if __name__ == "__main__":
    raise SystemExit(run(sys.argv[1:]))
