from __future__ import annotations

import os
from pathlib import Path
import sys


def main() -> None:
    args = sys.argv[1:]
    if "--runtime-dir" in args:
        index = args.index("--runtime-dir")
        if index + 1 < len(args):
            os.environ["WOD_RUNTIME_DIR"] = str(Path(args[index + 1]).expanduser().resolve())

    from wod_replay_server.desktop_cli import run

    raise SystemExit(run(args))


if __name__ == "__main__":
    main()
