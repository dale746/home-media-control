"""Computer downloads and idle-time, verified copies to Home Media media server."""
import ctypes
import datetime
import http.cookiejar
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
import urllib.error
from windows_paths import io_path, resolved_path

# Startup runs outside Codex's redirected AppData context. An installed helper
# carries its configuration beside it; source checkouts retain the old default.
ROOT=(pathlib.Path(os.environ['HMC_MEDIA_RUNTIME']) if os.environ.get('HMC_MEDIA_RUNTIME') else
      pathlib.Path(__file__).resolve().parent if (pathlib.Path(__file__).resolve().parent/'settings.json').is_file() else
      pathlib.Path(os.environ['LOCALAPPDATA'])/'HomeMediaControl')
CONFIG=json.loads((ROOT/'settings.json').read_text())
NO_WINDOW=0x08000000
STATE_FILE=ROOT/'status.json'
BUSY_CACHE={'checked':0,'busy':False}


def refresh_config():
    current=json.loads((ROOT/'settings.json').read_text())
    CONFIG.update(current)


def copy_paused():
    from control_state import read
    return read(ROOT).get('copyPaused',False)


def viewing_blocks_copy():
    return CONFIG.get('copy_pause_while_playing',True) and playing()

class Api:
    def __init__(self,base,headers=None,auth=None):
        self.base=base.rstrip('/')
        self.headers=headers or {}
        self.auth=auth
        self.opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def request(self,method,path,data=None,form=None,timeout=15,_can_reauth=True):
        headers=dict(self.headers)
        body=None
        if data is not None:
            body=json.dumps(data).encode();headers['Content-Type']='application/json'
        if form is not None:
            body=urllib.parse.urlencode(form).encode();headers['Content-Type']='application/x-www-form-urlencoded'
        req=urllib.request.Request(self.base+path,data=body,headers=headers,method=method)
        try:
            with self.opener.open(req,timeout=timeout) as response:
                value=response.read()
                if not value:return None
                try:return json.loads(value)
                except ValueError:return value
        except urllib.error.HTTPError as exc:
            if exc.code not in (401,403) or not self.auth or not _can_reauth or path=='/api/v2/auth/login':raise
            # A long checksum pass can outlive its downloader session. Renew
            # this client's cookie and retry the rejected request only once.
            exc.close()
            login=self.request('POST','/api/v2/auth/login',form=self.auth,timeout=timeout,_can_reauth=False)
            if login not in (b'Ok.',None):raise RuntimeError('Downloader sign-in was not accepted')
            return self.request(method,path,data=data,form=form,timeout=timeout,_can_reauth=False)

def qb_api():
    api=Api(CONFIG['api'],{'Origin':CONFIG['api'],'Referer':CONFIG['api'].rstrip('/')+'/'},
            auth={'username':CONFIG['username'],'password':CONFIG['password']})
    api.request('POST','/api/v2/auth/login',form={'username':CONFIG['username'],'password':CONFIG['password']})
    api.request('GET','/api/v2/app/version')
    return api

def ssh_options():
    return ['-i',CONFIG['key'],'-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',
            '-o','ConnectTimeout=10','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3']

def pi_python(source,timeout=90):
    # Windows pipe-reader threads can hang after a child is killed on timeout.
    # Regular temporary files keep the wait bounded even if another process holds a handle.
    with tempfile.TemporaryFile() as commands,tempfile.TemporaryFile() as output,tempfile.TemporaryFile() as errors:
        commands.write(source.encode('utf-8'));commands.seek(0)
        job=subprocess.Popen([CONFIG['ssh'],*ssh_options(),CONFIG['pi'],'python3','-'],
            stdin=commands,stdout=output,stderr=errors,creationflags=NO_WINDOW,close_fds=True)
        try:job.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            job.kill()
            try:job.wait(timeout=5)
            except subprocess.TimeoutExpired:pass
            raise TimeoutError('Media server command timed out') from None
        if job.returncode:raise RuntimeError('Media server connection or copy verification failed')
        output.seek(0)
        return output.read().decode('utf-8',errors='replace')

def state(value):
    value['updated']=datetime.datetime.now().astimezone().isoformat(timespec='minutes')
    temporary=STATE_FILE.with_suffix('.tmp')
    temporary.write_text(json.dumps(value,indent=2))
    temporary.replace(STATE_FILE)

def playing():
    authorization=('MediaBrowser Client="mediaadmin Media", Device="Computer", '
                   'DeviceId="hmc-computer-downloads", Version="1.0", '
                   'Token="'+CONFIG['jellyfin_token']+'"')
    api=Api('http://192.0.2.10:8096',{'Authorization':authorization})
    # Failure is conservative: no bulk copying while playback state is unknown.
    try:
        sessions=api.request('GET','/Sessions',timeout=8)
        return any(s.get('NowPlayingItem') and not s.get('PlayState',{}).get('IsPaused',False) for s in sessions)
    except Exception:
        return True

def checked_media_mount(path):
    if path not in ('/opt/media/data','/mnt/hmc-media-upgrade'):
        raise ValueError('Unexpected media mount')
    return path


def server_busy(media_mount='/opt/media/data'):
    checked_media_mount(media_mount)
    now=time.monotonic()
    if BUSY_CACHE.get('mount')==media_mount and now-BUSY_CACHE['checked']<30:return BUSY_CACHE['busy']
    try:
        report=json.loads(pi_python("import json,os,shutil,subprocess; p="+repr(media_mount)+"; m={l.split(':')[0]:int(l.split()[1]) for l in open('/proc/meminfo') if l.startswith('MemAvailable:')}; v=subprocess.run(['findmnt','-rn','-M',p,'-o','UUID'],capture_output=True,text=True).stdout.strip(); print(json.dumps({'load':os.getloadavg()[0],'availableKiB':m['MemAvailable'],'freeBytes':shutil.disk_usage(p).free,'volumeUUID':v}))",timeout=8))
        if CONFIG.get('pi_media_uuid') and report['volumeUUID']!=CONFIG['pi_media_uuid']:
            raise RuntimeError('Media drive is not mounted')
        threshold=3.5 if BUSY_CACHE['busy'] else 6
        busy=report['load']>threshold or report['availableKiB']<512*1024
        BUSY_CACHE['freeBytes']=report['freeBytes']
    except Exception:busy=True
    BUSY_CACHE.update(checked=now,busy=busy,mount=media_mount)
    return busy


def pi_storage_report(timeout=15,allow_staging=False):
    source="""import json,shutil,subprocess
def volume(path):return subprocess.run(['findmnt','-rn','-M',path,'-o','UUID'],capture_output=True,text=True).stdout.strip()
path='/opt/media/data'
stage='/mnt/hmc-media-upgrade'
if STAGING and volume(stage)==EXPECTED:path=stage
print(json.dumps({'free':shutil.disk_usage(path).free,'uuid':volume(path),'path':path}))
""".replace('STAGING',repr(bool(allow_staging and CONFIG.get('allow_staging_bulk',False)))).replace('EXPECTED',repr(CONFIG.get('pi_media_uuid')))
    report=json.loads(pi_python(source,timeout=timeout))
    if CONFIG.get('pi_media_uuid') and report['uuid']!=CONFIG['pi_media_uuid']:
        raise RuntimeError('Expected media drive is not mounted')
    return report


def upgrade_verified(report,expected):
    return bool(expected and report.get('phase')=='complete' and report.get('checksumVerified') is True
                and report.get('appsValidated') is True and report.get('ssdSourceRemoved') is True
                and report.get('filesystemUUID')==expected and report.get('mountedUUID')==expected)


def finish_storage_upgrade():
    if not CONFIG.get('hdd_upgrade_pending'):return False
    try:
        report=json.loads(pi_python("import json,subprocess; s=json.loads(subprocess.check_output(['sudo','-n','cat','/opt/media/config/storage-upgrade/state.json'],text=True)); s['mountedUUID']=subprocess.run(['findmnt','-rn','-M','/opt/media/data','-o','UUID'],capture_output=True,text=True).stdout.strip(); print(json.dumps(s))",timeout=10))
        save_to=ROOT/'storage-upgrade-status.json';temporary=save_to.with_suffix('.tmp');temporary.write_text(json.dumps(report,indent=2));temporary.replace(save_to)
        if not upgrade_verified(report,CONFIG.get('pi_media_uuid')):return False
        settings=ROOT/'settings.json';current=json.loads(settings.read_text())
        current.update(hdd_upgrade_pending=False,delete_pc_after_verified_import=True,allow_staging_bulk=False,use_pi_copy_plan=False)
        temporary=settings.with_suffix('.tmp');temporary.write_text(json.dumps(current,indent=2));temporary.replace(settings)
        CONFIG.update(current)
        pause=ROOT/'pause-copies'
        if pause.exists() and pause.read_text().startswith('Pi drive upgrade'):pause.unlink()
        return True
    except Exception:return False

def relative_files(qb,torrent):
    category=torrent['category']
    if category not in ('movies','tv'):raise ValueError('Unsupported category')
    save=pathlib.Path(torrent['save_path']).resolve()
    allowed_roots=[(pathlib.Path(root)/'torrents'/category).resolve()
                   for root in CONFIG.get('source_roots',[CONFIG['data']])]
    if save not in allowed_roots:raise ValueError('Unexpected download location')
    allowed=save
    files=qb.request('GET','/api/v2/torrents/files?'+urllib.parse.urlencode({'hash':torrent['hash']}))
    selected=[]
    for item in files:
        if item.get('priority',0)==0:continue
        relative=pathlib.PurePosixPath(item['name'].replace('\\','/'))
        if relative.is_absolute() or '..' in relative.parts or not relative.parts:
            raise ValueError('Unsafe torrent filename')
        local=resolved_path(save/pathlib.Path(*relative.parts))
        physical=io_path(local)
        if not local.is_relative_to(allowed) or not physical.is_file() or physical.stat().st_size!=item['size'] or item.get('progress',0)<1:
            raise ValueError('Download is not complete')
        selected.append({'name':relative.as_posix(),'size':item['size'],'local':str(local)})
    if not selected:raise ValueError('No completed files')
    return selected

def protect_storage(qb,torrents=None):
    """Keep every source drive's reserve, including during a long Pi copy."""
    roots=[pathlib.Path(root).resolve() for root in CONFIG.get('source_roots',[CONFIG['data']])]
    low=[root for root in roots if shutil.disk_usage(root).free<CONFIG['min_pc_free_gib']*1024**3]
    if not low:return []
    if torrents is None:torrents=qb.request('GET','/api/v2/torrents/info')
    held=[t['hash'] for t in torrents if t.get('category') in ('movies','tv') and t.get('progress',0)<1
          and not t['state'].startswith('stopped')
          and any(pathlib.Path(t['save_path']).resolve()==root/'torrents'/t['category'] for root in low)]
    if held:
        qb.request('POST','/api/v2/torrents/stop',form={'hashes':'|'.join(held)})
        path=ROOT/'storage-paused.json'
        saved=set(json.loads(path.read_text())) if path.exists() else set()
        temporary=path.with_name(path.name+'.'+str(os.getpid())+'.tmp');temporary.write_text(json.dumps(sorted(saved|set(held))));temporary.replace(path)
    return held


def transfer(qb,torrent,media_mount='/opt/media/data',rate_limit=None):
    checked_media_mount(media_mount)
    torrent_hash=torrent['hash'].lower()
    import media_hold
    if torrent_hash in media_hold.blocked(fresh=True)['hashes']:return 'held'
    if len(torrent_hash) not in (40,64) or any(c not in '0123456789abcdef' for c in torrent_hash):
        raise ValueError('Invalid torrent identifier')
    files=relative_files(qb,torrent)
    request={'hash':torrent_hash,'category':torrent['category'],
             'files':[{k:x[k] for k in ['name','size']} for x in files],
             'reserve':CONFIG['min_pi_free_gib']*1024**3,'volumeUUID':CONFIG.get('pi_media_uuid'),
             'mediaMount':media_mount}
    prep='''import json,pathlib,shutil,subprocess
p=json.loads(PAYLOAD)
data=pathlib.Path(p['mediaMount']);root=data/'torrents/pc'
if p.get('volumeUUID'):assert subprocess.check_output(['findmnt','-rn','-M',str(data),'-o','UUID'],text=True).strip()==p['volumeUUID'],'Media disk missing'
ready=root/'.ready'/(p['hash']+'.json')
if ready.exists():print(json.dumps({'status':'ready'}))
elif shutil.disk_usage(root).free < sum(x['size'] for x in p['files'])+p['reserve']:print(json.dumps({'status':'space'}))
else:
    incoming=root/'.incoming'/p['hash']
    for f in p['files']:(incoming/f['name']).parent.mkdir(parents=True,exist_ok=True)
    existing={f['name']:(incoming/f['name']).stat().st_size for f in p['files'] if (incoming/f['name']).is_file()}
    print(json.dumps({'status':'copy','existing':existing}))
'''.replace('PAYLOAD',repr(json.dumps(request)))
    response=json.loads(pi_python(prep))
    if response['status']!='copy':return response['status']
    progress_path=ROOT/'copy-progress.json'
    progress=json.loads(progress_path.read_text()) if progress_path.exists() else {}
    verified=progress.setdefault(torrent_hash,{})
    scp=str(pathlib.Path(CONFIG['ssh']).with_name('scp.exe'))
    for item in files:
        if verified.get(item['name'])==item['size'] and response['existing'].get(item['name'])==item['size']:continue
        destination=pathlib.PurePosixPath(media_mount)/'torrents/pc/.incoming'/torrent_hash/item['name']
        # Modern OpenSSH scp uses SFTP; arguments are never assembled as a shell command.
        rate_mib=rate_limit if rate_limit is not None else CONFIG.get('copy_limit_mib_per_second',4)
        if CONFIG.get('copy_engine')=='ssh-stream' and pathlib.Path(CONFIG.get('copy_ssh_executable','')).is_file():
            from fast_copy import launch
            job=launch(CONFIG,ssh_options(),item['local'],str(destination),media_mount,item['size'],
                       rate_mib*1024**2,CONFIG['min_pi_free_gib']*1024**3)
            engine='ssh-stream'
        else:
            rate=str(int(rate_mib*8192))
            job=subprocess.Popen([scp,*ssh_options(),'-l',rate,item['local'],CONFIG['pi']+':'+str(destination)],
                stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=NO_WINDOW)
            engine='scp'
        started=time.monotonic()
        next_storage_check=started
        while job.poll() is None:
            time.sleep(1)
            if job.poll() is not None:break
            refresh_config()
            if copy_paused():
                job.terminate();job.wait(timeout=15)
                return 'paused'
            if time.monotonic()>=next_storage_check:
                try: removal_held=torrent_hash in media_hold.blocked(fresh=True)['hashes']
                except Exception:
                    job.terminate();job.wait(timeout=15)
                    raise RuntimeError('Holding safety check unavailable; original computer file retained') from None
                if removal_held:
                    job.terminate();job.wait(timeout=15);return 'held'
                protect_storage(qb)
                state({'status':'Copying completed download to media server','title':torrent['name'],
                       'hash':torrent_hash,'file':item['name'],'filesCompleted':files.index(item),
                       'filesTotal':len(files),'elapsedSeconds':round(time.monotonic()-started),'engine':engine})
                next_storage_check=time.monotonic()+30
            low_space=BUSY_CACHE.get('freeBytes',2**63)<(CONFIG['min_pi_free_gib']+1)*1024**3
            if low_space:
                job.terminate();job.wait(timeout=15)
                return 'space'
            if viewing_blocks_copy() or server_busy(media_mount) or time.monotonic()-started>12*3600:
                job.terminate();job.wait(timeout=15)
                return 'viewing'
        if job.returncode:raise RuntimeError('Transfer interrupted; original computer file retained')
        verified[item['name']]=item['size']
        temporary=progress_path.with_suffix('.tmp');temporary.write_text(json.dumps(progress));temporary.replace(progress_path)
    if torrent_hash in media_hold.blocked(fresh=True)['hashes']:return 'held'
    finish='''import json,pathlib,os,subprocess
p=json.loads(PAYLOAD)
data=pathlib.Path(p['mediaMount']);root=data/'torrents/pc'
if p.get('volumeUUID'):assert subprocess.check_output(['findmnt','-rn','-M',str(data),'-o','UUID'],text=True).strip()==p['volumeUUID'],'Media disk missing'
incoming=root/'.incoming'/p['hash']
for f in p['files']:
    source=incoming/f['name']
    assert source.is_file() and source.stat().st_size==f['size'],'Incomplete copy'
for f in p['files']:
    source=incoming/f['name'];target=root/p['category']/f['name']
    target.parent.mkdir(parents=True,exist_ok=True)
    if target.exists():assert target.is_file() and target.stat().st_size==f['size'],'Conflicting existing file'
    else:os.replace(source,target)
marker=root/'.ready'/(p['hash']+'.json')
temporary=marker.with_suffix('.tmp');temporary.write_text(json.dumps(p));os.replace(temporary,marker)
print('ready')
'''.replace('PAYLOAD',repr(json.dumps(request)))
    return pi_python(finish).strip()

def main():
    import msvcrt
    lock=(ROOT/'worker.lock').open('a+b')
    try:msvcrt.locking(lock.fileno(),msvcrt.LK_NBLCK,1)
    except OSError:lock.close();return
    tunnel=None
    qb_process=None
    log=(ROOT/'logs'/'worker.log').open('a',encoding='utf-8',buffering=1)
    copied_path=ROOT/'copied.json'
    copied=json.loads(copied_path.read_text()) if copied_path.exists() else {}
    errors_path=ROOT/'copy-errors.json'
    copy_errors=json.loads(errors_path.read_text()) if errors_path.exists() else {}
    next_catalogue_check=time.monotonic()+120
    while True:
        if (ROOT/'server-move-hold.json').exists():
            try: message=json.loads((ROOT/'server-move-hold.json').read_text()).get('message','Server move in progress')
            except (OSError,ValueError): message='Server move in progress'
            state({'status':message});time.sleep(5);continue
        try:
            refresh_config()
            try:qb=qb_api()
            except Exception:
                if qb_process is None or qb_process.poll() is not None:
                    qb_process=subprocess.Popen([CONFIG['exe'],'--profile='+CONFIG['profile'],'--confirm-legal-notice','--no-splash'],
                        stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=NO_WINDOW)
                time.sleep(10)
                continue
            if tunnel is None or tunnel.poll() is not None:
                from fast_copy import OwnedProcess
                tunnel=OwnedProcess(subprocess.Popen([CONFIG['ssh'],*ssh_options(),'-o','ExitOnForwardFailure=yes','-N','-T',
                    '-R','127.0.0.1:18080:127.0.0.1:18080',CONFIG['pi']],
                    stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=NO_WINDOW))
            if CONFIG.get('hdd_upgrade_pending'):
                raise RuntimeError('Storage migration is not part of this preview')
            torrents=qb.request('GET','/api/v2/torrents/info')
            free=shutil.disk_usage(CONFIG['data']).free/1024**3
            working=[t for t in torrents if t.get('category') in ('movies','tv') and t.get('progress',0)<1 and not t['state'].startswith('stopped')]
            storage_hold=free<CONFIG['min_pc_free_gib']
            held=protect_storage(qb,torrents)
            working=[t for t in working if t['hash'] not in held]
            waiting=[t for t in torrents if t.get('category') in ('movies','tv') and t.get('progress',0)>=1 and t['hash'] not in copied]
            import media_hold
            removal_holds=set(media_hold.blocked()['hashes'])
            waiting=[t for t in waiting if t['hash'] not in removal_holds]
            ctypes.windll.kernel32.SetThreadExecutionState(0x80000001 if working or waiting else 0x80000000)
            copies_paused=(ROOT/'pause-copies').exists() or copy_paused()
            busy=False if copies_paused else server_busy()
            is_playing=True if copies_paused or busy else viewing_blocks_copy()
            state({'status':'Transfers paused while the media server catches up' if copies_paused or busy else ('Waiting for viewing to finish before copying' if is_playing and waiting else ('Computer storage reserve; completed files can still copy' if storage_hold else 'Running')),
                'activeDownloads':sum(t['state'] in ('downloading','forcedDL') for t in torrents),
                'queuedDownloads':sum(t['state']=='queuedDL' for t in torrents),'downloadsPausedForStorage':storage_hold,
                'waitingForCopy':len(waiting),'copied':len(copied),'freeGiB':round(free,1)})
            ready_to_copy=[t for t in waiting if copy_errors.get(t['hash'],{}).get('retryAt',0)<=time.time()]
            plan_path=ROOT/'pi-copy-plan.json'
            if plan_path.exists() and CONFIG.get('use_pi_copy_plan',True):
                plan=json.loads(plan_path.read_text())
                order={h:i for i,h in enumerate(plan.get('order',[]))}
                excluded=set(plan.get('excluded',[]))
                ready_to_copy=[t for t in ready_to_copy if t['hash'] not in excluded]
                ready_to_copy.sort(key=lambda t:order.get(t['hash'],len(order)))
            free_on_pi=BUSY_CACHE.get('freeBytes')
            if free_on_pi is not None:
                budget=free_on_pi-(CONFIG['min_pi_free_gib']+1)*1024**3
                ready_to_copy=[t for t in ready_to_copy if t.get('size',0)<=budget]
            if not is_playing and CONFIG.get('delete_pc_after_verified_import'):
                from pc_cleanup import run_one as cleanup_one
                state({'status':'Verifying HDD files before computer cleanup','waitingForCopy':len(waiting)})
                cleanup=cleanup_one(qb,CONFIG,ROOT,pi_python,relative_files)
                cleanup.update(updated=datetime.datetime.now().astimezone().isoformat(timespec='minutes'))
                temporary=ROOT/'cleanup-status.tmp';temporary.write_text(json.dumps(cleanup,indent=2));temporary.replace(ROOT/'cleanup-status.json')
            if ready_to_copy and not is_playing:
                item=ready_to_copy[0]
                state({'status':'Copying completed download to media server','title':item['name'],'waitingForCopy':len(waiting)})
                try:
                    result=transfer(qb,item)
                except Exception as exc:
                    # A bad path/file belongs to one job; keep the other completed jobs moving.
                    copy_errors[item['hash']]={'title':item['name'],'reason':str(exc)[:180],
                                               'type':type(exc).__name__,'retryAt':time.time()+600}
                    temporary=errors_path.with_suffix('.tmp');temporary.write_text(json.dumps(copy_errors,indent=2));temporary.replace(errors_path)
                    log.write('Copy deferred for '+item['hash']+': '+type(exc).__name__+': '+str(exc)[:180]+'\n')
                    state({'status':'One copy deferred; other completed files will continue','title':item['name'],
                           'reason':type(exc).__name__,'waitingForCopy':len(waiting)})
                    result='deferred'
                if result=='ready':
                    copied[item['hash']]={'title':item['name'],'time':time.time()}
                    temporary=copied_path.with_suffix('.tmp');temporary.write_text(json.dumps(copied,indent=2));temporary.replace(copied_path)
                    if copy_errors.pop(item['hash'],None):
                        temporary=errors_path.with_suffix('.tmp');temporary.write_text(json.dumps(copy_errors,indent=2));temporary.replace(errors_path)
                    log.write('Completed transfer verified; originals retained\n')
                elif result=='space':
                    state({'status':'Media server storage reserve reached; completed files retained on computer'})
            if not is_playing and time.monotonic()>=next_catalogue_check:
                next_catalogue_check=time.monotonic()+1800
                if (ROOT/'fresh_requests.py').exists():
                    try:
                        from fresh_requests import run as request_fresh
                        from fresh_collection import run as update_collection
                        report=request_fresh()
                        collection=update_collection()
                        (ROOT/'catalogue-status.json').write_text(json.dumps({'requests':report,'collection':collection},indent=2))
                        log.write('Catalogue check: '+report.get('status','complete')+'\n')
                    except Exception as exc:
                        log.write('Catalogue check deferred: '+type(exc).__name__+'\n')
            if '--once' in sys.argv:log.close();lock.close();return
            time.sleep(30)
        except Exception as exc:
            log.write(type(exc).__name__+': '+str(exc)[:180]+'\n')
            state({'status':'Connection unavailable; retrying safely','reason':type(exc).__name__})
            if '--once' in sys.argv:log.close();lock.close();raise
            time.sleep(30)

if __name__=='__main__':main()
