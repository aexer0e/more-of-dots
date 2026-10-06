"""Generate native and standalone traces and keep explicit comparison receipts.

Default runs the entire qualifying inventory. --max-frame is diagnostic only.
Native runtime directories are reused sequentially within each build, while traces
and logs are kept per original replay hash. A successful process exit alone never
marks a capture or comparison successful.
"""
import argparse
import collections
import concurrent.futures
from contextlib import contextmanager
import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import struct
import time
import uuid

REPO=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('strict_parity',REPO/'scripts/compare-parity-traces.py')
strict=importlib.util.module_from_spec(spec)
spec.loader.exec_module(strict)


def digest(path):
    with path.open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()


def atomic_json(path,value):
    temporary=path.with_name(path.name+'.'+uuid.uuid4().hex+'.tmp')
    temporary.write_text(json.dumps(value,indent=2),encoding='utf-8')
    temporary.replace(path)


def engine_fingerprint(path):
    # A framework-dependent apphost can stay byte-identical while its DLL changes.
    resources=[(file.relative_to(path.parent).as_posix(),digest(file))
        for file in sorted(path.parent.rglob('*')) if file.is_file() and file.suffix!='.pdb']
    return hashlib.sha256(json.dumps(resources,separators=(',',':')).encode()).hexdigest()


def snapshot_engine(path,root,fingerprint):
    """Freeze a batch's executable/DLL/maps while ongoing engine edits continue."""
    vault=root/'engines'
    vault.mkdir(exist_ok=True)
    target=vault/fingerprint
    if not target.exists():
        temporary=vault/(fingerprint+'.'+uuid.uuid4().hex+'.partial')
        shutil.copytree(path.parent,temporary)
        copied=temporary/path.name
        if engine_fingerprint(copied)!=fingerprint:
            raise RuntimeError('Engine changed while its batch snapshot was copied')
        try:
            temporary.rename(target)
        except FileExistsError:
            # Another dispatcher froze the identical engine concurrently.
            # Preserve the harmless temporary copy rather than deleting paths.
            pass
    frozen=target/path.name
    if engine_fingerprint(frozen)!=fingerprint:
        raise RuntimeError('Preserved batch engine does not match its fingerprint')
    return frozen


@contextmanager
def case_lock(directory):
    """Serialize case writes across dispatchers; OS locks release on exit."""
    with (directory/'.capture.lock').open('a+b') as handle:
        if handle.tell()==0:
            handle.write(b'0')
            handle.flush()
        handle.seek(0)
        if os.name=='nt':
            import msvcrt
            while True:
                try:
                    msvcrt.locking(handle.fileno(),msvcrt.LK_NBLCK,1)
                    break
                except OSError:
                    time.sleep(.25)
            try:
                yield
            finally:
                handle.seek(0)
                msvcrt.locking(handle.fileno(),msvcrt.LK_UNLCK,1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(),fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(handle.fileno(),fcntl.LOCK_UN)


def selected_build(record, root, plan):
    """Resolve an original replay to its timestamp/version-compatible build."""
    with Path(record['input']).open('rb') as stream:
        raw=stream.read(8)
    saved=struct.unpack('<I',raw[4:8])[0] if raw[:2]==b'\x1f\x8b' else 0
    recovered=False
    recovery_path=root/'timestamp-recovery.json'
    if not saved and recovery_path.exists():
        recovery=json.loads(recovery_path.read_text()).get(record['sha256'])
        if recovery:
            source_sha=recovery['source_sha256']
            if len(source_sha)!=64 or any(c not in '0123456789abcdef' for c in source_sha):
                raise ValueError('Invalid timestamp recovery source identity')
            source=root/'inputs'/(source_sha+'.rep')
            original=Path(record['input']).read_bytes();twin=source.read_bytes()
            if hashlib.sha256(original).hexdigest()!=record['sha256'] or hashlib.sha256(twin).hexdigest()!=source_sha:
                raise ValueError('Timestamp recovery inputs changed')
            decoded=lambda value:json.loads(gzip.decompress(value) if value[:2]==b'\x1f\x8b' else value)
            canonical=lambda value:json.dumps(decoded(value),sort_keys=True,separators=(',',':'),ensure_ascii=False)
            if canonical(original)!=canonical(twin):raise ValueError('Timestamp recovery replay payloads differ')
            if twin[:2]!=b'\x1f\x8b':raise ValueError('Timestamp recovery source has no gzip header')
            saved=struct.unpack('<I',twin[4:8])[0]
            if not saved:raise ValueError('Timestamp recovery source has no save time')
            recovered=True
    matches=[]
    for entry in plan:
        if entry['release_timestamp']>saved:continue
        inspection=root/'inspection'/entry['label']/'inspection.json'
        if inspection.exists():
            native_label=json.loads(inspection.read_text()).get('constants',{}).get('version')
            if native_label and native_label!=record['version']:continue
        matches.append(entry)
    if matches:
        method='gzip save timestamp recovered from an identical decoded original' if recovered else 'gzip save timestamp; recording label alone is ambiguous'
        return matches[-1]['label'],method
    fallback='1.4.1-reference' if record['version']=='1.4.1' else record['version']
    return fallback,'unknown save timestamp; native version label candidate'


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root',type=Path,default=REPO/'build/game-parity')
    p.add_argument('--engine',type=Path,default=REPO/'src-tauri/resources/player/ReplaySim.Standalone.exe')
    p.add_argument('--version',action='append')
    p.add_argument('--build',help='Explicit native build override for a selected replay/candidate check')
    p.add_argument('--selected-build',action='append',help='Filter selected native builds without overriding timestamp selection')
    p.add_argument('--sha',action='append')
    p.add_argument('--limit',type=int)
    p.add_argument('--limit-per-build',type=int)
    p.add_argument('--max-frame',type=int)
    p.add_argument('--native-only',action='store_true')
    p.add_argument('--standalone-only',action='store_true')
    p.add_argument('--workers',type=int,default=1)
    p.add_argument('--dry-run',action='store_true',help='Report selected native builds without launching either simulator')
    p.add_argument('--recapture',action='store_true',help='Regenerate immutable native references even when input/build/trace hashes match')
    p.add_argument('--captured-only',action='store_true',help='Select only replays with completed native reference receipts')
    p.add_argument('--bundled-only',action='store_true',help='Generate with bundled map assets, without a native game directory')
    p.add_argument('--case-set',choices=['full','candidate-full'],default='full',help='Keep ambiguous-build audits separate from the recorded-build scope')
    p.add_argument('--runtime-set',choices=['runtimes-authentic','runtimes-candidates'],default='runtimes-authentic')
    p.add_argument('--render-state',action='store_true',help='Use the same complete repsim command mode as the More of Dots player')
    p.add_argument('--startup-wait-seconds',type=int,default=10,help='Allow a preserved game to finish startup before attaching the probe')
    p.add_argument('--regenerate-standalone',action='store_true',help='Execute the selected player again while preserving the immutable native reference')
    args=p.parse_args()
    root=args.root.resolve()
    inv=json.loads((root/'inventory.json').read_text(encoding='utf-8'))
    rows=[r for r in inv['files'] if r['qualifies'] and (not args.version or r['version'] in args.version) and (not args.sha or r['sha256'] in args.sha)]
    rows.sort(key=lambda r:(r['version'],r['end']))
    if args.limit:rows=rows[:args.limit]
    groups=collections.defaultdict(list)
    plan=json.loads((root/'build-plan.json').read_text())['builds']
    for r in rows:
        build,r['build_selection']=selected_build(r,root,plan)
        if args.build:
            build=args.build
            r['build_selection']='explicit native build candidate'
        if args.selected_build and build not in args.selected_build:
            continue
        r['selected_build']=build
        if args.captured_only:
            directory=f'diagnostic-{args.max_frame}' if args.max_frame is not None else args.case_set
            existing=root/directory/build/r['sha256']/'receipt.json'
            if not existing.exists() or json.loads(existing.read_text(encoding='utf-8')).get('native')!='completed':
                continue
        groups[build].append(r)
    rows=[r for records in groups.values() for r in records]
    if args.limit_per_build:
        groups={build:records[:args.limit_per_build] for build,records in groups.items()}
        rows=[r for records in groups.values() for r in records]
    if args.dry_run:
        print(json.dumps({'qualifying_selected':len(rows),'builds':{build:len(records) for build,records in groups.items()},
            'missing_builds':[build for build in groups if not (root/'versions'/build/'parity-build.json').exists()]},indent=2))
        return
    suffix=f'diagnostic-{args.max_frame}' if args.max_frame is not None else args.case_set
    outroot=root/suffix
    outroot.mkdir(exist_ok=True)
    engine=args.engine.resolve()
    engine_hash=engine_fingerprint(engine) if engine.exists() else None
    if engine_hash and not args.native_only:
        engine=snapshot_engine(engine,root,engine_hash)
    capture_hash=digest(REPO/'scripts/parity-native-capture.py')
    flags=getattr(subprocess,'CREATE_NO_WINDOW',0)
    native_env=dict(os.environ,OMP_NUM_THREADS='1',OPENBLAS_NUM_THREADS='1',MKL_NUM_THREADS='1')

    def group(build,records):
        game=root/'versions'/build
        build_receipt=json.loads((game/'parity-build.json').read_text())
        if not build_receipt.get('steam_manifest_verified'):
            raise RuntimeError(f'Native build {build} has not passed Steam manifest verification')
        for r in records:
            case=outroot/build/r["sha256"];case.mkdir(parents=True,exist_ok=True)
            with case_lock(case):
                start=time.monotonic()
                end=min(int(r['end']),args.max_frame) if args.max_frame is not None else int(r['end'])
                native=case/'game.repsim.gz';actual=case/'standalone.repsim.gz'
                receipt_path=case/'receipt.json'
                receipt={'sha256':r['sha256'],'source':r['input'],'end':end,'recorded_end':r['end'],
                    'diagnostic_only':args.max_frame is not None,'game_build':build,
                    'manifest_id':build_receipt['manifest_id'],'game_exe_sha256':build_receipt['game_exe_sha256'],
                    'build_selection':r.get('build_selection','native version label confirmed'),
                    'engine_sha256':engine_hash,'capture_script_sha256':capture_hash,'parity':'pending'}
                receipt['engine_hash_scope']='executable and all sibling/runtime/map resources except debug symbols'
                receipt['engine_executable']=str(engine)
                receipt['asset_mode']='bundled' if args.bundled_only else 'native-build-directory'
                receipt['output_profile']='player-render-state' if args.render_state else 'simulation-state'
                previous=json.loads(receipt_path.read_text()) if receipt_path.exists() else {}
                try:
                    native_current=(not args.recapture and native.exists()
                        and previous.get('game_exe_sha256')==receipt['game_exe_sha256']
                        and previous.get('native')=='completed' and previous.get('native_sha256')==digest(native))
                    if native_current:
                        receipt['capture_script_sha256']=previous.get('capture_script_sha256')
                        if args.native_only:
                            print(json.dumps({'sha256':r['sha256'],'game_build':build,'native':'reused completed immutable reference','parity':previous.get('parity','pending')}),flush=True)
                            continue
                    if args.standalone_only and not native_current:
                        raise RuntimeError('No current native capture with matching provenance; capture it before standalone-only comparison')
                    if not args.standalone_only and not native_current:
                        cfg=dict(replay=r['input'],output=str(native),status=str(case/'native-status.json'),
                            scene_fields=str(case/'scene-fields.json'),game_exe=str(game/'game.exe'),max_frame=end)
                        Path(cfg['status']).write_text(json.dumps({'ok':False,'phase':'pending'}),encoding='utf-8')
                        config=case/'native-config.json';config.write_text(json.dumps(cfg),encoding='utf-8')
                        # The longest originals exceed an hour. Allow twice the
                        # recorded play time plus startup headroom, rather than
                        # terminating a progressing capture at one fixed hour.
                        capture_timeout=max(3600,(end+14)//15+300)
                        receipt['native_timeout_seconds']=capture_timeout
                        command=['pwsh','-NoProfile','-File',str(REPO/'scripts/invoke-parity-probe.ps1'),
                            '-GameDirectory',str(game),'-WorkDirectory',str(root/args.runtime_set/build),
                            '-Payload',str(REPO/'scripts/parity-native-capture.py'),'-Configuration',str(config),
                            '-StartupWaitSeconds',str(args.startup_wait_seconds),
                            '-TimeoutSeconds',str(capture_timeout)]
                        result=subprocess.run(command,capture_output=True,
                            timeout=capture_timeout+100+args.startup_wait_seconds,
                            creationflags=flags,env=native_env)
                        (case/'native-launch.log').write_bytes(result.stdout+result.stderr)
                        try:
                            status=json.loads((case/'native-status.json').read_text())
                        except (OSError,json.JSONDecodeError):
                            # A native startup exit can interrupt its status write.
                            # Preserve the launch error instead of reporting a JSON
                            # parser failure as though it were a replay discrepancy.
                            status={}
                        if result.returncode or not status.get('ok') or not native.exists():
                            raise RuntimeError(f"Native capture failed: {status.get('error',result.stderr.decode('utf-8',errors='replace'))}")
                    if native.exists():
                        with gzip.open(native,'rt',encoding='utf-8') as stream:
                            native_metadata=json.loads(next(stream))
                        if native_metadata.get('replay_sha256')!=r['sha256'] or native_metadata.get('binary_sha256')!=receipt['game_exe_sha256']:
                            raise RuntimeError('Native trace provenance does not match this replay/build')
                        receipt['native']='completed';receipt['native_sha256']=digest(native)
                    standalone_current=not args.regenerate_standalone and actual.exists() and previous.get('engine_sha256')==engine_hash and previous.get('asset_mode','native-build-directory')==receipt['asset_mode'] and previous.get('output_profile','simulation-state')==receipt['output_profile'] and previous.get('standalone')=='completed' and previous.get('standalone_sha256')==digest(actual)
                    comparison_path=case/'comparison.json'
                    if (not args.native_only and native_current and standalone_current
                            and previous.get('parity')=='matched' and previous.get('end')==end
                            and previous.get('recorded_end')==r['end']
                            and previous.get('comparison_sha256') and comparison_path.exists()
                            and previous['comparison_sha256']==digest(comparison_path)):
                        cached=json.loads(comparison_path.read_text())
                        if (cached.get('exact_full_state_parity') and cached.get('checked_frames')==end+1
                                and cached.get('actual_frames')==end+1 and cached.get('reference_frames')==end+1
                                and cached.get('position_tolerance')==0 and cached.get('hp_tolerance')==0):
                            print(json.dumps({'sha256':r['sha256'],'game_build':build,'parity':'matched',
                                'comparison':'reused full exact proof with matching input/build/engine/assets/output hashes'}),flush=True)
                            continue
                    if not args.native_only and not standalone_current:
                        command=[str(engine),r['input'],'-o','-']
                        if not args.bundled_only:command+=['--game-dir',str(game)]
                        if args.render_state:command+=['--render-state']
                        if args.max_frame is not None:command+=['--max-frame',str(end)]
                        with (case/'standalone.log').open('wb') as error_stream:
                            process=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=error_stream,creationflags=flags)
                            temporary=actual.with_name(actual.name+'.partial')
                            try:
                                with gzip.open(temporary,'wb',compresslevel=1) as output:
                                    while chunk:=process.stdout.read(1<<20):output.write(chunk)
                                code=process.wait(timeout=3600)
                                if code:raise RuntimeError(f'Standalone failed with code {code}; see standalone.log')
                                temporary.replace(actual)
                            finally:
                                if process.poll() is None:process.kill();process.wait()
                    if actual.exists():
                        receipt['standalone']='completed';receipt['standalone_sha256']=digest(actual)
                    if not args.native_only and native.exists() and actual.exists():
                        comparison=strict.compare(actual,native,end)
                        atomic_json(comparison_path,comparison)
                        receipt['comparison_sha256']=digest(comparison_path)
                        receipt['parity']='matched' if comparison['passed'] else 'mismatch'
                        receipt['first_difference']=comparison['first_difference']
                except Exception as error:
                    receipt['parity']='failed';receipt['error']=str(error)
                receipt['seconds']=round(time.monotonic()-start,3)
                atomic_json(receipt_path,receipt)
                print(json.dumps({k:receipt[k] for k in ('sha256','game_build','parity','seconds')}|{'error':receipt.get('error'),'first_difference':receipt.get('first_difference')},ensure_ascii=False),flush=True)
    def compare_group_process(build,records):
        # Exact JSON/state comparison is CPU-heavy Python work. Separate
        # processes let each build use a core instead of sharing one GIL.
        import sys
        command=[sys.executable,str(Path(__file__).resolve()),'--root',str(root),
                 '--engine',str(engine),'--standalone-only','--workers','1','--selected-build',build]
        for row in records:
            command+=['--sha',row['sha256']]
        if args.max_frame is not None:command+=['--max-frame',str(args.max_frame)]
        if args.build:command+=['--build',args.build]
        if args.recapture:command+=['--recapture']
        if args.regenerate_standalone:command+=['--regenerate-standalone']
        if args.bundled_only:command+=['--bundled-only']
        if args.render_state:command+=['--render-state']
        command+=['--case-set',args.case_set,'--runtime-set',args.runtime_set]
        command+=['--startup-wait-seconds',str(args.startup_wait_seconds)]
        with subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,
                text=True,encoding='utf-8',errors='replace',creationflags=flags,
                env=dict(os.environ,PYTHONIOENCODING='utf-8')) as process:
            for line in process.stdout:
                print(line,end='',flush=True)
            if process.wait():
                raise RuntimeError(f'Comparison worker for {build} failed with code {process.returncode}')

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        if args.standalone_only and args.workers>1:
            # Native captures share one isolated runtime per build. Standalone
            # cases share no mutable state, and each owns its receipt lock, so
            # a large single-build corpus can use every comparison worker too.
            futures=[pool.submit(compare_group_process,build,[record])
                     for build,records in groups.items() for record in records]
        else:
            futures=[pool.submit(group,build,records) for build,records in groups.items()]
        for future in concurrent.futures.as_completed(futures):future.result()
    receipts=[json.loads((outroot/r['selected_build']/r['sha256']/'receipt.json').read_text()) for r in rows]
    summary={'diagnostic_only':args.max_frame is not None,'selected':len(rows),
             'counts':dict(collections.Counter(r['parity'] for r in receipts)),'receipts':receipts}
    atomic_json(outroot/'summary.json',summary)
    print(json.dumps({k:v for k,v in summary.items() if k!='receipts'},indent=2),flush=True)


if __name__=='__main__':
    main()
