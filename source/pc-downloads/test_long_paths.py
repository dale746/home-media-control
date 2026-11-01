"""Regression: a complete long-named download must copy and verify safely."""
import hashlib
import pathlib
import tempfile
import types
import unittest
from unittest.mock import patch

import worker
from pc_cleanup import delete_verified_files, digest, volume_guid
from windows_paths import io_path, resolved_path


class LongPathTests(unittest.TestCase):
    def test_complete_long_file_is_recognized_and_only_verified_copy_removed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            folder = root / 'torrents/movies' / ('Folder' * 20)
            folder.mkdir(parents=True)
            path = folder / (('Film' * 30) + '.mp4')
            self.assertGreater(len(str(path)), 260)
            body = b'complete test media'
            io_path(path).write_bytes(body)
            sibling = folder / 'personal.jpg'
            sibling.write_bytes(b'keep')
            cfg = dict(worker.CONFIG, data=str(root), source_roots=[str(root)],
                       source_volume_guids={root.anchor.casefold(): volume_guid(root)})
            entry = {'name': path.relative_to(root/'torrents/movies').as_posix(),
                     'priority': 1, 'progress': 1, 'size': len(body)}
            qb = types.SimpleNamespace(request=lambda *args, **kwargs: [entry])
            torrent = {'category': 'movies', 'save_path': str(root/'torrents/movies'), 'hash': 'a'*40}
            try:
                with patch.object(worker, 'CONFIG', cfg):
                    result = worker.relative_files(qb, torrent)
                self.assertEqual(resolved_path(result[0]['local']), path)
                self.assertEqual(digest(result[0]['local']), hashlib.sha256(body).hexdigest())
                record = {'category': 'movies', 'files': [dict(result[0], sha256=digest(path))]}
                self.assertEqual(delete_verified_files(record, cfg), len(body))
                self.assertFalse(io_path(path).exists())
                self.assertEqual(sibling.read_bytes(), b'keep')
            finally:
                io_path(path).unlink(missing_ok=True)


if __name__ == '__main__':
    unittest.main()
