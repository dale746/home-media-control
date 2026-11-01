"""Bounded dashboard actions; irreversible media deletion requires a holding ID and confirmation."""
import hashlib,json,math,pathlib,re,shutil,threading,time,urllib.parse
import worker,control_state,pc_cleanup

ROOT=worker.ROOT
MUTATION_LOCK=threading.RLock()


def cfg():return json.loads((ROOT/'settings.json').read_text())


def save_settings(value):
    path=ROOT/'settings.json';temporary=path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value,indent=2));temporary.replace(path);worker.CONFIG.update(value)


def public_settings():
    value=cfg();pending=value.get('hdd_upgrade_pending',False)
    return {'pcMax':value.get('pc_max_downloads',100),'piMax':value.get('pi_max_downloads',2),
            'pcMbps':value.get('pc_download_mbps',500),'piMbps':value.get('pi_download_mbps',2),
            'copyMbps':round(value.get('staging_copy_limit_mib_per_second',60)*1048576/1000000,1) if pending else round(value.get('copy_limit_mib_per_second',20)*1048576/1000000,1),
            'drive':pathlib.Path(value['data']).anchor[:2],
            'drives':list(dict.fromkeys(pathlib.Path(root).anchor[:2] for root in value['source_roots'])),
            'bulkDestination':value.get('bulk_destination','computer'),'manualDestination':value.get('manual_destination','pi'),
            'fallback':value.get('pi_fallback',True),'bulkEnabled':value.get('bulk_enabled',True),
            'movies':value.get('bulk_movies_enabled',True),'tv':value.get('bulk_tv_enabled',True),
            'score':value.get('minimum_critics_score',75),'sequels':value.get('include_sequels',True),
            'pauseWhenWatching':value.get('copy_pause_while_playing',True),
            'horrorExcluded':True,'tvSeason':'First season only','order':'Newest available first'}


def validate_settings(value):
    if not isinstance(value,dict):raise ValueError('Settings must be a named set of options')
    numeric={'pcMax':(1,500,True),'piMax':(1,10,True),'pcMbps':(0,500,False),
             'piMbps':(0,100,False),'copyMbps':(1,120,False),'score':(0,100,True)}
    boolean={'fallback','bulkEnabled','movies','tv','sequels','pauseWhenWatching'}
    allowed=set(numeric)|boolean|{'drive','bulkDestination','manualDestination'}
    if set(value)-allowed:raise ValueError('An unsupported setting was submitted')
    out={}
    for key,item in value.items():
        if key in numeric:
            low,high,whole=numeric[key]
            if isinstance(item,bool) or not isinstance(item,(int,float)) or not math.isfinite(item) or not low<=item<=high or (whole and int(item)!=item):
                raise ValueError(key+' is outside its allowed range')
            out[key]=int(item) if whole else float(item)
        elif key in boolean:
            if not isinstance(item,bool):raise ValueError(key+' must be on or off')
            out[key]=item
        elif key in ('bulkDestination','manualDestination'):
            if item not in ('computer','pi'):raise ValueError('Choose the computer or the media server')
            out[key]=item
        elif key=='drive':
            if item not in public_settings()['drives']:raise ValueError('Choose one of the prepared download drives')
            out[key]=item
    return out


def qb(machine):
    if machine=='pc':return worker.qb_api()
    if machine!='pi':raise ValueError('Choose the computer or the media server')
    value=cfg();api=worker.Api('http://192.0.2.10:8080')
    api.request('POST','/api/v2/auth/login',form={'username':value['username'],'password':value['password']},timeout=3)
    api.request('GET','/api/v2/app/version',timeout=3);return api


def can_resume(torrent,machine):
    value=cfg()
    if machine=='pc':
        folder=pathlib.Path(torrent['save_path']).resolve()
        roots=[pathlib.Path(root).resolve() for root in value['source_roots']]
        source=next((root for root in roots if folder==root/'torrents'/torrent['category']),None)
        if source is None:raise ValueError('This job is outside managed downloads')
        if pc_cleanup.volume_guid(source)!=value['source_volume_guids'].get(source.anchor.casefold()):raise ValueError('The source drive identity changed')
        if shutil.disk_usage(source).free<value['min_pc_free_gib']*1024**3:raise ValueError('The 100 GB storage reserve prevents resuming this job')
    else:
        if worker.pi_storage_report()['free']<value['min_pi_free_gib']*1024**3:raise ValueError('The media server storage reserve prevents resuming this job')


def apply_settings(changes):
    changes=validate_settings(changes);value=cfg();api=qb('pc')
    live=api.request('GET','/api/v2/app/preferences')
    if 'drive' in changes and changes['drive']!=pathlib.Path(value['data']).anchor[:2]:
        root=next(pathlib.Path(item).resolve() for item in value['source_roots'] if pathlib.Path(item).anchor[:2]==changes['drive'])
        if pc_cleanup.volume_guid(root)!=value['source_volume_guids'].get(root.anchor.casefold()):raise ValueError('The selected drive identity changed')
        if shutil.disk_usage(root).free<value['min_pc_free_gib']*1024**3:raise ValueError('The selected drive needs at least 100 GB free')
        jobs=api.request('GET','/api/v2/torrents/info')
        for job in jobs:
            if job.get('category') not in ('movies','tv'):continue
            api.request('POST','/api/v2/torrents/setAutoManagement',form={'hashes':job['hash'],'enable':'false'})
            if job.get('progress',0)<1:
                api.request('POST','/api/v2/torrents/setDownloadPath',form={'id':job['hash'],'path':job.get('download_path') or live['temp_path']})
        for category in ('movies','tv'):
            api.request('POST','/api/v2/torrents/editCategory',form={'category':category,'savePath':str(root/'torrents'/category)})
        api.request('POST','/api/v2/app/setPreferences',form={'json':json.dumps({'save_path':str(root/'torrents/other'),'temp_path':str(root/'incomplete'),'temp_path_enabled':True})})
        value['data']=str(root)
    mapping={'pcMax':'pc_max_downloads','piMax':'pi_max_downloads','pcMbps':'pc_download_mbps','piMbps':'pi_download_mbps',
             'bulkDestination':'bulk_destination','manualDestination':'manual_destination','fallback':'pi_fallback',
             'bulkEnabled':'bulk_enabled','movies':'bulk_movies_enabled','tv':'bulk_tv_enabled','score':'minimum_critics_score',
             'sequels':'include_sequels','pauseWhenWatching':'copy_pause_while_playing'}
    for key,item in changes.items():
        if key in mapping:value[mapping[key]]=item
    if 'copyMbps' in changes:
        value['copy_limit_mib_per_second']=changes['copyMbps']*1000000/1048576
        value['staging_copy_limit_mib_per_second']=value['copy_limit_mib_per_second']
    if 'pcMax' in changes:value['max_pending_bulk_requests']=changes['pcMax']
    preferences={}
    if 'pcMax' in changes:preferences.update(max_active_downloads=changes['pcMax'],max_active_torrents=changes['pcMax']+max(0,live.get('max_active_uploads',10)),queueing_enabled=True,dont_count_slow_torrents=False)
    if 'pcMbps' in changes:preferences['dl_limit']=round(changes['pcMbps']*1000000)
    if preferences:api.request('POST','/api/v2/app/setPreferences',form={'json':json.dumps(preferences)})
    save_settings(value)
    return {'message':'Settings saved. media server routing and media server limits apply when its services are ready.','settings':public_settings()}


def perform(body):
    with MUTATION_LOCK:
        kind=body.get('action');state=control_state.read(ROOT)
        if kind=='server-power':
            import server_power
            return server_power.request_shutdown(body)
        if kind=='holding':
            import media_hold
            return media_hold.operation(body)
        if kind=='settings':return apply_settings(body.get('settings',{}))
        if kind=='copy':
            if body.get('operation') not in ('pause','resume'):raise ValueError('Choose pause or resume')
            state['copyPaused']=body['operation']=='pause';control_state.save(state,ROOT)
            return {'message':'Stopping transfers safely; computer originals stay in place.' if state['copyPaused'] else 'Transfers enabled. Completed files copy when the downloader, server and safety checks are ready.',
                    'copyPaused':state['copyPaused'],'controlUpdatedAt':state['updated']}
        if kind not in ('queue','torrent'):raise ValueError('Unknown action')
        machine=body.get('machine');operation=body.get('operation')
        if machine not in ('pc','pi') or operation not in ('pause','resume','retry'):raise ValueError('Unknown download action')
        if kind=='queue' and operation=='retry':raise ValueError('Retry is available for individual downloads')
        if kind=='queue' and machine=='pi':
            state['piPaused']=operation=='pause';control_state.save(state,ROOT)
            return {'message':'media server queue preference saved. It applies when the media server downloader is ready.'}
        api=qb(machine);jobs=api.request('GET','/api/v2/torrents/info',timeout=5)
        if kind=='queue':
            if operation=='pause':
                active=[item['hash'] for item in jobs if item.get('category') in ('movies','tv') and item.get('progress',0)<1 and not item.get('state','').startswith(('paused','stopped'))]
                state['pcResume']=sorted(set(state['pcResume'])|set(active));state['pcPaused']=True
                control_state.save(state,ROOT)
                if active:api.request('POST','/api/v2/torrents/stop',form={'hashes':'|'.join(active)})
            else:
                selected=[item for item in jobs if item['hash'] in state['pcResume'] and item['hash'] not in state['pcJobs'] and item.get('progress',0)<1]
                for item in selected:can_resume(item,machine)
                if selected:api.request('POST','/api/v2/torrents/start',form={'hashes':'|'.join(item['hash'] for item in selected)})
                state.update(pcPaused=False,pcResume=[]);control_state.save(state,ROOT)
            return {'message':'Computer downloads '+('paused.' if operation=='pause' else 'resumed.')}
        torrent_hash=body.get('hash','')
        if not isinstance(torrent_hash,str) or not re.fullmatch('[a-f0-9]{40}|[a-f0-9]{64}',torrent_hash):raise ValueError('Invalid job identifier')
        job=next((item for item in jobs if item['hash']==torrent_hash and item.get('category') in ('movies','tv','bulk-movies','bulk-tv')),None)
        if job is None:raise ValueError('This download is no longer in the queue')
        if operation=='resume':
            import media_hold
            if torrent_hash in media_hold.blocked(fresh=True)['hashes']:raise ValueError('This title is in Media holding. Restore it there first.')
        held=set(state[machine+'Jobs'])
        if operation=='retry':api.request('POST','/api/v2/torrents/reannounce',form={'hashes':torrent_hash})
        elif operation=='pause':
            held.add(torrent_hash);state[machine+'Jobs']=sorted(held);control_state.save(state,ROOT)
            api.request('POST','/api/v2/torrents/stop',form={'hashes':torrent_hash})
        else:
            if state[machine+'Paused']:raise ValueError('Resume this machine’s queue first')
            can_resume(job,machine)
            api.request('POST','/api/v2/torrents/start',form={'hashes':torrent_hash})
            held.discard(torrent_hash);state[machine+'Jobs']=sorted(held);control_state.save(state,ROOT)
        return {'message':{'pause':'Download paused.','resume':'Download resumed.','retry':'Asked existing sources to reconnect.'}[operation]}


def desired_pi():
    value=cfg();state=control_state.read(ROOT)
    public={key:value.get(key,default) for key,default in [('bulk_destination','computer'),('manual_destination','pi'),('pi_fallback',True),('pi_max_downloads',2),('pi_download_mbps',2)]}
    public.update(piPaused=state['piPaused'],piJobs=state['piJobs'])
    limit=value.get('staging_copy_limit_mib_per_second',60) if value.get('hdd_upgrade_pending') else value.get('copy_limit_mib_per_second',20)
    public['copyBytesPerSecond']=round(limit*1024**2)
    public['revision']=hashlib.sha256(json.dumps(public,sort_keys=True).encode()).hexdigest()
    return public


LAST_SYNC={'revision':None,'time':0,'applied':False}
def reconcile(api,jobs):
    state=control_state.read(ROOT)
    held=control_state.held_hashes(jobs,state)
    if held and api:api.request('POST','/api/v2/torrents/stop',form={'hashes':'|'.join(held)},timeout=4)
    return public_controls()


def public_controls():
    return {'state':control_state.read(ROOT),'settings':public_settings(),
            'piSettingsApplied':LAST_SYNC['applied'] and LAST_SYNC['revision']==desired_pi()['revision']}


def sync_pi():
    if (ROOT/'server-move-hold.json').exists():LAST_SYNC['applied']=False;return
    desired=desired_pi();now=time.monotonic()
    if LAST_SYNC['revision']!=desired['revision'] or (not LAST_SYNC['applied'] and now-LAST_SYNC['time']>30):
        source="""import json,pathlib,subprocess,os
p=json.loads(PAYLOAD)
base=pathlib.Path('/opt/media/config/pc-downloads');path=base/'dashboard-controls.json'
temporary=path.with_suffix('.tmp');temporary.write_text(json.dumps(p));os.chmod(temporary,0o600);temporary.replace(path)
s=json.loads(subprocess.check_output(['sudo','-n','cat','/opt/media/config/storage-upgrade/state.json'],text=True))
if s.get('phase')=='complete':
 subprocess.run(['sudo','-n','systemctl','start','--no-block','media-download-guard.service'],check=True)
state=json.loads((base/'failover-state.json').read_text()) if (base/'failover-state.json').exists() else {}
print(json.dumps({'applied':state.get('dashboardRevision')==p['revision']}))
""".replace('PAYLOAD',repr(json.dumps(desired)))
        try:
            response=json.loads(worker.pi_python(source,timeout=20));LAST_SYNC.update(revision=desired['revision'],time=now,applied=response['applied'])
        except Exception:LAST_SYNC.update(time=now,applied=False)


def sync_forever():
    while True:
        try:sync_pi()
        except Exception:LAST_SYNC['applied']=False
        time.sleep(5)
