from __future__ import annotations

import argparse
import json
from pathlib import Path
import shutil
from typing import Iterable


EXCLUDED_DIR_NAMES = {"replays", "__pycache__"}
EXCLUDED_FILE_NAMES = {"config.txt", "error_log.txt", "out.txt", "err.txt"}
EXCLUDED_SUFFIXES = {".log", ".bak", ".rep", ".pyc", ".pyo"}


def should_copy_path(path: Path, source_root: Path) -> bool:
    relative = path.relative_to(source_root)
    parts_lower = [part.lower() for part in relative.parts]

    if any(part in EXCLUDED_DIR_NAMES for part in parts_lower[:-1]):
        return False

    name_lower = path.name.lower()
    if name_lower in EXCLUDED_FILE_NAMES:
        return False

    return path.suffix.lower() not in EXCLUDED_SUFFIXES


def iter_copyable_files(source_root: Path) -> Iterable[Path]:
    for path in source_root.rglob("*"):
        if path.is_file() and should_copy_path(path, source_root):
            yield path


def _prepare_destination(source_root: Path, destination_root: Path) -> None:
    source_resolved = source_root.resolve()
    destination_resolved = destination_root.resolve()

    if source_resolved == destination_resolved:
        raise ValueError("Destination cannot be the same directory as the Steam game source.")
    if source_resolved.is_relative_to(destination_resolved):
        raise ValueError("Destination cannot be a parent of the Steam game source.")
    if destination_resolved == Path(destination_resolved.anchor):
        raise ValueError("Refusing to stage into a drive root.")

    if destination_root.exists():
        shutil.rmtree(destination_root)
    destination_root.mkdir(parents=True, exist_ok=True)


def stage_game(source_root: Path, destination_root: Path, *, dry_run: bool = False) -> dict[str, int | str]:
    if not source_root.exists():
        raise FileNotFoundError(f"Steam game directory does not exist: {source_root}")
    if not (source_root / "game.exe").exists():
        raise FileNotFoundError(f"Steam game directory does not contain game.exe: {source_root}")

    copied = 0
    skipped = 0
    bytes_copied = 0

    if not dry_run:
        _prepare_destination(source_root, destination_root)

    for path in source_root.rglob("*"):
        if not path.is_file():
            continue

        if not should_copy_path(path, source_root):
            skipped += 1
            continue

        relative = path.relative_to(source_root)
        target = destination_root / relative
        copied += 1
        bytes_copied += path.stat().st_size

        if not dry_run:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)

    return {
        "source": str(source_root),
        "destination": str(destination_root),
        "copied_files": copied,
        "skipped_files": skipped,
        "bytes_copied": bytes_copied,
        "dry_run": str(dry_run).lower(),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Stage War of Dots files without private user data.")
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--destination", required=True, type=Path)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    result = stage_game(args.source, args.destination, dry_run=args.dry_run)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
