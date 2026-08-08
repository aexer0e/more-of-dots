from __future__ import annotations

from pathlib import Path

import pytest

from wod_replay_server import desktop_cli
from wod_replay_server.recorder_version import RecorderVersionError, recorder_version

ROOT = Path(__file__).resolve().parents[1]


def test_recorder_version_is_a_three_part_version() -> None:
    value = recorder_version()

    parts = value.split(".")
    assert len(parts) == 3
    assert all(part.isdigit() for part in parts)


def test_recorder_version_file_sits_inside_the_package() -> None:
    # PyInstaller resolves it next to the module, so a file that only exists at
    # the repository root would vanish from the packaged recorder.
    assert (ROOT / "wod_replay_server" / "RECORDER_VERSION").is_file()


def test_capabilities_report_the_recorder_version() -> None:
    payload = desktop_cli.command_recorder_capabilities()

    assert payload["version"] == recorder_version()
    assert payload["protocol_versions"] == [1]


def test_recorder_version_rejects_a_malformed_file(tmp_path: Path) -> None:
    from wod_replay_server import recorder_version as module

    broken = tmp_path / "RECORDER_VERSION"
    broken.write_text("nightly", encoding="utf-8")

    with pytest.raises(RecorderVersionError, match="MAJOR.MINOR.PATCH"):
        module._read(broken)


def test_recorder_version_is_independent_of_the_app_version() -> None:
    # The app ships far more often than the recorder. Tying them together would
    # push the full recorder installer for every app patch.
    build_script = (ROOT / "scripts" / "build-recorder.ps1").read_text(encoding="utf-8")

    assert "wod_replay_server\\RECORDER_VERSION" in build_script
    assert "Join-Path $Root 'VERSION'" not in build_script
