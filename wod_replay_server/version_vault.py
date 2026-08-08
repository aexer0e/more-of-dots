from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
from typing import Any

from .stage_game import stage_game


APP_ID = 3902430
WINDOWS_DEPOT_ID = 3902431
VAULT_SCHEMA_VERSION = 1
CATALOG_SCHEMA_VERSION = 1
BUILTIN_CATALOG_SHA256 = "05928ccd8804c03cc3a6f3aa989ba823f338297bebf9a1a8b934f3f96f318549"
TARGET_GAME_VERSION = "1.3.4"
KNOWN_COMPATIBLE_REPLAY_VERSIONS = ("1.2.23", "1.3.4")
RETIRED_BUNDLED_GAME_VERSIONS = ("1.2.23",)
_VERSION_PATTERN = re.compile(r"^[0-9]+(?:\.[0-9]+){1,3}$")


class VersionVaultError(RuntimeError):
    """Raised when a replay-compatible bundled game build cannot be prepared safely."""


class VersionUnavailable(VersionVaultError):
    """Raised when the recorder does not contain a build matching a replay version."""


def normalize_game_version(value: object) -> str:
    if not isinstance(value, str):
        raise VersionUnavailable("This replay does not identify its game version.")
    version = value.strip()
    if version.lower().startswith("v"):
        version = version[1:].strip()
    if not _VERSION_PATTERN.fullmatch(version):
        raise VersionUnavailable(f"Replay game version {value!r} is not a supported numeric version.")
    return version


def default_recorder_home() -> Path:
    configured = os.environ.get("WOD_RECORDER_HOME")
    if configured:
        return Path(configured).expanduser().resolve()
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        return Path(local_app_data) / "More of Dots Recorder"
    return Path.home() / "AppData" / "Local" / "More of Dots Recorder"


def _utc_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _inventory(game_dir: Path) -> tuple[list[dict[str, Any]], int]:
    files: list[dict[str, Any]] = []
    total_bytes = 0
    for path in sorted((item for item in game_dir.rglob("*") if item.is_file()), key=lambda item: str(item).lower()):
        relative = path.relative_to(game_dir).as_posix()
        size = path.stat().st_size
        files.append({"path": relative, "size": size, "sha256": _sha256(path)})
        total_bytes += size
    return files, total_bytes


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True), encoding="utf-8")
    temporary.replace(path)


@dataclass(frozen=True)
class SupportedBuild:
    version: str
    app_id: int
    depot_id: int
    manifest_id: str
    game_exe_sha256: str
    release_version: str | None = None
    build_id: str | None = None


class SupportedVersionCatalog:
    def __init__(self, path: Path | None = None):
        is_builtin = path is None
        path = path or Path(__file__).with_name("supported_versions.json")
        self.path = path
        try:
            contents = path.read_bytes()
            value = json.loads(contents)
            canonical = json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
            if is_builtin and hashlib.sha256(canonical).hexdigest() != BUILTIN_CATALOG_SHA256:
                raise VersionVaultError(f"Built-in supported-version catalog integrity check failed: {path}")
        except (OSError, json.JSONDecodeError) as exc:
            raise VersionVaultError(f"Could not read supported-version catalog {path}: {exc}") from exc
        self._validate_value(value, str(path))
        self._value = value

    @staticmethod
    def _validate_value(value: Any, source: str) -> None:
        if not isinstance(value, dict) or value.get("schema_version") != CATALOG_SCHEMA_VERSION:
            raise VersionVaultError(
                f"Supported-version catalog {source} must use schema_version {CATALOG_SCHEMA_VERSION}."
            )
        if int(value.get("app_id", 0)) != APP_ID or int(value.get("windows_depot_id", 0)) != WINDOWS_DEPOT_ID:
            raise VersionVaultError(f"Supported-version catalog {source} targets the wrong game app or depot.")
        versions = value.get("versions")
        if not isinstance(versions, dict) or not versions:
            raise VersionVaultError(f"Supported-version catalog {source} has no versions map.")
        for version, raw in versions.items():
            if not isinstance(version, str) or not _VERSION_PATTERN.fullmatch(version) or not isinstance(raw, dict):
                raise VersionVaultError(f"Supported-version catalog {source} contains an invalid version entry.")
            exe_hash = str(raw.get("game_exe_sha256", "")).lower()
            if not re.fullmatch(r"[0-9a-f]{64}", exe_hash):
                raise VersionVaultError(f"Supported-version entry {version} needs a valid game.exe SHA-256 hash.")

    @property
    def versions(self) -> tuple[str, ...]:
        return tuple(sorted(self._value["versions"]))

    def lookup(self, version: str) -> SupportedBuild | None:
        raw = self._value["versions"].get(version)
        if not isinstance(raw, dict):
            return None
        return SupportedBuild(
            version=version,
            app_id=int(raw.get("app_id", self._value["app_id"])),
            depot_id=int(raw.get("depot_id", self._value["windows_depot_id"])),
            manifest_id=str(raw.get("manifest_id", "")),
            release_version=str(raw["release_version"]) if raw.get("release_version") is not None else None,
            build_id=str(raw["build_id"]) if raw.get("build_id") is not None else None,
            game_exe_sha256=str(raw["game_exe_sha256"]).lower(),
        )

    def public_summary(self) -> dict[str, Any]:
        return {
            "schema_version": CATALOG_SCHEMA_VERSION,
            "mode": "single-build-schema-normalization",
            "app_id": int(self._value["app_id"]),
            "windows_depot_id": int(self._value["windows_depot_id"]),
            "versions": list(self.versions),
            "target_game_version": TARGET_GAME_VERSION,
            "compatible_replay_versions": list(KNOWN_COMPATIBLE_REPLAY_VERSIONS),
        }


class VersionVault:
    def __init__(self, home: Path | None = None, catalog: SupportedVersionCatalog | None = None):
        self.home = (home or default_recorder_home()).expanduser().resolve()
        self.versions_dir = self.home / "versions"
        self.catalog = catalog or SupportedVersionCatalog()

    def ensure_dirs(self) -> None:
        self.versions_dir.mkdir(parents=True, exist_ok=True)
        self._prune_retired_bundled_versions()

    @staticmethod
    def _is_reparse_point(path: Path) -> bool:
        is_junction = getattr(os.path, "isjunction", lambda _path: False)
        return path.is_symlink() or bool(is_junction(path))

    def _prune_retired_bundled_versions(self) -> None:
        versions_root = self.versions_dir.resolve()
        for version in RETIRED_BUNDLED_GAME_VERSIONS:
            root = self.versions_dir / version
            if not root.exists() or root.parent.resolve() != versions_root or self._is_reparse_point(root):
                continue
            try:
                metadata = json.loads((root / "version.json").read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if metadata.get("game_version") != version or metadata.get("source") != "bundled":
                continue
            contains_reparse_point = False
            for directory, child_dirs, files in os.walk(root, topdown=True, followlinks=False):
                for name in [*child_dirs, *files]:
                    if self._is_reparse_point(Path(directory) / name):
                        contains_reparse_point = True
                        break
                if contains_reparse_point:
                    break
            if contains_reparse_point:
                continue
            try:
                shutil.rmtree(root)
            except OSError:
                # A running legacy capture may still hold a file. Leave the
                # retired build intact and try again during the next startup.
                continue

    def version_root(self, version: str) -> Path:
        return self.versions_dir / normalize_game_version(version)

    def game_dir(self, version: str) -> Path:
        return self.version_root(version) / "game"

    def metadata_path(self, version: str) -> Path:
        return self.version_root(version) / "version.json"

    def _require_supported(self, version: object) -> tuple[str, SupportedBuild]:
        normalized = normalize_game_version(version)
        build = self.catalog.lookup(normalized)
        if build is None:
            supported = ", ".join(self.catalog.versions)
            raise VersionUnavailable(
                f"Replay version {normalized} is not supported by this recorder. Supported versions: {supported}."
            )
        return normalized, build

    def read_metadata(self, version: str) -> dict[str, Any] | None:
        version = normalize_game_version(version)
        path = self.metadata_path(version)
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        if value.get("schema_version") != VAULT_SCHEMA_VERSION or value.get("game_version") != version:
            return None
        game_dir = self.game_dir(version)
        if not (game_dir / "game.exe").is_file():
            return None
        value["path"] = str(game_dir)
        value["metadata_path"] = str(path)
        return value

    def list_versions(self) -> list[dict[str, Any]]:
        self.ensure_dirs()
        records = []
        for version in self.catalog.versions:
            metadata = self.read_metadata(version)
            if metadata:
                records.append(metadata)
        return records

    def import_build(
        self,
        version: object,
        source_dir: Path,
        *,
        source: str = "user-import",
        supported_build: SupportedBuild | None = None,
    ) -> dict[str, Any]:
        version, catalog_build = self._require_supported(version)
        build = supported_build or catalog_build
        source_dir = source_dir.expanduser().resolve()
        if not (source_dir / "game.exe").is_file():
            raise VersionVaultError(f"Game build does not contain game.exe: {source_dir}")
        self.ensure_dirs()
        final_root = self.version_root(version)
        if final_root.exists():
            existing = self.read_metadata(version)
            if existing:
                return existing
            raise VersionVaultError(f"Version vault entry is incomplete and must be removed before repair: {final_root}")

        temporary_root = Path(tempfile.mkdtemp(prefix=f".{version}-", dir=self.versions_dir))
        try:
            game_dir = temporary_root / "game"
            stage_game(source_dir, game_dir)
            inventory, total_bytes = _inventory(game_dir)
            exe_hash = _sha256(game_dir / "game.exe")
            if exe_hash != build.game_exe_sha256:
                raise VersionVaultError(f"game.exe does not match the trusted bundled build for {version}.")
            metadata: dict[str, Any] = {
                "schema_version": VAULT_SCHEMA_VERSION,
                "game_version": version,
                "source": source,
                "imported_at": _utc_timestamp(),
                "last_verified_at": _utc_timestamp(),
                "app_id": build.app_id,
                "depot_id": build.depot_id,
                "manifest_id": build.manifest_id,
                "release_version": build.release_version,
                "build_id": build.build_id,
                "game_exe_sha256": exe_hash,
                "file_count": len(inventory),
                "total_bytes": total_bytes,
                "files": inventory,
            }
            _write_json(temporary_root / "version.json", metadata)
            temporary_root.replace(final_root)
        except Exception:
            shutil.rmtree(temporary_root, ignore_errors=True)
            raise
        result = self.read_metadata(version)
        if result is None:
            raise VersionVaultError(f"Bundled build {version} could not be reopened from the version vault.")
        return result

    def verify(self, version: object) -> dict[str, Any]:
        version, _ = self._require_supported(version)
        metadata = self.read_metadata(version)
        if metadata is None:
            raise VersionUnavailable(f"Bundled game version {version} is missing. Repair or reinstall the recorder.")
        game_dir = self.game_dir(version)
        missing: list[str] = []
        changed: list[str] = []
        expected_files = metadata.get("files", [])
        for record in expected_files:
            relative = record.get("path")
            if not isinstance(relative, str):
                continue
            path = game_dir / Path(relative)
            if not path.is_file():
                missing.append(relative)
                continue
            if path.stat().st_size != record.get("size") or _sha256(path) != record.get("sha256"):
                changed.append(relative)
        expected_names = {record.get("path") for record in expected_files if isinstance(record, dict)}
        extra = [
            path.relative_to(game_dir).as_posix()
            for path in game_dir.rglob("*")
            if path.is_file() and path.relative_to(game_dir).as_posix() not in expected_names
        ]
        ok = not missing and not changed and not extra
        if ok:
            persisted = dict(metadata)
            persisted.pop("path", None)
            persisted.pop("metadata_path", None)
            persisted["last_verified_at"] = _utc_timestamp()
            _write_json(self.metadata_path(version), persisted)
            metadata = self.read_metadata(version) or metadata
        return {"ok": ok, "version": metadata, "missing": missing, "changed": changed, "extra": extra}

    def resolve(self, version: object) -> dict[str, Any]:
        version, build = self._require_supported(version)
        metadata = self.read_metadata(version)
        if metadata is None:
            raise VersionUnavailable(f"Bundled game version {version} is missing. Repair or reinstall the recorder.")
        executable = self.game_dir(version) / "game.exe"
        recorded_hash = metadata.get("game_exe_sha256")
        actual_hash = _sha256(executable)
        if recorded_hash != build.game_exe_sha256 or actual_hash != build.game_exe_sha256:
            raise VersionUnavailable(
                f"Bundled game version {version} failed its game.exe integrity check. Repair or reinstall the recorder."
            )
        return metadata
