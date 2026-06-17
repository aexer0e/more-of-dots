from __future__ import annotations

import argparse
import os
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description="War of Dots replay API sidecar.")
    parser.add_argument("--desktop-command", default=None)
    parser.add_argument("--host", default=os.environ.get("WOD_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("WOD_PORT", "8787")))
    parser.add_argument("--runtime-dir", type=Path, default=None)
    args, unknown = parser.parse_known_args()

    if args.runtime_dir is not None:
        os.environ["WOD_RUNTIME_DIR"] = str(args.runtime_dir.expanduser().resolve())

    if args.desktop_command:
        from wod_replay_server.desktop_cli import run

        raise SystemExit(run(["--desktop-command", args.desktop_command, *unknown]))

    import uvicorn

    os.environ.setdefault("WOD_HOST", args.host)
    os.environ.setdefault("WOD_PORT", str(args.port))
    uvicorn.run("wod_replay_server.app:app", host=args.host, port=args.port, reload=False)


if __name__ == "__main__":
    main()
