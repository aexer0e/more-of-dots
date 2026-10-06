"""Recover missing numbered-map mode layouts from authenticated full captures."""
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil

REPO=Path(__file__).resolve().parents[1]
ROOT=REPO/'build/game-parity'
spec=importlib.util.spec_from_file_location('runner',REPO/'scripts/run-game-parity.py')
runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)
inventory=json.loads((ROOT/'inventory.json').read_text())
plan=json.loads((ROOT/'build-plan.json').read_text())['builds']
catalog_path=REPO/'engine/repsim/maps/deployments.json'
catalog=json.loads(catalog_path.read_text())
imports=[];verified_builds={}
for record in inventory['files']:
    if not record['qualifies']:continue
    source=Path(record['input']);raw=source.read_bytes()
    if hashlib.sha256(raw).hexdigest()!=record['sha256']:raise RuntimeError('Input changed')
    replay=json.loads(gzip.decompress(raw) if raw[:2]==b'\x1f\x8b' else raw)
    number=replay.get('map')
    if isinstance(number,bool) or not isinstance(number,(str,int)) or not str(number).strip().isdigit():continue
    if isinstance(replay.get('custom_map'),dict):continue
    number=str(int(str(number).strip()))
    mode=str(replay.get('mode','')).strip().lower()
    profile=mode if mode in ('experiment','avalanche') else 'classic'
    if profile in catalog.get(number,{}):continue
    build,_=runner.selected_build(record,ROOT,plan)
    case=ROOT/'full'/build/record['sha256']
    receipt=json.loads((case/'receipt.json').read_text())
    if receipt.get('native')!='completed':raise RuntimeError('Missing full native capture')
    directory=ROOT/'versions'/build
    if build not in verified_builds:
        provenance=json.loads((directory/'parity-build.json').read_text())
        if not provenance.get('steam_manifest_verified') or runner.digest(directory/'game.exe')!=provenance['game_exe_sha256']:
            raise RuntimeError('Native build provenance differs')
        verified_builds[build]=provenance
    provenance=verified_builds[build]
    with gzip.open(case/'game.repsim.gz','rt') as stream:metadata=json.loads(next(stream))
    if metadata.get('binary_sha256')!=provenance['game_exe_sha256'] or metadata.get('replay_sha256')!=record['sha256']:
        raise RuntimeError('Native capture input/build provenance differs')
    initial_path=case/'native-initial.json';initial=json.loads(initial_path.read_text())
    candidates=initial['native_map_candidates']
    if candidates.get('scene.map')!=candidates.get('core.map'):raise RuntimeError('Native scene/core map differs')
    native=candidates['scene.map']
    if str(native.get('index'))!=number:raise RuntimeError('Native map index differs')
    layout={k:v for k,v in native.items() if k in ('path','infantry','tanks','motorised','cities','capitals','bridges')}
    relative=layout['path'].replace('\\','/')
    asset=next((f for f in provenance['files'] if f['path'].replace('\\','/').lower()==relative.lower()),None)
    image=(directory/relative).resolve()
    if not image.is_relative_to(directory.resolve()) or not asset or runner.digest(image)!=asset['sha256']:
        raise RuntimeError('Native terrain asset provenance differs')
    destination=REPO/'engine/repsim/maps'/relative
    if destination.exists() and runner.digest(destination)!=asset['sha256']:raise RuntimeError('Bundled image collision')
    destination.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(image,destination)
    catalog.setdefault(number,{})[profile]=layout
    imports.append({'map_id':number,'profile':profile,'input_sha256':record['sha256'],
        'build':build,'manifest_id':provenance['manifest_id'],'native_exe_sha256':provenance['game_exe_sha256'],
        'native_initial_sha256':runner.digest(initial_path),'terrain_sha256':asset['sha256'],
        'layout_sha256':hashlib.sha256(json.dumps(layout,sort_keys=True,separators=(',',':')).encode()).hexdigest()})
catalog_path.write_text(json.dumps(catalog,indent=2)+'\n')
report=ROOT/'research/map-profile-imports.json'
history=json.loads(report.read_text()) if report.exists() else []
report.write_text(json.dumps(history+imports,indent=2))
print(json.dumps({'imported_profiles':imports},indent=2))
