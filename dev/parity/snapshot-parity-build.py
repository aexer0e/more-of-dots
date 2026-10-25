"""Preserve a completed Steam depot download for native replay comparisons."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--source', type=Path, required=True)
p.add_argument('--vault', type=Path, required=True)
p.add_argument('--label', required=True)
p.add_argument('--manifest', required=True)
p.add_argument('--build', required=True)
a = p.parse_args()
if not (a.source / 'game.exe').is_file():
    p.error('Source has no game.exe')
if '/' in a.label or '\\' in a.label or a.label in ('.', '..'):
    p.error('Label must be one directory name')
destination = a.vault.resolve() / a.label
receipt_path = destination / 'parity-build.json'
if destination.exists():
    if not receipt_path.exists():
        p.error(f'Existing destination lacks a receipt: {destination}')
    receipt = json.loads(receipt_path.read_text())
    if receipt['manifest_id'] != a.manifest:
        p.error('Refusing to replace a different immutable build')
    print(json.dumps(receipt, indent=2))
else:
    shutil.copytree(a.source, destination,
                    ignore=shutil.ignore_patterns('config.txt', 'error_log.txt', 'replays', '.DepotDownloader'))
    files = []
    for path in sorted(destination.rglob('*')):
        if path.is_file():
            files.append(dict(path=path.relative_to(destination).as_posix(), bytes=path.stat().st_size,
                              sha256=hashlib.sha256(path.read_bytes()).hexdigest()))
    receipt = dict(label=a.label, app_id=3902430, depot_id=3902431,
                   manifest_id=a.manifest, build_id=a.build, source=str(a.source),
                   game_exe_sha256=next(f['sha256'] for f in files if f['path']=='game.exe'),
                   file_count=len(files), files=files)
    receipt_path.write_text(json.dumps(receipt, indent=2), encoding='utf-8')
    print(json.dumps({k:v for k,v in receipt.items() if k != 'files'}, indent=2))
