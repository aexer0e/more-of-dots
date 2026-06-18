from __future__ import annotations

import gzip
import json
from pathlib import Path

from wod_replay_server.synthesis import synthesize_replay


def test_synthesize_replay_streams_samples_jsonl(tmp_path: Path) -> None:
    replay_path = tmp_path / "input.rep"
    stats_path = tmp_path / "stats.json"
    output_path = tmp_path / "output.rep"
    replay_path.write_bytes(
        gzip.compress(
            json.dumps(
                {
                    "map": "12",
                    "custom_map": None,
                    "player_usernames": [["one"], ["two"]],
                    "version": "1.2.18.3",
                    "result": 1,
                    "end": 120,
                }
            ).encode("utf-8")
        )
    )
    stats_path.write_text(
        json.dumps(
            {
                "source": "game-live-python",
                "summary": {"sample_count": 2},
                "samples": [],
            }
        ),
        encoding="utf-8",
    )
    stats_path.with_name("stats.json.samples.jsonl").write_text(
        "\n".join(
            [
                json.dumps({"sample_index": 0, "tick": 30, "troops": [], "events": {}}),
                json.dumps({"sample_index": 1, "tick": 60, "troops": [], "events": {}}),
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    result = synthesize_replay(
        input_replay_path=replay_path,
        stats_path=stats_path,
        output_replay_path=output_path,
        max_json_bytes=1_000_000,
    )

    payload = json.loads(gzip.decompress(output_path.read_bytes()).decode("utf-8"))
    simulation = payload["wod_replay_server_simulation"]
    assert result["sample_count"] == 2
    assert simulation["source"] == "game-live-python"
    assert simulation["samples"][1]["tick"] == 60
