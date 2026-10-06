"""Import only required missing layouts/images from a verified native catalog."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import shutil

REPO=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--root',type=Path,default=REPO/'build/game-parity')
p.add_argument('--catalog',type=Path,required=True)
p.add_argument('--build-label',required=True)
p.add_argument('--include-existing-images',action='store_true',help='Preserve existing layouts but add their canonical bundled asset paths')
a=p.parse_args()
game=(a.root/'versions'/a.build_label).resolve()
build=json.loads((game/'parity-build.json').read_text())
native=json.loads(a.catalog.read_text())
if not build.get('steam_manifest_verified') or native['binary_sha256']!=build['game_exe_sha256']:
    raise RuntimeError('Native map catalog is not bound to this verified build')
files={row['path'].replace('\\','/').lower():row for row in build['files']}
inventory=json.loads((a.root/'inventory.json').read_text())
needed=set()
for row in inventory['files']:
    if not row['qualifies']:continue
    data=Path(row['input']).read_bytes()
    replay=json.loads(gzip.decompress(data) if data[:2]==b'\x1f\x8b' else data)
    value=replay.get('map')
    if isinstance(value,(str,int)) and str(value).strip().isdigit() and not isinstance(replay.get('custom_map'),dict):
        needed.add(str(int(str(value).strip())))
path=REPO/'engine/repsim/maps/deployments.json'
catalog=json.loads(path.read_text())
imports=[]
for number in sorted(needed,key=int):
    layout_added='classic' not in catalog.get(number,{})
    if (not layout_added and not a.include_existing_images) or number not in native['maps']:continue
    layout={k:v for k,v in native['maps'][number].items()
            if k in ['path','infantry','tanks','motorised','cities','capitals','bridges']}
    relative=layout['path'].replace('\\','/')
    file=files.get(relative.lower())
    if file is None:raise RuntimeError(f'Native map {number} image is absent from the build receipt')
    source=(game/relative).resolve()
    if not source.is_relative_to(game):raise RuntimeError('Native map image escaped its build directory')
    image_hash=hashlib.sha256(source.read_bytes()).hexdigest()
    if image_hash!=file['sha256']:raise RuntimeError(f'Native map {number} image changed after verification')
    destination=REPO/'engine/repsim/maps'/relative
    if destination.exists() and hashlib.sha256(destination.read_bytes()).hexdigest()!=image_hash:
        raise RuntimeError(f'Bundled map image collision for {number}; preserve/version it before importing')
    imports.append({'number':number,'layout':layout,'layout_added':layout_added,'source':source,'destination':destination,'image_sha256':image_hash})
for item in imports:
    item['destination'].parent.mkdir(parents=True,exist_ok=True)
    shutil.copyfile(item['source'],item['destination'])
    if item['layout_added']:catalog.setdefault(item['number'],{})['classic']=item['layout']
path.write_text(json.dumps(catalog,indent=2)+'\n')
report_path=a.root/'research/catalog-imports.json'
report=json.loads(report_path.read_text()) if report_path.exists() else []
report.extend({'map_id':item['number'],'build_label':a.build_label,'manifest_id':build['manifest_id'],
    'native_exe_sha256':native['binary_sha256'],'catalog_sha256':hashlib.sha256(a.catalog.read_bytes()).hexdigest(),
    'layout_added':item['layout_added'],
    'layout_sha256':hashlib.sha256(json.dumps(item['layout'],sort_keys=True,separators=(',',':')).encode()).hexdigest(),
    'image_sha256':item['image_sha256'],'source_image':str(item['source']),'bundled_image':str(item['destination'])} for item in imports)
report_path.write_text(json.dumps(report,indent=2))
print(json.dumps({'imported':[item['number'] for item in imports],
    'still_missing':[number for number in sorted(needed,key=int) if 'classic' not in catalog.get(number,{})]}))
