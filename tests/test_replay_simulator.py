from __future__ import annotations

import gzip
import json
from pathlib import Path

from wod_replay_server.replay_simulator import simulate_replay_file


def test_simulate_replay_file_writes_tick_samples(tmp_path: Path) -> None:
    payload = {
        "map": "12",
        "custom_map": None,
        "player_usernames": [["one"], ["two"]],
        "version": "1.2.18.3",
        "result": 1,
        "end": 300,
        "180": {"34": [[1058, 481], [1082, 470]], "production0": {"color": 0}},
        "210": {"35": [[1043, 512]]},
    }
    replay_path = tmp_path / "input.rep"
    stats_path = tmp_path / "job" / "stats.json"
    stats_path.parent.mkdir()
    replay_path.write_bytes(gzip.compress(json.dumps(payload).encode("utf-8")))

    stats = simulate_replay_file(
        input_replay_path=replay_path,
        stats_path=stats_path,
        max_json_bytes=1_000_000,
    )

    assert stats["source"] == "replay-file-derived"
    assert stats["summary"]["sample_count"] == 2
    assert stats["summary"]["troop_slots_seen"] == 2
    assert stats["summary"]["production_event_count"] == 1
    assert stats["samples"][0]["tick"] == 180
    assert stats["samples"][0]["troops"][0]["x"] == 1082.0
    assert stats_path.exists()
