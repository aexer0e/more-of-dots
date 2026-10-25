"""Adds maps the deployment catalog lacks, taking their starting layouts from replays.

Every official map can be played in each mode, and replays that record their map
(experiment-mode replays do) carry its whole layout. The engine converts a classic
layout to experimental and back, so one recorded mode serves both. A map is added
only when at least --min-copies replays record it and every copy agrees.

  python dev/parity/harvest-replay-deployments.py REPLAY_DIR [REPLAY_DIR ...]
"""
import argparse
import collections
import gzip
import json
from pathlib import Path
import re

REPO = Path(__file__).resolve().parents[2]
CATALOG = REPO / 'engine/repsim/maps/deployments.json'
FIELDS = ['bridges', 'capitals', 'cities', 'infantry', 'motorised', 'tanks']
PROFILES = {'experiment': 'experiment', 'avalanche': 'avalanche'}


def recorded_layouts(directories):
    """{(number, profile): Counter of layout JSON} for replays that record an official map."""
    found = collections.defaultdict(collections.Counter)
    for directory in directories:
        for file in Path(directory).iterdir():
            if file.suffix.lower() not in ('.rep', '.json'):
                continue
            try:
                data = file.read_bytes()
                raw = json.loads(gzip.decompress(data) if data[:2] == b'\x1f\x8b' else data)
            except (OSError, ValueError, EOFError):
                continue
            map_value = raw.get('map') if isinstance(raw, dict) else None
            if not isinstance(map_value, dict) or 'map_surface' in map_value or 'infantry' not in map_value:
                continue
            path = str(map_value.get('path', '')).replace('\\', '/').strip()
            match = re.fullmatch(r'assets/[a-z]+_maps/map(\d+)\.png', path)
            if not match:
                continue
            profile = PROFILES.get(str(raw.get('mode', '')).strip().lower(), 'classic')
            layout = {key: map_value.get(key, []) for key in FIELDS} | {'path': path}
            found[(str(int(match.group(1))), profile)][json.dumps(layout, sort_keys=True)] += 1
    return found


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('replay_dirs', nargs='+', type=Path)
    parser.add_argument('--min-copies', type=int, default=2)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    catalog = json.loads(CATALOG.read_text(encoding='utf-8'))
    added = []
    for (number, profile), copies in sorted(recorded_layouts(args.replay_dirs).items(), key=lambda item: (int(item[0][0]), item[0][1])):
        entry = catalog.get(number, {})
        # A map known in classic or experimental mode already serves both.
        if profile in entry or (profile != 'avalanche' and ({'classic', 'experiment'} & entry.keys())):
            continue
        if len(copies) > 1:
            print(f'map {number} {profile}: {len(copies)} different layouts recorded, skipped')
            continue
        (layout, count), = copies.items()
        if count < args.min_copies:
            print(f'map {number} {profile}: only {count} replay records it, skipped')
            continue
        catalog.setdefault(number, {})[profile] = json.loads(layout)
        added.append(f'{number} ({profile}, {count} replays)')
    print('Added: ' + (', '.join(added) if added else 'nothing'))
    if added and not args.dry_run:
        # Existing entries keep their order, so only the added maps change.
        CATALOG.write_text(json.dumps(catalog, indent=2) + '\n', encoding='utf-8', newline='\n')


if __name__ == '__main__':
    main()
