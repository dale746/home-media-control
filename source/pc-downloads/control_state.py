"""Persistent user choices shared by the dashboard and download workers."""
import json,os,pathlib,time
ROOT=pathlib.Path(os.environ.get('LOCALAPPDATA',str(pathlib.Path.home())))/'HomeMediaControl'


def read(root=None):
    path=pathlib.Path(root or ROOT)/'manual-controls.json'
    try:value=json.loads(path.read_text())
    except (OSError,ValueError):value={}
    for key in ('pcPaused','piPaused','copyPaused'):value.setdefault(key,False)
    for key in ('pcJobs','piJobs','pcResume'):value.setdefault(key,[])
    return value


def save(value,root=None):
    path=pathlib.Path(root or ROOT)/'manual-controls.json'
    value['updated']=time.time()
    temporary=path.with_name(path.name+'.'+str(os.getpid())+'.tmp')
    temporary.write_text(json.dumps(value,indent=2));temporary.replace(path)


def is_forced(torrent):
    return bool(torrent.get('force_start')) or torrent.get('state','').startswith('forced')


def held_hashes(torrents,value,machine='pc'):
    held=set(value.get(machine+'Jobs',[]))
    return [item['hash'] for item in torrents if item.get('progress',0)<1
            and not item.get('state','').startswith(('stopped','paused'))
            and not is_forced(item)
            and (value.get(machine+'Paused') or item['hash'] in held)]
