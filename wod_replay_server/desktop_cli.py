from __future__ import annotations

import argparse
from contextlib import contextmanager
import ctypes
import json
import os
from pathlib import Path
import sys
import time
from threading import Lock
from types import SimpleNamespace
from typing import Any

from .address_profiles import AddressProfile, MissingAddressProfile, load_matching_profile
from .config import get_settings
from .local_runner import LocalSessionRunner
from .replay import ReplayValidationError, validate_replay
from .stage_game import stage_game
from .storage import JobPaths, JobStore
from .synthesis import MAX_INLINE_STATS_BYTES, synthesize_replay


AUTHORITATIVE_CAPTURE_SOURCES = {"game-live-python", "memory", "local-session-memory-capture"}
ORPHAN_UPLOAD_MAX_AGE_SECONDS = 60 * 60
STAGE_GAME_MUTEX_NAME = "Global\\MoreOfDotsStageGame"


@contextmanager
def _stage_game_mutex(timeout_seconds: int = 120):
    if os.name != "nt":
        yield
        return

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_bool, ctypes.c_wchar_p]
    kernel32.CreateMutexW.restype = ctypes.c_void_p
    kernel32.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
    kernel32.WaitForSingleObject.restype = ctypes.c_uint32
    kernel32.ReleaseMutex.argtypes = [ctypes.c_void_p]
    kernel32.ReleaseMutex.restype = ctypes.c_bool
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel32.CloseHandle.restype = ctypes.c_bool

    handle = kernel32.CreateMutexW(None, False, STAGE_GAME_MUTEX_NAME)
    if not handle:
        raise OSError(ctypes.get_last_error(), "CreateMutexW failed for staged game lock")

    acquired = False
    try:
        wait = kernel32.WaitForSingleObject(handle, max(1, timeout_seconds) * 1000)
        if wait not in (0, 0x80):
            raise TimeoutError(f"Timed out waiting for staged game lock after {timeout_seconds}s.")
        acquired = True
        yield
    finally:
        if acquired:
            kernel32.ReleaseMutex(handle)
        kernel32.CloseHandle(handle)


def _json_default(value: Any) -> str:
    return str(value)


def _load_backend(runtime_dir: Path | None, owner_pid: int | None = None):
    if runtime_dir is not None:
        os.environ["WOD_RUNTIME_DIR"] = str(runtime_dir.expanduser().resolve())

    get_settings.cache_clear()
    settings = get_settings()
    settings.ensure_runtime_dirs()
    return SimpleNamespace(
        settings=settings,
        store=JobStore(settings.jobs_dir),
        replay_runner=LocalSessionRunner(settings, owner_pid=owner_pid),
        capture_lock=Lock(),
        stage_lock=Lock(),
    )


def _job_response(job: dict[str, Any]) -> dict[str, Any]:
    return {
        "job_id": job["job_id"],
        "status": job["status"],
        "metadata": job.get("metadata"),
        "capture": job.get("capture"),
        "synthesis": job.get("synthesis"),
        "address_profile": job.get("address_profile"),
        "error": job.get("error"),
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
    stats_summary = capture.get("stats_summary")
    source = capture.get("source")
    if isinstance(stats, dict):
        source = source or stats.get("source")
        samples = stats.get("samples")
        if source in AUTHORITATIVE_CAPTURE_SOURCES and isinstance(samples, list) and len(samples) > 0:
            return True
    if isinstance(stats_summary, dict):
        source = source or stats_summary.get("source")
        sample_count = stats_summary.get("sample_count")
        if not isinstance(sample_count, int):
            summary = stats_summary.get("summary")
            sample_count = summary.get("sample_count") if isinstance(summary, dict) else 0
        return source in AUTHORITATIVE_CAPTURE_SOURCES and isinstance(sample_count, int) and sample_count > 0
    return False


def _stats_public_summary(stats: dict[str, Any]) -> dict[str, Any]:
    samples = stats.get("samples")
    summary = stats.get("summary", {})
    sample_count = summary.get("sample_count") if isinstance(summary, dict) else None
    return {
        "source": stats.get("source"),
        "sample_rate_hz": stats.get("sample_rate_hz"),
        "sample_count": sample_count if isinstance(sample_count, int) else (len(samples) if isinstance(samples, list) else 0),
        "summary": summary if isinstance(summary, dict) else {},
        "replay_metadata": stats.get("replay_metadata", {}),
    }


def _capture_public_summary(capture: dict[str, Any]) -> dict[str, Any]:
    public = {key: value for key, value in capture.items() if key != "stats"}
    stats = capture.get("stats")
    if isinstance(stats, dict):
        public["stats_summary"] = _stats_public_summary(stats)
    return public


def _sample_stream_path(paths: JobPaths) -> Path:
    return paths.stats_path.with_name(paths.stats_path.name + ".samples.jsonl")


def _write_sample_stream_if_needed(stream_path: Path, samples: list[Any]) -> None:
    if not samples or (stream_path.exists() and stream_path.stat().st_size > 0):
        return
    with stream_path.open("w", encoding="utf-8") as handle:
        for sample in samples:
            if isinstance(sample, dict):
                handle.write(json.dumps(sample, ensure_ascii=False, separators=(",", ":")) + "\n")


def _metadata_only_stats(stats: dict[str, Any], stream_path: Path) -> dict[str, Any]:
    metadata = dict(stats)
    samples = stats.get("samples")
    sample_count = len(samples) if isinstance(samples, list) else 0
    summary = dict(stats.get("summary")) if isinstance(stats.get("summary"), dict) else {}
    if sample_count and not isinstance(summary.get("sample_count"), int):
        summary["sample_count"] = sample_count
    summary["embedded_sample_count"] = 0
    summary["sample_stream_path"] = str(stream_path)
    metadata["summary"] = summary
    metadata["samples"] = []
    return metadata


def _write_metadata_only_stats(paths: JobPaths, stats: dict[str, Any]) -> None:
    samples = stats.get("samples")
    stream_path = _sample_stream_path(paths)
    if isinstance(samples, list):
        _write_sample_stream_if_needed(stream_path, samples)
    paths.stats_path.write_text(
        json.dumps(_metadata_only_stats(stats, stream_path), indent=2),
        encoding="utf-8",
    )


def _stats_summary_from_file(stats_path: Path) -> dict[str, Any] | None:
    try:
        if not stats_path.exists() or stats_path.stat().st_size > MAX_INLINE_STATS_BYTES:
            return None
        stats = json.loads(stats_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(stats, dict):
        return None
    return _stats_public_summary(stats)


def _compact_existing_stats_file(paths: JobPaths) -> None:
    if not paths.stats_path.exists():
        return
    stream_path = _sample_stream_path(paths)
    try:
        stats_size = paths.stats_path.stat().st_size
    except OSError:
        return

    if stats_size > MAX_INLINE_STATS_BYTES:
        meta_path = paths.stats_path.with_name(paths.stats_path.name + ".partial.meta.json")
        if not stream_path.exists() or not meta_path.exists():
            return
        try:
            if meta_path.stat().st_size > MAX_INLINE_STATS_BYTES:
                return
            stats = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        if not isinstance(stats, dict):
            return
        summary = dict(stats.get("summary")) if isinstance(stats.get("summary"), dict) else {}
        summary["partial"] = False
        stats["summary"] = summary
        _write_metadata_only_stats(paths, stats)
        return

    try:
        stats = json.loads(paths.stats_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return
    if isinstance(stats, dict) and isinstance(stats.get("samples"), list) and stats["samples"]:
        _write_metadata_only_stats(paths, stats)


def _cleanup_orphan_uploads(runtime_dir: Path) -> dict[str, Any]:
    uploads_dir = runtime_dir / "desktop-uploads"
    if not uploads_dir.exists():
        return {"removed_files": 0, "removed_bytes": 0}

    now = time.time()
    removed_files = 0
    removed_bytes = 0
    for path in uploads_dir.iterdir():
        if not path.is_file():
            continue
        try:
            if now - path.stat().st_mtime < ORPHAN_UPLOAD_MAX_AGE_SECONDS:
                continue
            size = path.stat().st_size
            path.unlink()
        except OSError:
            continue
        removed_files += 1
        removed_bytes += size
    return {"removed_files": removed_files, "removed_bytes": removed_bytes}


def _cleanup_runtime(ctx, *, preserve_job_ids: set[str] | None = None) -> dict[str, Any]:
    return {
        "uploads": _cleanup_orphan_uploads(ctx.settings.runtime_dir),
        "jobs": ctx.store.prune_finished_jobs(
            max_bytes=ctx.settings.runtime_jobs_max_bytes,
            preserve_job_ids=preserve_job_ids or set(),
        ),
    }


def _skipped_runtime_cleanup(reason: str) -> dict[str, Any]:
    return {
        "skipped": True,
        "reason": reason,
        "uploads": {"skipped": True, "removed_files": 0, "removed_bytes": 0},
        "jobs": {"skipped": True, "deleted_jobs": [], "deleted_bytes": 0},
    }


def _finalize_capture(ctx, paths: JobPaths, capture: dict[str, Any]) -> None:
    stats = capture.get("stats")
    if isinstance(stats, dict):
        _write_metadata_only_stats(paths, stats)
    else:
        _compact_existing_stats_file(paths)
    stats_summary = _stats_summary_from_file(paths.stats_path)
    if stats_summary is not None:
        capture["stats_summary"] = stats_summary

    public_capture = _capture_public_summary(capture)
    paths.capture_result_path.write_text(json.dumps(public_capture, indent=2), encoding="utf-8")
    ctx.store.append_log(paths, f"Capture result {capture['status']}: {public_capture}")
    ctx.store.update_job(paths, status="finalizing", capture=public_capture)

    if capture.get("status") != "succeeded":
        message = _capture_error(capture)
        ctx.store.update_job(paths, status="failed", capture=public_capture, error=message)
        return

    source = capture.get("source") or capture.get("stats", {}).get("source") or capture.get("stats_summary", {}).get("source")
    if source not in AUTHORITATIVE_CAPTURE_SOURCES:
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

    if source in AUTHORITATIVE_CAPTURE_SOURCES and not _has_authoritative_samples(capture):
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
            if capture_source not in {"auto", "memory", "game-live-python"}:
                raise ValueError("WOD_CAPTURE_SOURCE must be auto, game-live-python, or memory.")

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


def command_health(runtime_dir: Path | None, owner_pid: int | None = None) -> dict[str, Any]:
    ctx = _load_backend(runtime_dir, owner_pid)
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
        "runtime_jobs_max_bytes": settings.runtime_jobs_max_bytes,
        "runtime_cleanup": _skipped_runtime_cleanup("startup-health"),
        "runner": runner,
        "debug_tools": _debug_tool_inventory(settings),
    }


def command_stage_game(runtime_dir: Path | None, owner_pid: int | None = None) -> dict[str, Any]:
    ctx = _load_backend(runtime_dir, owner_pid)
    with ctx.stage_lock:
        with _stage_game_mutex():
            result = stage_game(ctx.settings.steam_game_dir, ctx.settings.staged_game_dir)
    return {"status": "staged", **result}


def command_list_jobs(runtime_dir: Path | None, limit: int, owner_pid: int | None = None) -> dict[str, Any]:
    ctx = _load_backend(runtime_dir, owner_pid)
    bounded_limit = min(max(limit, 1), 100)
    return {"jobs": [_job_response(job) for job in ctx.store.list_jobs(limit=bounded_limit)]}


def command_job(runtime_dir: Path | None, job_id: str, owner_pid: int | None = None) -> dict[str, Any]:
    ctx = _load_backend(runtime_dir, owner_pid)
    paths = ctx.store.paths_for(job_id)
    return _job_response(ctx.store.read_job(paths))


def command_capture_file(
    runtime_dir: Path | None,
    input_path: Path,
    filename: str | None,
    owner_pid: int | None = None,
) -> dict[str, Any]:
    ctx = _load_backend(runtime_dir, owner_pid)
    _cleanup_runtime(ctx)
    raw = input_path.read_bytes()
    paths = ctx.store.create_job(filename or input_path.name, owner_pid=owner_pid)
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

    paths.input_replay_path.write_bytes(raw)
    ctx.store.append_log(paths, "Replay gzip and JSON structure validated.")
    ctx.store.update_job(paths, metadata=document.metadata)

    _run_capture_job(ctx, paths.job_id)
    _cleanup_runtime(ctx, preserve_job_ids={paths.job_id})
    return _job_response(ctx.store.read_job(paths))


def command_release_job_artifacts(
    runtime_dir: Path | None,
    job_id: str,
    owner_pid: int | None = None,
) -> dict[str, Any]:
    ctx = _load_backend(runtime_dir, owner_pid)
    release = ctx.store.release_job_artifacts(job_id)
    cleanup = _cleanup_runtime(ctx, preserve_job_ids={job_id})
    return {"status": "ok", "release": release, "cleanup": cleanup}


def _create_capture_job(ctx, input_path: Path, filename: str | None):
    raw = input_path.read_bytes()
    paths = ctx.store.create_job(filename or input_path.name, owner_pid=ctx.replay_runner.owner_pid)
    ctx.store.append_log(paths, f"Created desktop probe job for {filename or input_path.name!r}.")

    if len(raw) > ctx.settings.max_replay_bytes:
        message = f"Replay exceeds max upload size of {ctx.settings.max_replay_bytes} bytes."
        ctx.store.append_log(paths, message)
        ctx.store.update_job(paths, status="failed", error=message)
        return paths, None

    document = validate_replay(raw, max_json_bytes=ctx.settings.max_replay_json_bytes)
    paths.input_replay_path.write_bytes(raw)
    ctx.store.append_log(paths, "Replay gzip and JSON structure validated for probe.")
    ctx.store.update_job(paths, status="probe_queued", metadata=document.metadata)
    _write_capture_request(ctx, paths, document.metadata, None)
    return paths, document


def command_probe_runtime(
    runtime_dir: Path | None,
    job_id: str | None = None,
    owner_pid: int | None = None,
) -> dict[str, Any]:
    ctx = _load_backend(runtime_dir, owner_pid)
    return ctx.replay_runner.probe_runtime(job_id)


def command_probe_file(
    runtime_dir: Path | None,
    input_path: Path,
    filename: str | None,
    mode: str,
    owner_pid: int | None = None,
) -> dict[str, Any]:
    ctx = _load_backend(runtime_dir, owner_pid)
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
        _cleanup_runtime(ctx, preserve_job_ids={paths.job_id})
        result = _capture_public_summary(capture)
    else:
        raise ValueError(f"Unknown probe mode: {mode}")

    ctx.store.append_log(paths, f"{mode} result: {result}")
    job = ctx.store.read_job(paths)
    return {"job": _job_response(job), "result": result}


def command_record_replay(
    runtime_dir: Path | None,
    input_path: Path,
    filename: str | None,
    output_path: Path,
    ffmpeg_path: Path,
    cancel_path: Path,
    status_path: Path,
    playback_speed: int,
    bitrate_kbps: int,
    resolution_height: int,
    owner_pid: int | None = None,
) -> dict[str, Any]:
    ctx = _load_backend(runtime_dir, owner_pid)
    paths, document = _create_capture_job(ctx, input_path, filename)
    if document is None:
        return _job_response(ctx.store.read_job(paths))

    output_path = output_path.expanduser().resolve()
    ffmpeg_path = ffmpeg_path.expanduser().resolve()
    cancel_path = cancel_path.expanduser().resolve()
    status_path = status_path.expanduser().resolve()
    if playback_speed not in {1, 2, 4, 6, 10}:
        raise ValueError("Playback speed must be 1x, 2x, 4x, 6x, or 10x.")
    if bitrate_kbps not in {500, 1000, 2500, 5000, 10000}:
        raise ValueError("Video bitrate must use one of the supported presets.")
    if resolution_height not in {480, 720, 1080}:
        raise ValueError("Video resolution must be 480p, 720p, or 1080p.")
    if not ffmpeg_path.is_file():
        raise FileNotFoundError(f"FFmpeg was not found: {ffmpeg_path}")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    cancel_path.parent.mkdir(parents=True, exist_ok=True)
    status_path.parent.mkdir(parents=True, exist_ok=True)

    ctx.store.update_job(paths, status="recording_replay")
    result = ctx.replay_runner.record_replay(
        paths.job_id,
        output_path=output_path,
        ffmpeg_path=ffmpeg_path,
        cancel_path=cancel_path,
        status_path=status_path,
        playback_speed=playback_speed,
        bitrate_kbps=bitrate_kbps,
        resolution_height=resolution_height,
        timeout_seconds=max(60, ctx.settings.capture_timeout_seconds),
    )
    ctx.store.append_log(paths, f"record-replay result: {result}")
    final_status = "cancelled" if result.get("status") == "cancelled" else result.get("status", "failed")
    ctx.store.update_job(paths, status=final_status, capture=result)
    _cleanup_runtime(ctx, preserve_job_ids={paths.job_id})
    return {"job_id": paths.job_id, "status": final_status, "result": result}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="War of Dots replay desktop backend command mode.")
    parser.add_argument("--desktop-command", required=True)
    parser.add_argument("--runtime-dir", type=Path, default=None)
    parser.add_argument("--limit", type=int, default=25)
    parser.add_argument("--input", type=Path, default=None)
    parser.add_argument("--filename", default=None)
    parser.add_argument("--job-id", default=None)
    parser.add_argument("--output", type=Path, default=None)
    parser.add_argument("--ffmpeg", type=Path, default=None)
    parser.add_argument("--cancel-path", type=Path, default=None)
    parser.add_argument("--status-path", type=Path, default=None)
    parser.add_argument("--playback-speed", type=int, default=10)
    parser.add_argument("--bitrate-kbps", type=int, default=5000)
    parser.add_argument("--resolution-height", type=int, default=720)
    parser.add_argument("--owner-pid", type=int, default=None)
    return parser


def run(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    try:
        if args.desktop_command == "health":
            payload = command_health(args.runtime_dir, args.owner_pid)
        elif args.desktop_command == "stage-game":
            payload = command_stage_game(args.runtime_dir, args.owner_pid)
        elif args.desktop_command == "list-jobs":
            payload = command_list_jobs(args.runtime_dir, args.limit, args.owner_pid)
        elif args.desktop_command == "job":
            if not args.job_id:
                raise ValueError("--job-id is required for job.")
            payload = command_job(args.runtime_dir, args.job_id, args.owner_pid)
        elif args.desktop_command == "release-job-artifacts":
            if not args.job_id:
                raise ValueError("--job-id is required for release-job-artifacts.")
            payload = command_release_job_artifacts(args.runtime_dir, args.job_id, args.owner_pid)
        elif args.desktop_command == "capture-file":
            if args.input is None:
                raise ValueError("--input is required for capture-file.")
            payload = command_capture_file(args.runtime_dir, args.input, args.filename, args.owner_pid)
        elif args.desktop_command == "probe-runtime":
            payload = command_probe_runtime(args.runtime_dir, args.job_id, args.owner_pid)
        elif args.desktop_command in {"probe-replay-state", "sample-live-state", "capture-live-replay"}:
            if args.input is None:
                raise ValueError(f"--input is required for {args.desktop_command}.")
            payload = command_probe_file(args.runtime_dir, args.input, args.filename, args.desktop_command, args.owner_pid)
        elif args.desktop_command == "record-replay":
            if args.input is None or args.output is None or args.ffmpeg is None or args.cancel_path is None or args.status_path is None:
                raise ValueError("--input, --output, --ffmpeg, --cancel-path, and --status-path are required for record-replay.")
            payload = command_record_replay(
                args.runtime_dir,
                args.input,
                args.filename,
                args.output,
                args.ffmpeg,
                args.cancel_path,
                args.status_path,
                args.playback_speed,
                args.bitrate_kbps,
                args.resolution_height,
                args.owner_pid,
            )
        else:
            raise ValueError(f"Unknown desktop command: {args.desktop_command}")
    except Exception as exc:
        print(json.dumps({"status": "error", "error": str(exc)}, default=_json_default))
        return 1

    print(json.dumps(payload, default=_json_default))
    return 0


if __name__ == "__main__":
    raise SystemExit(run(sys.argv[1:]))
