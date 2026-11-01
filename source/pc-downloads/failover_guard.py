"""Pi-owned backup routing and season-one/disk-reserve guard."""
import datetime
import http.cookiejar
import json
import pathlib
import shutil
import subprocess
import time
import urllib.parse
import urllib.request

ROOT=pathlib.Path('/opt/media/config/pc-downloads')

class Api:
    def __init__(self,base,key=None):
        self.base=base;self.key=key
        self.opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    def call(self,method,path,data=None,form=None,timeout=6):
        headers={'X-Api-Key':self.key} if self.key else {}
        body=None
        if data is not None:body=json.dumps(data).encode();headers['Content-Type']='application/json'
        if form is not None:body=urllib.parse.urlencode(form).encode()
        request=urllib.request.Request(self.base+path,data=body,headers=headers,method=method)
        with self.opener.open(request,timeout=timeout) as response:
            body=response.read()
            if not body:return None
            try:return json.loads(body)
            except ValueError:return body.decode()

def priorities(healthy):return {'computer':1,'backup':20} if healthy else {'computer':20,'backup':1}


def seerr_server_update(server,tags):
    # Seerr returns an ID but marks that property read-only in update bodies.
    body={key:value for key,value in server.items() if key!='id'}
    body['tags']=list(tags)
    return body


def client_layout(preferences,bulk_tag,manual_tag,disabled_tag,healthy):
    bulk=preferences.get('bulk_destination','computer')
    manual=preferences.get('manual_destination','pi')
    fallback=preferences.get('pi_fallback',True)
    computer_tags=[]
    if bulk=='computer':computer_tags.append(bulk_tag)
    if manual=='computer':computer_tags.append(manual_tag)
    def pi_lane(destination,tag):
        enabled=destination=='pi' or fallback
        return {'tags':[tag] if enabled else [disabled_tag],
                'priority':1 if destination=='pi' or (fallback and not healthy) else 20}
    return {'computer':{'tags':computer_tags or [disabled_tag],'priority':1 if healthy else 20},
            'backup':pi_lane(bulk,bulk_tag),'manual':pi_lane(manual,manual_tag)}

def run():
    cfg=json.loads((ROOT/'failover-config.json').read_text())
    dashboard=ROOT/'dashboard-controls.json'
    preferences=json.loads(dashboard.read_text()) if dashboard.exists() else {}
    if cfg.get('mediaUUID'):
        mounted=subprocess.check_output(['findmnt','-rn','-M','/opt/media/data','-o','UUID'],text=True).strip()
        assert mounted==cfg['mediaUUID'],'Media disk is unavailable'
    path=ROOT/'failover-state.json'
    state=json.loads(path.read_text()) if path.exists() else {'healthy':True,'good':0,'bad':0,'seriesCheck':0}
    try:
        pc=Api('http://127.0.0.1:18080')
        pc.call('POST','/api/v2/auth/login',form={'username':cfg['username'],'password':cfg['password']})
        pc.call('GET','/api/v2/app/version')
        free=pc.call('GET','/api/v2/sync/maindata').get('server_state',{}).get('free_space_on_disk')
        healthy=free is None or free>=100*1024**3
    except Exception:healthy=False
    state['good']=state.get('good',0)+1 if healthy else 0
    state['bad']=state.get('bad',0)+1 if not healthy else 0
    if state['bad']>=2:state['healthy']=False
    if state['good']>=2:state['healthy']=True
    wanted=priorities(state['healthy'])
    check_tags=time.time()-state.get('dashboardTagCheck',0)>300 or state.get('dashboardRevision')!=preferences.get('revision')
    for name,port in [('radarr',7878),('sonarr',8989)]:
        api=Api('http://127.0.0.1:'+str(port),cfg['api_keys'][name])
        layout=None
        if preferences:
            tags=api.call('GET','/api/v3/tag')
            def tag_id(label):
                existing=next((item['id'] for item in tags if item['label']==label),None)
                if existing is not None:return existing
                item=api.call('POST','/api/v3/tag',data={'label':label});tags.append(item);return item['id']
            manual_tag=tag_id('dashboard-manual');disabled_tag=tag_id('dashboard-unused')
            bulk_tag=cfg['tags'][name]
            resource='movie' if name=='radarr' else 'series'
            if check_tags:
                for item in api.call('GET','/api/v3/'+resource,timeout=20):
                    before=set(item.get('tags',[]));after=set(before)
                    if bulk_tag in before:after.discard(manual_tag)
                    else:after.add(manual_tag)
                    if after!=before:
                        item['tags']=sorted(after);api.call('PUT','/api/v3/'+resource+'/'+str(item['id']),data=item,timeout=15)
                seerr=Api('http://127.0.0.1:5055',cfg['api_keys']['seerr'])
                for server in seerr.call('GET','/api/v1/settings/'+name):
                    if server.get('isDefault') and server.get('tags')!=[manual_tag]:
                        seerr.call('PUT','/api/v1/settings/'+name+'/'+str(server['id']),
                                   data=seerr_server_update(server,[manual_tag]),timeout=15)
            layout=client_layout(preferences,bulk_tag,manual_tag,disabled_tag,state['healthy'])
        for client in api.call('GET','/api/v3/downloadclient'):
            role=next((role for role in (['computer','backup','manual'] if layout else ['computer','backup']) if client['id']==cfg['clients'][name].get(role)),None)
            changes=layout.get(role) if layout and role else ({'priority':wanted[role]} if role else None)
            if changes and any(client.get(key)!=value for key,value in changes.items()):
                client.update(changes)
                api.call('PUT',f'/api/v3/downloadclient/{client["id"]}?forceSave=true',data=client)
        if name=='sonarr' and time.time()-state.get('seriesCheck',0)>300:
            for series in api.call('GET','/api/v3/series'):
                if cfg['tags'][name] not in series.get('tags',[]):continue
                changed=series.get('monitorNewItems')!='none';series['monitorNewItems']='none'
                for season in series['seasons']:
                    expected=season['seasonNumber']==1 and series.get('monitored',True)
                    if season['monitored']!=expected:season['monitored']=expected;changed=True
                if changed:api.call('PUT','/api/v3/series/'+str(series['id']),data=series,timeout=15)
            state['seriesCheck']=time.time()
    # The system/media drive must retain working space even in backup mode.
    state['piFreeGiB']=round(shutil.disk_usage('/opt/media/data').free/1024**3,1)
    if state['piFreeGiB']<100 or preferences:
        pi=Api('http://127.0.0.1:8080')
        pi.call('POST','/api/v2/auth/login',form={'username':cfg['username'],'password':cfg['password']})
        torrents=pi.call('GET','/api/v2/torrents/info')
        paused=set(preferences.get('piJobs',[]))
        active=[t['hash'] for t in torrents if t['progress']<1 and not t['state'].startswith(('stopped','paused'))
                and (state['piFreeGiB']<100 or preferences.get('piPaused') or t['hash'] in paused)]
        if active:pi.call('POST','/api/v2/torrents/stop',form={'hashes':'|'.join(active)})
        owned=set(state.get('dashboardPiOwned',[]))
        if preferences.get('piPaused'):owned.update(active)
        elif state['piFreeGiB']>=100:
            resume=owned-paused
            if resume:pi.call('POST','/api/v2/torrents/start',form={'hashes':'|'.join(sorted(resume))})
            owned.clear()
        state['dashboardPiOwned']=sorted(owned)
        if preferences and state.get('dashboardRevision')!=preferences.get('revision'):
            count=preferences.get('pi_max_downloads',2);rate=preferences.get('pi_download_mbps',2)
            pi.call('POST','/api/v2/app/setPreferences',form={'json':json.dumps({'queueing_enabled':True,
                'dont_count_slow_torrents':False,'max_active_downloads':count,'max_active_torrents':count+2,
                'dl_limit':int(rate*1000000)})})
            state.update(dashboardRevision=preferences.get('revision'))
    if preferences and check_tags:state['dashboardTagCheck']=time.time()
    state.update(updated=datetime.datetime.now().astimezone().isoformat(timespec='minutes'),
                 bulkRoute=preferences.get('bulk_destination','computer') if preferences else ('computer' if state['healthy'] else 'Pi backup'),
                 manualRoute=preferences.get('manual_destination','pi'))
    temporary=path.with_suffix('.tmp');temporary.write_text(json.dumps(state,indent=2));temporary.replace(path)
    print(json.dumps({'manual':state['manualRoute'],'bulk':state['bulkRoute'],'seasonPolicy':'first season only'}))

if __name__=='__main__':
    try:run()
    except Exception as exc:print('Routing check deferred:',type(exc).__name__)
