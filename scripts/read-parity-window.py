"""Print a small state/command window from an existing parity case."""
import argparse
import gzip
import json
from pathlib import Path

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('case', type=Path)
p.add_argument('--frame', type=int, required=True)
p.add_argument('--unit', type=int)
p.add_argument('--field', help='Print one dotted state field instead of the entire state')
p.add_argument('--radius', type=int, default=1)
a = p.parse_args()
config = json.loads((a.case/'native-config.json').read_text(encoding='utf-8-sig'))
data = Path(config['replay']).read_bytes()
replay = json.loads(gzip.decompress(data) if data[:2] == b'\x1f\x8b' else data)
for tick in range(max(0,a.frame-a.radius-1),a.frame+a.radius):
    if str(tick) in replay:
        print(json.dumps({'command_tick':tick,'commands':replay[str(tick)]}))
for name in ['game.repsim.gz','standalone.repsim.gz']:
    with gzip.open(a.case/name,'rt',encoding='utf-8') as stream:
        for line in stream:
            row=json.loads(line)
            if row.get('kind') != 'state': continue
            frame=row['frame']
            if frame>a.frame+a.radius: break
            if frame<a.frame-a.radius: continue
            if a.unit is not None:
                row['dots']=[next((dot for dot in row['dots'] if dot is not None and dot['id']==a.unit),None)]
                row['core']={key:row['core'][key] for key in ['frame','psrandom','economy']}
                row.pop('render',None)
            if a.field:
                value=row
                keys=a.field.split('.')
                if keys[0]=='dots' and len(keys)>1 and keys[1].isdigit():
                    value=next((dot for dot in row['dots'] if dot is not None and dot['id']==int(keys[1])),None)
                    keys=keys[2:]
                for key in keys:
                    if value is None:break
                    value=value[int(key)] if isinstance(value,list) else value[key]
                row={'frame':frame,'field':a.field,'value':value}
            print(json.dumps({'trace':name,'state':row}))
