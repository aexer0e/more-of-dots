from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from wod_replay_server.version_vault import (
    SupportedVersionCatalog,
    VersionUnavailable,
    VersionVault,
    normalize_game_version,
)


FAKE_EXE = b"game executable"
FAKE_EXE_SHA256 = hashlib.sha256(FAKE_EXE).hexdigest()


def write_catalog(path: Path, versions: dict | None = None) -> SupportedVersionCatalog:
    path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "app_id": 3902430,
                "windows_depot_id": 3902431,
                "versions": versions
                or {
                    "1.2.18.3": {
                        "manifest_id": "test",
                        "game_exe_sha256": FAKE_EXE_SHA256,
                    }
                },
            }
        ),
        encoding="utf-8",
    )
    return SupportedVersionCatalog(path)


def game_build(path: Path) -> Path:
    path.mkdir()
    (path / "game.exe").write_bytes(FAKE_EXE)
    (path / "assets").mkdir()
    (path / "assets" / "map.png").write_bytes(b"map")
    (path / "replays").mkdir()
    (path / "replays" / "private.rep").write_bytes(b"private")
    (path / "config.txt").write_text("private", encoding="utf-8")
    (path / "strings.txt").write_text("local diagnostic", encoding="utf-8")
    (path / "dev-helper.cmd").write_text("local helper", encoding="utf-8")
    (path / "dlcs").mkdir()
    (path / "dlcs" / "optional.dat").write_bytes(b"optional")
    (path / "map_editor").mkdir()
    (path / "map_editor" / "private-map.png").write_bytes(b"private")
    return path


def test_normalize_game_version_accepts_replay_versions() -> None:
    assert normalize_game_version("1.2.18.3") == "1.2.18.3"
    assert normalize_game_version("v1.3.1") == "1.3.1"
    with pytest.raises(VersionUnavailable):
        normalize_game_version(None)


def test_imported_build_is_immutable_inventory_without_user_data(tmp_path: Path) -> None:
    source = game_build(tmp_path / "source-game")
    vault = VersionVault(tmp_path / "recorder", write_catalog(tmp_path / "catalog.json"))

    imported = vault.import_build("1.2.18.3", source)

    game_dir = Path(imported["path"])
    assert (game_dir / "game.exe").read_bytes() == FAKE_EXE
    assert (game_dir / "assets" / "map.png").is_file()
    assert not (game_dir / "replays").exists()
    assert not (game_dir / "config.txt").exists()
    assert not (game_dir / "strings.txt").exists()
    assert not (game_dir / "dev-helper.cmd").exists()
    assert not (game_dir / "dlcs").exists()
    assert not (game_dir / "map_editor").exists()
    assert imported["source"] == "user-import"
    assert imported["file_count"] == 2
    assert vault.resolve("1.2.18.3")["game_exe_sha256"] == imported["game_exe_sha256"]


def test_verify_reports_changed_bundled_files(tmp_path: Path) -> None:
    source = game_build(tmp_path / "source-game")
    vault = VersionVault(tmp_path / "recorder", write_catalog(tmp_path / "catalog.json"))
    imported = vault.import_build("1.2.18.3", source)
    Path(imported["path"]).joinpath("game.exe").write_bytes(b"changed")

    result = vault.verify("1.2.18.3")

    assert result["ok"] is False
    assert result["changed"] == ["game.exe"]
    with pytest.raises(VersionUnavailable, match="integrity check"):
        vault.resolve("1.2.18.3")


def test_missing_bundled_version_requires_repair(tmp_path: Path) -> None:
    vault = VersionVault(tmp_path / "recorder", write_catalog(tmp_path / "catalog.json"))

    with pytest.raises(VersionUnavailable, match="Repair or reinstall"):
        vault.resolve("1.2.18.3")


def test_unsupported_version_is_rejected(tmp_path: Path) -> None:
    vault = VersionVault(tmp_path / "recorder", write_catalog(tmp_path / "catalog.json"))

    with pytest.raises(VersionUnavailable, match="Supported versions: 1.2.18.3"):
        vault.resolve("1.3.4")


def test_builtin_catalog_bundles_only_the_1_4_1_game_build() -> None:
    catalog = SupportedVersionCatalog()

    assert catalog.versions == ("1.4.1",)
    assert catalog.lookup("1.3.4") is None
    assert catalog.lookup("1.2.23") is None
    assert catalog.lookup("1.4.1").game_exe_sha256 == "ea9225cf73a84ccdcb2f197cfd3f7b4765e5f00c3c1bb54b4fa5bd0b30befce1"
    assert catalog.lookup("1.3.1") is None
    assert catalog.public_summary()["mode"] == "single-build-schema-normalization"
    assert catalog.public_summary()["target_game_version"] == "1.4.1"
    assert catalog.public_summary()["compatible_replay_versions"] == ["1.2.23", "1.3.4", "1.4.1"]


@pytest.mark.parametrize("retired_version", ["1.2.23", "1.3.4"])
def test_retired_bundled_build_is_removed_but_user_import_is_preserved(tmp_path: Path, retired_version: str) -> None:
    vault = VersionVault(tmp_path / "recorder", write_catalog(tmp_path / "catalog.json"))
    retired = vault.versions_dir / retired_version
    retired.mkdir(parents=True)
    (retired / "game").mkdir()
    (retired / "game" / "game.exe").write_bytes(b"old")
    (retired / "version.json").write_text(
        json.dumps({"game_version": retired_version, "source": "bundled"}),
        encoding="utf-8",
    )

    vault.ensure_dirs()

    assert not retired.exists()

    retired.mkdir(parents=True)
    (retired / "version.json").write_text(
        json.dumps({"game_version": retired_version, "source": "user-import"}),
        encoding="utf-8",
    )
    vault.ensure_dirs()
    assert retired.exists()


def test_version_vault_has_no_network_or_steam_downloader_path() -> None:
    source = Path(__file__).resolve().parents[1].joinpath("wod_replay_server", "version_vault.py").read_text(
        encoding="utf-8"
    )

    assert "DepotDownloader" not in source
    assert "subprocess" not in source
    assert "urllib" not in source
    assert "urlopen" not in source
