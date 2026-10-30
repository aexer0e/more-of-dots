"""Compare two engines' playback chunk streams (--format binary) frame by frame.

usage: compare-engine-chunks.py BASELINE CANDIDATE REPLAY... [--game-dir DIR] [--jobs N]

Each stream is decoded as docs/replay-frames.md describes. Unit, death and
contour fields compare exactly; the core JSON compares by value, since engines
may format the same double differently. Chunk boundaries and sound cues must
match too.
"""
import argparse
import json
import os
import struct
import subprocess
import sys
import zlib
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(__file__))
compare_engines = __import__("compare-engines")


class Reader:
    def __init__(self, data):
        self.data, self.at = data, 0

    def take(self, fmt):
        values = struct.unpack_from("<" + fmt, self.data, self.at)
        self.at += struct.calcsize("<" + fmt)
        return values if len(values) > 1 else values[0]

    def bytes(self, n):
        value = self.data[self.at:self.at + n]
        self.at += n
        return value


def frames(raw, count):
    r = Reader(raw)
    for _ in range(count):
        frame = {"frame": r.take("I"), "units": [], "deaths": []}
        for _ in range(r.take("H")):
            unit = list(r.take("HBBBBHHffdffffffffff"))
            length = r.take("H")
            unit.append("same" if length == 0xFFFF else [r.take("ff") for _ in range(length)])
            frame["units"].append(unit)
        for _ in range(r.take("H")):
            frame["deaths"].append(r.take("IBBBff"))
        changes = r.take("B")
        if changes & 1:
            frame["contours"] = [[[r.take("dd") for _ in range(r.take("I"))] for _ in range(r.take("H"))] for _ in range(r.take("B"))]
        if changes & 2:
            frame["core"] = json.loads(r.bytes(r.take("I")).decode())
        yield frame


def stream(engine, replay, game_dirs):
    command = [engine, replay, "--format", "binary", "-o", "-"]
    for directory in game_dirs:
        command += ["--game-dir", directory]
    result = subprocess.run(command, capture_output=True)
    data = result.stdout
    assert data[:8] == b"WODFRM1\n", f"{engine}: {result.stderr.decode(errors='replace')}"
    at, static, chunks = 8, None, []
    while at < len(data):
        kind, length = struct.unpack_from("<BI", data, at)
        payload = data[at + 5:at + 5 + length]
        at += 5 + length
        if kind == 1:
            static = json.loads(payload)
        elif kind == 2:
            count = struct.unpack_from("<I", payload, 1)[0]
            header = struct.unpack_from(f"<{3 * count}I", payload, 5)
            raw = zlib.decompress(payload[5 + 12 * count:], -15)
            chunks.append((header, list(frames(raw, count))))
    return static, chunks, result.returncode


def compare(replay, args):
    a_static, a_chunks, a_code = stream(args.baseline, replay, args.game_dir)
    b_static, b_chunks, b_code = stream(args.candidate, replay, args.game_dir)
    found = compare_engines.difference(compare_engines.normalize_static(a_static), compare_engines.normalize_static(b_static), "static")
    if not found and a_code != b_code:
        found = f"exit codes {a_code} != {b_code}"
    if not found and len(a_chunks) != len(b_chunks):
        found = f"{len(a_chunks)} chunks != {len(b_chunks)}"
    frames_compared = 0
    for (a_header, a_frames), (b_header, b_frames) in zip(a_chunks, b_chunks):
        if found:
            break
        if a_header != b_header:
            found = f"chunk header at frame {a_header[0]} differs"
            break
        for a, b in zip(a_frames, b_frames):
            found = compare_engines.difference(a, b, f"frame {a['frame']}")
            if found:
                break
            frames_compared += 1
    return replay, frames_compared, found


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("baseline")
    parser.add_argument("candidate")
    parser.add_argument("replays", nargs="+")
    parser.add_argument("--game-dir", action="append", default=[])
    parser.add_argument("--jobs", type=int, default=4)
    args = parser.parse_args()
    args.baseline, args.candidate = os.path.abspath(args.baseline), os.path.abspath(args.candidate)
    failed = 0
    with ThreadPoolExecutor(args.jobs) as pool:
        for replay, count, found in pool.map(lambda replay: compare(replay, args), args.replays):
            failed += bool(found)
            print(f"{'DIFF' if found else 'ok  '} {os.path.basename(replay)} frames={count} {found or ''}", flush=True)
    print(f"{len(args.replays) - failed}/{len(args.replays)} identical")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
