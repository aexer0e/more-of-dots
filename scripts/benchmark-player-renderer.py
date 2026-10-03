"""Compare an archived PNG renderer with the integrated raw-pixel renderer.

Inputs are draw commands saved by the development player's --qa-performance
hook. Neither renderer loads a game executable. Run outside release packaging.
"""
import argparse
import base64
import io
import json
from pathlib import Path
import statistics
import subprocess
import time


def render(executable, request, transport, count):
    child = subprocess.Popen(
        [str(executable.resolve()), "--render-worker"],
        cwd=executable.resolve().parent, stdin=subprocess.PIPE,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    def send(command):
        child.stdin.write(json.dumps(command, ensure_ascii=False).encode() + b"\n")
        child.stdin.flush()
        line = child.stdout.readline()
        if not line:
            raise RuntimeError("Renderer stopped: " + child.stderr.read().decode(errors="replace"))
        response = json.loads(line)
        if not response.get("ok"):
            raise RuntimeError(response)
        return response
    try:
        for texture in request["textures"]:
            send(texture)
        command = {key: value for key, value in request.items() if key != "textures"}
        command["record"] = False
        command["transport"] = transport
        times, pixels = [], None
        for index in range(count + 3):
            started = time.perf_counter()
            response = send(command)
            if transport == "rgb":
                pixels = child.stdout.read(response["bytes"])
                if len(pixels) != response["bytes"]:
                    raise RuntimeError("Truncated RGB frame")
            else:
                from PIL import Image
                pixels = Image.open(io.BytesIO(base64.b64decode(response["png"]))).convert("RGB").tobytes()
            if index >= 3:
                times.append((time.perf_counter() - started) * 1000)
        ordered = sorted(times)
        return {"frames": count, "median_ms": statistics.median(times),
                "p95_ms": ordered[min(len(ordered) - 1, int(len(ordered) * .95))],
                "mean_ms": statistics.mean(times)}, pixels
    finally:
        child.kill()
        child.wait()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("report", type=Path)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--current", type=Path, required=True)
    parser.add_argument("--frames", type=int, default=30)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    request = json.loads(args.report.read_text(encoding="utf-8"))["drawRequest"]
    old, old_pixels = render(args.baseline, request, "png", args.frames)
    new, new_pixels = render(args.current, request, "rgb", args.frames)
    if len(old_pixels) != len(new_pixels):
        raise RuntimeError("Frame dimensions differ")
    result = {"size": [request["width"], request["height"]], "baseline_png": old,
              "integrated_rgb": new, "speedup": old["mean_ms"] / new["mean_ms"],
              "changed_pixels": sum(old_pixels[i:i+3] != new_pixels[i:i+3] for i in range(0, len(old_pixels), 3))}
    args.output.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
