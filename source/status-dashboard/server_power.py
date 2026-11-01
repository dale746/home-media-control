"""Confirmed, graceful power-off of the verified Intel media server only.

Installation and status reads never power anything off. The existing copy
worker retains originals on interruption and resumes after the server returns.
"""
import json
import os
import pathlib
import re
import threading
import time

import worker

ROOT=worker.ROOT
LOCK=threading.RLock()
DELAY_SECONDS=15
PENDING_SECONDS=180
EXPECTED_HOST='media-server'
EXPECTED_ARCH='x86_64'
UNIT='hmc-dashboard-poweroff'

IDENTITY_SOURCE="""import json,pathlib,platform,socket
print(json.dumps({'hostname':socket.gethostname(),'architecture':platform.machine(),
 'bootId':pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()}))
"""

# These arguments are fixed. No browser-supplied host, command or options enter
# the remote program, and normal systemd shutdown stops services/unmounts disks.
SCHEDULE_SOURCE="""import json,pathlib,platform,socket,subprocess
expected_boot=EXPECTED_BOOT
identity={'hostname':socket.gethostname(),'architecture':platform.machine(),
 'bootId':pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()}
if identity['hostname']!='media-server' or identity['architecture']!='x86_64' or identity['bootId']!=expected_boot:
 print(json.dumps({'error':'The server identity changed. Shutdown was not requested.'}));raise SystemExit(0)
active=subprocess.run(['/usr/bin/systemctl','is-active','hmc-dashboard-poweroff.timer'],capture_output=True,text=True,timeout=5)
if active.stdout.strip()!='active':
 result=subprocess.run(['sudo','-n','/usr/bin/systemd-run','--unit=hmc-dashboard-poweroff','--on-active=15s',
  '--timer-property=AccuracySec=1s','/usr/bin/systemctl','poweroff'],capture_output=True,text=True,timeout=10)
 if result.returncode:
  print(json.dumps({'error':'The server did not confirm the shutdown request. Refresh Server Status before trying again.'}));raise SystemExit(0)
print(json.dumps({'accepted':True,'bootId':identity['bootId']}))
"""


def read():
    try:
        value=json.loads((ROOT/'server-power.json').read_text())
        return value if isinstance(value,dict) else {}
    except (OSError,ValueError):return {}


def save(value):
    path=ROOT/'server-power.json'
    temporary=path.with_name(path.name+'.'+str(os.getpid())+'.tmp')
    temporary.write_text(json.dumps(value,indent=2));temporary.replace(path)


def verified_identity(value):
    return isinstance(value,dict) and value.get('hostname')==EXPECTED_HOST and value.get('architecture')==EXPECTED_ARCH and isinstance(value.get('bootId'),str) and bool(re.fullmatch(r'[a-f0-9-]{36}',value['bootId']))


def identity_after_health_failure(probe):
    """Power access need not depend on disk, Docker or journal status commands.

    Keep the full media-health failure intact. This small, unprivileged probe
    only establishes that the known i7 is available to accept a shutdown.
    """
    result={**probe,'powerReachable':False}
    try:identity=json.loads(worker.pi_python(IDENTITY_SOURCE,timeout=4))
    except Exception:return result
    if verified_identity(identity):
        result.update(powerReachable=True,**{key:identity[key] for key in ('hostname','architecture','bootId')})
    return result


def public_status(probe,now=None):
    now=time.time() if now is None else now
    with LOCK:
        state=read()
        result={'phase':'offline','canShutdown':False,'serverName':'i7 media server',
                'requestedAt':state.get('requestedAt'),'shutdownDelaySeconds':DELAY_SECONDS}
        if not (probe.get('reachable') or probe.get('powerReachable')):
            result['message']='The server is unreachable. Check its power light before unplugging or moving drives.'
            if state.get('requestedAt'):result['message']='Shutdown was requested and the server is now unreachable. Check its power light before unplugging or moving drives.'
            return result
        if not verified_identity(probe):
            result.update(phase='unverified',message='The i7 server identity has not been confirmed. Refresh before shutting down.')
            return result
        if state.get('bootId') and state['bootId']!=probe['bootId']:
            # The server has returned on a new boot. Leave all user pause and
            # download settings unchanged so their normal rules can resume.
            save({});state={};result['requestedAt']=None
        if state.get('requestedAt'):
            pending=state.get('phase')=='pending' and now-state['requestedAt']<PENDING_SECONDS
            result.update(phase='pending' if pending else 'unconfirmed',message=(
                'Shutdown requested. Watching and server tasks will stop; wait for the server power light to go out.' if pending else
                'Shutdown could not yet be confirmed. Check the server before unplugging or moving drives.'))
            return result
        result.update(phase='online',canShutdown=True,message=(
            'Shut down the i7 safely before disconnecting cables or moving drives.' if probe.get('reachable') else
            'The i7 is responding, while detailed media status is delayed. You can request a safe shutdown.'))
        return result


def request_shutdown(body):
    if set(body)-{'action','operation','confirmation'} or body.get('action')!='server-power' or body.get('operation')!='shutdown':
        raise ValueError('Choose Shut down i7 server.')
    if body.get('confirmation')!='SHUTDOWN':raise ValueError('Type SHUTDOWN to confirm powering off the i7 server.')
    with LOCK:
        previous=read()
        if previous.get('requestedAt'):
            if previous.get('phase')=='pending' and time.time()-previous['requestedAt']<PENDING_SECONDS:
                return {'accepted':True,'message':'Shutdown has already been requested. Wait for the server power light to go out.',
                        'serverPower':{'phase':'pending','canShutdown':False,'serverName':'i7 media server',
                                       'requestedAt':previous['requestedAt'],'shutdownDelaySeconds':DELAY_SECONDS,
                                       'message':'Shutdown has already been requested.'}}
            raise ValueError('A previous shutdown request has not been confirmed. Refresh Server Status and check the server before trying again.')
        try:identity=json.loads(worker.pi_python(IDENTITY_SOURCE,timeout=12))
        except Exception:raise ValueError('The i7 server could not be reached. Shutdown was not requested.') from None
        if not verified_identity(identity):raise ValueError('This is not the verified i7 media server. Shutdown was not requested.')
        state={'phase':'requesting','requestedAt':time.time(),'bootId':identity['bootId']}
        save(state)
        try:
            response=json.loads(worker.pi_python(SCHEDULE_SOURCE.replace('EXPECTED_BOOT',repr(identity['bootId'])),timeout=20))
            if not isinstance(response,dict) or not response.get('accepted') or response.get('bootId')!=identity['bootId']:
                raise ValueError('The shutdown request could not be confirmed.')
        except Exception:
            state['phase']='unconfirmed';save(state)
            raise ValueError('The shutdown result could not be confirmed. The server may already be shutting down. Refresh Server Status and check its power light before trying again.') from None
        state['phase']='pending';save(state)
        power=public_status({'reachable':True,**identity})
        return {'accepted':True,'message':'Shutdown requested. The i7 will stop its services and power off. Wait for its power light to go out before disconnecting anything.',
                'serverPower':power}
