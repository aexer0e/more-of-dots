from __future__ import annotations

from io import BytesIO
import gzip
import json
from pathlib import Path
from typing import Any

from .replay import validate_replay


def _gzip_json(payload: dict[str, Any]) -> bytes:
    raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    output = BytesIO()
    with gzip.GzipFile(fileobj=output, mode="wb", mtime=0) as gz:
        gz.write(raw)
    return output.getvalue()


def synthesize_replay(
    *,
    input_replay_path: Path,
    stats_path: Path,
    output_replay_path: Path,
    max_json_bytes: int,
) -> dict[str, Any]:
    source = validate_replay(input_replay_path.read_bytes(), max_json_bytes=max_json_bytes)
    stats = json.loads(stats_path.read_text(encoding="utf-8"))
    if not isinstance(stats, dict):
        raise ValueError("Stats payload must be a JSON object.")

    payload = dict(source.payload)
    payload["wod_replay_server_simulation"] = {
        "schema_version": 1,
        "source": stats.get("source", "local-session-memory-capture"),
        "summary": stats.get("summary", {}),
        "samples": stats.get("samples", []),
    }

    output_replay_path.write_bytes(_gzip_json(payload))
    return {
        "path": str(output_replay_path),
        "bytes": output_replay_path.stat().st_size,
        "sample_count": len(payload["wod_replay_server_simulation"]["samples"]),
    }
