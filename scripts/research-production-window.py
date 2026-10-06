"""Show births, queues and RNG consumption at one recorded economy tick."""
import argparse
import gzip
import json
from pathlib import Path

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('case',type=Path)
p.add_argument('--frame',type=int,required=True)
a=p.parse_args()
for trace in ['game.repsim.gz','standalone.repsim.gz']:
    rows=[]
    seen_before=set()
    with gzip.open(a.case/trace,'rt') as stream:
        for line in stream:
            r=json.loads(line)
            if r.get('kind')!='state':continue
            if r['frame']<a.frame:seen_before.update(d['id'] for d in r['dots'] if d is not None)
            if r['frame'] in [a.frame-1,a.frame]:rows.append(r)
            if r['frame']>=a.frame:break
    before,after=rows
    rng=before['core']['psrandom']['state'];target=after['core']['psrandom']['state']
    draws=None
    for count in range(2001):
        if rng==target:draws=count;break
        rng^=(rng<<13)&0xffffffff;rng^=rng>>17;rng^=(rng<<5)&0xffffffff;rng&=0xffffffff
    def economy(row):
        fields=row['core']['economy']['fields']
        return {k:fields[k] for k in ['zrtyz','production_queue','production_rate','production_ratio','production_type','industrial_zone','city_enc'] if k in fields}
    print(json.dumps({'trace':trace,'frame':a.frame,'rng_draws':draws,
        'living_before':sum(d is not None and d['health']>0 for d in before['dots']),
        'damaged_before':sum(d is not None and d['damage_received']>0 for d in before['dots']),
        'before':economy(before),'after':economy(after),
        'births':[d for d in after['dots'] if d is not None and d['id'] not in seen_before]}))
