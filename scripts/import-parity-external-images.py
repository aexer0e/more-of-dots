"""Bundle terrain PNGs referenced by explicit qualifying replay map objects."""
import gzip
import importlib.util
import json
from pathlib import Path
import shutil

REPO=Path(__file__).resolve().parents[1];root=REPO/'build/game-parity'
spec=importlib.util.spec_from_file_location('runner',REPO/'scripts/run-game-parity.py')
runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)
plan=json.loads((root/'build-plan.json').read_text())['builds']
records=json.loads((root/'inventory.json').read_text())['files']
destroot=(REPO/'engine/repsim/maps').resolve();imports={};builds={}
for record in records:
    if not record['qualifies']:continue
    raw=Path(record['input']).read_bytes()
    replay=json.loads(gzip.decompress(raw) if raw[:2]==b'\x1f\x8b' else raw)
    layout=replay.get('custom_map') if isinstance(replay.get('custom_map'),dict) else replay.get('map')
    if not isinstance(layout,dict) or layout.get('map_surface') or not layout.get('path'):continue
    relative=layout['path'].replace('\\','/')
    if not relative.lower().startswith('assets/') or '..' in relative.split('/'):
        raise ValueError(f'External map path needs separate review: {relative}')
    destination=(destroot/relative).resolve()
    if not destination.is_relative_to(destroot):raise ValueError('Map asset escaped bundle directory')
    build,selection=runner.selected_build(record,root,plan)
    if build not in builds:
        directory=root/'versions'/build
        receipt=json.loads((directory/'parity-build.json').read_text())
        if not receipt.get('steam_manifest_verified'):raise ValueError('Native image source is not verified')
        builds[build]=(directory,receipt,{r['path'].replace('\\','/').lower():r for r in receipt['files']})
    directory,receipt,files=builds[build]
    source=directory/relative;entry=files[relative.lower()]
    if runner.digest(source)!=entry['sha256']:raise ValueError(f'Native image changed: {source}')
    if destination.exists() and runner.digest(destination)!=entry['sha256']:
        raise ValueError(f'Historical image collision requires versioned assets: {relative}')
    if relative in imports and imports[relative]['sha256']!=entry['sha256']:
        raise ValueError(f'Replays require different historical images: {relative}')
    item=imports.setdefault(relative,{'path':relative,'sha256':entry['sha256'],'source':str(source),
        'manifest_id':receipt['manifest_id'],'game_build':build,'destination':str(destination),'replays':[]})
    item['replays'].append(record['sha256'])
for item in imports.values():
    destination=Path(item['destination']);destination.parent.mkdir(parents=True,exist_ok=True)
    if not destination.exists():shutil.copyfile(item['source'],destination)
runner.atomic_json(root/'research/external-image-imports.json',list(imports.values()))
print(json.dumps({'verified_external_paths':len(imports),'replays':sum(len(r['replays']) for r in imports.values())}))
