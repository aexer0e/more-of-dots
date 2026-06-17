from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
from typing import Any


class AddressProfileError(ValueError):
    """Raised when a memory address profile is missing or malformed."""


class MissingAddressProfile(AddressProfileError):
    """Raised when no profile matches the staged game build."""


@dataclass(frozen=True)
class AddressProfile:
    path: Path
    data: dict[str, Any]
    game_exe_sha256: str
    game_version: str | None

    @property
    def name(self) -> str:
        return self.path.name

    def public_summary(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "path": str(self.path),
            "game_exe_sha256": self.game_exe_sha256,
            "game_version": self.game_version,
            "schema_version": self.data.get("schema_version"),
        }


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _read_profile(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError as exc:
        raise AddressProfileError(f"Address profile is not valid JSON: {path}") from exc
    if not isinstance(data, dict):
        raise AddressProfileError(f"Address profile must be a JSON object: {path}")
    return data


def _validate_profile(path: Path, data: dict[str, Any]) -> AddressProfile:
    if data.get("schema_version") != 1:
        raise AddressProfileError(f"Address profile {path.name} must use schema_version 1.")
    if data.get("enabled") is False:
        raise AddressProfileError(f"Address profile {path.name} is disabled.")

    game_hash = data.get("game_exe_sha256")
    if not isinstance(game_hash, str) or len(game_hash) != 64:
        raise AddressProfileError(f"Address profile {path.name} needs a 64 character game_exe_sha256.")

    memory = data.get("memory")
    if not isinstance(memory, dict):
        raise AddressProfileError(f"Address profile {path.name} needs a memory object.")
    if not isinstance(memory.get("troops"), dict):
        raise AddressProfileError(f"Address profile {path.name} needs memory.troops layout.")

    troops = memory["troops"]
    if not isinstance(troops.get("fields"), dict):
        raise AddressProfileError(f"Address profile {path.name} needs memory.troops.fields.")
    if "base" not in troops or "stride" not in troops:
        raise AddressProfileError(f"Address profile {path.name} needs memory.troops.base and stride.")

    game_version = data.get("game_version")
    return AddressProfile(
        path=path,
        data=data,
        game_exe_sha256=game_hash.lower(),
        game_version=game_version if isinstance(game_version, str) else None,
    )


def load_matching_profile(profile_dir: Path, game_exe: Path) -> AddressProfile:
    if not game_exe.exists():
        raise MissingAddressProfile(f"Staged game executable does not exist: {game_exe}")

    game_hash = sha256_file(game_exe).lower()
    profile_paths = sorted(profile_dir.glob("*.json")) if profile_dir.exists() else []
    errors: list[str] = []

    for path in profile_paths:
        try:
            profile = _validate_profile(path, _read_profile(path))
        except AddressProfileError as exc:
            errors.append(str(exc))
            continue
        if profile.game_exe_sha256 == game_hash:
            return profile

    message = (
        f"No validated address profile matches staged game hash {game_hash}. "
        "Run scripts\\calibrate-memory.ps1 in the logged-in Windows session, then add a completed "
        "profile under runtime\\address-profiles."
    )
    if errors:
        message += f" Ignored profile errors: {'; '.join(errors)}"
    raise MissingAddressProfile(message)


def write_profile_template(destination: Path, *, game_exe_sha256: str, game_version: str | None) -> None:
    template = {
        "schema_version": 1,
        "enabled": False,
        "game_exe_sha256": game_exe_sha256,
        "game_version": game_version,
        "notes": "Fill memory layouts from calibration before enabling.",
        "memory": {
            "tick": {"base_module": "game.exe", "base_offset": "0x0", "offsets": [], "type": "int32"},
            "troops": {
                "base": {"base_module": "game.exe", "base_offset": "0x0", "offsets": []},
                "stride": 0,
                "max_count": 0,
                "fields": {
                    "owner": {"offset": 0, "type": "int32"},
                    "type": {"offset": 0, "type": "int32"},
                    "x": {"offset": 0, "type": "float64"},
                    "y": {"offset": 0, "type": "float64"},
                    "health": {"offset": 0, "type": "float64"},
                    "morale": {"offset": 0, "type": "float64"},
                    "alive": {"offset": 0, "type": "bool"},
                },
            },
        },
    }
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(template, indent=2), encoding="utf-8")
