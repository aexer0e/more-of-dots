"""Verify local reference builds against Steam's cached depot manifests.

Format follows SteamKit's DepotManifest and ContentManifest protobuf schema.
Optional repair removes trailing bytes ONLY when the retained prefix exactly
matches the manifest's SHA-1 and size. Original bytes and receipts are preserved.
"""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import struct


def varint(data,position):
    result=0
    for shift in range(0,70,7):
        value=data[position];position+=1
        result|=(value&127)<<shift
        if value<128:return result,position
    raise ValueError('Invalid protobuf varint')


def fields(data):
    position=0
    while position<len(data):
        tag,position=varint(data,position)
        number,wire=tag>>3,tag&7
        if wire==0:value,position=varint(data,position)
        elif wire==2:
            size,position=varint(data,position);value=data[position:position+size];position+=size
        elif wire in (1,5):
            size=8 if wire==1 else 4;value=data[position:position+size];position+=size
        else:raise ValueError(f'Unsupported protobuf wire type {wire}')
        if position>len(data):raise ValueError('Truncated protobuf')
        yield number,value


def manifest(path):
    data=path.read_bytes();position=0;sections={}
    while position<len(data):
        magic,=struct.unpack_from('<I',data,position);position+=4
        if magic==0x32C415AB:break
        size,=struct.unpack_from('<I',data,position);position+=4
        sections[magic]=data[position:position+size];position+=size
    metadata=dict(fields(sections[0x1F4812BE]))
    if metadata.get(4,0):raise ValueError('Encrypted filenames in cached manifest')
    files=[]
    for number,mapping in fields(sections[0x71F617D0]):
        if number!=1:continue
        row=dict(fields(mapping))
        if row.get(3,0)&64:continue
        files.append({'path':row[1].decode('utf-8').replace('\\','/'),
                      'bytes':row.get(2,0),'sha1':row[5].hex()})
    return {'depot_id':metadata[1],'manifest_id':str(metadata[2]),'files':files}


def verify(directory,parsed,repair,backups):
    report={'directory':str(directory),'files':len(parsed['files']),'matched':0,'repaired':[],'errors':[]}
    for expected in parsed['files']:
        relative=Path(expected['path'])
        path=(directory/relative).resolve()
        if relative.is_absolute() or not path.is_relative_to(directory.resolve()):
            raise ValueError('Manifest path escaped build directory')
        if not path.is_file():
            report['errors'].append({'path':expected['path'],'error':'missing'});continue
        data=path.read_bytes()
        if len(data)==expected['bytes'] and hashlib.sha1(data).hexdigest()==expected['sha1']:
            report['matched']+=1;continue
        prefix=data[:expected['bytes']]
        if len(data)>expected['bytes'] and hashlib.sha1(prefix).hexdigest()==expected['sha1']:
            detail={'path':expected['path'],'actual_bytes':len(data),'expected_bytes':expected['bytes'],
                    'prefix_sha1_matches':True,'original_sha256':hashlib.sha256(data).hexdigest()}
            if repair:
                backup=(backups/relative).with_name(relative.name+'.original.gz')
                backup.parent.mkdir(parents=True,exist_ok=True)
                if not backup.exists():
                    with gzip.open(backup,'wb',compresslevel=1) as stream:stream.write(data)
                temporary=path.with_name(path.name+'.verified-prefix.tmp')
                temporary.write_bytes(prefix);temporary.replace(path)
                detail['backup']=str(backup)
                report['matched']+=1;report['repaired'].append(detail)
            else:
                report['errors'].append(detail|{'error':'authenticated prefix plus trailing bytes'})
        else:
            report['errors'].append({'path':expected['path'],'error':'content hash/size mismatch',
                                    'actual_bytes':len(data),'expected_bytes':expected['bytes']})
    report['passed']=report['matched']==report['files'] and not report['errors']
    return report


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root',type=Path,required=True)
    p.add_argument('--cache',type=Path,default=Path(r'C:\Program Files (x86)\Steam\depotcache'))
    p.add_argument('--repair-prefixes',action='store_true')
    p.add_argument('--label',action='append',help='Verify only named builds, preserving other build receipts in the report')
    a=p.parse_args();root=a.root.resolve();reports=[]
    for receipt_path in sorted((root/'versions').glob('*/parity-build.json')):
        if a.label and receipt_path.parent.name not in a.label:continue
        receipt=json.loads(receipt_path.read_text(encoding='utf-8'))
        cached=a.cache/f"3902431_{receipt['manifest_id']}.manifest"
        if not cached.exists():
            reports.append({'build':receipt_path.parent.name,'passed':False,'error':'cached manifest missing'});continue
        parsed=manifest(cached)
        if parsed['manifest_id']!=receipt['manifest_id'] or parsed['depot_id']!=3902431:
            raise ValueError('Cached manifest identity mismatch')
        report=verify(receipt_path.parent,parsed,a.repair_prefixes,root/'repair-backups'/receipt_path.parent.name)
        report['build']=receipt_path.parent.name
        reports.append(report)
        print(json.dumps({k:v for k,v in report.items() if k not in ('errors','repaired')}|{'repair_count':len(report['repaired']),'error_count':len(report['errors'])}),flush=True)
        if a.repair_prefixes and report['repaired']:
            original=receipt_path.with_name('parity-build-before-repair.json')
            if not original.exists():original.write_text(json.dumps(receipt,indent=2),encoding='utf-8')
            files=[]
            for expected in parsed['files']:
                path=receipt_path.parent/expected['path']
                if path.exists():files.append(dict(path=expected['path'],bytes=path.stat().st_size,sha256=hashlib.sha256(path.read_bytes()).hexdigest(),steam_sha1=expected['sha1']))
            receipt.update(files=files,file_count=len(files),game_exe_sha256=next(f['sha256'] for f in files if f['path']=='game.exe'),steam_manifest_verified=report['passed'])
            receipt_path.write_text(json.dumps(receipt,indent=2),encoding='utf-8')
        elif a.repair_prefixes and report['passed']:
            receipt['steam_manifest_verified']=True
            receipt_path.write_text(json.dumps(receipt,indent=2),encoding='utf-8')
    report_path=root/'build-integrity.json'
    saved=reports
    if a.label and report_path.exists():
        prior={r['build']:r for r in json.loads(report_path.read_text(encoding='utf-8'))}
        prior.update({r['build']:r for r in reports})
        saved=list(prior.values())
    report_path.write_text(json.dumps(saved,indent=2),encoding='utf-8')
    return 0 if all(r['passed'] for r in reports) else 1


if __name__=='__main__':raise SystemExit(main())
