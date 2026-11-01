"""Install the built bundle into an existing native Jellyfin web directory."""
import argparse,datetime,hashlib,json,os,pathlib,re


def sha(data):return hashlib.sha256(data).hexdigest()
def write(path,data):
    temp=path.with_name(path.name+'.hmc-update.tmp');temp.write_bytes(data);os.replace(temp,path)


def install(bundle,web_root,backup_root):
    bundle=pathlib.Path(bundle).resolve();root=pathlib.Path(web_root).resolve();backups=pathlib.Path(backup_root).resolve()
    if backups==root or root in backups.parents:raise ValueError('Backups must stay outside the served web directory')
    index=root/'index.html';asset=root/'home-media-control.js'
    if not index.is_file():raise ValueError('The supplied web directory has no index.html')
    payload=bundle.read_bytes()
    if b'Home Media Control' not in payload:raise ValueError('Build the Home Media Control bundle first')
    before=index.read_bytes();html=before.decode('utf-8')
    html=re.sub(r'<script\b(?=[^>]*\bid=[\"\']home-media-control[\"\'])[^>]*>[\s\S]*?</script>\s*','',html,flags=re.I)
    tag='<script id="home-media-control" src="home-media-control.js?v='+sha(payload)[:12]+'"></script>\n'
    html,count=re.subn(r'</body\s*>',lambda _:tag+'</body>',html,count=1,flags=re.I)
    if count!=1:raise ValueError('No closing body tag; refusing to modify this client')
    backup=backups/datetime.datetime.now().strftime('%Y%m%dT%H%M%S%f');backup.mkdir(parents=True,exist_ok=False)
    (backup/'index.html').write_bytes(before)
    prior=asset.read_bytes() if asset.exists() else None
    if prior is not None:(backup/'home-media-control.js').write_bytes(prior)
    record={'webRoot':str(root),'beforeIndex':sha(before),'afterIndex':sha(html.encode()),'afterAsset':sha(payload),'priorAsset':prior is not None}
    (backup/'receipt.json').write_text(json.dumps(record,indent=2)+'\n')
    try:write(asset,payload);write(index,html.encode())
    except Exception:
        write(index,before)
        if prior is not None:write(asset,prior)
        elif asset.exists():asset.unlink()
        raise
    return backup


def restore(backup):
    backup=pathlib.Path(backup).resolve();record=json.loads((backup/'receipt.json').read_text())
    root=pathlib.Path(record['webRoot']).resolve();index=root/'index.html';asset=root/'home-media-control.js'
    if sha(index.read_bytes())!=record['afterIndex'] or sha(asset.read_bytes())!=record['afterAsset']:
        raise ValueError('The client changed since installation; review the backup before restoring')
    original=(backup/'index.html').read_bytes()
    if sha(original)!=record['beforeIndex']:raise ValueError('The saved index backup was changed')
    write(index,original)
    if record['priorAsset']:write(asset,(backup/'home-media-control.js').read_bytes())
    else:asset.unlink()


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--bundle',type=pathlib.Path,default=pathlib.Path('build/home-media-control.js'))
    p.add_argument('--web-root',type=pathlib.Path)
    p.add_argument('--backup-root',type=pathlib.Path,default=pathlib.Path.home()/'.home-media-control/backups')
    p.add_argument('--restore',type=pathlib.Path)
    args=p.parse_args()
    if args.restore:restore(args.restore);print('Saved client restored. Reload Jellyfin.')
    elif args.web_root:print('Installed. Reload Jellyfin. Backup:',install(args.bundle,args.web_root,args.backup_root))
    else:p.error('Choose --web-root or --restore')


if __name__=='__main__':main()
