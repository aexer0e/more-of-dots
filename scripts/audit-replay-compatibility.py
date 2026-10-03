"""Run a prior replay inventory through every tick, and optionally compare modern outputs.

Inventory format: {"files": [{"input": "...rep", "schema": "...", ...}]}.
Original recordings are never rewritten. This checks completion, not game parity.
"""
import argparse
import collections
import concurrent.futures
import hashlib
import json
from pathlib import Path
import subprocess
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--engine", type=Path, required=True)
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--game-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--numbered-only", action="store_true", help="Audit number-only replays against the deployment catalog")
    args = parser.parse_args()
    inventory = json.loads(args.inventory.read_text(encoding="utf-8"))
    records = [dict(r) for r in inventory["files"] if (r["schema"] == "map ID only") == args.numbered_only]
    output = {"engine_sha256": hashlib.sha256(args.engine.read_bytes()).hexdigest(),
              "method": "Simulate every tick, render state enabled; serialize initial/final frames. Compare modern final states with the previous engine. Completion does not prove historical fidelity.",
              "files": records}
    for record in records:
        record["compatibility_status"] = "pending"

    def invoke(engine, record):
        process = subprocess.run([str(engine.resolve()), record["input"], "--render-state",
                                  "--sample-every", "2147483647", "--game-dir", str(args.game_dir), "-o", "-"],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=900,
                                 creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        rows = [json.loads(line) for line in process.stdout.splitlines() if line]
        return process, rows

    def check(record):
        started = time.monotonic()
        try:
            result, rows = invoke(args.engine, record)
            record.update(compatibility_status="completed" if result.returncode == 0 else "failed",
                          compatibility_error=result.stderr.decode("utf-8", errors="replace").strip())
            if result.returncode == 0:
                state = rows[-1]
                record["final_frame"] = state["frame"]
                record.update(state.get("compatibility", {}))
                record["simulation_profile"] = rows[0]["simulation_profile"]
                if args.baseline and record.get("status") == "simulation completed" and record.get("version") == "1.4.1":
                    previous, old_rows = invoke(args.baseline, record)
                    state.pop("compatibility", None)
                    state["core"]["economy"]["fields"].pop("production_ratio", None)
                    record["matches_previous_final_state"] = previous.returncode == 0 and state == old_rows[-1]
        except Exception as error:
            record.update(compatibility_status="failed", compatibility_error=str(error))
        record["compatibility_seconds"] = round(time.monotonic() - started, 3)
        return record

    def save():
        output["counts"] = dict(collections.Counter(r["compatibility_status"] for r in records))
        args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")

    save()
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [pool.submit(check, r) for r in records]
        for index, future in enumerate(concurrent.futures.as_completed(futures), 1):
            future.result()
            if index % 20 == 0 or index == len(records):
                save()
                print(f"{index}/{len(records)}: {output['counts']}", flush=True)
    print("Audit complete.", flush=True)


if __name__ == "__main__":
    main()
