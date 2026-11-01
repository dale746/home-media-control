"""Finish existing downloads before ordering new work by release date."""
import json
import os
import pathlib
import shutil
import urllib.parse

import worker
import bulk_policy as policy
import control_state

ORDER_FILE=policy.ROOT/'queue-order-state.json'


def desired_queue(candidates,torrents,held=(),policy_paused=(),urgent=()):
    """Return priorities without changing jobs, pause choices, or queue limits."""
    blocked={str(value).lower() for value in (*held,*policy_paused)}
    eligible={}
    for torrent in torrents:
        torrent_hash=torrent['hash'].lower()
        if (torrent_hash in blocked or torrent.get('category') not in ('movies','tv')
                or torrent.get('progress',0)>=1
                or control_state.is_forced(torrent)
                or torrent.get('state','').startswith(('stopped','paused'))):
            continue
        eligible.setdefault(torrent_hash,torrent)

    ordered=[];seen=set()
    def append(torrent_hash):
        torrent_hash=str(torrent_hash).lower()
        if torrent_hash in eligible and torrent_hash not in seen:
            ordered.append(torrent_hash);seen.add(torrent_hash)

    for torrent_hash in urgent:append(torrent_hash)

    def finish_order(torrent):
        remaining=torrent.get('amount_left')
        if remaining is None:
            size=torrent.get('size',0)
            remaining=max(0,size-torrent.get('completed',size*torrent['progress'])) if size else float('inf')
        return (remaining,-torrent['progress'],torrent['hash'].lower())

    finishing=[torrent for torrent in eligible.values() if torrent.get('progress',0)>=.98]
    for torrent in sorted(finishing,key=finish_order):append(torrent['hash'])
    for available,date,title,torrent_hash in sorted(candidates,reverse=True):append(torrent_hash)
    return ordered


def run():
    worker.refresh_config()
    state=policy.load();policy.pending_items(state);q=worker.qb_api();torrents=q.request('GET','/api/v2/torrents/info')
    worker.protect_storage(q,torrents)
    controls=control_state.read(worker.ROOT)
    import media_hold
    exclusions=media_hold.blocked()
    held=set(control_state.held_hashes(torrents,controls))|set(exclusions['hashes'])
    if held:q.request('POST','/api/v2/torrents/stop',form={'hashes':'|'.join(held)})
    if controls['pcPaused']:return {'status':'Computer downloads paused by you'}
    if shutil.disk_usage(worker.CONFIG['data']).free<105*1024**3:return {'status':'Storage reserve; no starts'}
    storage_path=worker.ROOT/'storage-paused.json'
    storage_paused=set(json.loads(storage_path.read_text())) if storage_path.exists() else set()
    book=json.loads(ORDER_FILE.read_text()) if ORDER_FILE.exists() else {'started':[],'policyPaused':[],'lastOrder':[]}
    started=set(book['started']);paused=set(book['policyPaused']);hash_records={};seen=book.get('seen',{})
    for app,kind,resource,param in [('radarr','movie','movie','includeMovie=true'),('sonarr','tv','series','includeSeries=true')]:
        api=policy.api(app)
        native={x['id']:x for x in api.request('GET','/api/v3/'+resource,timeout=20)}
        queue=api.request('GET','/api/v3/queue?pageSize=1000&'+param,timeout=20)['records']
        for item in queue:
            native_id=item.get('movieId' if kind=='movie' else 'seriesId')
            entry=native.get(native_id,{})
            record=state['items'].get(policy.key(kind,entry.get('tmdbId')))
            if item.get('downloadId') and record:hash_records[item['downloadId'].lower()]=record
    candidates=[];stop=[];manual_stopped=0
    for torrent in torrents:
        if torrent.get('category') not in ('movies','tv') or torrent.get('progress',0)>=1:continue
        torrent_hash=torrent['hash'];record=hash_records.get(torrent_hash)
        # qBittorrent's Stop is an owner choice, including jobs previously
        # paused by this scheduler or its disk guard. Only an explicit Start
        # from the owner may restart an already-stopped job.
        if torrent['state'].startswith(('stopped','paused')):
            manual_stopped+=1;continue
        if torrent_hash in held or (record and policy.key(record['kind'],record['tmdbId']) in exclusions['keys']):
            if not torrent['state'].startswith(('stopped','paused')):stop.append(torrent_hash)
            continue
        if torrent_hash in controls['pcJobs']:continue
        if any(pathlib.Path(torrent['save_path']).resolve()==(pathlib.Path(root)/'torrents'/torrent['category']).resolve()
               and shutil.disk_usage(root).free<105*1024**3
               for root in worker.CONFIG.get('source_roots',[worker.CONFIG['data']])):
            if not torrent['state'].startswith('stopped'):stop.append(torrent_hash)
            paused.add(torrent_hash);continue
        # Force Start deliberately bypasses automatic rating/order decisions.
        # Explicit media holds and the existing disk reserve still take effect.
        if control_state.is_forced(torrent):
            started.add(torrent_hash);paused.discard(torrent_hash);continue
        if not record:continue
        wanted=record.get('manual') or record.get('eligible')
        if not wanted:
            if not torrent['state'].startswith('stopped'):stop.append(torrent_hash)
            paused.add(torrent_hash);continue
        import time
        seen.setdefault(torrent_hash,time.time())
        available=(torrent.get('dlspeed',0)>0 or torrent.get('num_seeds',0)>0 or torrent.get('num_complete',0)>0 or torrent.get('availability',0)>=1 or time.time()-seen[torrent_hash]<900)
        candidates.append((int(available),record['releaseDate'],record['title'],torrent_hash))
        started.add(torrent_hash)
    if stop:q.request('POST','/api/v2/torrents/stop',form={'hashes':'|'.join(stop)})
    desired=desired_queue(candidates,torrents,held=held|set(controls['pcJobs'])|set(stop),
                          policy_paused=paused|storage_paused,urgent=controls.get('pcPriority',[]))
    if desired!=book['lastOrder']:
        for torrent_hash in reversed(desired):q.request('POST','/api/v2/torrents/topPrio',form={'hashes':torrent_hash})
    candidate_details={h.lower():{'title':title,'releaseDate':date} for ready,date,title,h in candidates}
    titles={torrent['hash'].lower():torrent['name'] for torrent in torrents}
    report={'started':sorted(started),'policyPaused':sorted(paused),'lastOrder':desired,'seen':seen,
        'order':'urgent-then-finish-first-then-newest-available',
        'firstTen':[candidate_details.get(h,{'title':titles[h],'releaseDate':None}) for h in desired[:10]]}
    temporary=ORDER_FILE.with_suffix('.tmp');temporary.write_text(json.dumps(report,indent=2));temporary.replace(ORDER_FILE)
    return {'status':'Queue ordered','eligible':len(candidates),'resumed':0,'manualStopped':manual_stopped,'excludedHeld':len(paused),'firstTen':report['firstTen']}

if __name__=='__main__':print(json.dumps(run()))
