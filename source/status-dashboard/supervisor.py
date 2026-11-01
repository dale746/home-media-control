"""Keep the local dashboard running; never stop a process or change media tasks.

Started by the user's existing Windows Startup shortcut. A dashboard already
holding server.lock is adopted even when its HTTP or media health check is slow.
"""
import json
import os
import pathlib
import subprocess
import sys
import time

POLL_SECONDS=5
HEALTHY_SECONDS=60
MAX_RETRY_SECONDS=300
LOG_LIMIT=1024*1024
LOG_TAIL=256*1024


def acquire_lock(path):
    import msvcrt
    stream=pathlib.Path(path).open('a+b')
    try:
        stream.seek(0)
        msvcrt.locking(stream.fileno(),msvcrt.LK_NBLCK,1)
        return stream
    except OSError:
        stream.close()
        return None


def release_lock(stream):
    if stream is None:return
    import msvcrt
    try:
        stream.seek(0)
        msvcrt.locking(stream.fileno(),msvcrt.LK_UNLCK,1)
    finally:stream.close()


def dashboard_owned(root):
    """Inspect only the dashboard's own lock; release it immediately if free."""
    handle=acquire_lock(pathlib.Path(root)/'server.lock')
    if handle is None:return True
    release_lock(handle)
    return False


def bound_log(path):
    """Limit local diagnostic logs; their contents are never sent to the UI."""
    path=pathlib.Path(path)
    try:
        if path.stat().st_size<=LOG_LIMIT:return
        with path.open('rb') as source:
            source.seek(-LOG_TAIL,os.SEEK_END)
            tail=source.read(LOG_TAIL)
        with path.open('wb') as destination:destination.write(tail)
    except OSError:pass


def launch_dashboard(root):
    root=pathlib.Path(root)
    out=root/'dashboard.stdout.log';err=root/'dashboard.stderr.log'
    bound_log(out);bound_log(err)
    with out.open('ab') as stdout,err.open('ab') as stderr:
        return subprocess.Popen([sys.executable,str(root/'server.py')],cwd=str(root),
                                stdout=stdout,stderr=stderr,close_fds=True,
                                creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))


class Supervisor:
    def __init__(self,root,*,owned=dashboard_owned,launch=launch_dashboard):
        self.root=pathlib.Path(root)
        self.owned=owned;self.launch=launch
        self.child=None;self.started=None;self.owned_since=None
        self.retry_delay=POLL_SECONDS;self.next_attempt=0
        self.last_status=None

    def status(self,phase,**fields):
        value={'phase':phase,**fields}
        if value==self.last_status:return
        self.last_status=value
        path=self.root/'supervisor-status.json'
        temporary=path.with_name(path.name+'.'+str(os.getpid())+'.tmp')
        temporary.write_text(json.dumps({**value,'updated':time.time()},indent=2))
        temporary.replace(path)

    def retry(self,now,*,exit_code=None,error=None):
        delay=self.retry_delay
        self.next_attempt=now+delay
        self.retry_delay=min(delay*2,MAX_RETRY_SECONDS)
        self.child=None;self.started=None;self.owned_since=None
        fields={'retrySeconds':delay}
        if exit_code is not None:fields['exitCode']=exit_code
        if error:fields['error']=error
        self.status('retry',**fields)

    def step(self,now):
        if self.owned(self.root):
            if self.owned_since is None:self.owned_since=now
            if now-self.owned_since>=HEALTHY_SECONDS:self.retry_delay=POLL_SECONDS
            self.status('running')
            return
        if self.child is not None:
            code=self.child.poll()
            if code is None:
                # A live process can still be importing or waiting for resources.
                # Never kill it or create duplicate launches on an HTTP timeout.
                self.status('starting')
                return
            self.retry(now,exit_code=code)
            return
        if self.owned_since is not None:
            # An adopted instance has exited; allow a small restart delay.
            self.retry(now)
            return
        if now<self.next_attempt:return
        try:
            self.child=self.launch(self.root)
            self.started=now
            self.status('starting')
        except Exception as exc:
            # Only the exception class is exposed, never arguments/configuration.
            self.retry(now,error=type(exc).__name__)


def main():
    root=pathlib.Path(__file__).resolve().parent
    root.mkdir(parents=True,exist_ok=True)
    lock=acquire_lock(root/'supervisor.lock')
    if lock is None:return
    try:
        supervisor=Supervisor(root)
        while True:
            try:supervisor.step(time.monotonic())
            except Exception:
                # A transient lock or status-file error must not cause launches
                # to bypass the next ownership check or silently stop recovery.
                pass
            for name in ('dashboard.stdout.log','dashboard.stderr.log'):bound_log(root/name)
            time.sleep(POLL_SECONDS)
    finally:release_lock(lock)


if __name__=='__main__':main()
