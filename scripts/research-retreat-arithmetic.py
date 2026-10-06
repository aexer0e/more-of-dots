"""Check retreat centroids and operation order against a native trace."""
import argparse
import gzip
import json
import math
from pathlib import Path

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('case',type=Path)
p.add_argument('--frame',type=int,required=True)
p.add_argument('--unit',type=int,required=True)
p.add_argument('--speed',type=float,required=True)
a=p.parse_args()
rows=[]
with gzip.open(a.case/'game.repsim.gz','rt') as stream:
    for line in stream:
        r=json.loads(line)
        if r.get('kind')!='state':continue
        if r['frame'] in [a.frame-1,a.frame]:rows.append(r)
        if r['frame']>=a.frame:break
before,after=rows
unit=before['dots'][a.unit];x,y=unit['position']
enemies=[d['position'] for d in before['dots'] if d and d['health']>0 and d['color']!=unit['color']
         and (d['position'][0]-x)**2+(d['position'][1]-y)**2<=36**2]
centroid=[sum(e[i] for e in enemies)/len(enemies) for i in range(2)]
print(json.dumps({'enemies':enemies,'centroid':centroid,'reference':after['dots'][a.unit]['position']}))
for digits in [None,4]:
    cx,cy=centroid if digits is None else [round(c,4) for c in centroid]
    dx,dy=cx-x,cy-y;distance=math.sqrt(dx*dx+dy*dy)
    for scale in ['divide-first','scale-first']:
        rx,ry=[dx/distance*100,dy/distance*100] if scale=='divide-first' else [dx*(100/distance),dy*(100/distance)]
        gx,gy=x-rx,y-ry
        vx,vy=gx-x,gy-y;length=math.sqrt(vx*vx+vy*vy)
        point=[x+vx/length*a.speed,y+vy/length*a.speed]
        print(json.dumps({'centroid_digits':digits,'scale':scale,'point':point,'exact':point==after['dots'][a.unit]['position']}))
