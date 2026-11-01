"""Read-only Docker-network bridge to the computer's status screen."""
import http.client,http.server,ipaddress,urllib.parse

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def do_GET(self):
        if ipaddress.ip_address(self.client_address[0]) not in ipaddress.ip_network('192.0.2.0/24'):
            self.send_error(403);return
        if urllib.parse.urlsplit(self.path).path not in ('/','/index.html','/api/status','/api/holding','/favicon.svg','/controls.js','/controls.css','/projector-input.js'):
            self.send_error(404);return
        connection=http.client.HTTPConnection('127.0.0.1',18090,timeout=5)
        try:
            connection.request('GET',self.path,headers={'Host':'127.0.0.1:18090','X-HomeMedia-Read-Only':'1'})
            response=connection.getresponse();body=response.read(4*1024**2)
            self.send_response(response.status)
            self.send_header('Content-Type',response.getheader('Content-Type','application/octet-stream'))
            self.send_header('Content-Length',str(len(body)));self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(body)
        except (OSError,TimeoutError):self.send_error(503,'Start the main computer to view server status')
        finally:connection.close()

if __name__=='__main__':http.server.ThreadingHTTPServer(('192.0.2.10',18091),Handler).serve_forever()
