"""Delete only individually verified managed download files after HDD import."""
import ctypes
import hashlib
import json
import pathlib
import re
import time
import urllib.parse
from windows_paths import io_path, resolved_path

VIDEO={'.mkv','.mp4','.m4v','.avi','.mov','.ts','.m2ts','.webm'}


def volume_guid(path):
    anchor=pathlib.Path(path).resolve().anchor
    value=ctypes.create_unicode_buffer(1024)
    function=ctypes.windll.kernel32.GetVolumeNameForVolumeMountPointW
    function.argtypes=[ctypes.c_wchar_p,ctypes.POINTER(ctypes.c_wchar),ctypes.c_uint]
    if not function(anchor,value,len(value)):
        raise OSError('Cannot identify source volume')
    return value.value.casefold()


def checked_local(path,category,cfg):
    assert category in ('movies','tv')
    result=resolved_path(path)
    allowed=[(pathlib.Path(root)/'torrents'/category).resolve() for root in cfg['source_roots']]
    base=next((root for root in allowed if result.is_relative_to(root) and result!=root),None)
    if base is None:raise ValueError('Cleanup path is outside the managed downloads')
    expected=cfg['source_volume_guids'].get(base.anchor.casefold())
    if not expected or volume_guid(base)!=expected:raise ValueError('Source drive identity changed')
    return result,base


def digest(path):
    value=hashlib.sha256()
    with io_path(path).open('rb') as stream:
        for data in iter(lambda:stream.read(8*1024**2),b''):value.update(data)
    return value.hexdigest()


def save(path,value):
    temp=path.with_suffix('.tmp');temp.write_text(json.dumps(value,indent=2));temp.replace(path)


def delete_verified_files(record,cfg,persist=lambda:None):
    removed=0
    for item in record['files']:
        path,base=checked_local(item['local'],record['category'],cfg)
        if item.get('deleted'):continue
        physical=io_path(path)
        if physical.exists():
            if not physical.is_file() or physical.stat().st_size!=item['size'] or digest(path)!=item['sha256']:
                raise ValueError('Computer file changed after verification; retained')
            # Only this exact file is removed. Unmatched files and sibling folders are preserved.
            physical.unlink();removed+=item['size']
            parent=path.parent
            while parent!=base and parent.is_relative_to(base):
                try:io_path(parent).rmdir()
                except OSError:break
                parent=parent.parent
        item['deleted']=True;persist()
    return removed


REMOTE='''import hashlib,json,pathlib,subprocess,time
import os
os.nice(10)
subprocess.run(['ionice','-c','2','-n','7','-p',str(os.getpid())],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=False)
p=json.loads(PAYLOAD)
data=pathlib.Path('/opt/media/data')
root=data/'torrents/pc'
def check_volume():
 value=subprocess.check_output(['findmnt','-rn','-M',str(data),'-o','UUID'],text=True).strip()
 assert value==p['uuid'],'Media drive identity mismatch'
check_volume()
assert (root/'.ready'/(p['hash']+'.json')).is_file(),'Copy is not ready'
files=[]
for item in p['files']:
 relative=pathlib.PurePosixPath(item['name'])
 assert not relative.is_absolute() and '..' not in relative.parts
 path=(root/p['category']/relative).resolve()
 assert path.is_relative_to(root/p['category']) and path.is_file()
 info=path.stat()
 assert info.st_dev==data.stat().st_dev and info.st_size==item['size']
 if item['name'] in p['primary'] and info.st_nlink<2:
  print(json.dumps({'status':'awaiting-import','file':item['name']}));raise SystemExit(0)
 files.append((item,path))
cache_dir=root/'.verified';cache_dir.mkdir(exist_ok=True)
cache_path=cache_dir/(p['hash']+'.json')
cache=json.loads(cache_path.read_text()) if cache_path.exists() else {}
out={}
for item,path in files:
 check_volume();before=path.stat()
 stamp=[before.st_size,before.st_mtime_ns,before.st_ctime_ns,before.st_ino,before.st_dev]
 old=cache.get(item['name'],{})
 if old.get('stamp')==stamp and old.get('sha256'):value=old['sha256']
 else:
  h=hashlib.sha256();started=time.monotonic();total=0
  with path.open('rb') as stream:
   for block in iter(lambda:stream.read(4*1024**2),b''):
    h.update(block);total+=len(block)
    delay=total/(64*1024**2)-(time.monotonic()-started)
    if delay>0:time.sleep(delay)
  after=path.stat()
  assert [after.st_size,after.st_mtime_ns,after.st_ctime_ns,after.st_ino,after.st_dev]==stamp,'HDD file changed'
  value=h.hexdigest();cache[item['name']]={'stamp':stamp,'sha256':value}
  temp=cache_path.with_suffix('.tmp');temp.write_text(json.dumps(cache));temp.replace(cache_path)
 out[item['name']]=value
check_volume()
print(json.dumps({'status':'verified','uuid':p['uuid'],'sha256':out}))
'''


def _run_one(qb,cfg,root,remote,relative_files):
    if not cfg.get('delete_pc_after_verified_import') or not cfg.get('pi_media_uuid'):return {'status':'Cleanup disabled'}
    root=pathlib.Path(root);path=root/'pc-cleanup.json'
    book=json.loads(path.read_text()) if path.exists() else {}
    torrents=qb.request('GET','/api/v2/torrents/info')
    copied=json.loads((root/'copied.json').read_text())
    by_hash={t['hash']:t for t in torrents}
    pending=next(((h,r) for h,r in book.items() if r.get('status')=='deleting' and r.get('retryAt',0)<=time.time()),None)
    if pending:
        torrent_hash,record=pending
        record['retryAt']=time.time()+300;save(path,book)
        # A crash after removing the job is safe: verified file records survive and resume here.
        check=json.loads(remote("import subprocess,json;print(json.dumps({'uuid':subprocess.check_output(['findmnt','-rn','-M','/opt/media/data','-o','UUID'],text=True).strip()}))",timeout=15))
        assert check['uuid']==cfg['pi_media_uuid']
        if torrent_hash in by_hash:qb.request('POST','/api/v2/torrents/delete',form={'hashes':torrent_hash,'deleteFiles':'false'})
        removed=delete_verified_files(record,cfg,lambda:save(path,book))
        record.update(status='cleaned',finished=time.time());save(path,book)
        return {'status':'Verified computer copy removed','title':record['title'],'bytesRemoved':removed}
    candidates=[t for t in torrents if t['hash'] in copied and t.get('progress',0)>=1 and t.get('category') in ('movies','tv')
                and book.get(t['hash'],{}).get('retryAt',0)<=time.time()]
    candidates.sort(key=lambda t:copied[t['hash']].get('time',0))
    if not candidates:return {'status':'No imported computer copies waiting'}
    torrent=candidates[0];torrent_hash=torrent['hash']
    book[torrent_hash]={'status':'checking','retryAt':time.time()+300,'title':torrent['name']};save(path,book)
    assert re.fullmatch(r'[0-9a-f]{40}|[0-9a-f]{64}',torrent_hash)
    files=relative_files(qb,torrent)
    for f in files:checked_local(f['local'],torrent['category'],cfg)
    # Shared download paths are retained until they can be handled as a verified group.
    for other in torrents:
        if other['hash']==torrent_hash or not other.get('content_path'):continue
        content=resolved_path(other['content_path'])
        if any(resolved_path(f['local'])==content or resolved_path(f['local']).is_relative_to(content) for f in files):
            other_files=qb.request('GET','/api/v2/torrents/files?'+urllib.parse.urlencode({'hash':other['hash']}))
            other_paths=set()
            for entry in other_files:
                relative=pathlib.PurePosixPath(entry['name'].replace('\\','/'))
                if relative.is_absolute() or '..' in relative.parts:continue
                if entry.get('priority',0)>0:other_paths.add(resolved_path(pathlib.Path(other['save_path'])/pathlib.Path(*relative.parts)))
            if other_paths.intersection(resolved_path(f['local']) for f in files):
                book[torrent_hash]={'status':'shared-source','retryAt':time.time()+3600,'title':torrent['name']};save(path,book)
                return {'status':'Shared source retained','title':torrent['name']}
    videos=[f for f in files if pathlib.Path(f['name']).suffix.lower() in VIDEO and not re.search(r'(?i)sample|trailer',f['name'])]
    primary=[max(videos,key=lambda f:f['size'])['name']] if torrent['category']=='movies' and videos else [f['name'] for f in videos if re.search(r'(?i)S0?1E\d|1x\d',f['name'])]
    if not primary and videos:primary=[max(videos,key=lambda f:f['size'])['name']]
    request={'hash':torrent_hash,'category':torrent['category'],'uuid':cfg['pi_media_uuid'],
             'files':[{'name':f['name'],'size':f['size']} for f in files],'primary':primary}
    timeout=max(120,int(sum(f['size'] for f in files)/(15*1024**2))+90)
    report=json.loads(remote(REMOTE.replace('PAYLOAD',repr(json.dumps(request))),timeout=timeout))
    if report['status']!='verified':
        book[torrent_hash]={'status':report['status'],'retryAt':time.time()+300,'title':torrent['name']};save(path,book)
        return {'status':'Waiting for library import','title':torrent['name']}
    assert report['uuid']==cfg['pi_media_uuid']
    qb.request('POST','/api/v2/torrents/stop',form={'hashes':torrent_hash})
    for f in files:
        f['sha256']=digest(f['local'])
        assert f['sha256']==report['sha256'][f['name']],'Checksums differ; computer copy retained'
    recovery=root/'cleanup-recovery';recovery.mkdir(exist_ok=True)
    exported=qb.request('GET','/api/v2/torrents/export?'+urllib.parse.urlencode({'hash':torrent_hash}))
    if not isinstance(exported,bytes):raise ValueError('Cannot save torrent recovery record')
    (recovery/(torrent_hash+'.torrent')).write_bytes(exported)
    record={'status':'deleting','title':torrent['name'],'category':torrent['category'],
            'verifiedAt':time.time(),'piUUID':report['uuid'],'files':files}
    book[torrent_hash]=record;save(path,book)
    qb.request('POST','/api/v2/torrents/delete',form={'hashes':torrent_hash,'deleteFiles':'false'})
    removed=delete_verified_files(record,cfg,lambda:save(path,book))
    record.update(status='cleaned',finished=time.time());save(path,book)
    return {'status':'Verified computer copy removed','title':torrent['name'],'bytesRemoved':removed}


def run_one(qb,cfg,root,remote,relative_files):
    try:return _run_one(qb,cfg,root,remote,relative_files)
    except Exception as exc:
        return {'status':'Cleanup deferred; computer files retained','reason':type(exc).__name__+': '+str(exc)[:160]}
