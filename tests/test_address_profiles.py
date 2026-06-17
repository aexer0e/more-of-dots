from __future__ import annotations

import json
from pathlib import Path

import pytest

from wod_replay_server.address_profiles import (
    MissingAddressProfile,
    load_matching_profile,
    sha256_file,
)


def profile_for(game_hash: str) -> dict[str, object]:
    return {
        "schema_version": 1,
        "enabled": True,
        "game_exe_sha256": game_hash,
        "game_version": "1.2.20.0",
        "memory": {
            "troops": {
                "base": {"base_module": "game.exe", "base_offset": "0x100", "offsets": []},
                "stride": 64,
                "max_count": 1,
                "fields": {
                    "x": {"offset": 0, "type": "float64"},
                    "y": {"offset": 8, "type": "float64"},
                    "health": {"offset": 16, "type": "float64"},
                    "morale": {"offset": 24, "type": "float64"},
                    "owner": {"offset": 32, "type": "int32"},
                    "type": {"offset": 36, "type": "int32"},
                    "alive": {"offset": 40, "type": "bool"},
                },
            }
        },
    }


def test_load_matching_profile_by_game_hash(tmp_path: Path) -> None:
    game = tmp_path / "game.exe"
    game.write_bytes(b"fake game")
    game_hash = sha256_file(game)
    profile_path = tmp_path / "profiles" / "profile.json"
    profile_path.parent.mkdir()
    profile_path.write_text(json.dumps(profile_for(game_hash)), encoding="utf-8")

    profile = load_matching_profile(profile_path.parent, game)

    assert profile.game_exe_sha256 == game_hash
    assert profile.game_version == "1.2.20.0"
    assert profile.name == "profile.json"


def test_load_matching_profile_accepts_utf8_bom(tmp_path: Path) -> None:
    game = tmp_path / "game.exe"
    game.write_bytes(b"fake game")
    game_hash = sha256_file(game)
    profile_path = tmp_path / "profiles" / "profile.json"
    profile_path.parent.mkdir()
    profile_path.write_text(json.dumps(profile_for(game_hash)), encoding="utf-8-sig")

    profile = load_matching_profile(profile_path.parent, game)

    assert profile.game_exe_sha256 == game_hash


def test_missing_profile_includes_calibration_hint(tmp_path: Path) -> None:
    game = tmp_path / "game.exe"
    game.write_bytes(b"fake game")

    with pytest.raises(MissingAddressProfile, match="calibrate-memory"):
        load_matching_profile(tmp_path / "profiles", game)
