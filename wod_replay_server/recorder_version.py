"""Version of the recorder package.

Deliberately independent of the desktop app's ``VERSION``. The app ships far more
often than the recorder payload does, and the recorder installer carries a large
bundled game vault, so tying the two together would push a full re-download for
every app patch that left the recorder untouched.
"""

from __future__ import annotations

import re
from pathlib import Path

VERSION_PATTERN = re.compile(r"^[0-9]+(?:\.[0-9]+){2}$")


class RecorderVersionError(RuntimeError):
    """Raised when the packaged recorder version is missing or malformed."""


def _read(path: Path) -> str:
    try:
        value = path.read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise RecorderVersionError(f"Could not read recorder version file {path}: {exc}") from exc
    if not VERSION_PATTERN.fullmatch(value):
        raise RecorderVersionError(f"Recorder version file {path} must contain a MAJOR.MINOR.PATCH version.")
    return value


def recorder_version() -> str:
    """Return the packaged recorder version.

    Resolves next to this module so a source checkout and a PyInstaller bundle
    both find the same file; the build copies it into the bundled package.
    """

    return _read(Path(__file__).with_name("RECORDER_VERSION"))
