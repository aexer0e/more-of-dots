"""Compare the raw video frames of two engines' --export-video output.

usage: compare-video-frames.py BASELINE CANDIDATE REPLAY [--height H] [--step N]
       [--max-frame N] [--game-dir DIR] [--save DIR]

Prints, per frame, the share of pixels that differ and the largest channel
difference. With --save, writes both versions and a difference image of each
frame as PNG files.
"""
import argparse
import os
import struct
import subprocess
import threading
import time
import zlib


def png(path, width, height, rgb):
    raw = b"".join(b"\x00" + rgb[y * width * 3:(y + 1) * width * 3] for y in range(height))
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
    with open(path, "wb") as handle:
        handle.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
                     + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))


def frames(engine, args, width):
    command = [engine, args.replay, "--export-video", "--width", str(width), "--height", str(args.height),
               "--step", str(args.step), "--layers", args.layers, "--assets", os.path.abspath(args.assets)]
    if args.max_frame is not None:
        command += ["--max-frame", str(args.max_frame)]
    for directory in args.game_dir:
        command += ["--game-dir", directory]
    started = time.perf_counter()
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    errors = []
    threading.Thread(target=lambda: errors.append(process.stderr.read()), daemon=True).start()
    size = width * args.height * 3
    result = []
    while True:
        frame = process.stdout.read(size)
        if len(frame) < size:
            break
        result.append(frame)
    process.wait()
    return result, time.perf_counter() - started, process.returncode, errors


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("baseline")
    parser.add_argument("candidate")
    parser.add_argument("replay")
    parser.add_argument("--height", type=int, default=1080)
    parser.add_argument("--step", type=int, default=30)
    parser.add_argument("--max-frame", type=int)
    parser.add_argument("--layers", default="orders,health,morale,flags,icons,stats,players")
    parser.add_argument("--game-dir", action="append", default=[])
    parser.add_argument("--save")
    parser.add_argument("--assets", default="public/player-assets")
    args = parser.parse_args()
    width = (args.height * 16 // 9 + 1) & ~1
    a, ta, ca, ea = frames(os.path.abspath(args.baseline), args, width)
    b, tb, cb, eb = frames(os.path.abspath(args.candidate), args, width)
    print(f"baseline {len(a)} frames in {ta:.1f}s (exit {ca}), candidate {len(b)} frames in {tb:.1f}s (exit {cb})")
    sound_a = [l for l in ea[0].decode().splitlines() if not l.startswith("progress")]
    sound_b = [l for l in eb[0].decode().splitlines() if not l.startswith("progress")]
    print("stderr cues identical" if sound_a == sound_b else f"stderr cues differ: {len(sound_a)} vs {len(sound_b)} lines")
    if args.save:
        os.makedirs(args.save, exist_ok=True)
    for index, (x, y) in enumerate(zip(a, b)):
        different = sum(1 for i in range(0, len(x), 3) if x[i:i + 3] != y[i:i + 3])
        largest = max((abs(p - q) for p, q in zip(x, y)), default=0)
        print(f"frame {index}: {different / (len(x) // 3):.4%} of pixels differ, largest channel difference {largest}")
        if args.save:
            png(os.path.join(args.save, f"{index:03}-baseline.png"), width, args.height, x)
            png(os.path.join(args.save, f"{index:03}-candidate.png"), width, args.height, y)
            png(os.path.join(args.save, f"{index:03}-difference.png"), width, args.height,
                bytes(min(255, abs(p - q) * 8) for p, q in zip(x, y)))


if __name__ == "__main__":
    main()
