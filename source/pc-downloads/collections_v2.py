"""Available movie and TV picks using the verified 75% acquisition policy."""
import json,urllib.parse
import worker
import bulk_policy as policy

def run():
    state=policy.load();policy.pending_items(state)
    authorization=('MediaBrowser Client="mediaadmin Media", Device="Computer", DeviceId="hmc-computer-downloads", Version="1.0", Token="'+worker.CONFIG['jellyfin_token']+'"')
    api=worker.Api('http://192.0.2.10:8096',{'Authorization':authorization})
    boxes=api.request('GET','/Items?Recursive=true&IncludeItemTypes=BoxSet',timeout=30)['Items']
    mapping_file=policy.ROOT/'collections-state.json'
    mapping=json.loads(mapping_file.read_text()) if mapping_file.exists() else {}
    legacy=policy.ROOT/'Jellyfin collection.json'
    if 'movie' not in mapping and legacy.exists():mapping['movie']={'id':json.loads(legacy.read_text())['id']}
    result={}
    for kind,label,item_type,overview in [
        ('movie','Movie Picks - 75% and Sequels','Movie','Films rated 75% or higher on Rotten Tomatoes, plus their released sequels. Horror excluded.'),
        ('tv','TV Picks - 75%','Series','Highly rated TV series, starting with season one. Horror excluded.')]:
        media=api.request('GET','/Items?Recursive=true&IncludeItemTypes='+item_type+'&Fields=Genres,ProviderIds&Limit=10000',timeout=30)['Items']
        members=[]
        for item in media:
            tmdb=(item.get('ProviderIds') or {}).get('Tmdb')
            if not tmdb:continue
            record=state['items'].get(policy.key(kind,tmdb))
            if not record or not record.get('eligible') or any('horror' in g.casefold() for g in item.get('Genres',[])):continue
            members.append(item['Id'])
        if not members:continue
        prior=mapping.get(kind,{})
        found=next((b for b in boxes if b['Id']==prior.get('id') or b['Name']==label),None)
        cid=found['Id'] if found else api.request('POST','/Collections?'+urllib.parse.urlencode({'name':label,'isLocked':'true','ids':','.join(members)}),timeout=30)['Id']
        if not found or found['Name']!=label:
            dto=api.request('GET','/Items/'+cid,timeout=30)
            dto.update(Name=label,Overview=overview)
            api.request('POST','/Items/'+cid,data=dto,timeout=30)
        old={x['Id'] for x in api.request('GET','/Items?parentId='+cid,timeout=30)['Items']}
        for method,ids in [('POST',set(members)-old),('DELETE',old-set(members))]:
            if ids:api.request(method,'/Collections/'+cid+'/Items?ids='+','.join(ids),timeout=30)
        result[kind]={'id':cid,'name':label,'available':len(members),'url':'http://media-movies.local/web/#/details?id='+cid}
        mapping[kind]=result[kind]
    mapping_file.write_text(json.dumps(mapping,indent=2))
    return result

if __name__=='__main__':print(json.dumps(run()))
