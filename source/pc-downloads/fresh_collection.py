import collections
import json
import pathlib
import urllib.parse

import worker

NAME='Fresh Picks - 60% and Up'
ROOT=pathlib.Path(worker.CONFIG['data'])/'Rotten Tomatoes collection'

def normalize(value):
    import unicodedata
    return ''.join(c for c in unicodedata.normalize('NFKD',value).casefold().replace('&','and') if c.isalnum())

def run():
    catalogue=json.loads((ROOT/'catalogue.json').read_text(encoding='utf-8'))
    index=collections.defaultdict(dict)
    for film in catalogue:
        for title in [film['title'],*film.get('alternateTitles',[])]:
            index[(normalize(title),film['year'])][film['vanity']]=film
    authorization=('MediaBrowser Client="mediaadmin Media", Device="Computer", '
        'DeviceId="hmc-computer-downloads", Version="1.0", Token="'+worker.CONFIG['jellyfin_token']+'"')
    api=worker.Api('http://192.0.2.10:8096',{'Authorization':authorization})
    items=api.request('GET','/Items?Recursive=true&IncludeItemTypes=Movie&Fields=Genres,ProviderIds&Limit=10000',timeout=30)['Items']
    selected=[]
    for item in items:
        if not item.get('Genres') or any('horror' in g.casefold() for g in item['Genres']):continue
        year=item.get('ProductionYear')
        matches=index.get((normalize(item['Name']),year), {})
        if not matches and isinstance(year,int):
            matches={**index.get((normalize(item['Name']),year-1),{}),**index.get((normalize(item['Name']),year+1),{})}
        if len(matches)==1:selected.append(item['Id'])
    if not selected:return {'available':0}
    collections_list=api.request('GET','/Items?Recursive=true&IncludeItemTypes=BoxSet',timeout=30)['Items']
    found=next((x for x in collections_list if x['Name']==NAME),None)
    if found:collection_id=found['Id']
    else:
        query=urllib.parse.urlencode({'name':NAME,'isLocked':'true','ids':','.join(selected)})
        collection_id=api.request('POST','/Collections?'+query,timeout=30)['Id']
    before=api.request('GET','/Items?parentId='+collection_id,timeout=30)['Items']
    current={x['Id'] for x in before}
    for method,values in [('POST',set(selected)-current),('DELETE',current-set(selected))]:
        if values:api.request(method,'/Collections/'+collection_id+'/Items?ids='+','.join(values),timeout=30)
    report={'name':NAME,'id':collection_id,'available':len(selected),
        'url':'http://media-movies.local/web/#/details?id='+collection_id,
        'filter':'RT critics score at least 60; horror excluded; unique title/release-year matches only.'}
    (ROOT/'Jellyfin collection.json').write_text(json.dumps(report,indent=2))
    return report

if __name__=='__main__':print(json.dumps(run()))
