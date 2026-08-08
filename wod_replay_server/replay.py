from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
import copy
import gzip
import json
import re
from typing import Any


GZIP_MAGIC = b"\x1f\x8b"
TARGET_GAME_VERSION = "1.3.4"
REQUIRED_KEYS = {"map", "player_usernames"}
_LEGACY_PLAYER_LABEL = re.compile(r"^(.*?)\s+\[([^\[\]]+)]$")


class ReplayValidationError(ValueError):
    """Raised when uploaded replay bytes are not a supported War of Dots replay."""


@dataclass(frozen=True)
class ReplayDocument:
    payload: dict[str, Any]
    json_text: str
    metadata: dict[str, Any]
    recording_bytes: bytes


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


def _normalize_player(value: Any) -> tuple[dict[str, Any], bool]:
    if isinstance(value, dict):
        username = value.get("username")
        title = value.get("title")
        if not isinstance(username, str) or not username.strip():
            raise ReplayValidationError("Replay player names could not be derived from player_usernames.")
        if title is not None and not isinstance(title, str):
            raise ReplayValidationError("Replay player titles could not be derived from player_usernames.")
        return {"username": username.strip(), "title": title.strip() if isinstance(title, str) and title.strip() else None}, False
    if isinstance(value, str) and value.strip():
        label = value.strip()
        match = _LEGACY_PLAYER_LABEL.fullmatch(label)
        if match and match.group(1).strip():
            return {"username": match.group(1).strip(), "title": match.group(2).strip() or None}, True
        return {"username": label, "title": None}, True
    raise ReplayValidationError("Replay player names could not be derived from player_usernames.")


def _normalize_player_usernames(value: Any) -> tuple[list[list[dict[str, Any]]], str, int]:
    if not isinstance(value, list) or not value:
        raise ReplayValidationError("Replay player names could not be derived from player_usernames.")
    normalized: list[list[dict[str, Any]]] = []
    used_legacy_names = False
    player_count = 0
    for raw_team in value:
        team = raw_team if isinstance(raw_team, list) else [raw_team]
        normalized_team = []
        for raw_player in team:
            player, legacy = _normalize_player(raw_player)
            normalized_team.append(player)
            used_legacy_names = used_legacy_names or legacy
            player_count += 1
        normalized.append(normalized_team)
    if player_count == 0:
        raise ReplayValidationError("Replay player names could not be derived from player_usernames.")
    schema = "legacy-labelled-players" if used_legacy_names else "modern-structured-players"
    return normalized, schema, player_count


def _derive_move_orders(payload: dict[str, Any]) -> tuple[list[int], int, int]:
    tick_keys = _tick_keys(payload)
    move_order_count = 0
    waypoint_count = 0
    for tick in tick_keys:
        commands = payload.get(str(tick))
        if not isinstance(commands, dict):
            raise ReplayValidationError(f"Replay move orders at tick {tick} are not an object.")
        for command, path in commands.items():
            if not str(command).isdigit():
                # Production, message, and forward-compatible auxiliary commands
                # are preserved verbatim. Movement commands use numeric ids.
                continue
            if not isinstance(path, list):
                raise ReplayValidationError(f"Replay move order {command} at tick {tick} is not a path.")
            for point in path:
                if (
                    not isinstance(point, list)
                    or len(point) != 2
                    or any(not isinstance(coordinate, (int, float)) or isinstance(coordinate, bool) for coordinate in point)
                ):
                    raise ReplayValidationError(
                        f"Replay move order {command} at tick {tick} contains an invalid waypoint."
                    )
            move_order_count += 1
            waypoint_count += len(path)
    return tick_keys, move_order_count, waypoint_count


def _recording_bytes(payload: dict[str, Any]) -> tuple[str, bytes]:
    json_text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return json_text, gzip.compress(json_text.encode("utf-8"), mtime=0)


def validate_replay(raw: bytes, *, max_json_bytes: int) -> ReplayDocument:
    json_text = decompress_gzip_limited(raw, max_json_bytes)

    try:
        source_payload = json.loads(json_text)
    except json.JSONDecodeError as exc:
        raise ReplayValidationError(f"Replay gzip payload is not valid JSON: {exc}") from exc

    if not isinstance(source_payload, dict):
        raise ReplayValidationError("Replay JSON must be an object.")

    missing = sorted(REQUIRED_KEYS.difference(source_payload))
    if missing:
        raise ReplayValidationError(f"Replay JSON is missing required keys: {', '.join(missing)}.")

    payload = copy.deepcopy(source_payload)
    normalized_players, player_schema, player_count = _normalize_player_usernames(payload.get("player_usernames"))
    payload["player_usernames"] = normalized_players
    tick_keys, move_order_count, waypoint_count = _derive_move_orders(payload)
    end = payload.get("end")
    if end is None and tick_keys:
        end = tick_keys[-1]
    if end is None:
        raise ReplayValidationError("Replay JSON is missing required keys: end.")
    if not isinstance(end, (int, float)) or isinstance(end, bool) or end < 0:
        raise ReplayValidationError("Replay end tick is invalid.")
    payload["end"] = end
    payload.setdefault("result", False)
    if payload.get("map") == "custom" and isinstance(payload.get("custom_map"), dict):
        payload["map"] = copy.deepcopy(payload["custom_map"])

    source_version = payload.get("version")
    source_version = source_version.strip() if isinstance(source_version, str) and source_version.strip() else None
    payload["version"] = TARGET_GAME_VERSION
    normalized_json_text, normalized_bytes = _recording_bytes(payload)
    conversion_applied = payload != source_payload
    metadata = {
        "map": _metadata_map_name(payload["map"]),
        "custom_map_present": _custom_map_present(payload),
        "player_usernames": payload["player_usernames"],
        "source_version": source_version,
        "version": TARGET_GAME_VERSION,
        "target_game_version": TARGET_GAME_VERSION,
        "schema_family": "tick-orders-v2",
        "player_schema": player_schema,
        "version_inference": "compatible-replay-schema",
        "conversion_applied": conversion_applied,
        "player_count": player_count,
        "move_order_count": move_order_count,
        "waypoint_count": waypoint_count,
        "result": payload["result"],
        "end": end,
        "tick_count": len(tick_keys),
        "first_tick": tick_keys[0] if tick_keys else None,
        "max_tick": tick_keys[-1] if tick_keys else None,
        "json_bytes": len(json_text.encode("utf-8")),
    }

    return ReplayDocument(
        payload=payload,
        json_text=normalized_json_text if conversion_applied else json_text,
        metadata=metadata,
        recording_bytes=normalized_bytes if conversion_applied else raw,
    )
