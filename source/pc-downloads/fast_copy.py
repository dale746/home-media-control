"""Encrypted file streaming with receiver-side rate and disk-reserve checks."""
import ctypes
from ctypes import wintypes
import json
import math
import pathlib
import re
import shlex
import subprocess


RECEIVER=r'''import fcntl,json,math,os,pathlib,shutil,signal,subprocess,sys,time
def read_block(size):
 def expired(signum,frame):raise TimeoutError('Source stream stalled; partial copy retained')
 previous=signal.signal(signal.SIGALRM,expired)
 signal.alarm(120)
 try:return sys.stdin.buffer.read(size)
 finally:
  signal.alarm(0)
  signal.signal(signal.SIGALRM,previous)
os.nice(10)
subprocess.run(['ionice','-c','2','-n','7','-p',str(os.getpid())],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=False)
p=json.loads(COPY_PAYLOAD)
mount=pathlib.Path(p['mount']);incoming=mount/'torrents/pc/.incoming';path=pathlib.Path(p['destination'])
assert str(mount) in ('/mnt/hmc-media-upgrade','/opt/media/data') and mount.resolve()==mount
assert path.is_relative_to(incoming) and incoming.resolve().is_relative_to(mount)
def volume_ok():
 value=subprocess.check_output(['findmnt','-rn','-M',str(mount),'-o','UUID'],text=True).strip()
 assert value==p['uuid'],'Media disk identity changed'
volume_ok()
path.parent.mkdir(parents=True,exist_ok=True)
assert path.parent.resolve().is_relative_to(incoming.resolve())
assert shutil.disk_usage(mount).free>=p['size']+p['reserve'],'Media disk reserve reached'
fd=os.open(path,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o664)
with os.fdopen(fd,'r+b',buffering=1048576) as output:
 fcntl.flock(output.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
 assert os.fstat(output.fileno()).st_dev==mount.stat().st_dev
 output.seek(0);output.truncate(0)
 total=0;rate=p['rate'];window_start=time.monotonic();window_bytes=0;next_check=window_start
 while total<p['size']:
  now=time.monotonic()
  if now>=next_check:
   volume_ok()
   assert shutil.disk_usage(mount).free>=p['reserve']+1048576,'Media disk reserve reached'
   try:
    controls=json.loads(pathlib.Path('/opt/media/config/pc-downloads/dashboard-controls.json').read_text())
    updated=float(controls.get('copyBytesPerSecond',rate))
   except (OSError,ValueError,TypeError):updated=rate
   if math.isfinite(updated) and 0<updated<=150000000 and updated!=rate:
    rate=updated;window_start=now;window_bytes=0
   next_check=now+1
  block=read_block(min(1048576,p['size']-total))
  assert block,'File stream ended early'
  assert output.write(block)==len(block)
  total+=len(block);window_bytes+=len(block)
  delay=window_bytes/rate-(time.monotonic()-window_start)
  if delay>0:time.sleep(delay)
 assert not read_block(1),'Source size changed during transfer'
 output.flush();os.fsync(output.fileno())
 assert os.fstat(output.fileno()).st_size==p['size']
 volume_ok()
'''


# Microsoft JOBOBJECT_EXTENDED_LIMIT_INFORMATION, with KILL_ON_JOB_CLOSE.
# https://learn.microsoft.com/windows/win32/procthread/job-objects
class BasicLimits(ctypes.Structure):
    _fields_=[('processTime',ctypes.c_longlong),('jobTime',ctypes.c_longlong),('flags',wintypes.DWORD),
              ('minWorkingSet',ctypes.c_size_t),('maxWorkingSet',ctypes.c_size_t),('active',wintypes.DWORD),
              ('affinity',ctypes.c_size_t),('priority',wintypes.DWORD),('scheduling',wintypes.DWORD)]


class IoCounters(ctypes.Structure):
    _fields_=[(name,ctypes.c_ulonglong) for name in ('reads','writes','other','readBytes','writeBytes','otherBytes')]


class ExtendedLimits(ctypes.Structure):
    _fields_=[('basic',BasicLimits),('io',IoCounters),('processMemory',ctypes.c_size_t),
              ('jobMemory',ctypes.c_size_t),('peakProcess',ctypes.c_size_t),('peakJob',ctypes.c_size_t)]


class OwnedProcess:
    """The copy connection dies if its owning worker exits or is terminated."""
    def __init__(self,process):
        self.process=process;self.handle=None
        kernel=ctypes.WinDLL('kernel32',use_last_error=True);self.kernel=kernel
        kernel.CreateJobObjectW.argtypes=[ctypes.c_void_p,wintypes.LPCWSTR];kernel.CreateJobObjectW.restype=wintypes.HANDLE
        kernel.SetInformationJobObject.argtypes=[wintypes.HANDLE,ctypes.c_int,ctypes.c_void_p,wintypes.DWORD]
        kernel.SetInformationJobObject.restype=wintypes.BOOL
        kernel.AssignProcessToJobObject.argtypes=[wintypes.HANDLE,wintypes.HANDLE];kernel.AssignProcessToJobObject.restype=wintypes.BOOL
        kernel.TerminateJobObject.argtypes=[wintypes.HANDLE,wintypes.UINT];kernel.TerminateJobObject.restype=wintypes.BOOL
        kernel.CloseHandle.argtypes=[wintypes.HANDLE];kernel.CloseHandle.restype=wintypes.BOOL
        handle=kernel.CreateJobObjectW(None,None)
        if not handle:process.terminate();process.wait(timeout=5);raise ctypes.WinError(ctypes.get_last_error())
        self.handle=handle
        limits=ExtendedLimits();limits.basic.flags=0x2000
        if not kernel.SetInformationJobObject(handle,9,ctypes.byref(limits),ctypes.sizeof(limits)) or not kernel.AssignProcessToJobObject(handle,int(process._handle)):
            error=ctypes.get_last_error();process.terminate();process.wait(timeout=5);self.close();raise ctypes.WinError(error)

    @property
    def pid(self):return self.process.pid
    @property
    def returncode(self):return self.process.returncode
    def close(self):
        if self.handle:self.kernel.CloseHandle(self.handle);self.handle=None
    def poll(self):
        result=self.process.poll()
        if result is not None:self.close()
        return result
    def terminate(self):
        if self.handle:self.kernel.TerminateJobObject(self.handle,1)
        elif self.process.poll() is None:self.process.terminate()
    def wait(self,timeout=None):
        result=self.process.wait(timeout=timeout);self.close();return result
    def __del__(self):
        try:self.close()
        except Exception:pass


def launch(config,ssh_options,local,destination,media_mount,size,rate_bytes,reserve):
    if media_mount not in ('/mnt/hmc-media-upgrade','/opt/media/data'):raise ValueError('Unexpected media mount')
    path=pathlib.PurePosixPath(destination);base=pathlib.PurePosixPath(media_mount)/'torrents/pc/.incoming'
    if not path.is_relative_to(base) or '..' in path.parts:raise ValueError('Unexpected incoming file path')
    relative=path.relative_to(base)
    if len(relative.parts)<2 or not re.fullmatch('[a-f0-9]{40}|[a-f0-9]{64}',relative.parts[0]):raise ValueError('Invalid copy identifier')
    if not math.isfinite(rate_bytes) or not 0<rate_bytes<=150000000:raise ValueError('Invalid transfer rate')
    from windows_paths import io_path
    source=io_path(local)
    if not source.is_file() or source.stat().st_size!=size:raise ValueError('Source file changed before transfer')
    if not config.get('pi_media_uuid'):raise ValueError('Media disk identity is required')
    exe=pathlib.Path(config['copy_ssh_executable'])
    if not exe.is_file():raise ValueError('Fast copy client is unavailable')
    payload={'mount':media_mount,'destination':path.as_posix(),'uuid':config['pi_media_uuid'],
             'size':size,'rate':rate_bytes,'reserve':reserve}
    command='python3 -c '+shlex.quote(RECEIVER.replace('COPY_PAYLOAD',repr(json.dumps(payload))))
    args=[str(exe),*ssh_options,'-o','UserKnownHostsFile='+str(pathlib.Path(config['key']).with_name('known_hosts')).replace('\\','/'),
          '-T',config['pi'],command]
    with source.open('rb') as stream:
        process=subprocess.Popen(args,stdin=stream,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
                                 creationflags=0x08000000,close_fds=True)
        return OwnedProcess(process)
