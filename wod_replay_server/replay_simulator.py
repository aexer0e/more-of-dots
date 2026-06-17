from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .replay import validate_replay


def _tick_keys(payload: dict[str, Any]) -> list[int]:
    return sorted(int(key) for key in payload if key.isdigit())


def _point_from(value: Any) -> dict[str, float] | None:
    if (
        isinstance(value, list)
        and len(value) >= 2
        and isinstance(value[0], (int, float))
        and isinstance(value[1], (int, float))
    ):
        return {"x": float(value[0]), "y": float(value[1])}
    return None


def _troop_sample(unit_id: str, path: Any) -> dict[str, Any]:
    points: list[dict[str, float]] = []
    if isinstance(path, list):
        for item in path:
            point = _point_from(item)
            if point is not None:
                points.append(point)

    latest = points[-1] if points else None
    return {
        "slot": int(unit_id) if unit_id.isdigit() else unit_id,
        "unit_id": unit_id,
        "x": latest["x"] if latest else None,
        "y": latest["y"] if latest else None,
        "health": None,
        "morale": None,
        "alive": bool(points),
        "path": points,
    }


def simulate_replay_file(
    *,
    input_replay_path: Path,
    stats_path: Path,
    max_json_bytes: int,
) -> dict[str, Any]:
    document = validate_replay(input_replay_path.read_bytes(), max_json_bytes=max_json_bytes)
    payload = document.payload
    samples: list[dict[str, Any]] = []
    unit_ids: set[str] = set()
    production_events = 0

    for index, tick in enumerate(_tick_keys(payload)):
        frame = payload[str(tick)]
        troops: list[dict[str, Any]] = []
        events: dict[str, Any] = {}

        if isinstance(frame, dict):
            for key, value in frame.items():
                if key.isdigit():
                    unit_ids.add(key)
                    troops.append(_troop_sample(key, value))
                else:
                    events[key] = value
                    if key.startswith("production"):
                        production_events += 1

        samples.append(
            {
                "sample_index": index,
                "timestamp_ms": tick,
                "tick": tick,
                "troops": troops,
                "events": events,
            }
        )

    stats = {
        "job_id": stats_path.parent.name,
        "game_version": payload.get("version"),
        "game_exe_hash": None,
        "source": "replay-file-derived",
        "replay_metadata": document.metadata,
        "sample_rate_hz": None,
        "samples": samples,
        "summary": {
            "sample_count": len(samples),
            "troop_slots_seen": len(unit_ids),
            "production_event_count": production_events,
            "result": payload.get("result"),
            "end_tick": payload.get("end"),
        },
    }
    stats_path.write_text(json.dumps(stats, indent=2), encoding="utf-8")
    return stats
