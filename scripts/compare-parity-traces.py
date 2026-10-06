"""Compare every native and standalone state with zero numerical tolerance.

Streams plain or gzip JSONL so full-length recordings need not fit in memory.
Missing ticks, incomplete files, invalid unit identities and deferred orders fail.
"""
import argparse
import collections
import gzip
import hashlib
import itertools
import json
import math
from pathlib import Path


def states(path):
    with path.open('rb') as probe:
        compressed = probe.read(2) == b'\x1f\x8b'
    opener = gzip.open if compressed else open
    with opener(path, 'rt', encoding='utf-8-sig') as stream:
        for line in stream:
            row = json.loads(line)
            if row.get('kind') == 'state':
                yield row


def units(row):
    alive = row['core']['alive_dots']
    if not isinstance(alive,list) or len(alive)!=len(set(alive)):
        raise ValueError('Invalid or duplicate alive unit IDs')
    result = {}
    for index,dot in enumerate(row['dots']):
        if dot is None:
            continue
        unit_id = dot.get('id', index)
        if isinstance(unit_id,bool) or not isinstance(unit_id,int) or unit_id<0 or unit_id in result:
            raise ValueError('Invalid or duplicate unit ID')
        if not isinstance(dot.get('health'),(int,float)) or not math.isfinite(dot['health']):
            raise ValueError('Missing or nonfinite health')
        if dot['health']>0:
            result[unit_id] = {k:v for k,v in dot.items() if k!='id'}
    if set(result)!=set(alive):
        raise ValueError('Alive IDs disagree with unit health')
    return result


def difference(actual,reference,path='state'):
    if isinstance(actual,(int,float)) and isinstance(reference,(int,float)) and not isinstance(actual,bool) and not isinstance(reference,bool):
        return None if math.isfinite(actual) and math.isfinite(reference) and actual==reference else (path,actual,reference)
    if type(actual)!=type(reference):
        return path,actual,reference
    if isinstance(actual,dict):
        if actual.keys()!=reference.keys():
            return path+'.keys',sorted(map(str,actual)),sorted(map(str,reference))
        for key in actual:
            diff=difference(actual[key],reference[key],path+'.'+str(key))
            if diff:return diff
        return None
    if isinstance(actual,list):
        if len(actual)!=len(reference):return path+'.length',len(actual),len(reference)
        for index,(a,r) in enumerate(zip(actual,reference)):
            diff=difference(a,r,path+'.'+str(index))
            if diff:return diff
        return None
    return None if actual==reference else (path,actual,reference)


def equivalent(actual,reference):
    """Apply difference's equality rules without constructing diagnostic paths."""
    actual_type=type(actual);reference_type=type(reference)
    if actual_type in (int,float) and reference_type in (int,float):
        return math.isfinite(actual) and math.isfinite(reference) and actual==reference
    if actual_type is not reference_type:return False
    if actual_type is dict:
        if actual.keys()!=reference.keys():return False
        return all(equivalent(value,reference[key]) for key,value in actual.items())
    if actual_type is list:
        return len(actual)==len(reference) and all(equivalent(a,r) for a,r in zip(actual,reference))
    return actual==reference


def compare(actual,reference,end):
    counts=collections.Counter()
    first=None
    checked=0
    actual_count=reference_count=0
    max_reference_living=0
    for expected,(a,r) in enumerate(itertools.zip_longest(states(actual),states(reference))):
        actual_count+=a is not None
        reference_count+=r is not None
        if r is not None:
            max_reference_living=max(max_reference_living,len(r.get('core',{}).get('alive_dots',[])))
        diff=None
        if a is None or r is None:
            diff=('frame_coverage',None if a is None else a['frame'],None if r is None else r['frame'])
        elif expected>end or a.get('frame')!=expected or r.get('frame')!=expected:
            diff=('frame_sequence',a.get('frame'),r.get('frame'))
        elif a.get('core',{}).get('frame')!=expected or r.get('core',{}).get('frame')!=expected:
            diff=('core_frame',a.get('core',{}).get('frame'),r.get('core',{}).get('frame'))
        elif any(a.get('compatibility',{}).get(k,0) for k in ('deferred_orders','pending_orders')):
            diff=('order_recovery',a['compatibility'],{})
        else:
            actual_state={'units':units(a),'core':a['core']}
            reference_state={'units':units(r),'core':r['core']}
            if not equivalent(actual_state,reference_state):
                diff=difference(actual_state,reference_state)
            checked+=1
        if diff:
            counts[diff[0]]+=1
            if first is None:
                first={'frame':expected,'field':diff[0],'actual':diff[1],'reference':diff[2]}
    if actual_count!=end+1 or reference_count!=end+1:
        counts['expected_frame_count']+=1
        if first is None:first={'field':'expected_frame_count','expected':end+1,'actual':actual_count,'reference':reference_count}
    return dict(passed=not counts,exact_full_state_parity=not counts,
        expected_frames=end+1,actual_frames=actual_count,reference_frames=reference_count,
        checked_frames=checked,position_tolerance=0,hp_tolerance=0,
        max_reference_living=max_reference_living,
        mismatches=dict(counts),first_difference=first)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('actual',type=Path)
    parser.add_argument('reference',type=Path)
    parser.add_argument('--end',type=int,required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    try:
        if args.end<0:raise ValueError('Negative end frame')
        result=compare(args.actual,args.reference,args.end)
    except (ValueError,KeyError,OSError,TypeError) as error:
        result={'passed':False,'exact_full_state_parity':False,'error':str(error)}
    result.update(actual=str(args.actual.resolve()),reference=str(args.reference.resolve()))
    for key,path in [('actual',args.actual),('reference',args.reference)]:
        if path.exists():
            with path.open('rb') as stream:
                result[key+'_sha256']=hashlib.file_digest(stream,'sha256').hexdigest()
    args.output.write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps(result,indent=2))
    return 0 if result['passed'] else 1


if __name__=='__main__':
    raise SystemExit(main())
