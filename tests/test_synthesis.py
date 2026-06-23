from __future__ import annotations

import gzip
import json
from pathlib import Path

from wod_replay_server.desktop_cli import _write_metadata_only_stats
from wod_replay_server.storage import JobPaths
from wod_replay_server.synthesis import synthesize_replay


def write_replay(path: Path) -> None:
    path.write_bytes(
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


def test_synthesize_replay_streams_samples_jsonl(tmp_path: Path) -> None:
    replay_path = tmp_path / "input.rep"
    stats_path = tmp_path / "stats.json"
    output_path = tmp_path / "output.rep"
    write_replay(replay_path)
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


def test_metadata_only_stats_moves_embedded_samples_to_stream_for_synthesis(tmp_path: Path) -> None:
    replay_path = tmp_path / "input.rep"
    output_path = tmp_path / "output.rep"
    write_replay(replay_path)

    paths = JobPaths(job_id="abc123", root=tmp_path)
    _write_metadata_only_stats(
        paths,
        {
            "source": "game-live-python",
            "summary": {},
            "samples": [
                {"sample_index": 0, "tick": 30, "troops": [], "events": {}},
                {"sample_index": 1, "tick": 60, "troops": [], "events": {}},
            ],
        },
    )

    stats = json.loads(paths.stats_path.read_text(encoding="utf-8"))
    assert stats["samples"] == []
    assert stats["summary"]["sample_count"] == 2
    assert stats["summary"]["embedded_sample_count"] == 0
    assert paths.stats_path.with_name("stats.json.samples.jsonl").exists()

    result = synthesize_replay(
        input_replay_path=replay_path,
        stats_path=paths.stats_path,
        output_replay_path=output_path,
        max_json_bytes=1_000_000,
    )

    payload = json.loads(gzip.decompress(output_path.read_bytes()).decode("utf-8"))
    assert result["sample_count"] == 2
    assert payload["wod_replay_server_simulation"]["samples"][1]["tick"] == 60
