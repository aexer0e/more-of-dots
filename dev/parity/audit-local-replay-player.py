"""Audit actual replay loading and offscreen video rendering using an installed player engine."""
import argparse,collections,concurrent.futures,hashlib,json,subprocess,time
from pathlib import Path

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--inventory',type=Path,required=True)
p.add_argument('--engine',type=Path,required=True)
p.add_argument('--game-dir',type=Path,required=True)
p.add_argument('--output',type=Path,required=True)
p.add_argument('--workers',type=int,default=6)
a=p.parse_args()
engine=a.engine.resolve()
files=json.loads(a.inventory.read_text(encoding='utf-8'))['files']
files.sort(key=lambda r:0 if str(r.get('map_id'))=='23' or 'map23.' in str(r.get('map_path')) else 1)
report={'engine':str(engine),'engine_sha256':hashlib.sha256(engine.read_bytes()).hexdigest(),'scope':'Initial playback state and first video frame. Does not verify the remainder of each match.','files':files}
def run(r):
 for kind,extra in [('playback',['--render-state','-o','-']),('video',['--export-video','--width','320','--height','180'])]:
  start=time.monotonic()
  try:
   result=subprocess.run([str(engine),r['input'],'--max-frame','0','--game-dir',str(a.game_dir),*extra],cwd=engine.parent,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=90,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
   ok=result.returncode==0
   if ok and kind=='video':ok=len(result.stdout)==320*180*3
   if ok and kind=='playback':ok=any(json.loads(line).get('frame')==0 for line in result.stdout.splitlines())
   r[kind]={'ok':ok,'code':result.returncode,'bytes':len(result.stdout),'seconds':round(time.monotonic()-start,3),'error':'' if ok else result.stderr.decode('utf-8',errors='replace').strip()}
  except Exception as e:r[kind]={'ok':False,'error':str(e)}
 return r
def save():
 report['counts']={kind:dict(collections.Counter('passed' if r[kind]['ok'] else 'failed' for r in files if kind in r)) for kind in ['playback','video']}
 a.output.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
with concurrent.futures.ThreadPoolExecutor(max_workers=a.workers) as pool:
 futures=[pool.submit(run,r) for r in files]
 for i,f in enumerate(concurrent.futures.as_completed(futures),1):
  r=f.result()
  if not r['playback']['ok'] or not r['video']['ok']:print(json.dumps({'file':r['input'],'map':r.get('map_id') or r.get('map_path'),'mode':r.get('mode'),'playback':r['playback']['error'],'video':r['video']['error']},ensure_ascii=False),flush=True)
  if i%50==0 or i==len(files):save();print(f'{i}/{len(files)} {report["counts"]}',flush=True)
