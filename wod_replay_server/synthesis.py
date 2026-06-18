from __future__ import annotations

import gzip
import json
from pathlib import Path
from typing import Any, Iterator

from .replay import validate_replay

MAX_INLINE_STATS_BYTES = 16 * 1024 * 1024


def _sample_stream_path(stats_path: Path, stats: dict[str, Any]) -> Path:
    summary = stats.get("summary")
    configured = summary.get("sample_stream_path") if isinstance(summary, dict) else None
    if isinstance(configured, str) and configured:
        path = Path(configured)
        if path.exists():
            return path
    return stats_path.with_name(stats_path.name + ".samples.jsonl")


def _load_stats(stats_path: Path) -> dict[str, Any]:
    stream_path = stats_path.with_name(stats_path.name + ".samples.jsonl")
    if stats_path.stat().st_size > MAX_INLINE_STATS_BYTES:
        raise ValueError(
            "Stats metadata is too large to load safely. "
            f"Keep final stats.json metadata-only and store samples in {stream_path}."
        )
    stats = json.loads(stats_path.read_text(encoding="utf-8"))
    if not isinstance(stats, dict):
        raise ValueError("Stats payload must be a JSON object.")
    return stats


def _iter_samples(stats: dict[str, Any], stream_path: Path) -> Iterator[dict[str, Any]]:
    if stream_path.exists():
        with stream_path.open("r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                parsed = json.loads(line)
                if isinstance(parsed, dict):
                    yield parsed
        return

    samples = stats.get("samples")
    if isinstance(samples, list):
        for sample in samples:
            if isinstance(sample, dict):
                yield sample


def _write_text(handle: gzip.GzipFile, text: str) -> None:
    handle.write(text.encode("utf-8"))


def _write_synthesized_payload(
    *,
    source_payload: dict[str, Any],
    stats: dict[str, Any],
    samples: Iterator[dict[str, Any]],
    output_replay_path: Path,
) -> int:
    sample_count = 0
    with output_replay_path.open("wb") as raw_output:
        with gzip.GzipFile(fileobj=raw_output, mode="wb", mtime=0) as gz:
            _write_text(gz, "{")
            first_key = True
            for key, value in source_payload.items():
                if key == "wod_replay_server_simulation":
                    continue
                if not first_key:
                    _write_text(gz, ",")
                first_key = False
                _write_text(
                    gz,
                    json.dumps(str(key), ensure_ascii=False, separators=(",", ":"))
                    + ":"
                    + json.dumps(value, ensure_ascii=False, separators=(",", ":")),
                )

            if not first_key:
                _write_text(gz, ",")
            _write_text(
                gz,
                json.dumps("wod_replay_server_simulation", separators=(",", ":"))
                + ":{"
                + json.dumps("schema_version", separators=(",", ":"))
                + ":1,"
                + json.dumps("source", separators=(",", ":"))
                + ":"
                + json.dumps(stats.get("source", "local-session-memory-capture"), ensure_ascii=False, separators=(",", ":"))
                + ","
                + json.dumps("summary", separators=(",", ":"))
                + ":"
                + json.dumps(stats.get("summary", {}), ensure_ascii=False, separators=(",", ":"))
                + ","
                + json.dumps("samples", separators=(",", ":"))
                + ":[",
            )
            for sample in samples:
                if sample_count:
                    _write_text(gz, ",")
                _write_text(gz, json.dumps(sample, ensure_ascii=False, separators=(",", ":")))
                sample_count += 1
            _write_text(gz, "]}}")
    return sample_count


def synthesize_replay(
    *,
    input_replay_path: Path,
    stats_path: Path,
    output_replay_path: Path,
    max_json_bytes: int,
) -> dict[str, Any]:
    source = validate_replay(input_replay_path.read_bytes(), max_json_bytes=max_json_bytes)
    stats = _load_stats(stats_path)

    stream_path = _sample_stream_path(stats_path, stats)
    sample_count = _write_synthesized_payload(
        source_payload=source.payload,
        stats=stats,
        samples=_iter_samples(stats, stream_path),
        output_replay_path=output_replay_path,
    )

    return {
        "path": str(output_replay_path),
        "bytes": output_replay_path.stat().st_size,
        "sample_count": sample_count,
    }
