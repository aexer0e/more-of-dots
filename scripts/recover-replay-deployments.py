"""Build numbered-map deployments from a replay inventory, without copying player data.

Explicit official-map snapshots supply terrain references and geometry. Classic
infantry ordering is recovered from first movement orders in numbered recordings.
Experimental infantry retain their relative order when some become motorised.
Only a unique ordering satisfying those observations is admitted to the catalog.
Ambiguous/conflicting layouts are reported rather than selected arbitrarily.
"""
import argparse
import collections
import copy
import functools
import gzip
import hashlib
import json
from pathlib import Path
import re


def recover_infantry(infantry, motorised, fixed):
    """Count possible interleavings, capped at two; keep a sole solution."""
    infantry, motorised = tuple(map(tuple, infantry)), tuple(map(tuple, motorised))
    size = len(infantry) + len(motorised)

    @functools.lru_cache(None)
    def solve(position, next_infantry, used_motorised):
        if position == size:
            return 1, ()
        choices = []
        if next_infantry < len(infantry):
            choices.append((infantry[next_infantry], next_infantry + 1, used_motorised))
        choices.extend((point, next_infantry, used_motorised | (1 << index))
                       for index, point in enumerate(motorised) if not used_motorised & (1 << index))
        count, solution = 0, None
        for point, next_index, mask in choices:
            if position in fixed and fixed[position] != point:
                continue
            found, tail = solve(position + 1, next_index, mask)
            if found:
                solution = (point,) + tail if count == 0 else solution
                count += found
                if count >= 2:
                    return 2, ()
        return count, solution or ()

    count, result = solve(0, 0, 0)
    return [list(point) for point in result] if count == 1 else None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args()
    rows = json.loads(args.inventory.read_text(encoding="utf-8"))["files"]
    snapshots = collections.defaultdict(lambda: collections.defaultdict(list))
    numbered = collections.defaultdict(list)
    fields = ("path", "infantry", "tanks", "motorised", "cities", "capitals", "bridges")
    for row in rows:
        data = Path(row["input"]).read_bytes()
        raw = json.loads(gzip.decompress(data) if data[:2] == b"\x1f\x8b" else data)
        source = hashlib.sha256(data).hexdigest()
        mode = (raw.get("mode") or "classic").strip().lower()
        mode = "classic" if mode in ("classic", "1v1", "2v2") else mode
        m = raw.get("map")
        if isinstance(m, (str, int)) and str(m).isdigit():
            numbered[str(int(m))].append((source, mode, raw))
        if not isinstance(m, dict):
            continue
        match = re.fullmatch(r"assets/fahero_maps/map(\d+)\.png", m.get("path", "").replace("\\", "/"))
        if not match or mode not in ("classic", "experiment", "avalanche"):
            continue
        layout = {key: m[key] for key in fields if key in m}
        layout.setdefault("motorised", [[] for _ in layout["infantry"]])
        if not all(key in layout for key in ("infantry", "tanks", "cities", "capitals")):
            continue
        signature = json.dumps(layout, sort_keys=True, separators=(",", ":"))
        snapshots[(match[1], mode)][signature].append(source)

    catalog, evidence = {}, {}
    for (number, mode), variants in sorted(snapshots.items(), key=lambda item: (int(item[0][0]), item[0][1])):
        key = f"{number}/{mode}"
        if len(variants) != 1:
            evidence[key] = {"status": "conflicting saved layouts", "variants": len(variants)}
            continue
        signature, sources = next(iter(variants.items()))
        catalog.setdefault(number, {})[mode] = json.loads(signature)
        evidence[key] = {"status": "saved layout", "sources": sources}

    for number, profiles in catalog.items():
        if "classic" in profiles or "experiment" not in profiles:
            continue
        m = profiles["experiment"]
        infantry_counts = [len(inf) + len(motor) for inf, motor in zip(m["infantry"], m["motorised"])]
        units = [point for side, count in enumerate(infantry_counts)
                 for point in m["infantry"][side] + m["motorised"][side] + m["tanks"][side]]
        points = set(map(tuple, units))
        observed = collections.defaultdict(lambda: collections.defaultdict(set))
        for source, mode, raw in numbered[number]:
            if mode != "classic":
                continue
            seen = set()
            for tick in sorted(int(key) for key in raw if key.isdigit()):
                for key, path in raw[str(tick)].items():
                    if not key.isdigit() or not path:
                        continue
                    unit_id = int(key)
                    if unit_id in seen or unit_id >= len(units):
                        continue
                    seen.add(unit_id)
                    point = tuple(path[0])
                    if point in points:
                        observed[unit_id][point].add(source)
        fixed = {unit_id: next(iter(positions)) for unit_id, positions in observed.items() if len(positions) == 1}
        note = {"observed_ids": len(fixed), "total_units": len(units),
                "sources": sorted({source for positions in observed.values() for sources in positions.values() for source in sources})}
        if any(len(positions) != 1 for positions in observed.values()):
            evidence[f"{number}/classic"] = dict(note, status="conflicting unit IDs")
            continue
        result, offset = [], 0
        for side, count in enumerate(infantry_counts):
            order = recover_infantry(m["infantry"][side], m["motorised"][side],
                                     {index: fixed[offset + index] for index in range(count) if offset + index in fixed})
            tank_order_matches = all(offset + count + index not in fixed or fixed[offset + count + index] == tuple(point)
                                     for index, point in enumerate(m["tanks"][side]))
            if order is None or not tank_order_matches:
                break
            result.append(order)
            offset += count + len(m["tanks"][side])
        if len(result) != len(infantry_counts) or not observed:
            evidence[f"{number}/classic"] = dict(note, status="insufficient ordering evidence")
            continue
        classic = copy.deepcopy(m)
        classic["infantry"], classic["motorised"] = result, [[] for _ in result]
        profiles["classic"] = classic
        evidence[f"{number}/classic"] = dict(note, status="unique recovered ordering")

    args.output.write_text(json.dumps(catalog, indent=2) + "\n", encoding="utf-8")
    args.evidence.write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    print("Maps:", len(catalog), "Profiles:", collections.Counter(mode for profiles in catalog.values() for mode in profiles))
    print("Evidence:", collections.Counter(item["status"] for item in evidence.values()))
    print("Unresolved classic maps:", [key for key, item in evidence.items() if item["status"] not in ("saved layout", "unique recovered ordering")])
    print("Number-only recordings covered:", sum(mode in catalog.get(number, {}) for number, records in numbered.items() for _, mode, _ in records))


if __name__ == "__main__":
    main()
