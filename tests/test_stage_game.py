from __future__ import annotations

from pathlib import Path

from wod_replay_server.stage_game import should_copy_path, stage_game


def test_stage_game_excludes_private_and_runtime_files(tmp_path: Path) -> None:
    source = tmp_path / "source"
    destination = tmp_path / "destination"
    (source / "replays").mkdir(parents=True)
    (source / "assets").mkdir()
    (source / "game.exe").write_bytes(b"exe")
    (source / "config.txt").write_text("secret", encoding="utf-8")
    (source / "error_log.txt").write_text("trace", encoding="utf-8")
    (source / "out.txt").write_text("out", encoding="utf-8")
    (source / "game.exe.bak").write_text("backup", encoding="utf-8")
    (source / "replays" / "replay_1.rep").write_bytes(b"rep")
    (source / "assets" / "logo.png").write_bytes(b"png")

    result = stage_game(source, destination)

    assert result["copied_files"] == 2
    assert (destination / "game.exe").exists()
    assert (destination / "assets" / "logo.png").exists()
    assert not (destination / "config.txt").exists()
    assert not (destination / "error_log.txt").exists()
    assert not (destination / "out.txt").exists()
    assert not (destination / "game.exe.bak").exists()
    assert not (destination / "replays").exists()


def test_should_copy_path_filters_replays_directory(tmp_path: Path) -> None:
    source = tmp_path / "source"
    path = source / "replays" / "sample.rep"
    path.parent.mkdir(parents=True)
    path.write_bytes(b"rep")

    assert should_copy_path(path, source) is False
