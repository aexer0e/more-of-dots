"""Adds every official map in a dump of the game's map table to the deployment catalog.

The game keeps one layout per map, without motorised units: the classic layout.
Experimental matches turn some infantry into motorised units, which the engine
derives from the classic layout, and 2v2 shares the classic layout. So each map
the game ships plays in every mode once its classic layout is in the catalog.

Before adding anything, every map the catalog already has is compared with the
game's layout (converted where the catalog only knows experimental mode), and the
import stops on any disagreement.

  powershell -File dev/parity/dump-game-maps.ps1   (with the game running)
  python dev/parity/import-game-maps.py build/game-maps.json
"""
import argparse
import json
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CATALOG = REPO / 'engine/repsim/maps/deployments.json'
FIELDS = ['bridges', 'capitals', 'cities', 'infantry', 'tanks']


def to_experiment(layout):
    """BuiltInDeployments.TryConvert: every fifth infantry, counted back from the
    last and never the first, becomes motorised, listed last first."""
    result = dict(layout)
    infantry, motorised = [], []
    for side in layout['infantry']:
        converted = lambda at: at >= 1 and (len(side) - 1 - at) % 5 == 0
        infantry.append([unit for at, unit in enumerate(side) if not converted(at)])
        motorised.append([unit for at, unit in enumerate(side) if converted(at)][::-1])
    result['infantry'], result['motorised'] = infantry, motorised
    return result


def comparable(layout):
    motorised = layout.get('motorised') or []
    return {key: layout.get(key, []) for key in FIELDS} | {
        'motorised': motorised if any(motorised) else [],
        'path': str(layout.get('path', '')).replace('\\', '/'),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('dump', type=Path)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    native = json.loads(args.dump.read_text(encoding='utf-8'))['maps']
    catalog = json.loads(CATALOG.read_text(encoding='utf-8'))

    disagreements, checked, added = [], 0, []
    # Replays name official maps by number; the tutorial and default entries are not maps of their own.
    numbered = {number: game_map for number, game_map in native.items() if number.isdigit()}
    for number, game_map in sorted(numbered.items(), key=lambda item: int(item[0])):
        classic = {key: game_map.get(key, []) for key in FIELDS} | {
            'motorised': [[] for _ in game_map['infantry']], 'path': str(game_map['path']).replace('\\', '/')}
        entry = catalog.get(number, {})
        for profile, expected in (('classic', classic), ('experiment', to_experiment(classic))):
            if profile in entry:
                checked += 1
                if comparable(entry[profile]) != comparable(expected):
                    fields = [key for key, value in comparable(expected).items() if comparable(entry[profile]).get(key) != value]
                    disagreements.append(f'map {number} {profile}: {", ".join(fields)}')
        if not {'classic', 'experiment'} & entry.keys():
            catalog.setdefault(number, {})['classic'] = dict(sorted(classic.items()))
            added.append(f'{number} ({len(game_map["infantry"])} colors)')

    print(f'Compared {checked} catalog layouts with the game: {len(disagreements)} disagree')
    for line in disagreements:
        print('  ' + line)
    if disagreements:
        raise SystemExit('Nothing imported: the catalog and the game disagree.')
    print('Added: ' + (', '.join(added) if added else 'nothing'))
    if added and not args.dry_run:
        # Existing entries keep their order, so only the added maps change.
        CATALOG.write_text(json.dumps(catalog, indent=2) + '\n', encoding='utf-8', newline='\n')


if __name__ == '__main__':
    main()
