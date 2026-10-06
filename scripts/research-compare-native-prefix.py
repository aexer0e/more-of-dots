"""Prove a diagnostic wrapper leaves a native prefix unchanged.

This only validates instrumentation; it is never a full-scope receipt.
"""
import argparse
import gzip
import json
from pathlib import Path
import subprocess
import sys

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('diagnostic', type=Path)
p.add_argument('reference', type=Path)
p.add_argument('--end', type=int, required=True)
p.add_argument('--output', type=Path, required=True)
a = p.parse_args()
prefix = a.output.with_name('reference-prefix.repsim.gz')
with gzip.open(a.reference, 'rt', encoding='utf-8') as source, gzip.open(prefix, 'wt', encoding='utf-8') as target:
    for line in source:
        row = json.loads(line)
        if row.get('kind') == 'state' and row['frame'] > a.end:
            break
        target.write(line)
subprocess.run([sys.executable, str(Path(__file__).with_name('compare-parity-traces.py')),
    str(a.diagnostic), str(prefix), '--end', str(a.end), '--output', str(a.output)], check=True)
