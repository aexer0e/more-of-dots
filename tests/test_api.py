from __future__ import annotations

from dataclasses import replace
import gzip
import json
from types import SimpleNamespace

from fastapi.testclient import TestClient

from wod_replay_server import app as app_module
from wod_replay_server.address_profiles import MissingAddressProfile


def gzipped_replay() -> bytes:
    payload = {
        "map": "12",
        "custom_map": None,
        "player_usernames": [["one"], ["two"]],
        "version": "1.2.18.3",
        "result": 0,
        "end": 1200,
        "60": {"1": [[1, 2], [3, 4]]},
    }
    return gzip.compress(json.dumps(payload).encode("utf-8"))


def test_healthz() -> None:
    client = TestClient(app_module.app)

    response = client.get("/healthz")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert "steam_game_exists" in response.json()


def test_verify_replay_upload_and_download(monkeypatch) -> None:
    monkeypatch.setattr(
        app_module.replay_runner,
        "smoke_check",
        lambda: {"status": "skipped", "required": False, "message": "test"},
    )
    client = TestClient(app_module.app)
    raw = gzipped_replay()

    response = client.post(
        "/api/replays/verify",
        files={"file": ("replay.rep", raw, "application/octet-stream")},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "verified"
    assert body["metadata"]["map"] == "12"
    assert body["metadata"]["compressed_bytes"] == len(raw)

    job = client.get(body["links"]["job"])
    assert job.status_code == 200
    assert job.json()["job_id"] == body["job_id"]

    replay = client.get(body["links"]["replay"])
    assert replay.status_code == 200
    assert replay.content == raw

    logs = client.get(body["links"]["logs"])
    assert logs.status_code == 200
    assert "Replay gzip and JSON structure validated" in logs.text


def test_invalid_replay_returns_job_detail() -> None:
    client = TestClient(app_module.app)

    response = client.post(
        "/api/replays/verify",
        files={"file": ("bad.rep", b"plain text", "application/octet-stream")},
    )

    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail["status"] == "failed"
    assert "gzip" in detail["error"]


def test_list_jobs_returns_recent_jobs(monkeypatch) -> None:
    monkeypatch.setattr(
        app_module.replay_runner,
        "smoke_check",
        lambda: {"status": "skipped", "required": False, "message": "test"},
    )
    client = TestClient(app_module.app)

    response = client.post(
        "/api/replays/verify",
        files={"file": ("replay.rep", gzipped_replay(), "application/octet-stream")},
    )

    assert response.status_code == 200
    job_id = response.json()["job_id"]
    jobs = client.get("/api/jobs?limit=5")
    assert jobs.status_code == 200
    assert any(job["job_id"] == job_id for job in jobs.json()["jobs"])


def test_debug_tools_inventory_shape() -> None:
    client = TestClient(app_module.app)

    response = client.get("/api/debug-tools")

    assert response.status_code == 200
    tools = response.json()["tools"]
    assert "cheat_engine" in tools
    assert "available" in tools["cheat_engine"]


def test_capture_replay_fails_closed_when_no_game_capture_source(monkeypatch) -> None:
    def missing_profile(*args, **kwargs):
        raise MissingAddressProfile("No validated address profile matches staged game hash abc.")

    monkeypatch.setattr(app_module, "load_matching_profile", missing_profile)
    monkeypatch.setattr(
        app_module.replay_runner,
        "describe",
        lambda: {"game_live_capture_available": False},
    )
    client = TestClient(app_module.app)

    response = client.post(
        "/api/replays/capture",
        files={"file": ("replay.rep", gzipped_replay(), "application/octet-stream")},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "queued"

    job = client.get(body["links"]["job"]).json()
    assert job["status"] == "failed"
    assert "Accurate game-backed capture is unavailable" in job["error"]


def test_capture_replay_uses_game_python_when_profile_missing_and_available(monkeypatch) -> None:
    def missing_profile(*args, **kwargs):
        raise MissingAddressProfile("No validated address profile matches staged game hash abc.")

    monkeypatch.setattr(app_module, "load_matching_profile", missing_profile)
    monkeypatch.setattr(
        app_module.replay_runner,
        "describe",
        lambda: {"game_live_capture_available": True},
    )
    monkeypatch.setattr(
        app_module.replay_runner,
        "capture_live_replay",
        lambda job_id, timeout_seconds: {
            "status": "succeeded",
            "source": "game-live-python",
            "stats": {
                "job_id": job_id,
                "game_version": "1.2.18.3",
                "game_exe_hash": None,
                "source": "game-live-python",
                "replay_metadata": {},
                "sample_rate_hz": None,
                "samples": [
                    {
                        "sample_index": 0,
                        "timestamp_ms": 0,
                        "tick": 1,
                        "troops": [{"slot": 0, "unit_id": "0", "x": 1, "y": 2, "alive": True, "path": []}],
                        "events": {},
                    }
                ],
                "summary": {
                    "sample_count": 1,
                    "troop_slots_seen": 1,
                    "production_event_count": 0,
                    "result": 0,
                    "end_tick": 1200,
                },
            },
        },
    )
    client = TestClient(app_module.app)

    response = client.post(
        "/api/replays/capture",
        files={"file": ("replay.rep", gzipped_replay(), "application/octet-stream")},
    )

    assert response.status_code == 200
    body = response.json()
    job = client.get(body["links"]["job"]).json()
    assert job["status"] == "captured"
    assert job["capture"]["source"] == "game-live-python"
    assert "stats" not in job["capture"]
    assert job["capture"]["stats_summary"]["sample_count"] == 1


def test_capture_replay_forced_memory_fails_when_profile_missing(monkeypatch) -> None:
    def missing_profile(*args, **kwargs):
        raise MissingAddressProfile("No validated address profile matches staged game hash abc.")

    monkeypatch.setattr(app_module, "load_matching_profile", missing_profile)
    monkeypatch.setattr(app_module, "settings", replace(app_module.settings, capture_source="memory"))
    client = TestClient(app_module.app)

    response = client.post(
        "/api/replays/capture",
        files={"file": ("replay.rep", gzipped_replay(), "application/octet-stream")},
    )

    assert response.status_code == 200
    body = response.json()
    job = client.get(body["links"]["job"]).json()
    assert job["status"] == "failed"
    assert "address profile" in job["error"]


def test_capture_replay_writes_and_returns_stats(monkeypatch) -> None:
    profile = SimpleNamespace(
        name="profile.json",
        public_summary=lambda: {
            "name": "profile.json",
            "game_exe_sha256": "a" * 64,
            "game_version": "1.2.20.0",
            "schema_version": 1,
        },
    )

    monkeypatch.setattr(app_module, "load_matching_profile", lambda *args, **kwargs: profile)
    monkeypatch.setattr(app_module, "settings", replace(app_module.settings, capture_source="memory"))
    monkeypatch.setattr(
        app_module.replay_runner,
        "capture_replay",
        lambda job_id, timeout_seconds: {
            "status": "succeeded",
            "source": "memory",
            "stats": {
                "job_id": job_id,
                "game_version": "1.2.20.0",
                "game_exe_hash": "a" * 64,
                "replay_metadata": {},
                "sample_rate_hz": 10,
                "samples": [
                    {
                        "sample_index": 0,
                        "timestamp_ms": 0,
                        "tick": 1,
                        "troops": [{"slot": 0, "unit_id": "0", "x": 1, "y": 2, "alive": True, "path": []}],
                        "events": {},
                    }
                ],
                "summary": {"sample_count": 1, "troop_slots_seen": 1, "result": 0, "end_tick": 1200},
            },
        },
    )
    client = TestClient(app_module.app)

    response = client.post(
        "/api/replays/capture",
        files={"file": ("replay.rep", gzipped_replay(), "application/octet-stream")},
    )

    assert response.status_code == 200
    body = response.json()
    job = client.get(body["links"]["job"]).json()
    assert job["status"] == "captured"
    assert job["address_profile"]["name"] == "profile.json"
    assert "stats" not in job["capture"]
    assert job["capture"]["stats_summary"]["sample_count"] == 1

    stats = client.get(body["links"]["stats"])
    assert stats.status_code == 200
    assert stats.json()["job_id"] == body["job_id"]

    simulated = client.get(body["links"]["simulated_replay"])
    assert simulated.status_code == 200
    simulated_payload = json.loads(gzip.decompress(simulated.content).decode("utf-8"))
    assert simulated_payload["map"] == "12"
    assert simulated_payload["wod_replay_server_simulation"]["summary"]["sample_count"] == 1


def test_stage_game_runtime_endpoint(monkeypatch, tmp_path) -> None:
    source = tmp_path / "steam" / "War of Dots"
    destination = tmp_path / "runtime" / "staged-game"
    (source / "assets").mkdir(parents=True)
    (source / "game.exe").write_bytes(b"exe")
    (source / "assets" / "logo.png").write_bytes(b"png")
    monkeypatch.setattr(
        app_module,
        "settings",
        replace(app_module.settings, steam_game_dir=source, staged_game_dir=destination),
    )
    client = TestClient(app_module.app)

    response = client.post("/api/runtime/stage-game")

    assert response.status_code == 200
    assert response.json()["status"] == "staged"
    assert (destination / "game.exe").exists()
