from __future__ import annotations

import json
from pathlib import Path
from threading import Lock
from typing import Any

from fastapi import BackgroundTasks, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse
import uvicorn

from .address_profiles import AddressProfile, MissingAddressProfile, load_matching_profile
from .config import get_settings
from .local_runner import LocalSessionRunner
from .replay import ReplayValidationError, validate_replay
from .replay_simulator import simulate_replay_file
from .stage_game import stage_game
from .storage import JobPaths
from .storage import JobStore
from .synthesis import synthesize_replay


settings = get_settings()
settings.ensure_runtime_dirs()
store = JobStore(settings.jobs_dir)
replay_runner = LocalSessionRunner(settings)
app = FastAPI(title="War of Dots Replay Server", version="0.1.0")
capture_lock = Lock()
stage_lock = Lock()
AUTHORITATIVE_CAPTURE_SOURCES = {"game-live-python", "memory", "local-session-memory-capture"}

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^(https?://(localhost|127\.0\.0\.1|tauri\.localhost)(:\d+)?|tauri://localhost)$",
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
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


def _debug_tool_inventory() -> dict[str, Any]:
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


async def _read_and_validate_upload(file: UploadFile) -> tuple[bytes, dict[str, Any]]:
    raw = await file.read(settings.max_replay_bytes + 1)
    if len(raw) > settings.max_replay_bytes:
        raise ReplayValidationError(f"Replay upload exceeds {settings.max_replay_bytes} bytes.")

    document = validate_replay(raw, max_json_bytes=settings.max_replay_json_bytes)
    metadata = {
        **document.metadata,
        "compressed_bytes": len(raw),
    }
    return raw, metadata


def _write_capture_request(paths: JobPaths, metadata: dict[str, Any], profile: AddressProfile | None) -> None:
    request = {
        "job_id": paths.job_id,
        "input_replay": str(paths.input_replay_path),
        "stats_output": str(paths.stats_path),
        "profile": profile.public_summary() if profile is not None else None,
        "sample_rate_hz": settings.capture_sample_hz,
        "replay_metadata": metadata,
    }
    paths.capture_request_path.write_text(json.dumps(request, indent=2), encoding="utf-8")


def _run_replay_file_capture(paths: JobPaths) -> dict[str, Any]:
    stats = simulate_replay_file(
        input_replay_path=paths.input_replay_path,
        stats_path=paths.stats_path,
        max_json_bytes=settings.max_replay_json_bytes,
    )
    return {
        "status": "succeeded",
        "phase": "replay_file_simulation",
        "source": "replay-file-derived",
        "stats": stats,
    }


def _run_game_python_capture(paths: JobPaths, metadata: dict[str, Any]) -> dict[str, Any]:
    _write_capture_request(paths, metadata, None)
    return replay_runner.capture_live_replay(
        paths.job_id,
        timeout_seconds=settings.capture_timeout_seconds,
    )


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


def _finalize_capture(paths: JobPaths, capture: dict[str, Any]) -> None:
    if capture.get("stats"):
        paths.stats_path.write_text(
            json.dumps(capture["stats"], indent=2),
            encoding="utf-8",
        )

    public_capture = _capture_public_summary(capture)
    paths.capture_result_path.write_text(json.dumps(public_capture, indent=2), encoding="utf-8")
    store.append_log(paths, f"Capture result {capture['status']}: {public_capture}")
    store.update_job(paths, status="finalizing", capture=public_capture)

    if capture.get("status") != "succeeded":
        message = _capture_error(capture)
        store.update_job(paths, status="failed", capture=public_capture, error=message)
        return

    source = capture.get("source") or capture.get("stats", {}).get("source")
    if source not in AUTHORITATIVE_CAPTURE_SOURCES and source != "replay-file-derived":
        store.update_job(
            paths,
            status="failed",
            capture=public_capture,
            error=f"Capture produced unsupported source {source!r}.",
        )
        return

    if not paths.stats_path.exists():
        store.update_job(
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
            store.update_job(
                paths,
                status="failed",
                capture=public_capture,
                error="Authoritative game-backed capture produced no playable samples.",
            )
            return

    store.update_job(paths, status="synthesizing_replay")
    synthesis = synthesize_replay(
        input_replay_path=paths.input_replay_path,
        stats_path=paths.stats_path,
        output_replay_path=paths.simulated_replay_path,
        max_json_bytes=settings.max_replay_json_bytes,
    )
    store.append_log(paths, f"Synthesized replay: {synthesis}")
    store.update_job(paths, status="captured", capture=public_capture, synthesis=synthesis, error=None)


def run_capture_job(job_id: str) -> None:
    paths = store.paths_for(job_id)

    with capture_lock:
        try:
            job = store.update_job(paths, status="local_runner_starting")
            capture_source = settings.capture_source.lower()
            if capture_source == "game-python":
                capture_source = "game-live-python"
            if capture_source == "replay-file":
                capture_source = "replay-file-dev"
            if capture_source not in {"auto", "memory", "game-live-python", "replay-file-dev"}:
                raise ValueError("WOD_CAPTURE_SOURCE must be auto, game-live-python, memory, or replay-file-dev.")

            if capture_source == "replay-file-dev":
                store.append_log(paths, "Using explicit dev-only replay-file-derived capture.")
                store.update_job(paths, status="simulating_from_replay_dev")
                _finalize_capture(paths, _run_replay_file_capture(paths))
                return

            if capture_source == "game-live-python":
                store.update_job(paths, status="launching_hidden_game")
                _finalize_capture(paths, _run_game_python_capture(paths, job["metadata"]))
                return

            live_capture_error = None
            if capture_source == "auto":
                runner_state = replay_runner.describe()
                if runner_state.get("game_live_capture_available"):
                    store.append_log(paths, "Trying live Python capture from hidden game.")
                    store.update_job(paths, status="launching_hidden_game", error=None)
                    live_capture = _run_game_python_capture(paths, job["metadata"])
                    if live_capture.get("status") == "succeeded" and _has_authoritative_samples(live_capture):
                        _finalize_capture(paths, live_capture)
                        return
                    live_capture_error = _capture_error(live_capture)
                    store.append_log(paths, f"Live Python capture unavailable: {live_capture_error}")
                else:
                    live_capture_error = "Live Python capture is unavailable; staged game, runner script, or probe DLL is missing."
                    store.append_log(paths, live_capture_error)

            try:
                profile = load_matching_profile(settings.address_profile_dir, settings.staged_game_dir / "game.exe")
            except MissingAddressProfile as exc:
                if capture_source == "memory":
                    raise
                message = (
                    "Accurate game-backed capture is unavailable. "
                    f"Live Python capture: {live_capture_error or 'not attempted'}. "
                    f"Memory capture: {exc}"
                )
                store.append_log(paths, message)
                store.update_job(paths, status="failed", error=message)
                return

            store.update_job(paths, address_profile=profile.public_summary())
            store.append_log(paths, f"Using address profile {profile.name}.")
            _write_capture_request(paths, job["metadata"], profile)

            store.update_job(paths, status="starting_game")
            store.update_job(paths, status="opening_replay")
            store.update_job(paths, status="sampling_memory")
            capture = replay_runner.capture_replay(job_id, timeout_seconds=settings.capture_timeout_seconds)
            _finalize_capture(paths, capture)
        except MissingAddressProfile as exc:
            store.append_log(paths, f"Address profile missing: {exc}")
            store.update_job(paths, status="failed", error=str(exc))
        except Exception as exc:
            store.append_log(paths, f"Capture failed unexpectedly: {exc}")
            store.update_job(paths, status="failed", error=str(exc))


@app.get("/healthz")
def healthz() -> dict[str, Any]:
    runner = replay_runner.describe()
    return {
        "status": "ok",
        "host": settings.host,
        "port": settings.port,
        "runtime_dir": str(settings.runtime_dir),
        "jobs_dir": str(settings.jobs_dir),
        "staged_game_dir": str(settings.staged_game_dir),
        "steam_game_dir": str(settings.steam_game_dir),
        "steam_game_exists": (settings.steam_game_dir / "game.exe").exists(),
        "address_profile_dir": str(settings.address_profile_dir),
        "capture_sample_hz": settings.capture_sample_hz,
        "capture_source": settings.capture_source,
        "runner": runner,
    }


@app.get("/api/jobs")
def list_jobs(limit: int = 25) -> dict[str, Any]:
    bounded_limit = min(max(limit, 1), 100)
    return {"jobs": [_job_response(job) for job in store.list_jobs(limit=bounded_limit)]}


@app.get("/api/debug-tools")
def debug_tools() -> dict[str, Any]:
    return {"tools": _debug_tool_inventory()}


@app.post("/api/runtime/stage-game")
def stage_game_runtime() -> dict[str, Any]:
    if not settings.steam_game_dir.exists():
        raise HTTPException(status_code=404, detail=f"Steam game directory not found: {settings.steam_game_dir}")
    with stage_lock:
        try:
            result = stage_game(settings.steam_game_dir, settings.staged_game_dir)
        except (FileNotFoundError, ValueError, OSError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"status": "staged", **result}


@app.post("/api/replays/verify")
async def verify_replay(file: UploadFile = File(...)) -> dict[str, Any]:
    paths = store.create_job(file.filename)
    store.append_log(paths, f"Created replay verification job for {file.filename!r}.")

    try:
        store.update_job(paths, status="validating")
        raw, metadata = await _read_and_validate_upload(file)
        paths.replay_path.write_bytes(raw)
        store.append_log(paths, "Replay gzip and JSON structure validated.")
        store.update_job(paths, metadata=metadata)

        store.update_job(paths, status="runner_smoke_running")
        smoke = replay_runner.smoke_check()
        store.append_log(paths, f"Local runner smoke check {smoke['status']}: {smoke}")

        if smoke["status"] == "failed" and settings.runner_smoke_required:
            job = store.update_job(paths, status="failed", runner_smoke=smoke, error=smoke.get("message"))
            return _job_response(job)

        job = store.update_job(paths, status="verified", runner_smoke=smoke, error=None)
        return _job_response(job)
    except ReplayValidationError as exc:
        store.append_log(paths, f"Replay validation failed: {exc}")
        job = store.update_job(paths, status="failed", error=str(exc))
        raise HTTPException(status_code=422, detail=_job_response(job)) from exc


@app.post("/api/replays/capture")
async def capture_replay(background_tasks: BackgroundTasks, file: UploadFile = File(...)) -> dict[str, Any]:
    paths = store.create_job(file.filename)
    store.append_log(paths, f"Created replay capture job for {file.filename!r}.")

    try:
        store.update_job(paths, status="validating")
        raw, metadata = await _read_and_validate_upload(file)
        paths.input_replay_path.write_bytes(raw)
        store.append_log(paths, "Replay gzip and JSON structure validated for capture.")
        job = store.update_job(paths, status="queued", metadata=metadata)
        background_tasks.add_task(run_capture_job, paths.job_id)
        return _job_response(job)
    except ReplayValidationError as exc:
        store.append_log(paths, f"Replay validation failed: {exc}")
        job = store.update_job(paths, status="failed", error=str(exc))
        raise HTTPException(status_code=422, detail=_job_response(job)) from exc


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> dict[str, Any]:
    try:
        paths = store.paths_for(job_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Job not found.") from exc
    return _job_response(store.read_job(paths))


@app.get("/api/jobs/{job_id}/replay")
def get_replay(job_id: str) -> FileResponse:
    try:
        paths = store.paths_for(job_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Job not found.") from exc
    replay_path = paths.replay_path if paths.replay_path.exists() else paths.input_replay_path
    if not replay_path.exists():
        raise HTTPException(status_code=404, detail="Replay file is not available for this job.")
    return FileResponse(
        replay_path,
        media_type="application/octet-stream",
        filename=f"{job_id}.rep",
    )


@app.get("/api/jobs/{job_id}/stats")
def get_stats(job_id: str) -> FileResponse:
    try:
        paths = store.paths_for(job_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Job not found.") from exc
    if not paths.stats_path.exists():
        raise HTTPException(status_code=404, detail="Stats file is not available for this job.")
    return FileResponse(paths.stats_path, media_type="application/json", filename=f"{job_id}-stats.json")


@app.get("/api/jobs/{job_id}/simulated-replay")
def get_simulated_replay(job_id: str) -> FileResponse:
    try:
        paths = store.paths_for(job_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Job not found.") from exc
    if not paths.simulated_replay_path.exists():
        raise HTTPException(status_code=404, detail="Simulated replay file is not available for this job.")
    return FileResponse(
        paths.simulated_replay_path,
        media_type="application/octet-stream",
        filename=f"{job_id}-simulated.rep",
    )


@app.get("/api/jobs/{job_id}/logs")
def get_logs(job_id: str) -> PlainTextResponse:
    try:
        paths = store.paths_for(job_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Job not found.") from exc
    if not paths.logs_path.exists():
        return PlainTextResponse("")
    return PlainTextResponse(paths.logs_path.read_text(encoding="utf-8"))


def main() -> None:
    uvicorn.run("wod_replay_server.app:app", host=settings.host, port=settings.port, reload=False)


if __name__ == "__main__":
    main()
