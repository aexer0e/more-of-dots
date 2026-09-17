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
    assert replay.metadata["source_version"] == "1.2.18.3"
    assert replay.metadata["target_game_version"] == "1.4.1"
    assert replay.metadata["move_order_count"] == 2


def test_validate_custom_map_marks_custom_present() -> None:
    payload = valid_payload()
    payload["map"] = "custom"
    payload["custom_map"] = {"cities": []}

    replay = validate_replay(gzipped(payload), max_json_bytes=1_000_000)

    assert replay.metadata["map"] == "custom"
    assert replay.metadata["custom_map_present"] is True


def test_validate_replay_accepts_new_format_without_custom_map_key() -> None:
    payload = valid_payload()
    del payload["custom_map"]
    payload["player_usernames"] = [
        [{"username": "thesavvyy", "title": "Veteran"}],
        [{"username": "aexer0e", "title": "Friend"}],
    ]

    replay = validate_replay(gzipped(payload), max_json_bytes=1_000_000)

    assert replay.metadata["map"] == "6"
    assert replay.metadata["custom_map_present"] is False
    assert replay.metadata["player_usernames"] == payload["player_usernames"]


def test_validate_replay_accepts_new_custom_map_location() -> None:
    payload = valid_payload()
    del payload["custom_map"]
    payload["map"] = {
        "version": None,
        "map_surface": "iVBORw0KGgo=",
        "cities": [],
        "bridges": [],
    }

    replay = validate_replay(gzipped(payload), max_json_bytes=1_000_000)

    assert replay.metadata["map"] == "custom"
    assert replay.metadata["custom_map_present"] is True


def test_validate_replay_derives_missing_end_from_max_tick() -> None:
    payload = valid_payload()
    del payload["end"]

    replay = validate_replay(gzipped(payload), max_json_bytes=1_000_000)

    assert replay.metadata["end"] == 240


def test_rejects_non_gzip_data() -> None:
    with pytest.raises(ReplayValidationError, match="gzip"):
        validate_replay(b"not gzip", max_json_bytes=1_000_000)


def test_rejects_malformed_json() -> None:
    raw = gzip.compress(b"{not-json")

    with pytest.raises(ReplayValidationError, match="valid JSON"):
        validate_replay(raw, max_json_bytes=1_000_000)


def test_rejects_missing_metadata() -> None:
    payload = valid_payload()
    del payload["player_usernames"]

    with pytest.raises(ReplayValidationError, match="missing required keys"):
        validate_replay(gzipped(payload), max_json_bytes=1_000_000)


def test_missing_or_unknown_version_uses_schema_fallback() -> None:
    for source_version in (None, "9.9.9"):
        payload = valid_payload()
        payload["version"] = source_version

        replay = validate_replay(gzipped(payload), max_json_bytes=1_000_000)
        recording_payload = json.loads(gzip.decompress(replay.recording_bytes))

        assert replay.metadata["source_version"] == source_version
        assert replay.metadata["version_inference"] == "compatible-replay-schema"
        assert replay.metadata["target_game_version"] == "1.4.1"
        assert recording_payload["version"] == "1.4.1"


def test_1_2_23_conversion_preserves_orders_and_modern_names() -> None:
    payload = valid_payload()
    payload["version"] = "1.2.23"
    payload["player_usernames"] = [[{"username": "one", "title": "Friend"}], [{"username": "two", "title": None}]]
    payload["180"] = {
        "12": [[100, 200], [120, 220]],
        "production0": {"color": 0, "rate": 0.7, "ratio": 1},
        "message0": [7, [], -1],
    }

    replay = validate_replay(gzipped(payload), max_json_bytes=1_000_000)
    recording_payload = json.loads(gzip.decompress(replay.recording_bytes))

    assert recording_payload["version"] == "1.4.1"
    assert recording_payload["player_usernames"] == payload["player_usernames"]
    assert recording_payload["180"] == payload["180"]
    assert replay.metadata["move_order_count"] == 2
    assert replay.metadata["waypoint_count"] == 3


def test_legacy_player_labels_are_normalized_for_current_game() -> None:
    payload = valid_payload()
    payload["version"] = None
    payload["player_usernames"] = [["one [Friend]"], ["two"]]

    replay = validate_replay(gzipped(payload), max_json_bytes=1_000_000)
    recording_payload = json.loads(gzip.decompress(replay.recording_bytes))

    assert recording_payload["player_usernames"] == [
        [{"username": "one", "title": "Friend"}],
        [{"username": "two", "title": None}],
    ]
    assert replay.metadata["player_schema"] == "legacy-labelled-players"


def test_empty_move_order_set_is_derived_but_malformed_order_fails() -> None:
    payload = valid_payload()
    payload.pop("180")
    payload.pop("240")
    replay = validate_replay(gzipped(payload), max_json_bytes=1_000_000)
    assert replay.metadata["move_order_count"] == 0

    payload["180"] = {"12": "not-a-path"}
    with pytest.raises(ReplayValidationError, match="move order"):
        validate_replay(gzipped(payload), max_json_bytes=1_000_000)


def test_rejects_decompressed_payload_over_limit() -> None:
    payload = valid_payload()
    payload["999"] = {"1": [[1, 2]] * 10_000}

    with pytest.raises(ReplayValidationError, match="exceeds"):
        validate_replay(gzipped(payload), max_json_bytes=100)


def test_classic_replay_gains_mode_without_changing_original() -> None:
    payload = valid_payload()
    original = gzipped(payload)
    replay = validate_replay(original, max_json_bytes=1_000_000)
    assert replay.payload["mode"] == "1v1"
    assert replay.payload["map"] == payload["map"]
    assert json.loads(gzip.decompress(original)) == payload
    assert replay.payload["180"] == payload["180"]


def test_experimental_replay_preserves_motorised_and_production_orders() -> None:
    payload = valid_payload()
    payload.update(mode="experiment", version="1.4.1", map={
        "path": "assets/fahero_maps/map15.png", "infantry": [[], []],
        "tanks": [[], []], "motorised": [[[100, 200]], [[300, 400]]],
    })
    payload["180"]["production0"] = {"color": 0, "ratio": [0.2, 0.3, 0.5]}
    replay = validate_replay(gzipped(payload), max_json_bytes=1_000_000)
    assert replay.payload["mode"] == "experiment"
    assert replay.payload["map"] == payload["map"]
    assert replay.payload["180"] == payload["180"]


def test_old_custom_map_gains_empty_motorised_buckets() -> None:
    payload = valid_payload()
    payload["map"] = {"mode": "v3", "infantry": [[], [], []], "tanks": [[], [], []]}
    payload["player_usernames"] = [["one"], ["two"], ["three"]]
    replay = validate_replay(gzipped(payload), max_json_bytes=1_000_000)
    assert replay.payload["mode"] == "v3"
    assert replay.payload["map"]["motorised"] == [[], [], []]
    assert "motorised" not in payload["map"]
