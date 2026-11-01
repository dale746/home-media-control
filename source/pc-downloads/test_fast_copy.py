import ast,pathlib,signal,subprocess,sys,tempfile,unittest
from unittest.mock import patch
import fast_copy


class FastCopyTests(unittest.TestCase):
    @unittest.skipUnless(hasattr(signal,'alarm'),'Receiver runs on Linux')
    def test_stalled_source_releases_the_receiver(self):
        tree=ast.parse(fast_copy.RECEIVER)
        function=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='read_block')
        source=ast.get_source_segment(fast_copy.RECEIVER,function).replace('signal.alarm(120)','signal.alarm(1)')
        code='import signal,sys\n'+source+'\nread_block(1)\n'
        process=subprocess.Popen([sys.executable,'-c',code],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        try:
            process.wait(timeout=5)
            error=process.stderr.read().decode()
            self.assertNotEqual(process.returncode,0)
            self.assertIn('Source stream stalled; partial copy retained',error)
        finally:
            if process.poll() is None:process.kill();process.wait(timeout=5)
            for stream in (process.stdin,process.stdout,process.stderr):stream.close()

    def test_unsafe_destination_is_rejected_before_a_connection(self):
        with patch.object(fast_copy.subprocess,'Popen') as launch:
            with self.assertRaises(ValueError):
                fast_copy.launch({},[],'missing','/home/mediaadmin/personal.mkv','/mnt/hmc-media-upgrade',1,1000000,1)
            launch.assert_not_called()

    def test_changed_source_is_retained_without_opening_a_connection(self):
        with tempfile.TemporaryDirectory() as folder:
            path=pathlib.Path(folder)/'film.mkv';path.write_bytes(b'original')
            with patch.object(fast_copy.subprocess,'Popen') as launch:
                with self.assertRaises(ValueError):
                    fast_copy.launch({},[],path,'/mnt/hmc-media-upgrade/torrents/pc/.incoming/'+'a'*40+'/film.mkv','/mnt/hmc-media-upgrade',999,1000000,1)
                launch.assert_not_called()
            self.assertEqual(path.read_bytes(),b'original')

    def test_copy_connection_dies_when_its_owner_releases_it(self):
        process=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'],creationflags=0x08000000)
        job=None
        try:
            job=fast_copy.OwnedProcess(process);job.close()
            process.wait(timeout=5)
            self.assertIsNotNone(process.poll())
        finally:
            if process.poll() is None:process.kill();process.wait(timeout=5)
            if job:job.close()


if __name__=='__main__':unittest.main()
