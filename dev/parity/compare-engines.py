"""Compare two replay engines record by record with zero tolerance.

usage: compare-engines.py BASELINE CANDIDATE REPLAY... [--max-frame N] [--game-dir DIR]
       [--replay-dir DIR] [--no-render-state] [--sample-every N] [--jobs N] [--summary FILE]

Both engines run with JSONL output on stdout and are read in lockstep, so nothing
large is written to disk. Numbers compare by value: 0.7 and 0.69999999999999996
are the same double. The rendered map PNG compares by its decoded rows, and player
labels by their text, since the encoders and font rasterizers may differ.
"""
import argparse
import base64
import json
import os
import struct
import subprocess
import sys
import time
import zlib
from concurrent.futures import ThreadPoolExecutor


def png_rows(encoded):
    data = base64.b64decode(encoded)
    offset, idat, header = 8, b"", None
    while offset + 8 <= len(data):
        length = struct.unpack(">I", data[offset:offset + 4])[0]
        kind = data[offset + 4:offset + 8]
        body = data[offset + 8:offset + 8 + length]
        if kind == b"IHDR":
            header = body
        elif kind == b"IDAT":
            idat += body
        offset += 12 + length
    return header, zlib.decompress(idat)


def normalize_static(record):
    record = dict(record)
    if "rendered_map_surface" in record:
        record["rendered_map_surface"] = png_rows(record["rendered_map_surface"])
    if "player_labels" in record:
        record["player_labels"] = [[label.get("text") for label in team] for team in record["player_labels"]]
    return record


def difference(a, b, path="$"):
    if isinstance(a, dict) and isinstance(b, dict):
        for key in a.keys() | b.keys():
            if key not in a or key not in b:
                return f"{path}.{key}: present only in {'baseline' if key in a else 'candidate'}"
            found = difference(a[key], b[key], f"{path}.{key}")
            if found:
                return found
        return None
    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            return f"{path}: length {len(a)} != {len(b)}"
        for i, (x, y) in enumerate(zip(a, b)):
            found = difference(x, y, f"{path}[{i}]")
            if found:
                return found
        return None
    if isinstance(a, bool) or isinstance(b, bool):
        return None if a is b else f"{path}: {a!r} != {b!r}"
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return None if a == b or (a != a and b != b) else f"{path}: {a!r} != {b!r}"
    return None if a == b else f"{path}: {a!r} != {b!r}"


def start(engine, replay, args):
    command = [engine, replay, "-o", "-"]
    if args.render_state:
        command.append("--render-state")
    if args.max_frame is not None:
        command += ["--max-frame", str(args.max_frame)]
    if args.sample_every != 1:
        command += ["--sample-every", str(args.sample_every)]
    for directory in args.game_dir:
        command += ["--game-dir", directory]
    for directory in args.replay_dir:
        command += ["--replay-dir", directory]
    return subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=1 << 20)


def compare(replay, args):
    started = time.perf_counter()
    baseline, candidate = start(args.baseline, replay, args), start(args.candidate, replay, args)
    frames, verdict = 0, None
    try:
        for index in range(1 << 62):
            left, right = baseline.stdout.readline(), candidate.stdout.readline()
            if not left and not right:
                break
            if not left or not right:
                verdict = f"record {index}: output ends early in {'baseline' if not left else 'candidate'}"
                break
            a, b = json.loads(left), json.loads(right)
            if index == 0:
                a, b = normalize_static(a), normalize_static(b)
            found = difference(a, b)
            if found:
                frame = a.get("frame", "static")
                verdict = f"frame {frame}: {found}"
                break
            frames += 1
    finally:
        for process in (baseline, candidate):
            process.stdout.close()
            if verdict:
                process.kill()
        errors = [process.stderr.read().decode(errors="replace").strip() for process in (baseline, candidate)]
        codes = [process.wait() for process in (baseline, candidate)]
    if not verdict and codes[0] != codes[1]:
        verdict = f"exit codes {codes[0]} != {codes[1]}: {errors}"
    if not verdict and codes[0] != 0 and errors[0] != errors[1]:
        verdict = f"errors differ: {errors}"
    return {"replay": replay, "records": frames, "ok": verdict is None, "difference": verdict,
            "exit": codes, "error": errors[0] if codes[0] else None, "seconds": round(time.perf_counter() - started, 2)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("baseline")
    parser.add_argument("candidate")
    parser.add_argument("replays", nargs="+")
    parser.add_argument("--max-frame", type=int)
    parser.add_argument("--sample-every", type=int, default=1)
    parser.add_argument("--game-dir", action="append", default=[])
    parser.add_argument("--replay-dir", action="append", default=[])
    parser.add_argument("--no-render-state", dest="render_state", action="store_false")
    parser.add_argument("--jobs", type=int, default=max(1, (os.cpu_count() or 2) // 4))
    parser.add_argument("--summary")
    args = parser.parse_args()
    args.baseline, args.candidate = os.path.abspath(args.baseline), os.path.abspath(args.candidate)
    replays = []
    for path in args.replays:
        if os.path.isdir(path):
            replays += sorted(os.path.join(path, name) for name in os.listdir(path) if name.lower().endswith((".rep", ".json")))
        else:
            replays.append(path)
    results, failed = [], 0
    with ThreadPoolExecutor(args.jobs) as pool:
        for result in pool.map(lambda replay: compare(replay, args), replays):
            results.append(result)
            failed += not result["ok"]
            status = "ok  " if result["ok"] else "DIFF"
            note = result["difference"] or (f"both failed: {result['error']}" if result["error"] else "")
            print(f"{status} {os.path.basename(result['replay'])} records={result['records']} {result['seconds']}s {note}", flush=True)
    print(f"{len(results) - failed}/{len(results)} identical")
    if args.summary:
        with open(args.summary, "w", encoding="utf-8") as handle:
            json.dump(results, handle, indent=1)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
