"""Request verified, released, non-horror Fresh films in storage-aware batches."""
import datetime
import json
import os
import pathlib
import re
import shutil
import sys
import time
import unicodedata
import urllib.parse

import worker
if sys.stdout is not None:sys.stdout.reconfigure(encoding='utf-8')

ROOT=pathlib.Path(worker.CONFIG['data'])/'Rotten Tomatoes collection'
LEDGER=ROOT/'request-status.json'

def norm(value):
    text=unicodedata.normalize('NFKD',value).casefold().replace('&','and')
    return ''.join(c for c in text if c.isalnum())

def read_ledger():
    return json.loads(LEDGER.read_text()) if LEDGER.exists() else {}

def save_ledger(records):
    temporary=LEDGER.with_suffix('.tmp')
    temporary.write_text(json.dumps(records,indent=2),encoding='utf-8')
    temporary.replace(LEDGER)

def safe_film(detail,rating,candidate,today):
    genres=detail.get('genres') or []
    return (not detail.get('adult',False) and bool(genres)
        and not any(g.get('id')==27 or 'horror' in g.get('name','').casefold() for g in genres)
        and bool(detail.get('releaseDate')) and detail['releaseDate'][:10]<=today
        and rating is not None and isinstance(rating.get('criticsScore'),(int,float))
        and 60<=rating['criticsScore']<=100
        and urllib.parse.urlsplit(rating.get('url','')).path.rstrip('/').split('/')[-1]==candidate['vanity']
        and abs(int(rating.get('year',0))-candidate['year'])<=1)

def run(max_add=20):
    import msvcrt
    lock=(ROOT/'request-worker.lock').open('a+b')
    try:msvcrt.locking(lock.fileno(),msvcrt.LK_NBLCK,1)
    except OSError:return {'status':'Another request check is running'}
    try:return _run(max_add)
    finally:
        lock.seek(0);msvcrt.locking(lock.fileno(),msvcrt.LK_UNLCK,1);lock.close()

def _run(max_add=20):
    settings=json.loads((worker.ROOT/'settings.json').read_text())
    key=settings.get('seerr_key')
    if not key:return {'status':'Discovery key not configured'}
    if shutil.disk_usage(worker.CONFIG['data']).free<worker.CONFIG['min_pc_free_gib']*1024**3+80*1024**3:
        return {'status':'Computer storage reserve reached'}
    # Reading free-space data is cheap; it never starts a disk benchmark.
    pi_free=int(worker.pi_python("import shutil;print(shutil.disk_usage('/opt/media').free)",timeout=20).strip())
    if pi_free<worker.CONFIG['min_pi_free_gib']*1024**3+80*1024**3:
        return {'status':'Pi storage reserve reached'}
    seerr=worker.Api('http://192.0.2.10:5055',{'X-Api-Key':key})
    radarr=worker.Api('http://192.0.2.10:7878',{'X-Api-Key':settings['arr_keys']['radarr']})
    movies=radarr.request('GET','/api/v3/movie',timeout=30)
    by_id={m['tmdbId']:m for m in movies}
    existing_titles={(norm(m['title']),m.get('year')) for m in movies}
    ledger=read_ledger()
    for record in ledger.values():
        if record.get('status') not in ('requested','metadata-retry') or not record.get('requestId'):continue
        request=seerr.request('GET','/api/v1/request/'+str(record['requestId']),timeout=20)
        record['requestStatus']=request.get('status')
        external=(request.get('media') or {}).get('externalServiceId')
        if request.get('status') in (2,5) and external:
            record.update(status='requested',handoffVerified=True,radarrId=external)
        elif request.get('status')==4:
            record.update(status='metadata-retry',handoffVerified=False)
            if record.get('retryCount',0)<3 and time.time()-record.get('lastRetry',0)>1800:
                seerr.request('POST','/api/v1/request/'+str(record['requestId'])+'/retry',timeout=20)
                record['retryCount']=record.get('retryCount',0)+1;record['lastRetry']=time.time()
        save_ledger(ledger)
    pending=sum(r.get('status')=='requested' and not by_id.get(r.get('tmdbId'),{}).get('hasFile',False) for r in ledger.values())
    allowed=min(max_add,max(0,worker.CONFIG['max_pending_new_movies']-pending))
    if allowed<=0:return {'status':'Batch waiting for downloads','pending':pending,'newRequests':0}
    catalogue=json.loads((ROOT/'catalogue.json').read_text(encoding='utf-8'))
    today=datetime.datetime.now().astimezone().date().isoformat()
    added=0;checked=0
    for candidate in catalogue:
        slug=candidate['vanity']
        if slug in ledger:continue
        record={'title':candidate['title'],'year':candidate['year'],'source':candidate['url'],
                'criticsScore':candidate['criticsScore'],'checked':today}
        ledger[slug]=record
        try:
            if (norm(candidate['title']),candidate['year']) in existing_titles:
                record['status']='already-in-library-or-queue';save_ledger(ledger);continue
            checked+=1
            query=urllib.parse.urlencode({'query':candidate['title'],'language':'en'},quote_via=urllib.parse.quote)
            results=seerr.request('GET','/api/v1/search?'+query,timeout=25)['results']
            titles={norm(candidate['title']),*(norm(x) for x in candidate.get('alternateTitles',[]))}
            matches=[m for m in results if m.get('mediaType')=='movie'
                and norm(m.get('title','')) in titles and not m.get('adult',False)
                and (m.get('releaseDate') or '')[:4].isdigit()
                and abs(int(m['releaseDate'][:4])-candidate['year'])<=1]
            exact=[m for m in matches if m['releaseDate'][:4]==str(candidate['year'])]
            if exact:matches=exact
            if len(matches)!=1:
                record['status']='needs-exact-title-match';save_ledger(ledger);continue
            tmdb=matches[0]['id'];record['tmdbId']=tmdb
            if tmdb in by_id:
                record['status']='already-in-library-or-queue';save_ledger(ledger);continue
            detail=seerr.request('GET',f'/api/v1/movie/{tmdb}?language=en',timeout=25)
            # Check genres before requesting more ratings or submitting anything.
            genres=detail.get('genres') or []
            if not genres or detail.get('adult') or any(g.get('id')==27 or 'horror' in g.get('name','').casefold() for g in genres):
                record['status']='excluded-genre';save_ledger(ledger);continue
            if not detail.get('releaseDate') or detail['releaseDate'][:10]>today:
                record['status']='not-released';save_ledger(ledger);continue
            rating=seerr.request('GET',f'/api/v1/movie/{tmdb}/ratings',timeout=25)
            if not safe_film(detail,rating,candidate,today):
                record['status']='rating-not-verified';save_ledger(ledger);continue
            record['criticsScore']=rating['criticsScore']
            existing=(detail.get('mediaInfo') or {}).get('requests',[])
            relevant=[r for r in existing if not r.get('is4k') and r.get('status')!=3]
            if relevant:
                record.update(status='already-requested',requestId=relevant[0]['id']);save_ledger(ledger);continue
            lookup=radarr.request('GET','/api/v3/movie/lookup?'+urllib.parse.urlencode({'term':'tmdb:'+str(tmdb)}),timeout=45)
            if not any(m.get('tmdbId')==tmdb for m in lookup):
                record['status']='download-metadata-unavailable';save_ledger(ledger);continue
            # Save intent first. A timeout is reconciled using Discovery's existing requests next run.
            record['status']='submitting';save_ledger(ledger)
            request=seerr.request('POST','/api/v1/request',data={'mediaType':'movie','mediaId':tmdb,'is4k':False},timeout=60)
            record.update(status='requested',requestId=request['id'],requestStatus=request.get('status'))
            added+=1;save_ledger(ledger)
            print('Fresh request:',candidate['title'],str(rating['criticsScore'])+'%',flush=True)
            if added>=allowed:break
            time.sleep(1)
        except Exception as exc:
            # A failed write is left for explicit reconciliation, never blindly resubmitted.
            record.update(status='needs-check',error=type(exc).__name__)
            save_ledger(ledger)
            print('Kept for review:',candidate['title'],type(exc).__name__,flush=True)
            if isinstance(exc,(TimeoutError,ConnectionError)) or checked>=200:break
        if checked>=200:break
    return {'status':'Batch prepared','newRequests':added,'pendingBefore':pending,'candidatesChecked':checked,
            'catalogued':len(catalogue)}

if __name__=='__main__':
    limit=int(sys.argv[sys.argv.index('--limit')+1]) if '--limit' in sys.argv else 20
    print(json.dumps(run(limit)),flush=True)
