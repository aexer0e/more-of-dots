from __future__ import annotations

import gzip
import json

import pytest

from wod_replay_server.replay import ReplayValidationError, validate_replay


def gzipped(payload: object) -> bytes:
    return gzip.compress(json.dumps(payload).encode("utf-8"))


def valid_payload() -> dict[str, object]:
    return {
        "map": "6",
        "custom_map": None,
        "player_usernames": [["aexer0e [Friend]"], ["split [Veteran]"]],
        "version": "1.2.18.3",
        "result": 1,
        "end": 25470,
        "180": {"1": [[754, 379], [760, 377]]},
        "240": {"47": [[922, 747]]},
    }


def test_validate_valid_replay_extracts_metadata() -> None:
    raw = gzipped(valid_payload())

    replay = validate_replay(raw, max_json_bytes=1_000_000)

    assert replay.metadata["map"] == "6"
    assert replay.metadata["custom_map_present"] is False
    assert replay.metadata["tick_count"] == 2
    assert replay.metadata["first_tick"] == 180
    assert replay.metadata["max_tick"] == 240


def test_validate_custom_map_marks_custom_present() -> None:
    payload = valid_payload()
    payload["map"] = "custom"
    payload["custom_map"] = {"cities": []}

    replay = validate_replay(gzipped(payload), max_json_bytes=1_000_000)

    assert replay.metadata["map"] == "custom"
    assert replay.metadata["custom_map_present"] is True


def test_rejects_non_gzip_data() -> None:
    with pytest.raises(ReplayValidationError, match="gzip"):
        validate_replay(b"not gzip", max_json_bytes=1_000_000)


def test_rejects_malformed_json() -> None:
    raw = gzip.compress(b"{not-json")

    with pytest.raises(ReplayValidationError, match="valid JSON"):
        validate_replay(raw, max_json_bytes=1_000_000)


def test_rejects_missing_metadata() -> None:
    payload = valid_payload()
    del payload["result"]

    with pytest.raises(ReplayValidationError, match="missing required keys"):
        validate_replay(gzipped(payload), max_json_bytes=1_000_000)


def test_rejects_decompressed_payload_over_limit() -> None:
    payload = valid_payload()
    payload["999"] = {"1": [[1, 2]] * 10_000}

    with pytest.raises(ReplayValidationError, match="exceeds"):
        validate_replay(gzipped(payload), max_json_bytes=100)
