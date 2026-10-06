"""Audit every qualifying replay and ambiguous-build candidate before completion.

Quick mode checks receipts and coverage declarations for progress only. A full
audit binds each exact comparison to current input, build, engine and trace bytes.
"""
import argparse
import base64
from collections import Counter
import gzip
import importlib.util
import json
from pathlib import Path

REPO=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('parity_runner',REPO/'scripts/run-game-parity.py')
runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)


def first_record(path):
    with gzip.open(path,'rt',encoding='utf-8-sig') as stream:
        return json.loads(next(stream))


def native_version_matches(metadata,inspection,expected_version,expected_binary):
    label=metadata.get('native_version')
    if label is not None:return label==expected_version
    # Newer compiled builds no longer export main.version. Do not invent a
    # label or treat its absence as a different build: require an authenticated
    # inspection of this exact loaded binary confirming that export is absent.
    return (inspection.get('ok') is True
        and inspection.get('binary_sha256')==expected_binary==metadata.get('binary_sha256')
        and 'version' not in inspection.get('main_names',['version']))


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root',type=Path,default=REPO/'build/game-parity')
    p.add_argument('--engine',type=Path,required=True)
    p.add_argument('--quick',action='store_true')
    p.add_argument('--output',type=Path)
    a=p.parse_args();root=a.root.resolve();engine=a.engine.resolve()
    fingerprint=runner.engine_fingerprint(engine)
    inventory=json.loads((root/'inventory.json').read_text())
    rows=[r for r in inventory['files'] if r['qualifies']]
    plan=json.loads((root/'build-plan.json').read_text())['builds']
    builds={};frozen={};results=[];candidate_results=[]

    def audit_case(record,build,case):
        errors=[]
        def check(condition,message):
            if not condition:errors.append(message)
        try:
            receipt=json.loads((case/'receipt.json').read_text())
            proof_path=case/'comparison.json'
            proof=json.loads(proof_path.read_text())
            if build not in builds:
                directory=root/'versions'/build
                value=json.loads((directory/'parity-build.json').read_text())
                builds[build]=(value,runner.digest(directory/'game.exe')==value['game_exe_sha256'])
            native_build,unchanged=builds[build]
            check(native_build.get('steam_manifest_verified'),'Native build is not Steam-manifest verified')
            check(unchanged,'Preserved native executable changed')
            check(receipt.get('sha256')==record['sha256'],'Replay identity differs')
            check(receipt.get('game_build')==build,'Selected build differs')
            check(receipt.get('game_exe_sha256')==native_build['game_exe_sha256'],'Native executable provenance differs')
            check(str(receipt.get('manifest_id'))==str(native_build['manifest_id']),'Steam manifest differs')
            check(receipt.get('native')=='completed' and receipt.get('standalone')=='completed','Both outputs are not complete')
            check(receipt.get('end')==record['end']==receipt.get('recorded_end'),'Trace is not full length')
            check(not receipt.get('diagnostic_only'),'Diagnostic trace cannot complete the scope')
            check(receipt.get('engine_sha256')==fingerprint,'Output uses another engine revision')
            check(receipt.get('asset_mode')=='bundled','Output depends on native-build map assets')
            check(receipt.get('output_profile')=='player-render-state','Output did not use the app conversion mode')
            check(receipt.get('parity')=='matched','Exact parity has not passed')
            check(proof.get('passed') is True and proof.get('exact_full_state_parity') is True,'Full exact comparison did not pass')
            check(not proof.get('mismatches') and proof.get('first_difference') is None,'Comparison contains differences')
            for field in ['expected_frames','actual_frames','reference_frames','checked_frames']:
                check(proof.get(field)==record['end']+1,f'Incomplete {field}')
            check(proof.get('position_tolerance')==proof.get('hp_tolerance')==0,'Comparison allowed numerical tolerance')
            native=case/'game.repsim.gz';actual=case/'standalone.repsim.gz'
            metadata=first_record(native);static=first_record(actual)
            check(metadata.get('replay_sha256')==record['sha256'],'Native input provenance differs')
            check(metadata.get('binary_sha256')==native_build['game_exe_sha256'],'Loaded native binary differs')
            inspection_path=root/'inspection'/build/'inspection.json'
            inspection=json.loads(inspection_path.read_text()) if inspection_path.exists() else {}
            check(native_version_matches(metadata,inspection,record['version'],native_build['game_exe_sha256']),
                'Native version label differs or its absence lacks authenticated inspection evidence')
            check(static.get('kind')=='static','Player repsim has no static record')
            check(static.get('replay',{}).get('version')==record['version'],'Player version differs')
            check(static.get('replay',{}).get('end')==record['end'],'Player metadata end differs')
            surface=base64.b64decode(static.get('rendered_map_surface',''),validate=True)
            check(surface[:8]==bytes([137,80,78,71,13,10,26,10]),'Player repsim has no embedded rendered PNG')
            initial=json.loads((case/'native-initial.json').read_text())
            check(static.get('static_core',{}).get('map_size')==initial.get('native_map_size'),'Player map dimensions differ')
            check(static.get('static_core',{}).get('city_positions')==initial['core']['city_positions'],'Player map cities differ')
            # An incomplete or different-revision case cannot pass this audit.
            # Hash the large trace files only after all eligibility checks pass.
            if not a.quick and not errors:
                check(runner.digest(Path(record['input']))==record['sha256'],'Immutable original input changed')
                check(runner.digest(native)==receipt.get('native_sha256'),'Native trace changed')
                check(runner.digest(actual)==receipt.get('standalone_sha256'),'Player trace changed')
                check(runner.digest(proof_path)==receipt.get('comparison_sha256'),'Exact proof is not bound to receipt')
                path=Path(receipt['engine_executable'])
                if path not in frozen:frozen[path]=runner.engine_fingerprint(path)
                check(frozen[path]==fingerprint,'Frozen generating engine changed')
        except (OSError,ValueError,KeyError,TypeError,StopIteration) as error:
            errors.append(str(error))
        return {'sha256':record['sha256'],'game_build':build,'end':record['end'],
                'case':str(case),'passed':not errors,'errors':errors}

    for record in rows:
        build,selection=runner.selected_build(record,root,plan)
        results.append(audit_case(record,build,root/'full'/build/record['sha256']))
        if selection.startswith('unknown save timestamp'):
            for entry in plan:
                inspection=root/'inspection'/entry['label']/'inspection.json'
                native_version=json.loads(inspection.read_text()).get('constants',{}).get('version') if inspection.exists() else entry.get('native_version')
                if native_version==record['version'] and entry['label']!=build:
                    candidate=entry['label']
                    candidate_results.append(audit_case(record,candidate,root/'candidate-full'/candidate/record['sha256']))
    counts=Counter('passed' if row['passed'] else 'incomplete' for row in results)
    candidates=Counter('passed' if row['passed'] else 'incomplete' for row in candidate_results)
    report={'audit_mode':'quick progress only' if a.quick else 'full cryptographic completion audit',
            'engine':str(engine),'engine_sha256':fingerprint,'qualifying_unique':len(rows),
            'recorded_build_counts':dict(counts),'ambiguous_candidate_counts':dict(candidates),
            'scope_complete':not a.quick and all(row['passed'] for row in results+candidate_results)
                and len(rows)==inventory['qualifying_unique'],
            'replays':results,'ambiguous_candidates':candidate_results}
    if a.output:runner.atomic_json(a.output,report)
    print(json.dumps({k:v for k,v in report.items() if k not in ['replays','ambiguous_candidates']},indent=2))
    return 0 if report['scope_complete'] else 1


if __name__=='__main__':raise SystemExit(main())
