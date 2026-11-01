"""Expose the authenticated PC qB API to the media Docker network only.

The PC connects outward over SSH; no Windows inbound firewall opening is needed.
Completed downloads are held at 99.9% until the verified Pi copy is ready.
"""
import http.client
import http.server
import ipaddress
import json
import pathlib
import urllib.parse

READY=pathlib.Path('/opt/media/data/torrents/pc/.ready')
HOP={'connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailers','transfer-encoding','upgrade','content-length','host','accept-encoding'}

class Proxy(http.server.BaseHTTPRequestHandler):
    protocol_version='HTTP/1.1'

    def log_message(self,*args):
        pass

    def handle_request(self):
        if ipaddress.ip_address(self.client_address[0]) not in ipaddress.ip_network('192.0.2.10/16'):
            self.send_error(403)
            return
        length=int(self.headers.get('Content-Length','0'))
        if length>20*1024*1024:
            self.send_error(413)
            return
        data=self.rfile.read(length) if length else None
        headers={k:v for k,v in self.headers.items() if k.lower() not in HOP}
        headers['Host']='127.0.0.1:18080'
        if 'Origin' in headers:
            headers['Origin']='http://127.0.0.1:18080'
        if 'Referer' in headers:
            headers['Referer']='http://127.0.0.1:18080/'
        conn=http.client.HTTPConnection('127.0.0.1',18080,timeout=30)
        try:
            conn.request(self.command,self.path,body=data,headers=headers)
            response=conn.getresponse()
            body=response.read()
            if response.status==200 and urllib.parse.urlsplit(self.path).path=='/api/v2/torrents/info':
                records=json.loads(body)
                exclusions=json.loads(pathlib.Path('/opt/media/config/media-hold/blocked.json').read_text())
                blocked=set(exclusions['hashes'])
                records=[item for item in records if item.get('hash','').lower() not in blocked]
                for item in records:
                    torrent_hash=item.get('hash','').lower()
                    if item.get('progress',0)>=1 and not (READY/(torrent_hash+'.json')).is_file():
                        item.update(progress=0.999,state='stalledDL',amount_left=1,eta=8640000,dlspeed=0)
                body=json.dumps(records).encode()
            self.send_response(response.status)
            for key,value in response.getheaders():
                if key.lower() not in HOP:
                    self.send_header(key,value)
            self.send_header('Content-Length',str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (OSError,TimeoutError,ValueError):
            self.send_error(503,'Computer downloader unavailable')
        finally:
            conn.close()

    do_GET=handle_request
    do_POST=handle_request
    do_PUT=handle_request
    do_DELETE=handle_request

if __name__=='__main__':
    server=http.server.ThreadingHTTPServer(('192.0.2.10',18081),Proxy)
    server.daemon_threads=True
    server.serve_forever()

