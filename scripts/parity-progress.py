"""Summarize the entire replay scope independently of any narrower batch."""
import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path

REPO=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--root',type=Path,default=REPO/'build/game-parity')
p.add_argument('--engine',type=Path)
p.add_argument('--write',action='store_true')
a=p.parse_args()
inventory=json.loads((a.root/'inventory.json').read_text(encoding='utf-8'))
expected={row['sha256'] for row in inventory['files'] if row['qualifies']}
fingerprint=None
if a.engine:
    spec=importlib.util.spec_from_file_location('parity_runner',REPO/'scripts/run-game-parity.py')
    runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)
    fingerprint=runner.engine_fingerprint(a.engine.resolve())
receipts=[]
unreadable=[]
for path in sorted((a.root/'full').glob('*/*/receipt.json')):
    try:
        record=json.loads(path.read_text(encoding='utf-8'))
    except (OSError,json.JSONDecodeError):
        unreadable.append(str(path));continue
    if record.get('diagnostic_only') or record.get('sha256') not in expected:continue
    receipts.append(record)
native={r['sha256'] for r in receipts if r.get('native')=='completed' and r.get('end')==r.get('recorded_end')}
matched={r['sha256'] for r in receipts if r.get('parity')=='matched'}
current=[r for r in receipts if fingerprint and r.get('engine_sha256')==fingerprint]
current_matched={r['sha256'] for r in current if r.get('parity')=='matched'}
bundled_matched={r['sha256'] for r in current if r.get('parity')=='matched' and r.get('asset_mode')=='bundled'}
player_matched={r['sha256'] for r in current if r.get('parity')=='matched' and r.get('asset_mode')=='bundled' and r.get('output_profile')=='player-render-state'}
by_build=defaultdict(Counter)
for r in receipts:
    by_build[r['game_build']][r.get('parity','pending')]+=1
result={
    'updated_utc':datetime.now(timezone.utc).isoformat(),
    'qualifying_unique':len(expected),'full_native_completed':len(native),
    'full_parity_verified_any_engine':len(matched),
    'full_comparison_counts':dict(Counter(r.get('parity','pending') for r in receipts)),
    'current_engine_path':str(a.engine.resolve()) if a.engine else None,
    'current_engine_sha256':fingerprint,
    'current_engine_comparison_counts':dict(Counter(r.get('parity','pending') for r in current)),
    'current_engine_verified':len(current_matched),
    'current_engine_bundled_verified':len(bundled_matched),
    'current_engine_player_verified':len(player_matched),
    'by_build':{k:dict(v) for k,v in by_build.items()},
    'unreadable_receipts':unreadable,
    'scope_complete':len(player_matched)==len(expected) and len(native)==len(expected),
}
if a.write:
    path=a.root/'progress.json'
    previous=json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
    previous.update(result)
    previous['comparisons_completed']=len(matched)
    previous['phase']='full native capture and full standalone comparison'
    previous.pop('comparison_dispatcher_pid',None)
    previous.pop('comparison_exec_session',None)
    path.write_text(json.dumps(previous,indent=2),encoding='utf-8')
print(json.dumps(result,indent=2))
