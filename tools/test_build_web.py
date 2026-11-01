import pathlib,sys,unittest
sys.path.insert(0,str(pathlib.Path(__file__).parent))
from build_web import build,configuration


class WebBuildTests(unittest.TestCase):
    def test_optional_services_are_not_shown_when_unconfigured(self):
        value=build({'services':{'jellyfin':'https://movies.example.invalid'}}).decode()
        self.assertNotIn('["Discovery",',value)
        self.assertNotIn('["Server Status",',value)
        self.assertNotIn('__HMC_',value)
        self.assertIn('https://movies.example.invalid/web/#/home',value)

    def test_same_host_distinct_ports_remain_separate(self):
        value=configuration({'services':{'jellyfin':'http://media.example.invalid:8096/','discovery':'http://media.example.invalid:5055','status':'http://media.example.invalid'}})
        self.assertNotEqual(value['jellyfin'],value['discovery'])
        self.assertEqual(value['jellyfin'],'http://media.example.invalid:8096')

    def test_credentials_and_unsafe_origins_are_rejected(self):
        for value in ['javascript:alert(1)','https://'+'user:secret'+'@media.example.invalid','https://media.example.invalid/path','https://*.example.invalid','https://media.example.invalid/?token=x']:
            with self.subTest(value=value),self.assertRaises(ValueError):configuration({'services':{'jellyfin':value}})

    def test_extra_library_links_are_json_encoded_and_local_only(self):
        value=build({'services':{'jellyfin':'https://movies.example.invalid'},'extraLinks':[{'label':'Family <memories>','href':'#/list?type=Video','libraryId':'a'*32}]}).decode()
        self.assertIn('Family \\u003cmemories>',value)
        for href in ['https://elsewhere.example.invalid','#/home onclick=x','javascript:alert(1)']:
            with self.assertRaises(ValueError):configuration({'services':{'jellyfin':'http://media.example.invalid'},'extraLinks':[{'label':'Bad','href':href}]})


if __name__=='__main__':unittest.main()
