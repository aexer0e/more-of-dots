#!/usr/bin/env python3
"""Add values suffixed with "r" or "b"."""

from __future__ import annotations

import re
import sys


ENTRY_PATTERN = re.compile(r"(?i)(?<!\w)([+-]?\d+)\s*([rb])\b")


def calculate(text: str) -> tuple[int, int]:
    totals = {"r": 0, "b": 0}
    for value, group in ENTRY_PATTERN.findall(text):
        totals[group.lower()] += int(value)
    return totals["r"], totals["b"]


def read_input() -> str:
    if len(sys.argv) > 1:
        return " ".join(sys.argv[1:])

    if not sys.stdin.isatty():
        return sys.stdin.read()

    print('Paste entries such as "196b" or "211r". Press Enter twice to finish:')
    lines: list[str] = []
    while True:
        try:
            line = input()
        except EOFError:
            break
        if not line.strip():
            break
        lines.append(line)
    return "\n".join(lines)


def main() -> int:
    text = read_input()
    matches = ENTRY_PATTERN.findall(text)
    if not matches:
        print("No values ending in r or b were found.", file=sys.stderr)
        return 1

    r_total, b_total = calculate(text)
    print(f"B total: {b_total:,}")
    print(f"R total: {r_total:,}")
    print(f"Combined: {b_total + r_total:,}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
