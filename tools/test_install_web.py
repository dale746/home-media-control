import pathlib,sys,tempfile,unittest
sys.path.insert(0,str(pathlib.Path(__file__).parent))
from install_web import install,restore


class InstallTests(unittest.TestCase):
    def fixture(self,folder):
        root=pathlib.Path(folder);web=root/'web';web.mkdir()
        original=b'<html><body><script src="upstream.js"></script>Original</body></html>'
        (web/'index.html').write_bytes(original);bundle=root/'bundle.js';bundle.write_bytes(b'/* Home Media Control */console.log("test");')
        return root,web,bundle,original

    def test_install_and_restore_preserve_the_original_client(self):
        with tempfile.TemporaryDirectory() as folder:
            root,web,bundle,original=self.fixture(folder);backup=install(bundle,web,root/'backups')
            self.assertIn(b'upstream.js',(web/'index.html').read_bytes())
            self.assertEqual((web/'index.html').read_bytes().count(b'id="home-media-control"'),1)
            restore(backup);self.assertEqual((web/'index.html').read_bytes(),original)
            self.assertFalse((web/'home-media-control.js').exists())

    def test_reinstall_keeps_exactly_one_owned_script_tag(self):
        with tempfile.TemporaryDirectory() as folder:
            root,web,bundle,_=self.fixture(folder)
            install(bundle,web,root/'backups');backup=install(bundle,web,root/'backups')
            self.assertEqual((web/'index.html').read_bytes().count(b'id="home-media-control"'),1)
            restore(backup);self.assertTrue((web/'home-media-control.js').is_file())

    def test_restore_refuses_to_overwrite_later_client_changes(self):
        with tempfile.TemporaryDirectory() as folder:
            root,web,bundle,_=self.fixture(folder);backup=install(bundle,web,root/'backups')
            (web/'index.html').write_text('New upstream client')
            with self.assertRaises(ValueError):restore(backup)
            self.assertEqual((web/'index.html').read_text(),'New upstream client')

    def test_backups_cannot_be_written_into_the_public_web_directory(self):
        with tempfile.TemporaryDirectory() as folder:
            root,web,bundle,original=self.fixture(folder)
            with self.assertRaises(ValueError):install(bundle,web,web/'backups')
            self.assertEqual((web/'index.html').read_bytes(),original)


if __name__=='__main__':unittest.main()
