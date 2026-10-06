"""Inventory original user replays for the game-versus-player parity audit.

Keep source aliases and byte hashes, and stage immutable copies by content hash.
The cutoff is strictly greater than 300 seconds at 30 simulation ticks/second.
No simulation-completion result counts as parity evidence.
"""
import argparse
import collections
import gzip
import hashlib
import json
from pathlib import Path
import subprocess
import zipfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', action='append', type=Path, required=True)
    parser.add_argument('--archive', action='append', type=Path, default=[])
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    inputs = args.output / 'inputs'
    inputs.mkdir(exist_ok=True)
    records, errors, scanned = {}, [], []

    def add(raw, source):
        digest = hashlib.sha256(raw).hexdigest()
        if digest in records:
            if source not in records[digest]['sources']:
                records[digest]['sources'].append(source)
            return
        try:
            data = json.loads(gzip.decompress(raw) if raw[:2] == b'\x1f\x8b' else raw)
            if not isinstance(data, dict) or 'player_usernames' not in data or 'map' not in data:
                raise ValueError('Not a replay object')
            end = data.get('end', max([int(k) for k in data if k.isdigit()], default=0))
            if isinstance(end, bool) or not isinstance(end, (int, float)) or end < 0:
                raise ValueError(f'Invalid end tick: {end!r}')
            target = inputs / (digest + '.rep')
            if not target.exists():
                target.write_bytes(raw)
            records[digest] = dict(sha256=digest, input=str(target.resolve()), sources=[source],
                bytes=len(raw), version=data.get('version'), mode=data.get('mode'), end=end,
                seconds=end / 30, qualifies=end > 9000,
                map_id=data['map'] if not isinstance(data['map'], dict) else None,
                map_path=data['map'].get('path') if isinstance(data['map'], dict) else None,
                map_embedded=isinstance(data['map'], dict) or isinstance(data.get('custom_map'), dict),
                game_capture='pending', standalone_capture='pending', parity='pending')
        except Exception as error:
            errors.append(dict(source=source, sha256=digest, error=str(error)))

    for root in args.root:
        if not root.exists():
            scanned.append(dict(root=str(root), status='missing'))
            continue
        listing = subprocess.run(['rg', '--files', '--hidden', '--no-ignore', str(root),
                                  '-g', '*.rep', '-g', '!node_modules/**', '-g', '!.git/**'],
                                 capture_output=True, encoding='utf-8', check=False)
        paths = listing.stdout.splitlines()
        scanned.append(dict(root=str(root), files=len(paths), status='scanned'))
        for name in paths:
            path = Path(name)
            add(path.read_bytes(), str(path.resolve()))
        # Earlier development captured the original user's inputs without extensions.
        for path in root.glob('input-*'):
            if path.is_file() and not path.suffix:
                add(path.read_bytes(), str(path.resolve()))
    for path in args.archive:
        if not path.exists():
            continue
        with zipfile.ZipFile(path) as archive:
            entries = [e for e in archive.infolist() if not e.is_dir() and e.filename.lower().endswith('.rep')]
            scanned.append(dict(archive=str(path), files=len(entries), sha256=hashlib.sha256(path.read_bytes()).hexdigest()))
            for entry in entries:
                add(archive.read(entry), f'{path.resolve()}!{entry.filename}')
    files = sorted(records.values(), key=lambda r: (str(r['version']), r['sha256']))
    eligible = [r for r in files if r['qualifies']]
    report = dict(method='Byte-deduplicated original replays; strictly end > 9000 ticks; 30 ticks/second.',
        sources=scanned, total_unique=len(files), qualifying_unique=len(eligible),
        qualifying_source_files=sum(len(r['sources']) for r in eligible),
        versions=dict(collections.Counter(str(r['version']) for r in eligible)),
        modes=dict(collections.Counter(str(r['mode']) for r in eligible)),
        total_replay_hours=sum(r['seconds'] for r in eligible) / 3600,
        errors=errors, files=files)
    (args.output / 'inventory.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({k: v for k, v in report.items() if k not in ('files', 'errors')}, indent=2))
    print(f'Decode errors: {len(errors)}')


if __name__ == '__main__':
    main()
