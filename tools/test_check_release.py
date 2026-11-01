import unittest
from check_release import findings


class ReleaseChecks(unittest.TestCase):
    def test_rejects_private_hosts_and_credentials(self):
        for value in ('http://'+'192.168.'+'9.12','ghp_'+'x'*36,'-----BEGIN '+'OPENSSH PRIVATE KEY-----',
                      'https://'+'user:password'+'@example.invalid','password="'+'x'*30+'"'):
            with self.subTest(kind=value[:12]):self.assertTrue(findings('source/test.py',value))

    def test_allows_reserved_examples_and_fake_short_tokens(self):
        self.assertEqual(findings('source/test.py','http://192.0.2.10 password="test-only"'),[])

    def test_rejects_unexpected_runtime_and_binary_files(self):
        for name in ('settings.json','source/settings.json','source/movie.mp4','private/anything.json'):
            self.assertTrue(findings(name,''))


if __name__=='__main__':unittest.main()
