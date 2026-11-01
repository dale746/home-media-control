import hashlib
import pathlib
import tempfile
import unittest
from pc_cleanup import delete_verified_files,volume_guid


class CleanupTests(unittest.TestCase):
    def setup_case(self,directory):
        root=pathlib.Path(directory)/'managed'
        folder=root/'torrents/movies/Film';folder.mkdir(parents=True)
        media=folder/'film.mkv';media.write_bytes(b'verified media')
        cfg={'source_roots':[str(root)],'source_volume_guids':{root.anchor.casefold():volume_guid(root)}}
        record={'category':'movies','files':[{'local':str(media),'size':media.stat().st_size,
                  'sha256':hashlib.sha256(media.read_bytes()).hexdigest()}]}
        return root,media,cfg,record

    def test_only_verified_file_removed_and_unmatched_sibling_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            root,media,cfg,record=self.setup_case(directory)
            personal=media.parent/'keep.jpg';personal.write_bytes(b'keep')
            self.assertEqual(delete_verified_files(record,cfg),len(b'verified media'))
            self.assertFalse(media.exists());self.assertEqual(personal.read_bytes(),b'keep')

    def test_changed_file_is_retained(self):
        with tempfile.TemporaryDirectory() as directory:
            root,media,cfg,record=self.setup_case(directory)
            media.write_bytes(b'changed content')
            with self.assertRaises(ValueError):delete_verified_files(record,cfg)
            self.assertTrue(media.exists())

    def test_outside_path_cannot_be_deleted(self):
        with tempfile.TemporaryDirectory() as directory:
            root,media,cfg,record=self.setup_case(directory)
            outside=pathlib.Path(directory)/'personal.jpg';outside.write_bytes(b'keep')
            record['files'][0]['local']=str(outside)
            with self.assertRaises(ValueError):delete_verified_files(record,cfg)
            self.assertTrue(outside.exists())

    def test_reassigned_drive_letter_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root,media,cfg,record=self.setup_case(directory)
            cfg['source_volume_guids'][root.anchor.casefold()]='a different physical volume'
            with self.assertRaises(ValueError):delete_verified_files(record,cfg)
            self.assertTrue(media.exists())

    def test_completed_file_cleanup_can_resume(self):
        with tempfile.TemporaryDirectory() as directory:
            root,media,cfg,record=self.setup_case(directory)
            delete_verified_files(record,cfg)
            self.assertEqual(delete_verified_files(record,cfg),0)


if __name__=='__main__':unittest.main()
