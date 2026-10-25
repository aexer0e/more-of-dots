"""Inspect native mountain-slide scalar arithmetic using an exported terrain."""
import argparse
import gzip
import itertools
import json
import math
from pathlib import Path
import numpy as np

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('case',type=Path);p.add_argument('research',type=Path)
p.add_argument('--frame',type=int,required=True);p.add_argument('--unit',type=int,required=True)
p.add_argument('--speed',type=float,required=True)
a=p.parse_args();states=[]
with gzip.open(a.case/'game.repsim.gz','rt') as f:
    for line in f:
        row=json.loads(line)
        if row.get('kind')=='state' and row['frame'] in [a.frame-1,a.frame]:
            states.append(next(d for d in row['dots'] if d and d['id']==a.unit))
        if row.get('frame',-1)>=a.frame:break
before,after=states;x,y=before['position'];gx,gy=before['path'][0]
length=math.sqrt((gx-x)**2+(gy-y)**2)
desired=[(x+(gx-x)/length*a.speed)-x,(y+(gy-y)/length*a.speed)-y]
static=json.loads((a.research/'initial.repsim').read_text().splitlines()[0])
width,height=static['static_core']['map_size'];terrain=(a.research/'terrain.bin').read_bytes()
constants=json.loads((Path('build/game-parity/research/old-perimeter')/'calls.json').read_text())['constants']
offsets=constants['precomputed_dot_perimeter_offsets']
selected=[v for v in offsets if terrain[int(y+v[1]*12)*width+int(x+v[0]*12)]==7]
push=[0.,0.]
for v in selected:
    for i in range(2):push[i]+=v[i]
norms={'sqrt':lambda x,y:math.sqrt(x*x+y*y),'numpy':lambda x,y:float(np.linalg.norm([x,y])), 'hypot':math.hypot,
       'fma':lambda x,y:math.sqrt(math.fma(y,y,x*x))}
components={'serial':lambda x,y,u,v:x*u+y*v,'numpy':lambda x,y,u,v:float(np.dot([x,y],[u,v])),
            'fma':lambda x,y,u,v:math.fma(y,v,x*u)}
print(json.dumps({'push':push,'selected':selected,'desired':desired,'reference':after['position']}))
for pn,component,sn,normalization in itertools.product(norms,components,norms,['reciprocal','divide']):
    plen=norms[pn](*push)
    into=[v/plen if normalization=='divide' else v*(1/plen) for v in push]
    dp=components[component](*desired,*into)
    slide=[desired[i]-into[i]*dp for i in range(2)]
    slen=norms[sn](*slide);result=[x+slide[0]*(a.speed/slen),y+slide[1]*(a.speed/slen)]
    if result==after['position'] or (pn,component,sn,normalization)==('sqrt','serial','sqrt','reciprocal'):
        print(json.dumps({'push_norm':pn,'component':component,'slide_norm':sn,'normalization':normalization,
            'push_length':plen,'dot':dp,'slide':slide,'slide_length':slen,'result':result,'exact':result==after['position']}))
