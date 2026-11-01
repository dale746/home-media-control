"""Discovery bulk-server requests, in one combined release-date order."""
import datetime,json,pathlib,time,urllib.parse
import worker
import bulk_policy as policy

MANIFEST=policy.ROOT/'bulk-requests.json'

def save_manifest(data):
    temp=MANIFEST.with_suffix('.tmp');temp.write_text(json.dumps(data,indent=2));temp.replace(MANIFEST)

def is_complete(kind,native):
    if not native:return False
    if kind=='movie':return native.get('hasFile',False)
    first=next((s for s in native.get('seasons',[]) if s['seasonNumber']==1),{})
    stats=first.get('statistics') or {}
    return stats.get('episodeCount',0)>0 and stats.get('episodeFileCount',0)>=stats.get('episodeCount',0)

def request_is_pending(record,active,now=None,grace_seconds=900):
    """Reserve slots for recent searches and actual progress, not day-old empty searches."""
    now=time.time() if now is None else now
    if active and all(t and t.get('progress',0)>=1 for t in active):return False
    received=sum(int(t.get('completed',t.get('size',0)*t.get('progress',0))) for t in active if t)
    previous=record.get('lastObservedBytes')
    progressing=any(t.get('dlspeed',0)>0 for t in active if t) or (previous is not None and received>previous)
    record['lastObservedBytes']=received
    if progressing:record['lastProgressAt']=now
    reference=max(record.get('requestedAt',now),record.get('lastProgressAt',0))
    return now-reference<grace_seconds

def run(max_add=100):
    worker.refresh_config()
    cfg=policy.config();state=policy.load();seerr=policy.api('seerr')
    policy.pending_items(state)
    if not cfg.get('bulk_enabled',False):return {'status':'Bulk preparation hold'}
    import control_state
    controls=control_state.read(worker.ROOT)
    destination=cfg.get('bulk_destination','computer')
    if controls['pcPaused'] and destination=='computer':return {'status':'Computer downloads paused by you'}
    if controls['piPaused'] and destination=='pi':return {'status':'Pi downloads paused by you'}
    if destination=='computer' and __import__('shutil').disk_usage(worker.CONFIG['data']).free<180*1024**3:return {'status':'Computer storage reserve'}
    if worker.pi_storage_report(allow_staging=True)['free']<180*1024**3:return {'status':'Pi storage reserve'}
    manifest=json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {}
    import media_hold
    held=set(media_hold.blocked()['keys'])
    old_path=policy.ROOT/'request-status.json'
    if old_path.exists():
        for old in json.loads(old_path.read_text()).values():
            if old.get('requestId') and old.get('tmdbId'):
                item_key=policy.key('movie',old['tmdbId'])
                manifest.setdefault(item_key,{'requestId':old['requestId'],'kind':'movie','tmdbId':old['tmdbId'],'title':old['title'],'requestedAt':time.time()})
    native={};queue_by_media={}
    live_torrents={t['hash']:t for t in worker.qb_api().request('GET','/api/v2/torrents/info')}
    try:
        pi=worker.Api('http://192.0.2.10:8080')
        pi.request('POST','/api/v2/auth/login',form={'username':cfg['username'],'password':cfg['password']},timeout=3)
        live_torrents.update({t['hash']:t for t in pi.request('GET','/api/v2/torrents/info',timeout=3)})
    except Exception:pass
    for app,kind,resource in [('radarr','movie','movie'),('sonarr','tv','series')]:
        native[kind]={r['tmdbId']:r for r in policy.api(app).request('GET','/api/v3/'+resource,timeout=30) if r.get('tmdbId')}
        queue_by_media[kind]={}
        for item in policy.api(app).request('GET','/api/v3/queue?pageSize=1000',timeout=20)['records']:
            queue_by_media[kind].setdefault(item.get('movieId' if kind=='movie' else 'seriesId'),[]).append(live_torrents.get((item.get('downloadId') or '').lower(),{}))
    pending=0
    for item_key,record in manifest.items():
        if item_key in held:record['status']='held-for-deletion';continue
        meta=state['items'].get(item_key,{})
        if not meta.get('eligible'):record['status']='outside-current-policy';continue
        current=native[record['kind']].get(record['tmdbId'])
        if current:
            meta['nativeId']=current['id'];record['handoffVerified']=True
            record['status']='available' if is_complete(record['kind'],current) else 'requested'
            if record['kind']=='tv':
                changed=current.get('monitorNewItems')!='none';current['monitorNewItems']='none'
                for season in current['seasons']:
                    wanted=season['seasonNumber']==1
                    if season['monitored']!=wanted:season['monitored']=wanted;changed=True
                if changed:policy.api('sonarr').request('PUT','/api/v3/series/'+str(current['id']),data=current,timeout=25)
        else:
            request=seerr.request('GET','/api/v1/request/'+str(record['requestId']),timeout=20)
            record['status']='metadata-retry' if request['status']==4 else 'requested'
            if request['status']==4 and time.time()-record.get('lastRetry',0)>1800 and record.get('retries',0)<3:
                seerr.request('POST','/api/v1/request/'+str(record['requestId'])+'/retry',timeout=20)
                record['lastRetry']=time.time();record['retries']=record.get('retries',0)+1
        record.setdefault('requestedAt',time.time())
        if record['status']=='requested':
            active=queue_by_media[record['kind']].get((current or {}).get('id'),[])
            if active and all(t and t.get('progress',0)>=1 for t in active):
                record['status']='downloaded-awaiting-copy'
                continue
            if request_is_pending(record,active,grace_seconds=cfg.get('source_search_grace_seconds',900)):pending+=1
            else:record['status']='waiting-for-source'
    save_manifest(manifest);policy.save(state)
    allowed=min(max_add,max(0,cfg.get('max_pending_bulk_requests',100)-pending))
    if allowed<=0:return {'status':'Waiting for current bulk batch','pending':pending,'added':0}
    added=0
    for meta in policy.pending_items(state):
        latest=policy.config();manual=control_state.read(worker.ROOT)
        if not latest.get('bulk_enabled',True) or manual.get(('pc' if latest.get('bulk_destination','computer')=='computer' else 'pi')+'Paused'):break
        kind=meta['kind'];tmdb=meta['tmdbId'];item_key=policy.key(kind,tmdb)
        if item_key in media_hold.blocked(fresh=True)['keys']:continue
        if meta.get('manual') or item_key in manifest or tmdb in native[kind] or meta.get('deferUntil',0)>time.time():continue
        try:
            detail=seerr.request('GET',f'/api/v1/{kind}/{tmdb}?language=en',timeout=25)
            existing=[r for r in (detail.get('mediaInfo') or {}).get('requests',[]) if not r.get('is4k') and r.get('status')!=3]
            if existing:
                manifest[item_key]={'requestId':existing[0]['id'],'kind':kind,'tmdbId':tmdb,'title':meta['title'],'status':'requested'}
                save_manifest(manifest);continue
            app='radarr' if kind=='movie' else 'sonarr'
            term='tmdb:'+str(tmdb) if kind=='movie' else 'tvdb:'+str(meta.get('tvdbId') or '')
            if kind=='tv' and not meta.get('tvdbId'):
                meta['deferUntil']=time.time()+86400;policy.save(state);continue
            resource='movie' if kind=='movie' else 'series'
            lookup=policy.api(app).request('GET','/api/v3/'+resource+'/lookup?'+urllib.parse.urlencode({'term':term}),timeout=45)
            if not lookup:
                meta['deferUntil']=time.time()+86400;policy.save(state);continue
            payload={'mediaType':kind,'mediaId':tmdb,'is4k':False,'serverId':cfg['bulk_server_ids'][app]}
            if kind=='tv':payload.update(seasons=[1],tvdbId=meta['tvdbId'])
            # Reconcile an uncertain submission against Discovery before retrying it.
            meta['submissionStarted']=time.time();policy.save(state)
            request=seerr.request('POST','/api/v1/request',data=payload,timeout=60)
            manifest[item_key]={'requestId':request['id'],'kind':kind,'tmdbId':tmdb,'title':meta['title'],
                'releaseDate':meta['releaseDate'],'status':'requested','serverId':payload['serverId'],'requestedAt':time.time(),
                'seasons':[1] if kind=='tv' else None,'sequelException':meta.get('isSequel',False)}
            meta.update(requestId=request['id'],requested=True)
            save_manifest(manifest);policy.save(state);added+=1
            print('Queued',kind,meta['releaseDate'],meta['title'],flush=True)
            if added>=allowed:break
            time.sleep(2)
        except Exception as exc:
            print('Deferred',meta['title'],type(exc).__name__,flush=True)
            meta['deferUntil']=time.time()+3600
            state['failures'][item_key]=type(exc).__name__;policy.save(state)
            if isinstance(exc,(TimeoutError,ConnectionError)):break
    return {'status':'Bulk batch submitted','added':added,'pendingBefore':pending,'newestFirst':True}

if __name__=='__main__':
    import sys
    sys.stdout.reconfigure(encoding='utf-8')
    limit=int(sys.argv[sys.argv.index('--limit')+1]) if '--limit' in sys.argv else 100
    print(json.dumps(run(limit)),flush=True)
