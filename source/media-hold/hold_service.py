"""Recoverable media removal. HTTP can hold; only the local dashboard's SSH path can purge.

Jellyfin's library bind stays read-only. Journals are on the system SSD; payloads
are renamed on the verified media filesystem. Nothing expires automatically.
"""
import contextlib
import ctypes
import datetime
import fcntl
import http.server
import json
import os
import pathlib
import pwd
import re
import secrets
import shutil
import stat
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

BASE = pathlib.Path('/opt/media/config/media-hold')
MEDIA = pathlib.Path('/opt/media/data')
EXPECTED_UUID = '88f44748-c9ff-5d62-92b5-4c39bd8452a1'
PAYLOAD = MEDIA / '.hmc-hold'
ORIGINS = {'http://media-movies.local', 'http://media-movies.local:8096',
           'http://192.0.2.10', 'http://192.0.2.10:8096'}
try:
    remote=json.loads((BASE.parent/'remote-access/client-config.json').read_text())
    value=remote.get('movieOrigin','');parsed=urllib.parse.urlsplit(value)
    if parsed.scheme in ('http','https') and parsed.hostname and not parsed.username and not parsed.password and parsed.path in ('','/') and not parsed.query and not parsed.fragment and '*' not in parsed.hostname:
        ORIGINS.add(value.rstrip('/'))
except (OSError,ValueError,TypeError):
    pass
TERMINAL = {'restored', 'cancelled'}
LOCK = threading.RLock()
MAX_PURGE_SELECTION = 200


class HoldError(ValueError):
    pass


def rename_exclusive(source, destination):
    """Atomic no-overwrite rename, including a target created after preflight."""
    libc=ctypes.CDLL(None,use_errno=True)
    rename=libc.renameat2
    rename.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]
    rename.restype=ctypes.c_int
    if rename(-100,os.fsencode(source),-100,os.fsencode(destination),1):
        error=ctypes.get_errno()
        if error==17:raise HoldError('A file now occupies the destination. Nothing was overwritten.')
        raise OSError(error,os.strerror(error))


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')


def config():
    return json.loads((BASE / 'private.json').read_text())


def atomic(path, value):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temp = path.with_name(path.name + '.tmp')
    with temp.open('w') as out:
        os.chmod(temp, 0o600)
        json.dump(value, out, ensure_ascii=True, indent=2)
        out.flush()
        os.fsync(out.fileno())
    os.replace(temp, path)


@contextlib.contextmanager
def locked():
    with LOCK:
        BASE.mkdir(mode=0o700, parents=True, exist_ok=True)
        with (BASE / 'operation.lock').open('a') as stream:
            fcntl.flock(stream, fcntl.LOCK_EX)
            yield


def guard_storage():
    value = subprocess.check_output(['findmnt', '-rn', '-M', str(MEDIA), '-o', 'UUID'], text=True).strip()
    if value != EXPECTED_UUID:
        raise HoldError('The expected media drive is unavailable. No files were changed.')
    if MEDIA.is_symlink() or not os.access(MEDIA, os.W_OK):
        raise HoldError('The media drive is not ready for changes.')
    PAYLOAD.mkdir(mode=0o700, exist_ok=True)
    if PAYLOAD.is_symlink() or PAYLOAD.stat().st_dev != MEDIA.stat().st_dev:
        raise HoldError('The holding folder is not on the expected media drive.')


def api(service, method, path, data=None, token=None, form=None):
    cfg = config()
    if service == 'jellyfin':
        value=token or cfg['jellyfin_token']
        base, headers = 'http://127.0.0.1:8096', {'Authorization': 'MediaBrowser Client="mediaadmin Media Holding", Device="Media Server", DeviceId="hmc-media-hold", Version="1.0", Token="' + value + '"'}
    elif service in ('radarr', 'sonarr'):
        base = 'http://127.0.0.1:' + {'radarr': '7878', 'sonarr': '8989'}[service]
        headers = {'X-Api-Key': cfg['arr_keys'][service]}
    else:
        raise HoldError('Unknown media service')
    payload = None
    if data is not None:
        payload = json.dumps(data).encode()
        headers['Content-Type'] = 'application/json'
    if form is not None:
        payload = urllib.parse.urlencode(form).encode()
        headers['Content-Type'] = 'application/x-www-form-urlencoded'
    req = urllib.request.Request(base + path, payload, headers, method=method)
    with urllib.request.urlopen(req, timeout=25) as response:
        body = response.read()
        return json.loads(body) if body else None


def authenticate(token, deletion=False, admin=False):
    if not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9_-]{20,256}', token):
        raise HoldError('Sign in to Movies before changing the library.')
    if admin and any(secrets.compare_digest(token, known) for known in config().get('read_tokens', [])):
        # Existing automation API keys have no /Users/Me identity. They may read
        # exclusions and holding summaries; only user sessions may request a move.
        api('jellyfin', 'GET', '/System/Info', token=token)
        return {'Id': '', 'Policy': {'IsAdministrator': True}}
    try:
        user = api('jellyfin', 'GET', '/Users/Me', token=token)
    except urllib.error.HTTPError:
        raise HoldError('Your Movies sign-in has expired. Sign in again.') from None
    policy = user.get('Policy', {})
    if policy.get('IsDisabled') or (admin and not policy.get('IsAdministrator')):
        raise HoldError('This action requires the library administrator.')
    if deletion and not (policy.get('IsAdministrator') or policy.get('EnableContentDeletion')):
        raise HoldError('This account cannot remove media.')
    return user


def entry_path(identifier):
    if not isinstance(identifier, str) or not re.fullmatch(r'[a-f0-9]{32}', identifier):
        raise HoldError('Invalid holding item')
    return BASE / 'entries' / (identifier + '.json')


def entries():
    return [json.loads(p.read_text()) for p in sorted((BASE / 'entries').glob('*.json'))]


def write_entry(record):
    record['updated'] = now()
    atomic(entry_path(record['id']), record)
    records = entries()
    active = [x for x in records if x['state'] not in TERMINAL]
    atomic(BASE / 'blocked.json', {
        'keys': sorted({x['key'] for x in active if x.get('key')}),
        'hashes': sorted({h for x in active for h in x.get('hashes', [])}),
        'native': {app: sorted({x['organiser']['id'] for x in active if x.get('organiser') and x['organiser']['app'] == app}) for app in ('radarr', 'sonarr')},
        'updated': now(),
    })
    # The existing downloader proxy can read exclusions, never journals or credentials.
    os.chown(BASE / 'blocked.json', 0, pwd.getpwnam('mediaadmin').pw_gid)
    (BASE / 'blocked.json').chmod(0o640)


def blocked():
    p = BASE / 'blocked.json'
    return json.loads(p.read_text()) if p.exists() else {'keys': [], 'hashes': [], 'native': {}}


def checked_path(raw, roots):
    p = pathlib.Path(raw)
    if not p.is_absolute() or '..' in p.parts:
        raise HoldError('Unexpected media location')
    root = next((r for r in roots if p != r and p.is_relative_to(r)), None)
    if root is None:
        raise HoldError('This location is outside the managed movie and TV libraries.')
    for part in [root, *list(p.parents)[:len(p.parts) - len(root.parts) - 1], p]:
        if part.is_symlink():
            raise HoldError('Linked folders cannot be moved into holding.')
    if p.resolve(strict=False) != p:
        raise HoldError('Unexpected linked media location')
    return p


def inspect_tree(path):
    files = [path] if path.is_file() else list(path.rglob('*'))
    if len(files) > 30000:
        raise HoldError('This folder is too large for one holding action.')
    result = []
    for p in files:
        info = p.lstat()
        if stat.S_ISLNK(info.st_mode) or not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
            raise HoldError('The folder contains an unsupported linked or special file.')
        if info.st_dev != MEDIA.stat().st_dev:
            raise HoldError('A media folder crosses into another drive.')
        if stat.S_ISREG(info.st_mode):
            result.append((p, info))
    return result


def plan_item(item):
    kind = item.get('Type')
    if kind not in ('Movie', 'Series'):
        raise HoldError('Holding supports movies and whole TV series. Open the series page to hold a show.')
    root = MEDIA / 'media' / ('movies' if kind == 'Movie' else 'tv')
    raw = item.get('Path', '')
    if not raw.startswith('/data/media/'):
        raise HoldError('Only local movie and TV files can be held.')
    path = checked_path(str(MEDIA / raw.removeprefix('/data/')), [root])
    relative = path.relative_to(root)
    if kind == 'Movie' and len(relative.parts) >= 2:
        selected = root / relative.parts[0]
    elif kind == 'Series' and len(relative.parts) == 1 and path.is_dir():
        selected = path
    else:
        raise HoldError('This item needs its own movie or series folder before it can be held safely.')
    selected = checked_path(str(selected), [root])
    if not selected.is_dir():
        raise HoldError('The media folder is missing. Nothing was removed.')
    for source in item.get('MediaSources', []):
        candidate = pathlib.PurePosixPath(source.get('Path', ''))
        expected = pathlib.PurePosixPath('/data') / selected.relative_to(MEDIA)
        if candidate != expected and not candidate.is_relative_to(expected):
            raise HoldError('This title has versions in different folders. No files were moved.')
    files = inspect_tree(selected)
    if not files:
        raise HoldError('The media folder is empty.')
    return selected, files


def organiser(item):
    app, resource = ('radarr', 'movie') if item['Type'] == 'Movie' else ('sonarr', 'series')
    providers = item.get('ProviderIds', {})
    native = api(app, 'GET', '/api/v3/' + resource)
    match = [x for x in native if str(x.get('tmdbId', '')) == providers.get('Tmdb', '!') or str(x.get('tvdbId', '')) == providers.get('Tvdb', '!') or x.get('path') == str(pathlib.PurePosixPath(item.get('Path', '')).parent if item['Type'] == 'Movie' else item.get('Path'))]
    if len(match) > 1:
        raise HoldError('More than one organiser entry matches this title.')
    if not match:
        return None
    movie = match[0]
    return {'app': app, 'resource': resource, 'id': movie['id'], 'before': movie}


def set_monitor(record, restore=False):
    saved = record.get('organiser')
    if not saved:
        return
    route = '/api/v3/' + saved['resource'] + '/' + str(saved['id'])
    try:
        current = api(saved['app'], 'GET', route)
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return
        raise
    current['monitored'] = saved['before'].get('monitored', False) if restore else False
    if saved['app'] == 'sonarr':
        old = {s['seasonNumber']: s.get('monitored', False) for s in saved['before'].get('seasons', [])}
        for s in current.get('seasons', []):
            s['monitored'] = old.get(s['seasonNumber'], False) if restore else False
    api(saved['app'], 'PUT', route, current)


def discover_hashes(record, aliases):
    hashes = set()
    saved = record.get('organiser')
    if saved:
        field = 'movieId' if saved['app'] == 'radarr' else 'seriesId'
        for route in ['/api/v3/queue?pageSize=1000', '/api/v3/history?pageSize=1000&sortKey=date&sortDirection=descending']:
            data = api(saved['app'], 'GET', route)
            for row in data.get('records', []):
                value = (row.get('downloadId') or '').lower()
                if row.get(field) == saved['id'] and re.fullmatch(r'[a-f0-9]{40}|[a-f0-9]{64}', value):
                    hashes.add(value)
    # Ready markers connect hardlinked imports with their PC jobs even after Arr history ages out.
    alias_names = {str(p.relative_to(MEDIA / 'torrents/pc')) for p in aliases if p.is_relative_to(MEDIA / 'torrents/pc')}
    for marker in (MEDIA / 'torrents/pc/.ready').glob('*.json'):
        try:
            value = json.loads(marker.read_text())
            if any(value.get('category', '') + '/' + f.get('name', '') in alias_names for f in value.get('files', [])):
                hashes.add(value['hash'].lower())
        except (ValueError, KeyError, OSError):
            raise HoldError('A transfer marker could not be checked. No media was moved.') from None
    return sorted(hashes)


def stop_jobs(hashes):
    cfg = config()
    for name, base in [('server', 'http://127.0.0.1:8080'), ('computer', 'http://192.0.2.10:18081')]:
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor())
        def call(path, values):
            req = urllib.request.Request(base + path, urllib.parse.urlencode(values).encode(), method='POST')
            with opener.open(req, timeout=8) as res:
                return res.read()
        try:
            credentials=cfg['qb'][name]
            call('/api/v2/auth/login', {'username': credentials['username'], 'password': credentials['password']})
            if hashes:
                call('/api/v2/torrents/stop', {'hashes': '|'.join(hashes)})
                # Remove the job, retaining every source file. Otherwise Arr can reimport a completed, stopped job.
                call('/api/v2/torrents/delete', {'hashes': '|'.join(hashes), 'deleteFiles': 'false'})
        except (OSError, urllib.error.HTTPError):
            if name == 'server':
                raise HoldError('The server downloader could not be put on hold. Try again shortly.') from None
            # An offline PC cannot currently import. The persisted block also gates its worker and proxy.


def library_remove(record):
    # Every original source path is already absent. Jellyfin still has a read-only bind.
    try:
        api('jellyfin', 'DELETE', '/Items/' + record['item']['Id'])
    except urllib.error.HTTPError as exc:
        if exc.code != 404:
            api('jellyfin', 'POST', '/Library/Media/Updated', {'Updates': [{'Path': record['item']['Path'], 'UpdateType': 'Deleted'}]})


def hold(identifier, user):
    if not re.fullmatch(r'[a-fA-F0-9]{32}', identifier or ''):
        raise HoldError('Invalid movie identifier')
    with locked():
        guard_storage()
        previous = next((x for x in entries() if x['item']['Id'] == identifier and x['state'] not in TERMINAL), None)
        if previous:
            return {'message': 'This title is already in holding.', 'id': previous['id']}
        item = api('jellyfin', 'GET', '/Items/' + identifier + '?userId=' + user['Id'])
        source, files = plan_item(item)
        if not user.get('Policy', {}).get('IsAdministrator') and not item.get('CanDelete', False):
            raise HoldError('This account cannot remove this title.')
        sessions = api('jellyfin', 'GET', '/Sessions')
        prefix = str(pathlib.PurePosixPath('/data') / source.relative_to(MEDIA)) + '/'
        if any(s.get('NowPlayingItem') and (s['NowPlayingItem'].get('Id') == identifier or s['NowPlayingItem'].get('SeriesId') == identifier or str(s['NowPlayingItem'].get('Path', '')).startswith(prefix)) for s in sessions):
            raise HoldError('This title is playing. Stop it before moving it to holding.')
        library=api('jellyfin','GET','/Items?Recursive=true&IncludeItemTypes='+item['Type']+'&Fields=Path,ProviderIds&EnableUserData=false&Limit=20000')
        if library and library.get('TotalRecordCount',0)>20000:
            raise HoldError('The library is too large for this safety check. No media was moved.')
        for other in (library or {}).get('Items',[]):
            if other['Id']==identifier or not str(other.get('Path','')).startswith(prefix):continue
            same=any(value and other.get('ProviderIds',{}).get(name)==value for name,value in item.get('ProviderIds',{}).items() if name in ('Tmdb','Imdb','Tvdb'))
            if not same:raise HoldError('Another title shares this folder. Separate its files before moving it to holding.')
        links = {(s.st_dev, s.st_ino) for p, s in files if s.st_nlink > 1}
        aliases = []
        if links:
            for parent, dirs, names in os.walk(MEDIA / 'torrents', followlinks=False):
                dirs[:] = [d for d in dirs if not pathlib.Path(parent, d).is_symlink() and d != '.incoming']
                for name in names:
                    p = pathlib.Path(parent, name)
                    s = p.lstat()
                    if stat.S_ISREG(s.st_mode) and (s.st_dev, s.st_ino) in links:
                        checked_path(str(p), [MEDIA / 'torrents'])
                        aliases.append(p)
        saved = organiser(item)
        providers = item.get('ProviderIds', {})
        key = ('movie:' if item['Type'] == 'Movie' else 'tv:') + str(providers.get('Tmdb') or ((saved or {}).get('before') or {}).get('tmdbId') or '')
        if key.endswith(':'):
            key = ''
        record = {'id': uuid.uuid4().hex, 'state': 'preparing', 'created': now(), 'item': item,
                  'userId': user['Id'], 'key': key, 'organiser': saved, 'hashes': [], 'moves': [],
                  'bytes': sum(s.st_size for p, s in files), 'fileCount': len(files), 'error': None}
        record['hashes'] = discover_hashes(record, aliases)
        destination = PAYLOAD / record['id']
        destination.mkdir(mode=0o700)
        moves = [(source, destination / 'library')]
        moves += [(p, destination / 'links' / str(i)) for i, p in enumerate(aliases)]
        record['moves'] = [{'from': str(a), 'to': str(b)} for a, b in moves]
        write_entry(record)  # Publish the exclusion before any file can become missing.
        try:
            set_monitor(record)
            stop_jobs(record['hashes'])
            for a, b in moves:
                b.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                rename_exclusive(a, b)
            library_remove(record)
            record['state'] = 'held'
            write_entry(record)
        except Exception:
            record['state'] = 'attention'
            record['error'] = 'The move did not finish. Your files remain recoverable; use Restore in Media Control.'
            write_entry(record)
            raise HoldError(record['error']) from None
        return {'message': 'Moved to holding. Restore or permanently delete it in Media Control.', 'id': record['id']}


def list_public():
    records = [x for x in entries() if x['state'] not in TERMINAL and x['state'] != 'purged']
    return {'items': [{'id': x['id'], 'title': x['item']['Name'], 'year': x['item'].get('ProductionYear'),
                       'type': x['item']['Type'], 'created': x['created'], 'bytes': x['bytes'],
                       'state': x['state'], 'error': x.get('error')} for x in reversed(records)],
            'bytes': sum(x['bytes'] for x in records), 'automaticDeletion': False,
            'purgedCount': sum(x['state'] == 'purged' for x in entries())}


def validate_moves(record):
    if record['id'] != entry_path(record['id']).stem:
        raise HoldError('Invalid journal')
    for m in record['moves']:
        a = checked_path(m['from'], [MEDIA / 'media/movies', MEDIA / 'media/tv', MEDIA / 'torrents'])
        b = checked_path(m['to'], [PAYLOAD / record['id']])
        if a == b:
            raise HoldError('Invalid holding location')
        if b.exists():
            inspect_tree(b)


def restore(identifier):
    with locked():
        guard_storage()
        record = json.loads(entry_path(identifier).read_text())
        if record['state'] not in ('held', 'attention', 'preparing', 'restoring'):
            raise HoldError('This title is not available to restore.')
        validate_moves(record)
        for m in record['moves']:
            a, b = pathlib.Path(m['from']), pathlib.Path(m['to'])
            if a.exists() and b.exists():
                raise HoldError('A file now occupies the original location. Nothing was overwritten.')
            if not a.exists() and not b.exists():
                raise HoldError('A held file is missing. Restore was stopped.')
        record['state'] = 'restoring'
        write_entry(record)
        for m in record['moves']:
            a, b = pathlib.Path(m['from']), pathlib.Path(m['to'])
            if b.exists():
                a.parent.mkdir(parents=True, exist_ok=True)
                rename_exclusive(b, a)
        # A restore stays blocked until the organiser and library accept the files.
        saved = record.get('organiser')
        if saved:
            api(saved['app'], 'POST', '/api/v3/command', {'name': 'RefreshMovie' if saved['app'] == 'radarr' else 'RefreshSeries', ('movieIds' if saved['app'] == 'radarr' else 'seriesId'): [saved['id']] if saved['app'] == 'radarr' else saved['id']})
        api('jellyfin', 'POST', '/Library/Media/Updated', {'Updates': [{'Path': record['item']['Path'], 'UpdateType': 'Created'}]})
        parent=record['item'].get('ParentId')
        if parent and re.fullmatch(r'[a-fA-F0-9]{32}',parent):
            api('jellyfin','POST','/Items/'+parent+'/Refresh?Recursive=true&MetadataRefreshMode=ValidationOnly&ImageRefreshMode=ValidationOnly&ReplaceAllMetadata=false&ReplaceAllImages=false')
        found=False
        for _ in range(20):
            try:
                item=api('jellyfin','GET','/Items/'+record['item']['Id'])
                if item and item.get('Path')==record['item']['Path']:
                    found=True;break
            except urllib.error.HTTPError as exc:
                if exc.code!=404:raise
            time.sleep(1)
        if not found:
            record['error']='Files are restored safely; the library update is still pending. Choose Restore again shortly.'
            write_entry(record)
            return {'message':record['error']}
        saved_data=record['item'].get('UserData')
        if saved_data:
            wanted={k:v for k,v in saved_data.items() if k in ('IsFavorite','Played','PlaybackPositionTicks','PlayCount','LastPlayedDate','Likes','Rating')}
            api('jellyfin','POST','/UserItems/'+record['item']['Id']+'/UserData?userId='+record['userId'],wanted)
        set_monitor(record, restore=True)
        record['state'] = 'restored'
        record['error']=None
        write_entry(record)
        return {'message': 'Restored to Movies, including its saved favourite and viewing status.'}


def purge(identifier, confirmation):
    if confirmation != 'DELETE':
        raise HoldError('Type DELETE to confirm permanent deletion.')
    with locked():
        guard_storage()
        record = json.loads(entry_path(identifier).read_text())
        if record['state'] not in ('held', 'purging'):
            raise HoldError('Only a completed holding move can be permanently deleted.')
        validate_moves(record)
        # Fail closed if a source returned, rather than deleting the wrong version.
        if any(pathlib.Path(m['from']).exists() for m in record['moves']):
            raise HoldError('An original file has returned. Review this title before deleting it.')
        folder = checked_path(str(PAYLOAD / identifier), [PAYLOAD])
        if folder.exists():inspect_tree(folder)
        elif record['state']!='purging':raise HoldError('The holding folder is missing; deletion was stopped.')
        record['state'] = 'purging'
        write_entry(record)
        if folder.exists():shutil.rmtree(folder)
        record['state'] = 'purged'
        record['purgedAt'] = now()
        write_entry(record)  # Keep the exclusion after purge; do not download it again.
        return {'message': 'Permanently deleted from holding. Automatic downloads stay blocked for this title.'}


def purge_selected(identifiers, confirmation):
    """Delete only the confirmed snapshot; never expand it from the current list."""
    if confirmation != 'DELETE':
        raise HoldError('Type DELETE to confirm permanent deletion.')
    if not isinstance(identifiers, list) or not 1 <= len(identifiers) <= MAX_PURGE_SELECTION:
        raise HoldError('Select between 1 and 200 held titles.')
    # Validate the whole request before the first irreversible action.
    for identifier in identifiers:
        entry_path(identifier)
    identifiers = list(dict.fromkeys(identifiers))
    guard_storage()
    deleted, already_deleted, failed = [], [], []
    for identifier in identifiers:
        try:
            # Immutable journal IDs make a retry safe after a lost response. A
            # newly held copy of the same film gets a different ID.
            record = json.loads(entry_path(identifier).read_text())
            if record['state'] == 'purged':
                already_deleted.append(identifier)
            else:
                purge(identifier, 'DELETE')
            deleted.append(identifier)
        except HoldError as exc:
            failed.append({'id': identifier, 'message': str(exc)})
        except FileNotFoundError:
            failed.append({'id': identifier, 'message': 'This holding item is no longer available. Refresh the list.'})
        except Exception:
            failed.append({'id': identifier, 'message': 'Deletion could not finish. Refresh holding before trying this title again.'})
    if failed:
        message = (f'{len(deleted)} of {len(identifiers)} selected titles are permanently deleted. '
                   f'{len(failed)} could not be deleted; review their messages before trying again.')
    else:
        message = f'{len(deleted)} selected titles are permanently deleted. Automatic downloads stay blocked for these titles.'
    return {'message': message, 'deletedIds': deleted, 'alreadyDeletedIds': already_deleted,
            'failed': failed, 'selectedCount': len(identifiers), 'deletedCount': len(deleted)}


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, status, value):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        origin = self.headers.get('Origin')
        if origin in ORIGINS:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        if self.headers.get('Origin') not in ORIGINS:
            self.send(403, {'message': 'Open Movies to use this action.'})
            return
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', self.headers['Origin'])
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Emby-Token')
        self.send_header('Access-Control-Max-Age', '600')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        try:
            if self.headers.get('Origin') and self.headers['Origin'] not in ORIGINS:
                self.send(403, {'message': 'Unrecognised origin'}); return
            authenticate(self.headers.get('X-Emby-Token'), admin=True)
            path = urllib.parse.urlsplit(self.path).path
            if path == '/hmc-hold/blocked':
                self.send(200, blocked())
            elif path == '/hmc-hold/list':
                with locked():
                    self.send(200, list_public())
            else:
                self.send(404, {'message': 'Unknown holding action'})
        except HoldError as exc:
            self.send(403, {'message': str(exc)})
        except Exception:
            self.send(503, {'message': 'Holding is temporarily unavailable. No files were deleted.'})

    def do_POST(self):
        try:
            if urllib.parse.urlsplit(self.path).path != '/hmc-hold/move':
                self.send(404, {'message': 'Only moving into holding is available here.'}); return
            if self.headers.get('Origin') not in ORIGINS:
                self.send(403, {'message': 'Open Movies to use this action.'}); return
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 4096 or self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
                self.send(400, {'message': 'Invalid holding request'}); return
            user = authenticate(self.headers.get('X-Emby-Token'), deletion=True)
            body = json.loads(self.rfile.read(length))
            self.send(200, hold(body.get('id'), user))
        except HoldError as exc:
            self.send(409, {'message': str(exc)})
        except Exception:
            self.send(503, {'message': 'The move could not finish. Files were not permanently deleted. Check Media Control.'})


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'serve':
        http.server.ThreadingHTTPServer(('192.0.2.10', 18092), Handler).serve_forever()
    else:
        try:
            body = json.load(sys.stdin)
            operation = body.get('operation')
            if operation == 'list':
                with locked(): result = list_public()
            elif operation == 'restore': result = restore(body.get('id'))
            elif operation == 'purge': result = purge(body.get('id'), body.get('confirmation'))
            elif operation == 'purge-selected': result = purge_selected(body.get('ids'), body.get('confirmation'))
            else: raise HoldError('Unknown holding action')
            print(json.dumps(result))
        except HoldError as exc:
            print(json.dumps({'error': str(exc)}))
            sys.exit(2)
