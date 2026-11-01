"""Verified metadata and release ordering for automatic movie/season-one batches."""
import concurrent.futures
import csv
import datetime
import json
import pathlib
import sys
import time
import unicodedata
import urllib.parse

import worker

ROOT=pathlib.Path(worker.CONFIG.get('catalogue_root',str(pathlib.Path(worker.CONFIG['data'])/'Rotten Tomatoes collection')))
STATE=ROOT/'bulk-policy.json'
TODAY=lambda: datetime.datetime.now().astimezone().date().isoformat()

def config():return json.loads((worker.ROOT/'settings.json').read_text())
def api(name):
    cfg=config()
    if name=='seerr':return worker.Api('http://192.0.2.10:5055',{'X-Api-Key':cfg['bulk_seerr_key']})
    return worker.Api('http://192.0.2.10:'+{'radarr':'7878','sonarr':'8989'}[name],{'X-Api-Key':cfg['arr_keys'][name]})
def norm(value):return ''.join(c for c in unicodedata.normalize('NFKD',value).casefold().replace('&','and') if c.isalnum())
def load():return json.loads(STATE.read_text()) if STATE.exists() else {'items':{},'resolvedYears':{},'collections':{},'failures':{}}
def save(state):
    tmp=STATE.with_suffix('.tmp');tmp.write_text(json.dumps(state,indent=2),encoding='utf-8');tmp.replace(STATE)
def key(kind,tmdb):return kind+':'+str(tmdb)
def catalogue(kind):return json.loads((ROOT/('catalogue.json' if kind=='movie' else 'catalogue-tv.json')).read_text(encoding='utf-8'))
def allowed_genres(detail,candidate=None):
    genres=detail.get('genres') or []
    return bool(genres) and not detail.get('adult',False) and not any(g.get('id')==27 or 'horror' in g.get('name','').casefold() for g in genres) and not any('horror' in g.casefold() for g in (candidate or {}).get('genres',[]))

def language_allowed(record,cfg=None):
    cfg=config() if cfg is None else cfg
    if not cfg.get('bulk_english_only',False):return True
    if record.get('englishAudioVerified'):return True
    language=record.get('originalLanguage')
    if isinstance(language,dict):language=language.get('iso6391') or language.get('name')
    return str(language or '').strip().lower().replace('_','-') in ('en','eng','english','en-us','en-gb','en-au','en-za')

def fetch(kind,tmdb,candidate=None,sequel_of=None):
    service=api('seerr')
    detail=service.request('GET',f'/api/v1/{kind}/{tmdb}?language=en',timeout=25)
    date=detail.get('releaseDate' if kind=='movie' else 'firstAirDate') or ''
    record={'kind':kind,'tmdbId':tmdb,'title':detail.get('title') or detail.get('name'),
        'originalLanguage':detail.get('originalLanguage'),
        'releaseDate':date[:10],'year':int(date[:4]) if date[:4].isdigit() else None,
        'genres':[g['name'] for g in detail.get('genres',[])],'genreAllowed':allowed_genres(detail,candidate),
        'managed':True,'manual':False,'rootQualified':False,'isSequel':bool(sequel_of),
        'sequelOf':sequel_of or [],'checked':TODAY(),'collectionId':(detail.get('collection') or {}).get('id'),
        'tvdbId':(detail.get('externalIds') or {}).get('tvdbId'),
        'seasonOneExists':any(s.get('seasonNumber')==1 and s.get('episodeCount',0)>0 for s in detail.get('seasons',[])) if kind=='tv' else None}
    rating=None
    if record['genreAllowed']:
        try:rating=service.request('GET',f'/api/v1/{kind}/{tmdb}/ratings',timeout=25)
        except Exception:pass
    score=(rating or {}).get('criticsScore')
    same=not candidate or (rating or {}).get('url','').rstrip('/')==candidate['url'].rstrip('/')
    record.update(criticsScore=score,ratingsUrl=(rating or {}).get('url'))
    record['ratingVerified']=bool(same and isinstance(score,(int,float)) and not isinstance(score,bool))
    record['rootQualified']=bool(record['genreAllowed'] and record['ratingVerified'] and score>=config().get('minimum_critics_score',75))
    record['eligible']=bool(language_allowed(record) and record['genreAllowed'] and date and date[:10]<=TODAY() and (record['rootQualified'] or sequel_of) and (kind!='tv' or record['seasonOneExists']))
    return record

def resolve(candidate):
    kind=candidate['mediaType'];service=api('seerr')
    query=urllib.parse.urlencode({'query':candidate['title'],'language':'en'},quote_via=urllib.parse.quote)
    results=service.request('GET','/api/v1/search?'+query,timeout=25)['results']
    titles={norm(candidate['title']),*(norm(t) for t in candidate.get('alternateTitles',[]))}
    date_key='releaseDate' if kind=='movie' else 'firstAirDate'
    matches=[x for x in results if x.get('mediaType')==kind and norm(x.get('title') or x.get('name') or '') in titles and (x.get(date_key) or '')[:4].isdigit() and abs(int(x[date_key][:4])-candidate['year'])<=1]
    exact=[x for x in matches if x[date_key][:4]==str(candidate['year'])]
    if exact:matches=exact
    if len(matches)!=1:return None
    record=fetch(kind,matches[0]['id'],candidate)
    record['vanity']=candidate['vanity']
    return record

def merge(state,record):
    item_key=key(record['kind'],record['tmdbId']);before=state['items'].get(item_key,{})
    if before.get('manual'):record.update(manual=True,managed=False)
    for field in ['nativeId','requestId','requestStatus','handoffVerified','requested','policyPaused','englishAudioVerified']:
        if field in before:record[field]=before[field]
    if before.get('isSequel'):
        record['isSequel']=True;record['sequelOf']=sorted(set(record.get('sequelOf',[])+before.get('sequelOf',[])))
        record['eligible']=bool(language_allowed(record) and record['genreAllowed'] and record.get('releaseDate') and record['releaseDate']<=TODAY())
    state['items'][item_key]=record

def hydrate_known(state,managed_ids):
    for app,kind,resource in [('radarr','movie','movie'),('sonarr','tv','series')]:
        native=api(app).request('GET','/api/v3/'+resource,timeout=30)
        tasks=[]
        for item in native:
            tmdb=item.get('tmdbId')
            if not tmdb:continue
            item_key=key(kind,tmdb)
            if item_key in state['items']:
                record=state['items'][item_key];record['nativeId']=item['id']
                if item.get('originalLanguage'):record['originalLanguage']=item['originalLanguage']
                continue
            tasks.append((item,tmdb))
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            futures={pool.submit(fetch,kind,tmdb):(item,tmdb) for item,tmdb in tasks}
            for done,future in enumerate(concurrent.futures.as_completed(futures),1):
                item,tmdb=futures[future]
                try:
                    record=future.result();record.update(nativeId=item['id'],manual=tmdb not in managed_ids[kind],managed=tmdb in managed_ids[kind])
                    merge(state,record)
                except Exception as exc:state['failures'][key(kind,tmdb)]=type(exc).__name__
                if done%20==0:save(state);print('Resolved existing',kind,done,'of',len(tasks),flush=True)
        save(state)

def hydrate_year(state,kind,year):
    mark=kind+':'+str(year)
    if state['resolvedYears'].get(mark)==TODAY():return
    candidates=[x for x in catalogue(kind) if x['year']==year]
    known={x.get('vanity') for x in state['items'].values() if x['kind']==kind}
    pending=[c for c in candidates if c['vanity'] not in known]
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        futures={pool.submit(resolve,c):c for c in pending}
        for done,future in enumerate(concurrent.futures.as_completed(futures),1):
            candidate=futures[future]
            try:
                record=future.result()
                if record:merge(state,record)
                else:state['failures'][kind+':'+candidate['vanity']]='Exact match unavailable'
            except Exception as exc:state['failures'][kind+':'+candidate['vanity']]=type(exc).__name__
            if done%25==0:save(state);print('Dated',kind,year,done,'of',len(pending),flush=True)
    state['resolvedYears'][mark]=TODAY();save(state)

def expand_sequels(state):
    if not config().get('include_sequels',True):return
    groups={}
    for record in list(state['items'].values()):
        if record['kind']=='movie' and record.get('rootQualified') and record.get('eligible') and record.get('collectionId'):
            groups.setdefault(str(record['collectionId']),[]).append(record)
    service=api('seerr');added=0
    for collection_id,parents in groups.items():
        old=state['collections'].get(collection_id,{})
        if old.get('checked')==TODAY():continue
        try:
            detail=service.request('GET','/api/v1/collection/'+collection_id,timeout=25)
            cutoff=min(p['releaseDate'] for p in parents)
            for part in detail.get('parts',[]):
                date=part.get('releaseDate') or ''
                if not date or not cutoff<date[:10]<=TODAY() or 27 in part.get('genreIds',[]):continue
                item_key=key('movie',part['id'])
                if item_key in state['items']:
                    record=state['items'][item_key]
                    if record['genreAllowed']:
                        record.update(isSequel=True,sequelOf=sorted(set(record.get('sequelOf',[])+[p['tmdbId'] for p in parents])),eligible=language_allowed(record))
                else:
                    record=fetch('movie',part['id'],sequel_of=[p['tmdbId'] for p in parents]);merge(state,record)
                    added+=bool(record['eligible'])
            state['collections'][collection_id]={'checked':TODAY(),'title':detail.get('name'),'parents':[p['tmdbId'] for p in parents]}
            save(state)
        except Exception as exc:state['failures']['collection:'+collection_id]=type(exc).__name__
    print('Sequel candidates added:',added,flush=True);save(state)

def apply_native_policy(state):
    cfg=config();changed=0
    import media_hold
    exclusions=media_hold.blocked()
    for app,kind,resource in [('radarr','movie','movie'),('sonarr','tv','series')]:
        native=api(app).request('GET','/api/v3/'+resource,timeout=30)
        for item in native:
            record=state['items'].get(key(kind,item.get('tmdbId')))
            if key(kind,item.get('tmdbId')) in exclusions['keys'] or item['id'] in exclusions.get('native',{}).get(app,[]):
                if item.get('monitored'):
                    item['monitored']=False
                    if kind=='tv':
                        for season in item.get('seasons',[]):season['monitored']=False
                    api(app).request('PUT',f'/api/v3/{resource}/{item["id"]}',item,timeout=30);changed+=1
                continue
            if not record or not record.get('managed'):continue
            record['nativeId']=item['id'];tags=set(item.get('tags',[]));tags.add(cfg['bulk_tag_ids'][app]);dirty=tags!=set(item.get('tags',[]));item['tags']=sorted(tags)
            has_files=item.get('hasFile',False) if kind=='movie' else item.get('statistics',{}).get('episodeFileCount',0)>0
            if not record['eligible'] and not has_files and item.get('monitored'):
                item['monitored']=False;record['policyPaused']=True;dirty=True
            elif record['eligible'] and record.get('policyPaused') and not item.get('monitored'):
                item['monitored']=True;record['policyPaused']=False;dirty=True
            if kind=='tv':
                if item.get('monitorNewItems')!='none':item['monitorNewItems']='none';dirty=True
                for season in item['seasons']:
                    wanted=season['seasonNumber']==1 and record['eligible']
                    if season['monitored']!=wanted:season['monitored']=wanted;dirty=True
            if dirty:api(app).request('PUT',f'/api/v3/{resource}/{item["id"]}',item,timeout=30);changed+=1
    save(state);return changed

def pending_items(state):
    cfg=config()
    import media_hold
    held=set(media_hold.blocked()['keys'])
    for r in state['items'].values():
        r.setdefault('ratingVerified',bool(r.get('rootQualified')))
        r['rootQualified']=bool(r.get('genreAllowed') and r.get('ratingVerified') and isinstance(r.get('criticsScore'),(int,float)) and r['criticsScore']>=cfg.get('minimum_critics_score',75))
        type_enabled=cfg.get('bulk_movies_enabled',True) if r['kind']=='movie' else cfg.get('bulk_tv_enabled',True)
        r['eligible']=bool(key(r['kind'],r['tmdbId']) not in held and language_allowed(r,cfg) and type_enabled and r.get('genreAllowed') and r.get('releaseDate') and r['releaseDate']<=TODAY() and (r.get('rootQualified') or (r.get('isSequel') and cfg.get('include_sequels',True))) and (r['kind']!='tv' or r.get('seasonOneExists')))
    return sorted([r for r in state['items'].values() if r.get('managed') and r.get('eligible')],key=lambda r:(r['releaseDate'],r['kind'],r['title']),reverse=True)

def write_plan(state):
    with (ROOT/'Download plan - newest first.csv').open('w',newline='',encoding='utf-8-sig') as stream:
        writer=csv.DictWriter(stream,fieldnames=['type','title','releaseDate','criticsScore','sequelException','seasons'])
        writer.writeheader()
        for record in pending_items(state):
            writer.writerow({'type':record['kind'],'title':record['title'],'releaseDate':record['releaseDate'],
                'criticsScore':record.get('criticsScore'),'sequelException':record.get('isSequel',False),
                'seasons':'1 only' if record['kind']=='tv' else ''})

if __name__=='__main__':
    raise SystemExit('Use this module through a reviewed, configured scheduler; see README.')
