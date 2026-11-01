"""Build the optional Jellyfin web enhancement bundle; no server mutations."""
import argparse,hashlib,json,pathlib,re
from urllib.parse import urlsplit

ROOT=pathlib.Path(__file__).resolve().parents[1]


def origin(value):
    if not isinstance(value,str):raise ValueError('Service addresses must be text')
    u=urlsplit(value)
    if u.scheme not in ('http','https') or not u.hostname or u.username or u.password or u.path not in ('','/') or u.query or u.fragment or '*' in u.hostname:
        raise ValueError('Use an exact HTTP(S) origin without credentials, path, query or fragment')
    return value.rstrip('/')


def configuration(raw):
    if not isinstance(raw,dict):raise ValueError('Configuration must be an object')
    services=raw.get('services',{})
    result={'jellyfin':origin(services['jellyfin']),
            'discovery':origin(services['discovery']) if services.get('discovery') else None,
            'status':origin(services['status']) if services.get('status') else None}
    if result['discovery']==result['jellyfin']:raise ValueError('Discovery needs its own origin or port')
    links=[]
    for item in raw.get('extraLinks',[]):
        if not isinstance(item,dict) or not isinstance(item.get('label'),str) or not 1<=len(item['label'])<=80:raise ValueError('Extra links need a short label')
        href=item.get('href','')
        if not isinstance(href,str) or not re.fullmatch(r'#/[^\s<>]*',href):raise ValueError('Extra links must be local Jellyfin hash routes')
        entry={'label':item['label'],'href':href}
        if item.get('libraryId'):
            if not re.fullmatch('[a-fA-F0-9]{32}',item['libraryId']):raise ValueError('Invalid library identifier')
            entry['libraryId']=item['libraryId']
        links.append(entry)
    result['extraLinks']=links
    return result


def js(value):return json.dumps(value,ensure_ascii=True).replace('<','\\u003c')


def build(raw):
    cfg=configuration(raw);source=ROOT/'source'
    read=lambda name:(source/name).read_text(encoding='utf-8')
    css=read('appearance/hmc-cinema.css')+'\n'+read('netflix-layout/compact.css')
    nav=read('netflix-layout/hmc-navigation.js')
    tools=[['Favourites','#/home?tab=1'],['Saved artwork','#hmc-artwork'],['TV remote controls','#hmc-projector-controls']]
    if cfg['discovery']:tools.append(['Discovery',cfg['discovery']+'/'])
    if cfg['status']:tools.extend([['Download progress',cfg['status']+'/status/#downloads'],['Server Status',cfg['status']+'/status/']])
    nav,n=re.subn(r'const channelLinks = \[[\s\S]*?\n  \];',"const channelLinks = [['All channels & guide', '#/livetv?collectionType=livetv']];",nav,count=1)
    if n!=1:raise ValueError('Navigation source format changed')
    nav,n=re.subn(r'const toolsLinks = \[[\s\S]*?\n  \];',lambda _: 'const toolsLinks = '+js(tools)+';',nav,count=1)
    if n!=1:raise ValueError('Tools navigation source format changed')
    nav=nav.replace('__HMC_CSS__',js(css)).replace('__HMC_EXTRA_LINKS__',js(cfg['extraLinks']))
    # No optional Discovery action is left visible when that service is absent.
    if not cfg['discovery']:
        css_hide='a.hmc-discovery-button,[data-hmc-discovery]{display:none!important}'
        nav=nav.replace(js(css),js(css+'\n'+css_hide))
    remote={'movieOrigin':cfg['jellyfin'],'discoverOrigin':cfg['discovery'] or 'https://discovery.example.invalid','portalOrigin':cfg['status'] or cfg['jellyfin']}
    bundle='/* Home Media Control development preview. See LICENSE and README. */\nwindow.HomeMediaRemoteConfig='+js(remote)+';\n'+nav
    for name in ['usability/hmc-browse.js','artwork-cache/artwork-cache.js','projector-input/projector-input.js',
                 'projector-couch/tv-couch.js','projector-couch/tv-couch-actions.js','projector-couch/tv-couch-load.js',
                 'projector-couch/tv-search-focus.js','projector-couch/tv-playback-controls.js']:
        bundle+='\n\n'+read(name)
    replacements=[('http://192.0.2.10:8096',cfg['jellyfin']),
                  ('http://media-discover.local',cfg['discovery'] or 'https://discovery.example.invalid'),
                  ('http://192.0.2.10:5055',cfg['discovery'] or 'https://discovery.example.invalid'),
                  ('http://media-movies.local:8080',cfg['status'] or cfg['jellyfin']),
                  ('http://192.0.2.10:8080',cfg['status'] or cfg['jellyfin']),
                  ('http://192.0.2.10',cfg['status'] or cfg['jellyfin'])]
    for before,after in replacements:bundle=bundle.replace(before,after)
    if '__HMC_' in bundle:raise ValueError('Unresolved bundle placeholder')
    return bundle.encode('utf-8')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config',type=pathlib.Path,default=ROOT/'web-config.example.json')
    parser.add_argument('--output',type=pathlib.Path,default=ROOT/'build/home-media-control.js')
    args=parser.parse_args();data=build(json.loads(args.config.read_text(encoding='utf-8')))
    args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_bytes(data)
    print(json.dumps({'built':str(args.output),'sha256':hashlib.sha256(data).hexdigest(),'serverChanged':False}))


if __name__=='__main__':main()
