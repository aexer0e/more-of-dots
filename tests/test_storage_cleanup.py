from __future__ import annotations

import os
from pathlib import Path
import time

from wod_replay_server.storage import JobStore, directory_size


def write_bytes(path: Path, size: int) -> None:
    path.write_bytes(b"x" * size)


def make_job(store: JobStore, status: str, size: int, mtime: int):
    paths = store.create_job(f"{status}.rep")
    store.update_job(paths, status=status)
    write_bytes(paths.root / "payload.bin", size)
    os.utime(paths.job_json_path, (mtime, mtime))
    return paths


def test_prune_finished_jobs_deletes_oldest_until_under_cap(tmp_path: Path) -> None:
    store = JobStore(tmp_path / "jobs")
    oldest = make_job(store, "captured", 4096, 10)
    middle = make_job(store, "failed", 4096, 20)
    newest = make_job(store, "captured", 4096, 30)
    cap = directory_size(newest.root) + 256

    result = store.prune_finished_jobs(max_bytes=cap)

    assert not oldest.root.exists()
    assert not middle.root.exists()
    assert newest.root.exists()
    assert result["after_bytes"] <= cap
    assert result["deleted_jobs"] == [oldest.job_id, middle.job_id]


def test_prune_finished_jobs_keeps_active_jobs_even_over_cap(tmp_path: Path) -> None:
    store = JobStore(tmp_path / "jobs")
    now = int(time.time())
    active = make_job(store, "running_hidden_game_capture", 4096, now)
    complete = make_job(store, "captured", 4096, now - 10)

    result = store.prune_finished_jobs(max_bytes=1)

    assert active.root.exists()
    assert not complete.root.exists()
    assert result["after_bytes"] == directory_size(active.root)


def test_prune_finished_jobs_removes_stale_active_jobs(tmp_path: Path) -> None:
    store = JobStore(tmp_path / "jobs")
    stale = make_job(store, "running_hidden_game_capture", 4096, 10)

    result = store.prune_finished_jobs(max_bytes=1, stale_active_seconds=1)

    assert not stale.root.exists()
    assert result["after_bytes"] == 0


def test_list_jobs_returns_newest_bounded_jobs(tmp_path: Path) -> None:
    store = JobStore(tmp_path / "jobs")
    for index in range(8):
        make_job(store, "captured", 16, 10 + index)

    jobs = store.list_jobs(limit=3)

    assert len(jobs) == 3
    assert [job["filename"] for job in jobs] == ["captured.rep", "captured.rep", "captured.rep"]
    assert [Path(store.jobs_dir / job["job_id"] / "job.json").stat().st_mtime for job in jobs] == [17, 16, 15]


def test_release_job_artifacts_removes_bulky_files_only_for_final_jobs(tmp_path: Path) -> None:
    store = JobStore(tmp_path / "jobs")
    final = make_job(store, "captured", 16, 10)
    active = make_job(store, "running_hidden_game_capture", 16, 20)
    for root in (final.root, active.root):
        write_bytes(root / "stats.json.samples.jsonl", 128)
        write_bytes(root / "live-capture-artifact.json.progress.jsonl", 128)
        (root / "game-runtime").mkdir()
        write_bytes(root / "game-runtime" / "game.exe", 128)
        (root / "probe").mkdir()
        write_bytes(root / "probe" / "wod_python_probe_payload.py", 128)
        write_bytes(root / "stats.json", 32)
        write_bytes(root / "simulated.rep", 32)

    release = store.release_job_artifacts(final.job_id)
    skipped = store.release_job_artifacts(active.job_id)

    assert release["released"] is True
    assert not (final.root / "stats.json.samples.jsonl").exists()
    assert not (final.root / "live-capture-artifact.json.progress.jsonl").exists()
    assert not (final.root / "game-runtime").exists()
    assert not (final.root / "probe").exists()
    assert (final.root / "stats.json").exists()
    assert (final.root / "simulated.rep").exists()
    assert skipped["released"] is False
    assert (active.root / "stats.json.samples.jsonl").exists()
    assert (active.root / "game-runtime").exists()
    assert (active.root / "probe").exists()
