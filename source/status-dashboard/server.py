"""Local, read-only operational dashboard for Home Media media machines."""
import collections,copy,ctypes,datetime,http.server,json,os,pathlib,re,secrets,subprocess,sys,threading,time,urllib.parse

BASE=pathlib.Path(__file__).resolve().parent
ROOT=pathlib.Path(os.environ['HMC_MEDIA_RUNTIME']) if os.environ.get('HMC_MEDIA_RUNTIME') else (BASE.parent if (BASE.parent/'worker.py').is_file() and (BASE.parent/'settings.json').is_file() else pathlib.Path.home()/'AppData/Local/HomeMediaControl')
# The same installed files must load outside the packaged desktop app, where
# Windows' redirected AppData paths are no longer visible under their aliases.
os.environ['HMC_MEDIA_RUNTIME']=str(ROOT)
sys.path.insert(0,str(ROOT))
import worker
import actions,control_state,server_power
from progress_model import matching_copy_bytes,transfer_totals

DATA=ROOT/'status-dashboard';DATA.mkdir(exist_ok=True)
LOCK=threading.RLock()
SNAPSHOT={'updated':time.time(),'starting':True}
EVENT_FILE=DATA/'events.json'
CONTROL_TOKEN=secrets.token_urlsafe(32)
ALLOWED_ORIGINS={'http://127.0.0.1:18090','http://localhost:18090'}


def read_json(path,default=None):
    try:return json.loads(pathlib.Path(path).read_text(encoding='utf-8-sig'))
    except (OSError,ValueError):return default if default is not None else {}


EVENTS=read_json(EVENT_FILE,[])


def event(key,message,level='info',timestamp=None):
    with LOCK:
        if any(item['key']==key for item in EVENTS):return
        EVENTS.append({'key':key,'message':message,'level':level,'time':timestamp or time.time()})
        del EVENTS[:-80]
        temporary=EVENT_FILE.with_suffix('.tmp');temporary.write_text(json.dumps(EVENTS));temporary.replace(EVENT_FILE)


PI_SOURCE=r'''import json,os,pathlib,platform,socket,subprocess,time
p=json.loads(INPUT_PAYLOAD)
def cmd(args):
 try:
  r=subprocess.run(args,capture_output=True,text=True,timeout=4)
  return r.stdout.strip() if r.returncode==0 else ''
 except Exception:return ''
def mount(path):
 value=cmd(['findmnt','-rn','-M',path,'-o','UUID,OPTIONS']).split(None,1)
 return {'uuid':value[0] if value else '', 'options':value[1] if len(value)>1 else ''}
expected=p['uuid'];stage='/mnt/hmc-media-upgrade';live='/opt/media/data'
mounts={path:mount(path) for path in (stage,live)}
chosen=next((path for path,item in mounts.items() if item['uuid']==expected),None)
healthy=bool(chosen and not any(flag in mounts[chosen]['options'].split(',') for flag in ('ro','emergency_ro','shutdown')))
identity=cmd(['sudo','-n','/usr/local/sbin/hmc-media-check-storage'])
try: device=json.loads(identity).get('serial')=='EXAMPLE-DISK-SERIAL'
except (ValueError,AttributeError): device=cmd(['lsblk','-dn','-o','SERIAL','/dev/disk/by-id/wwn-0x0000000000000000'])=='EXAMPLE-DISK-SERIAL'
healthy=bool(healthy and device)
disk={'connected':device,'available':healthy,'mount':chosen,'mounts':mounts}
if healthy:
 try:
  stat=os.statvfs(chosen);disk.update(total=stat.f_frsize*stat.f_blocks,free=stat.f_frsize*stat.f_bavail)
  os.stat(chosen+'/torrents/pc')
 except OSError as exc:disk.update(available=False,error=str(exc))
copybytes=None
active=p.get('copy',{})
if healthy and active.get('hash') and len(active['hash']) in (40,64) and all(c in '0123456789abcdef' for c in active['hash']):
 relative=pathlib.PurePosixPath(active.get('file',''))
 if relative.parts and not relative.is_absolute() and '..' not in relative.parts:
  target=pathlib.Path(chosen)/'torrents/pc/.incoming'/active['hash']/relative
  try:copybytes=target.stat().st_size
  except OSError:pass
memory={}
for line in open('/proc/meminfo'):
 key,value=line.split(':',1)
 if key in ('MemTotal','MemAvailable'):memory[key]=int(value.split()[0])*1024
cpu=list(map(int,pathlib.Path('/proc/stat').read_text().splitlines()[0].split()[1:]))
try:temperature=int(pathlib.Path('/sys/class/thermal/thermal_zone0/temp').read_text())/1000
except OSError:temperature=None
state=cmd(['sudo','-n','cat','/opt/media/config/storage-upgrade/state.json'])
try:state=json.loads(state)
except ValueError:state={}
root=os.statvfs('/')
services=cmd(['sudo','-n','docker','ps','--format','{{.Names}}|{{.Status}}'])
kernel=cmd(['sudo','-n','journalctl','-k','-b','--no-pager','-o','short-iso','--grep=USB disconnect|Aborting journal','-n','5'])
print(json.dumps({'reachable':True,'checked':time.time(),'hostname':socket.gethostname(),'architecture':platform.machine(),
 'bootId':pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip(),'drive':disk,'copyBytes':copybytes,
 'copyHash':active.get('hash'),'copyFile':active.get('file'),
 'temperature':temperature,'load':os.getloadavg()[0],'memory':memory,
 'cpuTotal':sum(cpu),'cpuIdle':cpu[3]+cpu[4],'upgrade':state,
 'systemDisk':{'total':root.f_frsize*root.f_blocks,'free':root.f_frsize*root.f_bavail},
 'services':[line.split('|',1) for line in services.splitlines() if '|' in line],
 'kernelMessages':kernel.splitlines() if kernel else []}))
'''


def windows_disks(cfg):
    import shutil
    out=[]
    mask=ctypes.windll.kernel32.GetLogicalDrives()
    for index in range(26):
        if not mask&(1<<index):continue
        letter=chr(65+index);path=letter+':\\'
        if ctypes.windll.kernel32.GetDriveTypeW(path)!=3:continue
        try:
            stat=shutil.disk_usage(path);label=ctypes.create_unicode_buffer(261)
            ctypes.windll.kernel32.GetVolumeInformationW(path,label,261,None,None,None,None,0)
            out.append({'name':letter+':','label':label.value or ('Windows' if letter=='C' else 'Storage'),
                        'total':stat.total,'free':stat.free,
                        'downloads':pathlib.Path(cfg['data']).anchor.casefold()==path.casefold()})
        except OSError:pass
    return out


class CopyRate:
    def __init__(self):
        self.key=None;self.samples=collections.deque(maxlen=8);self.rate=0;self.measured_at=0
    def observe(self,key,size,observed,now,active):
        if not active:
            self.samples.clear();self.rate=0;self.key=None;return 0
        if size is not None and key and all(key):
            if key!=self.key:self.samples.clear();self.key=key
            if self.samples and size<self.samples[-1][1]:self.samples.clear();self.rate=0
            if not self.samples or observed>self.samples[-1][0]:
                self.samples.append((observed,size))
                if len(self.samples)>1:
                    elapsed=observed-self.samples[0][0]
                    if elapsed>0:
                        self.rate=max(0,(size-self.samples[0][1])/elapsed);self.measured_at=now
        return self.rate if now-self.measured_at<30 else 0


def collect():
    global SNAPSHOT
    previous_pi={};meter=CopyRate();previous_cpu=None;qb=None
    next_pi=next_disks=0;pi={};disks=[];sessions=[];counts={};files_cache={};pi_jobs=[]
    while True:
        started=time.monotonic();now=time.time();cfg=read_json(ROOT/'settings.json')
        status=read_json(ROOT/'status.json')
        copied=read_json(ROOT/'copied.json');cleanup=read_json(ROOT/'pc-cleanup.json')
        copy_errors=read_json(ROOT/'copy-errors.json')
        jobs=[];qb_error=None
        try:
            if qb is None:qb=worker.qb_api()
            jobs=[item for item in qb.request('GET','/api/v2/torrents/info',timeout=3) if item.get('category') in ('movies','tv')]
        except Exception as exc:qb_error=type(exc).__name__;qb=None
        try:controls=actions.reconcile(qb,jobs)
        except Exception:controls=actions.public_controls()
        by_hash={item['hash']:item for item in jobs}
        current=by_hash.get(status.get('hash'),{})
        current_file=status.get('file','');file_total=None
        if current and current_file:
            key=current['hash']
            try:
                if key not in files_cache:files_cache[key]=qb.request('GET','/api/v2/torrents/files?hash='+key,timeout=3)
                file_total=next((f['size'] for f in files_cache[key] if f['name'].replace('\\','/')==current_file),None)
            except Exception:pass
        if time.monotonic()>=next_pi:
            next_pi=time.monotonic()+5
            payload={'uuid':cfg['pi_media_uuid'],'copy':{'hash':current.get('hash'),'file':current_file}}
            try:
                pi=json.loads(worker.pi_python(PI_SOURCE.replace('INPUT_PAYLOAD',repr(json.dumps(payload))),timeout=10))
                if previous_cpu:
                    total=pi['cpuTotal']-previous_cpu[0];idle=pi['cpuIdle']-previous_cpu[1]
                    pi['cpuPercent']=round(100*(1-idle/total),1) if total>0 else None
                previous_cpu=(pi['cpuTotal'],pi['cpuIdle'])
                old_drive=previous_pi.get('drive',{})
                if previous_pi and not previous_pi.get('reachable'):event('pi-back-'+str(int(now)),'media server connection restored','good')
                if previous_pi and old_drive.get('available') and not pi['drive']['available']:
                    event('drive-down-'+str(int(now)),'media server media drive disconnected — transfers paused','bad')
                if previous_pi and not old_drive.get('available') and pi['drive']['available']:
                    event('drive-back-'+str(int(now)),'media server media drive reconnected','good')
                for line in pi.get('kernelMessages',[]):
                    if 'USB disconnect' in line:
                        try:stamp=datetime.datetime.fromisoformat(line.split()[0]).timestamp()
                        except ValueError:stamp=now
                        event('kernel-'+line,'USB drive interruption recorded on the media server','warn',stamp)
                previous_pi=copy.deepcopy(pi)
            except Exception as exc:
                if previous_pi.get('reachable'):event('pi-down-'+str(int(now)),'Detailed server status check interrupted; retrying','warn')
                pi=copy.deepcopy(previous_pi);pi.update(reachable=False,error=type(exc).__name__,checked=now)
                pi=server_power.identity_after_health_failure(pi)
                previous_pi=copy.deepcopy(pi)
            try:
                auth='MediaBrowser Client="Status screen", Device="Computer", DeviceId="status-screen", Version="1.0", Token="'+cfg['jellyfin_token']+'"'
                jellyfin=worker.Api('http://192.0.2.10:8096',{'Authorization':auth})
                raw=jellyfin.request('GET','/Sessions',timeout=3)
                sessions=[{'device':item.get('DeviceName') or item.get('Client','Player'),
                           'title':item['NowPlayingItem'].get('Name','Playing'),
                           'paused':item.get('PlayState',{}).get('IsPaused',False),
                           'method':item.get('PlayState',{}).get('PlayMethod','')} for item in raw if item.get('NowPlayingItem')]
                counts=jellyfin.request('GET','/Items/Counts',timeout=3)
                pi['jellyfinReachable']=True
            except Exception:sessions=[];pi['jellyfinReachable']=False
            try:
                if 'qbittorrent' in dict(pi.get('services',[])):
                    pi_api=actions.qb('pi');pi_jobs=[item for item in pi_api.request('GET','/api/v2/torrents/info',timeout=3) if item.get('category') in ('movies','tv','bulk-movies','bulk-tv')]
                else:pi_jobs=[]
            except Exception:pi_jobs=[]
        if time.monotonic()>=next_disks:
            disks=windows_disks(cfg);next_disks=time.monotonic()+20
        copy_active=not (ROOT/'server-move-hold.json').exists() and status.get('status','').startswith('Copying') and pi.get('reachable') and pi.get('drive',{}).get('available') and not controls['state']['copyPaused']
        # Keep the last measured rate briefly between files. The progress book
        # can contain older copies, so it is never used as a throughput counter.
        copy_bytes=matching_copy_bytes(status,pi)
        speed=meter.observe((current.get('hash'),current_file),copy_bytes,
                            pi.get('checked',now),time.monotonic(),copy_active)
        totals=transfer_totals(jobs,copied,status,files_cache.get(current.get('hash'),[]),copy_bytes,copy_active)
        remaining_bytes=totals['remainingBytes']
        records=[]
        for item in [dict(value,machine='pc') for value in jobs]+[dict(value,machine='pi') for value in pi_jobs]:
            state=item.get('state','');progress=item.get('progress',0)
            paused=state.startswith(('stopped','paused'))
            label='Paused' if paused and progress<1 else ('Downloading' if item.get('dlspeed',0)>0 and progress<1 else ('Waiting for sources' if progress<1 and 'stalled' in state.lower() else ('Queued' if progress<1 else ('On the media server' if item['machine']=='pi' else ('Copied to media server' if item['hash'] in copied else 'Waiting for media server transfer')))))
            issue=copy_errors.get(item['hash'],{}) if item['machine']=='pc' and item['hash'] not in copied else {}
            if item['machine']=='pc' and progress>=1 and item['hash'] not in copied:
                if copy_active and item['hash']==current.get('hash'):label='Copying to media server'
                elif issue:label='Waiting for copy retry'
            records.append({'hash':item['hash'],'title':item['name'],'type':'Movie' if item['category'] in ('movies','bulk-movies') else 'TV',
                            'state':label,'progress':progress,'speed':item.get('dlspeed',0),'size':item.get('size',0),
                            'copyDone':item['machine']=='pi' or item['hash'] in copied,'machine':item['machine'],'paused':paused,
                            'note':issue.get('reason') if issue else None})
        records.sort(key=lambda item:(item['speed']>0,not item['copyDone'],item['progress']<1),reverse=True)
        pause=(ROOT/'pause-copies').read_text().strip() if (ROOT/'pause-copies').exists() else ''
        snapshot={'remoteOrigins':read_json(ROOT/'remote-access.json'),'maintenance':read_json(ROOT/'server-move-hold.json'),'serverPower':server_power.public_status(pi),'updated':now,'starting':False,'pi':pi,'disks':disks,'sessions':sessions,'library':counts,
                  'status':status.get('status','Waiting for an update'),'pauseReason':pause,
                  'download':{'speed':sum(item.get('dlspeed',0) for item in jobs),
                              'active':sum(item.get('dlspeed',0)>0 and item.get('progress',0)<1 for item in jobs),
                              'waiting':sum(item.get('progress',0)<1 and not item.get('dlspeed',0) for item in jobs),
                              'error':qb_error,'defaultDrive':pathlib.Path(cfg['data']).anchor[:2]},
                  'copy':{**totals,'active':bool(copy_active),'speed':speed,'title':status.get('title') if copy_active else None,
                          'retryTransfers':sum(bool(r.get('note')) for r in records),
                          'awaitingLibraryImport':sum(v.get('status')=='awaiting-import' for v in cleanup.values()),
                          'fileBytes':copy_bytes if copy_active else None,'fileTotal':file_total if copy_active else None,
                          'eta':remaining_bytes/speed if speed>0 and copy_active and remaining_bytes>0 else None,
                          'pauseWhilePlaying':cfg.get('copy_pause_while_playing',True),'originalsKept':not cfg.get('delete_pc_after_verified_import'),
                          'cleaned':sum(value.get('status')=='cleaned' for value in cleanup.values())},
                  'jobs':records,'controls':controls,'events':sorted(EVENTS,key=lambda item:item['time'],reverse=True)[:12]}
        with LOCK:SNAPSHOT=snapshot
        time.sleep(max(1,3-(time.monotonic()-started)))


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def allowed_host(self):return self.headers.get('Host','').lower() in ('127.0.0.1:18090','localhost:18090')
    def can_control(self):return self.allowed_host() and self.headers.get('X-HomeMedia-Read-Only')!='1'
    def json_response(self,status,value):
        body=json.dumps(value).encode();self.send_response(status)
        self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)))
        self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(body)
    def do_GET(self):
        if not self.allowed_host():self.send_error(403);return
        path=urllib.parse.urlsplit(self.path).path
        if path=='/api/status':
            with LOCK:payload=copy.deepcopy(SNAPSHOT)
            payload['canControl']=self.can_control();body=json.dumps(payload).encode()
            kind='application/json'
        elif path=='/api/control-token':
            if not self.can_control():self.send_error(403);return
            self.json_response(200,{'token':CONTROL_TOKEN});return
        elif path=='/api/holding':
            try:
                import media_hold
                self.json_response(200,media_hold.operation({'operation':'list'}))
            except Exception:self.json_response(503,{'message':'The media holding service is temporarily unavailable.'})
            return
        elif path in ('/controls.js','/controls.css','/projector-input.js'):
            body=(BASE/'dist'/path[1:]).read_bytes();kind='text/javascript; charset=utf-8' if path.endswith('.js') else 'text/css'
        elif path in ('/','/index.html'):
            body=(BASE/'dist/index.html').read_bytes();kind='text/html; charset=utf-8'
        elif path=='/favicon.svg':
            body=b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#10241f"/><path d="M18 15h12c17 0 22 8 22 17S47 49 30 49H18V15zm10 9v16h3c9 0 11-4 11-8s-2-8-11-8h-3z" fill="#7ee8b4"/></svg>';kind='image/svg+xml'
        else:self.send_error(404);return
        self.send_response(200);self.send_header('Content-Type',kind);self.send_header('Content-Length',str(len(body)))
        self.send_header('Cache-Control','no-store');self.send_header('X-Content-Type-Options','nosniff')
        self.end_headers();self.wfile.write(body)
    def do_POST(self):
        if not self.can_control() or self.headers.get('Origin') not in ALLOWED_ORIGINS or not secrets.compare_digest(self.headers.get('X-HomeMedia-Control',''),CONTROL_TOKEN):
            self.json_response(403,{'message':'Controls are available from the HomeMedia Server Status shortcut on the main computer.'});return
        if urllib.parse.urlsplit(self.path).path!='/api/action':self.send_error(404);return
        try:
            size=int(self.headers.get('Content-Length','0'))
            if not 0<size<=16384 or self.headers.get('Content-Type','').split(';')[0]!='application/json':raise ValueError('Send a valid control request')
            body=json.loads(self.rfile.read(size))
            if not isinstance(body,dict):raise ValueError('Invalid control request')
            result=actions.perform(body)
            event('action-'+str(time.time_ns()),result['message'],'info')
            self.json_response(200,result)
        except ValueError as exc:self.json_response(400,{'message':str(exc)})
        except Exception:self.json_response(503,{'message':'That service is temporarily unavailable. Existing files have been kept; refresh and try again.'})


def collect_forever():
    while True:
        try:collect()
        except Exception as exc:
            with LOCK:SNAPSHOT.update(updated=time.time(),collectorError=type(exc).__name__,starting=False)
            time.sleep(5)


def tunnel():
    from fast_copy import OwnedProcess
    while True:
        try:
            # Closing/restarting the dashboard must also close its SSH forward.
            process=OwnedProcess(subprocess.Popen([worker.CONFIG['ssh'],*worker.ssh_options(),'-o','ExitOnForwardFailure=yes','-N','-T',
                '-R','127.0.0.1:18090:127.0.0.1:18090',worker.CONFIG['pi']],
                stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=worker.NO_WINDOW))
            process.wait()
        except Exception:pass
        time.sleep(10)


def main():
    import msvcrt
    lock=(DATA/'server.lock').open('a+b')
    try:msvcrt.locking(lock.fileno(),msvcrt.LK_NBLCK,1)
    except OSError:return
    event('video-drive-ready','Computer video storage ready — V: / 12 TB','good')
    threading.Thread(target=collect_forever,daemon=True).start()
    threading.Thread(target=actions.sync_forever,daemon=True).start()
    threading.Thread(target=tunnel,daemon=True).start()
    http.server.ThreadingHTTPServer(('127.0.0.1',18090),Handler).serve_forever()


if __name__=='__main__':main()
