"""Compare mountain arithmetic against a recorded native tick."""
import argparse
import gzip
import json
import math
from pathlib import Path

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('case',type=Path)
p.add_argument('research',type=Path)
p.add_argument('--frame',type=int,required=True)
p.add_argument('--unit',type=int,required=True)
p.add_argument('--speed',type=float,required=True)
a=p.parse_args()
rows=[]
with gzip.open(a.case/'game.repsim.gz','rt') as stream:
    for line in stream:
        r=json.loads(line)
        if r.get('kind')!='state':continue
        if r['frame'] in [a.frame-1,a.frame]:rows.append(r['dots'][a.unit])
        if r['frame']>=a.frame:break
before,after=rows
x,y=before['position'];gx,gy=before['path'][0]
dx,dy=gx-x,gy-y;dist=math.sqrt(dx*dx+dy*dy)
desired=[(x+dx/dist*a.speed)-x,(y+dy/dist*a.speed)-y]
terrain=(a.research/'native-terrain.bin').read_bytes()
meta=json.loads((a.research/'native-terrain.json').read_text())
height=meta['shape'][1];mountain=meta['terrain_colors_idx'].index('mountain')
perimeter=json.loads((a.research/'calls.json').read_text())['constants']['precomputed_dot_perimeter_offsets']
print(json.dumps({'before':before['position'],'reference':after['position'],'desired':desired}))
for perimeter_digits in [None,9]:
    samples=perimeter if perimeter_digits is None else [[round(v,9) for v in pair] for pair in perimeter]
    selected=[pair for pair in samples if terrain[int(x+pair[0]*12)*height+int(y+pair[1]*12)]==mountain]
    push=[sum(pair[i] for pair in selected) for i in range(2)]
    for push_digits in [None,6]:
        px,py=push if push_digits is None else [round(v,push_digits) for v in push]
        length=math.sqrt(px*px+py*py)
        if length==0:
            print(json.dumps({'perimeter_digits':perimeter_digits,'push_digits':push_digits,'push':[px,py],
                'forward':[x+desired[0],y+desired[1]],'exact_forward':[x+desired[0],y+desired[1]]==after['position']}))
            continue
        for normalization in ['divide','reciprocal']:
            ix,iy=[px/length,py/length] if normalization=='divide' else [px*(1/length),py*(1/length)]
            component=desired[0]*ix+desired[1]*iy
            sx,sy=desired[0]-ix*component,desired[1]-iy*component
            slide_length=math.sqrt(sx*sx+sy*sy)
            result=[x+sx*(a.speed/slide_length),y+sy*(a.speed/slide_length)]
            print(json.dumps({'perimeter_digits':perimeter_digits,'push_digits':push_digits,'normalization':normalization,'push':[px,py],'result':result,'exact':result==after['position']}))
