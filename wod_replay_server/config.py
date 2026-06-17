from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
import os
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_STEAM_GAME_DIR = Path(r"C:\Program Files (x86)\Steam\steamapps\common\War of Dots")
DEFAULT_LOCAL_RUNNER_SCRIPT = PROJECT_ROOT / "scripts" / "local-runner.ps1"
DEFAULT_GAME_WINDOW_TITLE = "War of Dots"


def _load_env_file(path: Path) -> None:
    if not path.exists():
        return

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def _bool_env(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _path_env(name: str, default: Path) -> Path:
    raw = os.environ.get(name)
    if not raw:
        return default
    return Path(raw).expanduser()


def _int_env(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if not raw:
        return default
    return int(raw)


@dataclass(frozen=True)
class AppSettings:
    project_root: Path
    host: str
    port: int
    runtime_dir: Path
    jobs_dir: Path
    staged_game_dir: Path
    address_profile_dir: Path
    steam_game_dir: Path
    local_runner_script: Path
    game_window_title: str
    game_desktop_strategy: str
    game_window_strategy: str
    capture_source: str
    runner_smoke_required: bool
    max_replay_bytes: int
    max_replay_json_bytes: int
    capture_sample_hz: int
    capture_timeout_seconds: int

    def ensure_runtime_dirs(self) -> None:
        self.runtime_dir.mkdir(parents=True, exist_ok=True)
        self.jobs_dir.mkdir(parents=True, exist_ok=True)
        self.staged_game_dir.mkdir(parents=True, exist_ok=True)
        self.address_profile_dir.mkdir(parents=True, exist_ok=True)


@lru_cache(maxsize=1)
def get_settings() -> AppSettings:
    _load_env_file(PROJECT_ROOT / ".env")

    runtime_dir = _path_env("WOD_RUNTIME_DIR", PROJECT_ROOT / "runtime")
    if not runtime_dir.is_absolute():
        runtime_dir = PROJECT_ROOT / runtime_dir

    address_profile_dir = _path_env("WOD_ADDRESS_PROFILE_DIR", runtime_dir / "address-profiles")
    if not address_profile_dir.is_absolute():
        address_profile_dir = PROJECT_ROOT / address_profile_dir
    local_runner_script = _path_env("WOD_LOCAL_RUNNER_SCRIPT", DEFAULT_LOCAL_RUNNER_SCRIPT)
    if not local_runner_script.is_absolute():
        local_runner_script = PROJECT_ROOT / local_runner_script

    return AppSettings(
        project_root=PROJECT_ROOT,
        host=os.environ.get("WOD_HOST", "127.0.0.1"),
        port=_int_env("WOD_PORT", 8787),
        runtime_dir=runtime_dir,
        jobs_dir=runtime_dir / "jobs",
        staged_game_dir=runtime_dir / "staged-game",
        address_profile_dir=address_profile_dir,
        steam_game_dir=_path_env("WOD_STEAM_GAME_DIR", DEFAULT_STEAM_GAME_DIR),
        local_runner_script=local_runner_script,
        game_window_title=os.environ.get("WOD_GAME_WINDOW_TITLE", DEFAULT_GAME_WINDOW_TITLE),
        game_desktop_strategy=os.environ.get("WOD_GAME_DESKTOP_STRATEGY", "automation-desktop"),
        game_window_strategy=os.environ.get("WOD_GAME_WINDOW_STRATEGY", "offscreen"),
        capture_source=os.environ.get("WOD_CAPTURE_SOURCE", "auto"),
        runner_smoke_required=_bool_env("WOD_RUNNER_SMOKE_REQUIRED", False),
        max_replay_bytes=_int_env("WOD_MAX_REPLAY_BYTES", 20 * 1024 * 1024),
        max_replay_json_bytes=_int_env("WOD_MAX_REPLAY_JSON_BYTES", 100 * 1024 * 1024),
        capture_sample_hz=_int_env("WOD_CAPTURE_SAMPLE_HZ", 10),
        capture_timeout_seconds=_int_env("WOD_CAPTURE_TIMEOUT_SECONDS", 1800),
    )
