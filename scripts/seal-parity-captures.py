"""Recover complete native references after a dispatcher exits mid-capture.

Only a successful native completion marker, exact input/build provenance and a
full structural/tick validation can seal a reference. This never verifies the
standalone engine or marks parity matched.
"""
import argparse
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path

REPO=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--root',type=Path,default=REPO/'build/game-parity')
p.add_argument('--write',action='store_true')
p.add_argument('--capture-script-sha',help='Supply only when the exact generation script hash is known')
a=p.parse_args()
spec=importlib.util.spec_from_file_location('strict_parity',REPO/'scripts/compare-parity-traces.py')
strict=importlib.util.module_from_spec(spec);spec.loader.exec_module(strict)
inventory=json.loads((a.root/'inventory.json').read_text())
rows={r['sha256']:r for r in inventory['files'] if r['qualifies']}
recovered=[]
for case in sorted((a.root/'full').glob('*/*')):
    if not case.is_dir() or case.name not in rows:continue
    native=case/'game.repsim.gz';status_path=case/'native-status.json';receipt_path=case/'receipt.json'
    if not native.exists() or not status_path.exists():continue
    try:
        status=json.loads(status_path.read_text())
        previous=json.loads(receipt_path.read_text()) if receipt_path.exists() else {}
    except json.JSONDecodeError:
        continue
    if previous.get('native')=='completed':continue
    row=rows[case.name];end=int(row['end'])
    if not status.get('ok') or status.get('frames')!=end+1 or status.get('end')!=end:continue
    build=json.loads((a.root/'versions'/case.parent.name/'parity-build.json').read_text())
    if not build.get('steam_manifest_verified'):raise RuntimeError('Build is not manifest verified')
    with gzip.open(native,'rt',encoding='utf-8') as stream:
        metadata=json.loads(next(stream))
    source_hash=hashlib.sha256(Path(row['input']).read_bytes()).hexdigest()
    if source_hash!=case.name or metadata.get('replay_sha256')!=source_hash or metadata.get('binary_sha256')!=build['game_exe_sha256']:
        raise RuntimeError(f'Native provenance mismatch in {case}')
    validation=strict.compare(native,native,end)
    if not validation['passed']:raise RuntimeError(f'Native tick/state validation failed in {case}')
    with native.open('rb') as stream:
        trace_hash=hashlib.file_digest(stream,'sha256').hexdigest()
    record=previous|{
        'sha256':case.name,'source':row['input'],'end':end,'recorded_end':end,
        'diagnostic_only':False,'game_build':case.parent.name,'manifest_id':build['manifest_id'],
        'game_exe_sha256':build['game_exe_sha256'],'native':'completed','native_sha256':trace_hash,
        'capture_script_sha256':previous.get('capture_script_sha256') or a.capture_script_sha,
        'parity':'pending','seconds':None,
        'native_seal_verification':'Successful native completion; authenticated input/executable; every tick and native state structurally validated; standalone comparison still required',
    }
    if a.write:receipt_path.write_text(json.dumps(record,indent=2))
    recovered.append({'build':case.parent.name,'sha256':case.name,'frames':end+1})
print(json.dumps({'write':a.write,'recovered':recovered},indent=2))
