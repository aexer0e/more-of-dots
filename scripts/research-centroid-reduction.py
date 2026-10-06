"""Inspect native matrix centroid reduction and candidate summation orders."""
import argparse
import gzip
import json
import math
from pathlib import Path
import numpy as np

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('case',type=Path);p.add_argument('--frame',type=int,required=True);p.add_argument('--unit',type=int,required=True)
a=p.parse_args()
with gzip.open(a.case/'game.repsim.gz','rt') as stream:
    before=next(json.loads(line) for line in stream if f'"frame":{a.frame-1},' in line)
dots=[d for d in before['dots'] if d and d['health']>0]
points=np.array([d['position'] for d in dots],dtype=np.float64)
colors=np.array([d['color'] for d in dots]);row=next(i for i,d in enumerate(dots) if d['id']==a.unit)
delta=points[:,None,:]-points[None,:,:]
mask=(np.sum(delta*delta,axis=2)<=1296)&(colors[:,None]!=colors[None,:])
print(json.dumps({'living':len(dots),'unit_row':row,'enemies':[d['id'] for d,m in zip(dots,mask[row]) if m],
    'matrix_centroid':((mask.astype(np.float64)@points)[row]/sum(mask[row])).tolist()}))
for label,left,right in [('bool',mask,points),('float-fortran',np.asfortranarray(mask.astype(float)),np.asfortranarray(points)),
                         ('float-row',mask[row].astype(float),points),('bool-row',mask[row],points)]:
    value=left@right
    if value.ndim==2:value=value[row]
    print(json.dumps({'layout':label,'centroid':(value/sum(mask[row])).tolist()}))
print(json.dumps({'points':points.tolist(),'mask':mask[row].tolist()}))
repeated=np.tile(mask[row].astype(float),(len(dots),1))
repeated_result=repeated@points
groups={}
for index,value in enumerate(repeated_result[:,0]):groups.setdefault(str(value/sum(mask[row])),[]).append(index)
print(json.dumps({'same_mask_by_row':groups}))
for coordinate in range(2):
    values=[float(point[coordinate]) if m else 0.0 for point,m in zip(points,mask[row])]
    count=sum(mask[row])
    result={'coordinate':coordinate,'fsum':math.fsum(values)/count,'numpy_sum':float(np.sum(values))/count}
    for width in [1,2,4,8]:
        totals=[0.0]*width
        for i,value in enumerate(values):totals[i%width]+=value
        serial=0.0
        for value in totals:serial+=value
        result['buckets'+str(width)]=serial/count
        if width==8:
            halves=[totals[i]+totals[i+4] for i in range(4)]
            result['reduce8']=((halves[0]+halves[2])+(halves[1]+halves[3]))/count
            result['reduce8-pairs']=((totals[0]+totals[1])+(totals[2]+totals[3])+(totals[4]+totals[5])+(totals[6]+totals[7]))/count
            result['reduce8-four-rows']=(((totals[0]+totals[1])+(totals[2]+totals[3]))+((totals[4]+totals[5])+(totals[6]+totals[7])))/count
    print(json.dumps(result))
