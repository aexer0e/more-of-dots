from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
import gzip
import json
from typing import Any


GZIP_MAGIC = b"\x1f\x8b"
REQUIRED_KEYS = {"map", "player_usernames", "version", "result"}


class ReplayValidationError(ValueError):
    """Raised when uploaded replay bytes are not a supported War of Dots replay."""


@dataclass(frozen=True)
class ReplayDocument:
    payload: dict[str, Any]
    json_text: str
    metadata: dict[str, Any]


def decompress_gzip_limited(raw: bytes, max_json_bytes: int) -> str:
    if not raw.startswith(GZIP_MAGIC):
        raise ReplayValidationError("Replay must be gzip-compressed and start with a gzip header.")

    output = bytearray()
    try:
        with gzip.GzipFile(fileobj=BytesIO(raw)) as gz:
            while True:
                chunk = gz.read(64 * 1024)
                if not chunk:
                    break
                output.extend(chunk)
                if len(output) > max_json_bytes:
                    raise ReplayValidationError(
                        f"Decompressed replay exceeds {max_json_bytes} bytes."
                    )
    except ReplayValidationError:
        raise
    except OSError as exc:
        raise ReplayValidationError(f"Replay is not valid gzip data: {exc}") from exc

    try:
        return output.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ReplayValidationError("Replay JSON must be UTF-8 encoded.") from exc


def _tick_keys(payload: dict[str, Any]) -> list[int]:
    return sorted(int(key) for key in payload if key.isdigit())


def _metadata_map_name(map_value: Any) -> str:
    if isinstance(map_value, dict):
        return "custom"
    return str(map_value)


def _custom_map_present(payload: dict[str, Any]) -> bool:
    map_value = payload.get("map")
    return isinstance(map_value, dict) or payload.get("custom_map") is not None


def validate_replay(raw: bytes, *, max_json_bytes: int) -> ReplayDocument:
    json_text = decompress_gzip_limited(raw, max_json_bytes)

    try:
        payload = json.loads(json_text)
    except json.JSONDecodeError as exc:
        raise ReplayValidationError(f"Replay gzip payload is not valid JSON: {exc}") from exc

    if not isinstance(payload, dict):
        raise ReplayValidationError("Replay JSON must be an object.")

    missing = sorted(REQUIRED_KEYS.difference(payload))
    if missing:
        raise ReplayValidationError(f"Replay JSON is missing required keys: {', '.join(missing)}.")

    tick_keys = _tick_keys(payload)
    end = payload.get("end")
    if end is None and tick_keys:
        end = tick_keys[-1]
    if end is None:
        raise ReplayValidationError("Replay JSON is missing required keys: end.")
    metadata = {
        "map": _metadata_map_name(payload["map"]),
        "custom_map_present": _custom_map_present(payload),
        "player_usernames": payload["player_usernames"],
        "version": payload["version"],
        "result": payload["result"],
        "end": end,
        "tick_count": len(tick_keys),
        "first_tick": tick_keys[0] if tick_keys else None,
        "max_tick": tick_keys[-1] if tick_keys else None,
        "json_bytes": len(json_text.encode("utf-8")),
    }

    return ReplayDocument(payload=payload, json_text=json_text, metadata=metadata)
