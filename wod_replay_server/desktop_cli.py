from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
from typing import Any

from .replay import ReplayValidationError, validate_replay


def _json_default(value: Any) -> str:
    return str(value)


def _load_app(runtime_dir: Path | None):
    if runtime_dir is not None:
        os.environ["WOD_RUNTIME_DIR"] = str(runtime_dir.expanduser().resolve())

    from . import config

    config.get_settings.cache_clear()

    from . import app as app_module

    return app_module


def _job_response(job: dict[str, Any]) -> dict[str, Any]:
    return dict(job)


def command_health(runtime_dir: Path | None) -> dict[str, Any]:
    app_module = _load_app(runtime_dir)
    settings = app_module.settings
    settings.ensure_runtime_dirs()
    runner = app_module.replay_runner.describe()
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
        "debug_tools": app_module._debug_tool_inventory(),
    }


def command_stage_game(runtime_dir: Path | None) -> dict[str, Any]:
    app_module = _load_app(runtime_dir)
    settings = app_module.settings
    settings.ensure_runtime_dirs()
    result = app_module.stage_game(settings.steam_game_dir, settings.staged_game_dir)
    return {"status": "staged", **result}


def command_list_jobs(runtime_dir: Path | None, limit: int) -> dict[str, Any]:
    app_module = _load_app(runtime_dir)
    settings = app_module.settings
    settings.ensure_runtime_dirs()
    bounded_limit = min(max(limit, 1), 100)
    return {"jobs": [_job_response(job) for job in app_module.store.list_jobs(limit=bounded_limit)]}


def command_job(runtime_dir: Path | None, job_id: str) -> dict[str, Any]:
    app_module = _load_app(runtime_dir)
    paths = app_module.store.paths_for(job_id)
    return _job_response(app_module.store.read_job(paths))


def command_capture_file(runtime_dir: Path | None, input_path: Path, filename: str | None) -> dict[str, Any]:
    app_module = _load_app(runtime_dir)
    settings = app_module.settings
    settings.ensure_runtime_dirs()

    raw = input_path.read_bytes()
    paths = app_module.store.create_job(filename or input_path.name)
    app_module.store.append_log(paths, f"Created desktop capture job for {filename or input_path.name!r}.")

    if len(raw) > settings.max_replay_bytes:
        message = f"Replay exceeds max upload size of {settings.max_replay_bytes} bytes."
        app_module.store.append_log(paths, message)
        job = app_module.store.update_job(paths, status="failed", error=message)
        return _job_response(job)

    try:
        document = validate_replay(raw, max_json_bytes=settings.max_replay_json_bytes)
    except ReplayValidationError as exc:
        app_module.store.append_log(paths, f"Replay validation failed: {exc}")
        job = app_module.store.update_job(paths, status="failed", error=str(exc))
        return _job_response(job)

    paths.replay_path.write_bytes(raw)
    paths.input_replay_path.write_bytes(raw)
    app_module.store.append_log(paths, "Replay gzip and JSON structure validated.")
    app_module.store.update_job(paths, metadata=document.metadata)

    app_module.run_capture_job(paths.job_id)
    return _job_response(app_module.store.read_job(paths))


def _create_capture_job(app_module, input_path: Path, filename: str | None):
    settings = app_module.settings
    raw = input_path.read_bytes()
    paths = app_module.store.create_job(filename or input_path.name)
    app_module.store.append_log(paths, f"Created desktop probe job for {filename or input_path.name!r}.")

    if len(raw) > settings.max_replay_bytes:
        message = f"Replay exceeds max upload size of {settings.max_replay_bytes} bytes."
        app_module.store.append_log(paths, message)
        app_module.store.update_job(paths, status="failed", error=message)
        return paths, None

    document = validate_replay(raw, max_json_bytes=settings.max_replay_json_bytes)
    paths.replay_path.write_bytes(raw)
    paths.input_replay_path.write_bytes(raw)
    app_module.store.append_log(paths, "Replay gzip and JSON structure validated for probe.")
    app_module.store.update_job(paths, status="probe_queued", metadata=document.metadata)
    app_module._write_capture_request(paths, document.metadata, None)
    return paths, document


def command_probe_runtime(runtime_dir: Path | None, job_id: str | None = None) -> dict[str, Any]:
    app_module = _load_app(runtime_dir)
    app_module.settings.ensure_runtime_dirs()
    return app_module.replay_runner.probe_runtime(job_id)


def command_probe_file(
    runtime_dir: Path | None,
    input_path: Path,
    filename: str | None,
    mode: str,
) -> dict[str, Any]:
    app_module = _load_app(runtime_dir)
    app_module.settings.ensure_runtime_dirs()
    paths, document = _create_capture_job(app_module, input_path, filename)
    if document is None:
        return _job_response(app_module.store.read_job(paths))

    if mode == "probe-replay-state":
        app_module.store.update_job(paths, status="probing_replay_state")
        result = app_module.replay_runner.probe_replay_state(paths.job_id)
    elif mode == "sample-live-state":
        app_module.store.update_job(paths, status="sampling_live_state")
        result = app_module.replay_runner.sample_live_state(paths.job_id)
    elif mode == "capture-live-replay":
        app_module.store.update_job(paths, status="launching_hidden_game")
        capture = app_module.replay_runner.capture_live_replay(
            paths.job_id,
            timeout_seconds=app_module.settings.capture_timeout_seconds,
        )
        app_module._finalize_capture(paths, capture)
        result = app_module._capture_public_summary(capture)
    else:
        raise ValueError(f"Unknown probe mode: {mode}")

    app_module.store.append_log(paths, f"{mode} result: {result}")
    job = app_module.store.read_job(paths)
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
