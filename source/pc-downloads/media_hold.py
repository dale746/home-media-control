"""Shared exclusions and dashboard access to recoverable server removals."""
import json
import subprocess
import time
import worker

CACHE = {'time': 0, 'value': None}


def remote_read(path):
    return worker.Api('http://192.0.2.10', {'X-Emby-Token': worker.CONFIG['jellyfin_token']}).request('GET', '/hmc-hold/' + path, timeout=8)


def blocked(fresh=False):
    if fresh or CACHE['value'] is None or time.monotonic() - CACHE['time'] > 15:
        # No stale fallback: an unavailable exclusion service must not re-add held films.
        value = remote_read('blocked')
        if not isinstance(value.get('keys'), list) or not isinstance(value.get('hashes'), list):
            raise RuntimeError('Media holding exclusions unavailable')
        CACHE.update(time=time.monotonic(), value=value)
    return CACHE['value']


def excluded(kind, tmdb, fresh=False):
    return kind + ':' + str(tmdb) in blocked(fresh)['keys']


def operation(body):
    operation = body.get('operation')
    if operation == 'list':
        return remote_read('list')
    if operation not in ('restore', 'purge'):
        raise ValueError('Choose Restore or permanent deletion')
    request = {k: body.get(k) for k in ('operation', 'id', 'confirmation')}
    source = "import json,subprocess; p=subprocess.run(['sudo','-n','python3','/opt/media/config/media-hold/hold_service.py'],input=" + repr(json.dumps(request)) + ",text=True,capture_output=True,timeout=90); print(p.stdout if p.stdout else json.dumps({'error':'The holding service is unavailable. No further files were changed.'}))"
    result = json.loads(worker.pi_python(source, timeout=100))
    if result.get('error'):
        raise ValueError(result['error'])
    CACHE['time'] = 0
    return result
