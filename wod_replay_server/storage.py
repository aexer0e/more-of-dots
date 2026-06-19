from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, UTC
import json
from pathlib import Path
from typing import Any
from uuid import uuid4


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


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

    def create_job(self, filename: str | None) -> JobPaths:
        job_id = uuid4().hex
        paths = JobPaths(job_id=job_id, root=self.jobs_dir / job_id)
        paths.root.mkdir(parents=True, exist_ok=False)
        self.write_job(
            paths,
            {
                "job_id": job_id,
                "filename": filename,
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
