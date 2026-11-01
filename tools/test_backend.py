"""Run prototype tests with dummy runtime settings, never the operator's settings."""
import argparse,ipaddress,json,os,pathlib,subprocess,sys,tempfile,unittest

ROOT=pathlib.Path(__file__).resolve().parents[1]


def child(path):
    # This guard applies to this test interpreter. Child-process tests use their
    # own temporary fixtures and never launch a real downloader or SSH client.
    def audit(event,args):
        if event=='socket.connect':
            address=args[1]
            if isinstance(address,tuple):
                host=address[0]
                try:allowed=ipaddress.ip_address(host).is_loopback
                except ValueError:allowed=host=='localhost'
                if not allowed:raise RuntimeError('External networking is disabled during regression tests')
    sys.addaudithook(audit)
    sys.path[:0]=[str(ROOT/'source/pc-downloads'),str(ROOT/'source/status-dashboard')]
    if path.name=='test_runtime_bootstrap.py':os.environ.pop('HMC_MEDIA_RUNTIME',None)
    suite=unittest.defaultTestLoader.discover(str(path.parent),pattern=path.name)
    return unittest.TextTestRunner(verbosity=1).run(suite).wasSuccessful()


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--child',type=pathlib.Path);args=p.parse_args()
    if args.child:return 0 if child(args.child) else 1
    with tempfile.TemporaryDirectory(prefix='hmc-tests-') as temporary:
        runtime=pathlib.Path(temporary);data=runtime/'data';data.mkdir();catalogue=runtime/'catalogue';catalogue.mkdir()
        cfg={'data':str(data),'catalogue_root':str(catalogue),'source_roots':[str(data)],
             'api':'http://127.0.0.1:1','username':'test-user','password':'test-only',
             'ssh':str(runtime/'not-installed-ssh.exe'),'key':str(runtime/'no-key'),
             'exe':str(runtime/'not-installed-downloader.exe'),'profile':str(runtime/'profile'),
             'pi':'mediaadmin@192.0.2.10','pi_root':'/opt/media/data/torrents/pc',
             'jellyfin_token':'test-token','arr_keys':{},'bulk_seerr_key':'test-key',
             'min_pc_free_gib':100,'min_pi_free_gib':100,'hdd_upgrade_pending':False,
             'delete_pc_after_verified_import':False}
        (runtime/'settings.json').write_text(json.dumps(cfg))
        env=os.environ.copy();env['HMC_MEDIA_RUNTIME']=str(runtime);env['LOCALAPPDATA']=str(runtime)
        failed=[];files=[]
        for directory in ('pc-downloads','status-dashboard'):
            files.extend(sorted((ROOT/'source'/directory).glob('test*.py')))
        for file in files:
            print('\n'+file.relative_to(ROOT).as_posix(),flush=True)
            result=subprocess.run([sys.executable,__file__,'--child',str(file)],env=env,timeout=90)
            if result.returncode:failed.append(file.name)
        print(json.dumps({'testFiles':len(files),'failed':failed,'privateRuntimeUsed':False}))
        return bool(failed)


if __name__=='__main__':raise SystemExit(main())
