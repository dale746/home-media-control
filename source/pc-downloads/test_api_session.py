import io
import json
import types
import unittest
import urllib.error
from unittest.mock import Mock

from worker import Api


def response(value):
    return io.BytesIO(value)


def forbidden():
    return urllib.error.HTTPError('http://127.0.0.1:18080/api/v2/torrents/files',403,'Forbidden',{},None)


class ApiSessionTests(unittest.TestCase):
    def client(self,replies):
        client=Api('http://127.0.0.1:18080',auth={'username':'test-user','password':'test-password'})
        client.opener=types.SimpleNamespace(open=Mock(side_effect=replies))
        return client

    def test_expired_downloader_cookie_is_renewed_before_single_retry(self):
        client=self.client([forbidden(),response(b'Ok.'),response(b'[{"name":"film.mkv"}]')])
        self.assertEqual(client.request('GET','/api/v2/torrents/files?hash=abc'),[{'name':'film.mkv'}])
        requests=[call.args[0] for call in client.opener.open.call_args_list]
        self.assertEqual([item.method for item in requests],['GET','POST','GET'])
        self.assertTrue(requests[1].full_url.endswith('/auth/login'))
        self.assertEqual(requests[0].full_url,requests[2].full_url)

    def test_failed_login_does_not_retry_sensitive_operations(self):
        client=self.client([forbidden(),response(b'Fails.')])
        with self.assertRaises(RuntimeError):client.request('POST','/api/v2/torrents/delete',form={'deleteFiles':'false'})
        self.assertEqual(client.opener.open.call_count,2)

    def test_successful_login_with_no_response_body_is_supported(self):
        client=self.client([forbidden(),response(b''),response(b'[]')])
        self.assertEqual(client.request('GET','/api/v2/torrents/info'),[])
        self.assertEqual(client.opener.open.call_count,3)

    def test_other_services_cannot_receive_downloader_login(self):
        client=Api('http://other-service');client.opener=types.SimpleNamespace(open=Mock(side_effect=forbidden()))
        with self.assertRaises(urllib.error.HTTPError):client.request('GET','/status')
        self.assertEqual(client.opener.open.call_count,1)

    def test_repeated_forbidden_response_is_returned_without_login_loop(self):
        client=self.client([forbidden(),response(b'Ok.'),forbidden()])
        with self.assertRaises(urllib.error.HTTPError):client.request('GET','/api/v2/torrents/info')
        self.assertEqual(client.opener.open.call_count,3)


if __name__=='__main__':unittest.main()
