import io
import unittest
from unittest.mock import Mock, patch

from pi_proxy import Handler


class ProxyTests(unittest.TestCase):
    def handler(self, path):
        handler = object.__new__(Handler)
        handler.path = path
        handler.client_address = ('192.0.2.10', 1234)
        handler.wfile = io.BytesIO()
        handler.send_error = Mock()
        handler.send_response = Mock()
        handler.send_header = Mock()
        handler.end_headers = Mock()
        return handler

    def test_holding_list_is_forwarded_as_read_only(self):
        handler = self.handler('/api/holding')
        response = Mock(status=200)
        response.read.return_value = b'{"items":[]}'
        response.getheader.return_value = 'application/json'
        with patch('pi_proxy.http.client.HTTPConnection') as connection:
            connection.return_value.getresponse.return_value = response
            handler.do_GET()
            connection.return_value.request.assert_called_once_with(
                'GET', '/api/holding', headers={'Host': '127.0.0.1:18090', 'X-HomeMedia-Read-Only': '1'})
        self.assertEqual(handler.wfile.getvalue(), b'{"items":[]}')

    def test_control_token_is_never_forwarded(self):
        handler = self.handler('/api/control-token')
        with patch('pi_proxy.http.client.HTTPConnection') as connection:
            handler.do_GET()
            connection.assert_not_called()
        handler.send_error.assert_called_once_with(404)

    def test_requests_outside_bridge_network_are_rejected(self):
        handler = self.handler('/api/status')
        handler.client_address = ('198.51.100.10', 1234)
        with patch('pi_proxy.http.client.HTTPConnection') as connection:
            handler.do_GET()
            connection.assert_not_called()
        handler.send_error.assert_called_once_with(403)


if __name__ == '__main__':
    unittest.main()
