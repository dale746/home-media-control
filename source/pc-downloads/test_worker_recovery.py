"""Regression checks for stalled-copy and low-storage recovery, using no live jobs."""
import json
import pathlib
import tempfile
import types
import unittest
from unittest.mock import patch,Mock

import worker


class FakeQueue:
    def __init__(self, torrents):
        self.torrents = torrents
        self.stopped = []

    def request(self, method, path, **kwargs):
        if path.endswith('/torrents/info'):
            return self.torrents
        if path.endswith('/torrents/stop'):
            self.stopped.extend(kwargs['form']['hashes'].split('|'))
            return None
        raise AssertionError('Unexpected live API request: ' + path)


def torrent(identifier, complete=True):
    return {'hash': identifier * 40, 'category': 'movies', 'progress': 1 if complete else 0.5,
            'state': 'queuedUP' if complete else 'downloading', 'name': identifier}


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        import media_hold
        fixture=patch.object(media_hold,'blocked',return_value={'hashes':[]})
        fixture.start();self.addCleanup(fixture.stop)

    def test_pi_timeout_never_uses_pipe_reader_threads(self):
        child=Mock()
        child.wait.side_effect=[worker.subprocess.TimeoutExpired('ssh',1),0]
        def launch(*args,**kwargs):
            for name in ('stdin','stdout','stderr'):
                self.assertTrue(hasattr(kwargs[name],'fileno'))
            return child
        with patch.object(worker.subprocess,'Popen',side_effect=launch):
            with self.assertRaises(TimeoutError):worker.pi_python('print(1)',timeout=1)
        child.kill.assert_called_once()

    def test_pi_command_output_is_read_from_regular_file(self):
        def launch(*args,**kwargs):
            self.assertEqual(kwargs['stdin'].read(),b'print(1)')
            kwargs['stdout'].write(b'1\n')
            return types.SimpleNamespace(returncode=0,wait=lambda timeout:0)
        with patch.object(worker.subprocess,'Popen',side_effect=launch):
            self.assertEqual(worker.pi_python('print(1)'),'1\n')

    def test_copy_stops_before_pi_storage_reserve_is_crossed(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory).resolve()
            folder=root/'torrents/movies';folder.mkdir(parents=True)
            (folder/'film.mp4').write_bytes(b'test')
            item=dict(torrent('a'),save_path=str(folder))
            qb=types.SimpleNamespace(request=lambda *args,**kwargs:[{'name':'film.mp4','size':4,'priority':1,'progress':1}])
            child=Mock();child.poll.return_value=None
            cfg=dict(worker.CONFIG,data=str(root),source_roots=[str(root)],min_pi_free_gib=100,copy_engine='scp')
            with patch.object(worker,'ROOT',root),patch.object(worker,'CONFIG',cfg), \
                 patch.object(worker,'refresh_config'), \
                 patch.object(worker,'pi_python',return_value='{"status":"copy","existing":{}}'), \
                 patch.object(worker,'BUSY_CACHE',{'freeBytes':100*1024**3}), \
                 patch.object(worker,'protect_storage',return_value=[]),patch.object(worker,'state'), \
                 patch.object(worker.time,'sleep'),patch.object(worker.subprocess,'Popen',return_value=child):
                self.assertEqual(worker.transfer(qb,item),'space')
            child.terminate.assert_called_once()

    def run_worker(self, root, queue, transfer, free_gib=200):
        (root / 'logs').mkdir(exist_ok=True)
        settings = dict(worker.CONFIG, data=str(root), source_roots=[str(root)], min_pc_free_gib=100,
                        hdd_upgrade_pending=False,delete_pc_after_verified_import=False)
        for item in queue.torrents:
            item.setdefault('save_path', str(root / 'torrents' / item['category']))
        tunnel = types.SimpleNamespace(poll=lambda: None)
        with patch.object(worker, 'ROOT', root), patch.object(worker, 'STATE_FILE', root / 'status.json'), \
             patch.object(worker, 'refresh_config'), \
             patch.object(worker, 'CONFIG', settings), patch.object(worker, 'qb_api', return_value=queue), \
             patch.object(worker, 'server_busy', return_value=False), patch.object(worker, 'playing', return_value=False), \
             patch.object(worker, 'transfer', side_effect=transfer), \
             patch.object(worker.shutil, 'disk_usage', return_value=types.SimpleNamespace(free=free_gib * 1024**3)), \
             patch.object(worker.subprocess, 'Popen', return_value=tunnel), \
             patch('fast_copy.OwnedProcess', side_effect=lambda process: process), \
             patch.object(worker.ctypes.windll.kernel32, 'SetThreadExecutionState'), \
             patch.object(worker.sys, 'argv', ['worker.py', '--once']):
            worker.main()

    def test_one_bad_completed_job_does_not_block_other_jobs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory).resolve()
            queue = FakeQueue([torrent('a'), torrent('b')])
            attempted = []

            def transfer(qb, item):
                attempted.append(item['hash'])
                if item['hash'] == 'a' * 40:
                    raise ValueError('Unexpected download location')
                return 'ready'

            self.run_worker(root, queue, transfer)
            self.run_worker(root, queue, transfer)
            self.assertEqual(attempted, ['a' * 40, 'b' * 40])
            self.assertIn('b' * 40, json.loads((root / 'copied.json').read_text()))
            self.assertIn('a' * 40, json.loads((root / 'copy-errors.json').read_text()))

    def test_completed_files_can_copy_from_either_approved_drive(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory).resolve()
            roots = [root / 'old', root / 'new']
            qb = types.SimpleNamespace(request=lambda *args, **kwargs: [{'name': 'film.mp4', 'size': 4, 'progress': 1, 'priority': 1}])
            with patch.object(worker, 'CONFIG', dict(worker.CONFIG, data=str(roots[1]), source_roots=list(map(str, roots)))):
                for source in roots:
                    folder = source / 'torrents/movies'
                    folder.mkdir(parents=True)
                    (folder / 'film.mp4').write_bytes(b'test')
                    item = dict(torrent('a'), save_path=str(folder))
                    self.assertEqual(worker.relative_files(qb, item)[0]['local'], str(folder / 'film.mp4'))
                with self.assertRaisesRegex(ValueError, 'Unexpected download location'):
                    worker.relative_files(qb, dict(torrent('b'), save_path=str(root / 'unrelated')))

    def test_old_source_drive_reserve_is_enforced_while_new_drive_has_space(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory).resolve()
            old, new = root / 'old', root / 'new'
            job = torrent('a', complete=False)
            job['save_path'] = str(old / 'torrents/movies')
            queue = FakeQueue([job])
            cfg = dict(worker.CONFIG, data=str(new), source_roots=[str(new), str(old)], min_pc_free_gib=100)
            def usage(path):
                return types.SimpleNamespace(free=(90 if pathlib.Path(path)==old else 200)*1024**3)
            with patch.object(worker, 'ROOT', root), patch.object(worker, 'CONFIG', cfg), \
                 patch.object(worker.shutil, 'disk_usage', side_effect=usage):
                self.assertEqual(worker.protect_storage(queue), ['a' * 40])
            self.assertEqual(queue.stopped, ['a' * 40])

    def test_storage_hold_stops_downloads_but_allows_completed_copy(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory).resolve()
            queue = FakeQueue([torrent('a', complete=False), torrent('b')])
            self.run_worker(root, queue, lambda qb, item: 'ready', free_gib=90)
            self.assertEqual(queue.stopped, ['a' * 40])
            self.assertIn('b' * 40, json.loads((root / 'copied.json').read_text()))


if __name__ == '__main__':
    unittest.main()
