from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, UTC
import json
from pathlib import Path
import shutil
import time
from typing import Any
from uuid import uuid4


DEFAULT_STALE_ACTIVE_JOB_SECONDS = 2 * 60 * 60
FINAL_JOB_STATUSES = {"captured", "completed", "failed", "recorded", "succeeded"}
BULKY_JOB_ARTIFACT_PATTERNS = (
    "stats.json.samples.jsonl",
    "stats.json.partial.json",
    "stats.json.partial.json.tmp",
    "stats.json.partial.json.*.tmp",
    "stats.json.partial.meta.json",
    "stats.json.partial.meta.json.tmp",
    "stats.json.partial.meta.json.*.tmp",
    "live-capture-artifact.json",
    "live-capture-artifact.json.tmp",
    "live-capture-artifact.json.error.txt",
    "live-capture-artifact.json.progress.jsonl",
    "game-runtime",
    "probe",
    "recording.mp4",
    "video-bootstrap-artifact.json",
)
TRANSIENT_JOB_PATTERNS = (
    "*.tmp",
    "*.partial.json.tmp",
    "*.partial.meta.json.tmp",
)


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


def directory_size(path: Path) -> int:
    total = 0
    for item in path.rglob("*"):
        try:
            if item.is_file():
                total += item.stat().st_size
        except OSError:
            continue
    return total


def _remove_path(path: Path) -> int:
    try:
        if path.is_dir():
            size = directory_size(path)
            shutil.rmtree(path)
            return size
        if path.is_file():
            size = path.stat().st_size
            path.unlink()
            return size
    except OSError:
        return 0
    return 0


@dataclass(frozen=True)
class JobPaths:
    job_id: str
    root: Path

    @property
    def input_replay_path(self) -> Path:
        return self.root / "input.rep"

    @property
    def stats_path(self) -> Path:
        return self.root / "stats.json"

    @property
    def simulated_replay_path(self) -> Path:
        return self.root / "simulated.rep"

    @property
    def capture_request_path(self) -> Path:
        return self.root / "capture-request.json"

    @property
    def capture_result_path(self) -> Path:
        return self.root / "capture-result.json"

    @property
    def job_json_path(self) -> Path:
        return self.root / "job.json"

    @property
    def logs_path(self) -> Path:
        return self.root / "logs.txt"


class JobStore:
    def __init__(self, jobs_dir: Path):
        self.jobs_dir = jobs_dir
        self.jobs_dir.mkdir(parents=True, exist_ok=True)

    def create_job(self, filename: str | None, owner_pid: int | None = None) -> JobPaths:
        job_id = uuid4().hex
        paths = JobPaths(job_id=job_id, root=self.jobs_dir / job_id)
        paths.root.mkdir(parents=True, exist_ok=False)
        self.write_job(
            paths,
            {
                "job_id": job_id,
                "filename": filename,
                "owner_pid": owner_pid if owner_pid and owner_pid > 0 else None,
                "status": "queued",
                "created_at": utc_now(),
                "updated_at": utc_now(),
                "metadata": None,
                "capture": None,
                "synthesis": None,
                "address_profile": None,
                "error": None,
            },
        )
        return paths

    def paths_for(self, job_id: str) -> JobPaths:
        if not job_id or any(char not in "0123456789abcdef" for char in job_id):
            raise FileNotFoundError(job_id)
        paths = JobPaths(job_id=job_id, root=self.jobs_dir / job_id)
        if not paths.job_json_path.exists():
            raise FileNotFoundError(job_id)
        return paths

    def list_jobs(self, *, limit: int = 25) -> list[dict[str, Any]]:
        jobs: list[dict[str, Any]] = []
        for path in sorted(self.jobs_dir.glob("*/job.json"), key=lambda item: item.stat().st_mtime, reverse=True):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if isinstance(data, dict):
                jobs.append(data)
            if len(jobs) >= limit:
                break
        return jobs

    def jobs_size_bytes(self) -> int:
        return directory_size(self.jobs_dir)

    def read_job(self, paths: JobPaths) -> dict[str, Any]:
        return json.loads(paths.job_json_path.read_text(encoding="utf-8"))

    def write_job(self, paths: JobPaths, data: dict[str, Any]) -> None:
        data["updated_at"] = utc_now()
        paths.job_json_path.write_text(json.dumps(data, indent=2), encoding="utf-8")

    def update_job(self, paths: JobPaths, **updates: Any) -> dict[str, Any]:
        data = self.read_job(paths)
        data.update(updates)
        self.write_job(paths, data)
        return data

    def append_log(self, paths: JobPaths, message: str) -> None:
        timestamp = utc_now()
        with paths.logs_path.open("a", encoding="utf-8") as handle:
            handle.write(f"[{timestamp}] {message}\n")

    def _read_job_for_root(self, root: Path) -> dict[str, Any] | None:
        path = root / "job.json"
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        return data if isinstance(data, dict) else None

    def _job_sort_time(self, root: Path) -> float:
        path = root / "job.json"
        try:
            return path.stat().st_mtime
        except OSError:
            pass
        try:
            return root.stat().st_mtime
        except OSError:
            return 0.0

    def _is_final_job(self, root: Path) -> bool:
        job = self._read_job_for_root(root)
        if job is None:
            return True
        return job.get("status") in FINAL_JOB_STATUSES

    def _is_prunable_job(self, root: Path, *, now: float, stale_active_seconds: int) -> bool:
        if self._is_final_job(root):
            return True
        return now - self._job_sort_time(root) > stale_active_seconds

    def cleanup_transient_job_files(self, *, preserve_job_ids: set[str] | None = None) -> dict[str, Any]:
        preserve_job_ids = preserve_job_ids or set()
        removed_files = 0
        removed_bytes = 0
        for root in self.jobs_dir.iterdir() if self.jobs_dir.exists() else []:
            if not root.is_dir() or root.name in preserve_job_ids or not self._is_final_job(root):
                continue
            for pattern in TRANSIENT_JOB_PATTERNS:
                for path in root.glob(pattern):
                    if path.name == "job.json":
                        continue
                    size = _remove_path(path)
                    if size:
                        removed_files += 1
                        removed_bytes += size
        return {"removed_files": removed_files, "removed_bytes": removed_bytes}

    def release_job_artifacts(self, job_id: str) -> dict[str, Any]:
        paths = self.paths_for(job_id)
        job = self.read_job(paths)
        status = job.get("status")
        if status not in FINAL_JOB_STATUSES:
            return {
                "released": False,
                "reason": "job-not-final",
                "job_id": job_id,
                "status": status,
                "removed_files": 0,
                "removed_bytes": 0,
            }

        removed_files = 0
        removed_bytes = 0
        seen: set[Path] = set()
        for pattern in BULKY_JOB_ARTIFACT_PATTERNS:
            for path in paths.root.glob(pattern):
                if path in seen:
                    continue
                seen.add(path)
                size = _remove_path(path)
                if size:
                    removed_files += 1
                    removed_bytes += size

        return {
            "released": True,
            "job_id": job_id,
            "status": status,
            "removed_files": removed_files,
            "removed_bytes": removed_bytes,
        }

    def prune_finished_jobs(
        self,
        *,
        max_bytes: int,
        preserve_job_ids: set[str] | None = None,
        stale_active_seconds: int = DEFAULT_STALE_ACTIVE_JOB_SECONDS,
    ) -> dict[str, Any]:
        preserve_job_ids = preserve_job_ids or set()
        max_bytes = max(0, int(max_bytes))
        stale_active_seconds = max(0, int(stale_active_seconds))
        now = time.time()
        before_bytes = self.jobs_size_bytes()
        transient_cleanup = self.cleanup_transient_job_files(preserve_job_ids=preserve_job_ids)

        candidates: list[tuple[float, Path, int]] = []
        for root in self.jobs_dir.iterdir() if self.jobs_dir.exists() else []:
            if (
                not root.is_dir()
                or root.name in preserve_job_ids
                or not self._is_prunable_job(root, now=now, stale_active_seconds=stale_active_seconds)
            ):
                continue
            candidates.append((self._job_sort_time(root), root, directory_size(root)))
        candidates.sort(key=lambda item: item[0])

        deleted_jobs: list[str] = []
        deleted_bytes = 0
        current_bytes = self.jobs_size_bytes()
        for _, root, size in candidates:
            if current_bytes <= max_bytes:
                break
            removed = _remove_path(root)
            if removed:
                deleted_jobs.append(root.name)
                deleted_bytes += removed
                current_bytes = max(0, current_bytes - removed)
            else:
                current_bytes = max(0, current_bytes - size)

        return {
            "max_bytes": max_bytes,
            "before_bytes": before_bytes,
            "after_bytes": self.jobs_size_bytes(),
            "deleted_jobs": deleted_jobs,
            "deleted_bytes": deleted_bytes,
            "stale_active_seconds": stale_active_seconds,
            "transient_cleanup": transient_cleanup,
        }
