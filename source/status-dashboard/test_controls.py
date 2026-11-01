import http.client,json,pathlib,sys,tempfile,threading,types,unittest
from unittest.mock import patch,Mock
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'pc-downloads'))
import actions,server,control_state


class ControlTests(unittest.TestCase):
    def test_explicit_pause_all_still_stops_forced_jobs_at_the_owners_request(self):
        with tempfile.TemporaryDirectory() as folder:
            root=pathlib.Path(folder);control_state.save(control_state.read(root),root)
            job={'hash':'a'*40,'category':'movies','progress':.5,'state':'forcedDL','force_start':True}
            api=Mock();api.request.side_effect=[[job],None]
            with patch.object(actions,'ROOT',root),patch.object(actions,'qb',return_value=api):
                actions.perform({'action':'queue','machine':'pc','operation':'pause'})
            self.assertTrue(control_state.read(root)['pcPaused'])
            self.assertEqual(api.request.call_args.args,('POST','/api/v2/torrents/stop'))
            self.assertEqual(api.request.call_args.kwargs['form']['hashes'],job['hash'])

    def test_copy_start_and_stop_change_only_copy_preference_and_return_acknowledgement(self):
        with tempfile.TemporaryDirectory() as folder:
            root=pathlib.Path(folder)
            original=control_state.read(root);original.update(pcPaused=True,piPaused=True,pcJobs=['a'*40],piJobs=['b'*40]);control_state.save(original,root)
            with patch.object(actions,'ROOT',root),patch.object(actions,'qb') as downloader:
                for operation,paused in [('pause',True),('resume',False)]:
                    result=actions.perform({'action':'copy','operation':operation})
                    current=control_state.read(root)
                    self.assertEqual(current['copyPaused'],paused)
                    self.assertEqual(result['copyPaused'],paused)
                    self.assertEqual(result['controlUpdatedAt'],current['updated'])
                    for key in ('pcPaused','piPaused','pcJobs','piJobs'):self.assertEqual(current[key],original[key])
                downloader.assert_not_called()

    def test_copy_controls_reject_unknown_operations_without_changing_state(self):
        with tempfile.TemporaryDirectory() as folder:
            root=pathlib.Path(folder);control_state.save(control_state.read(root),root)
            before=(root/'manual-controls.json').read_bytes()
            with patch.object(actions,'ROOT',root):
                for operation in ('delete','force','restart',None):
                    with self.assertRaises(ValueError):actions.perform({'action':'copy','operation':operation})
            self.assertEqual((root/'manual-controls.json').read_bytes(),before)

    def test_unsafe_settings_do_not_reach_a_downloader(self):
        with patch.object(actions,'qb') as api:
            for value in ({'pcMax':1000},{'pcMax':True},{'score':float('nan')},{'deleteFiles':True},{'drive':'Z:'}):
                with self.assertRaises(ValueError):actions.apply_settings(value)
            api.assert_not_called()

    def test_individual_resume_does_not_bypass_master_pause(self):
        with tempfile.TemporaryDirectory() as folder:
            root=pathlib.Path(folder);state=control_state.read(root);state.update(pcPaused=True,pcJobs=['a'*40]);control_state.save(state,root)
            api=Mock();api.request.return_value=[{'hash':'a'*40,'category':'movies','progress':.2}]
            with patch.object(actions,'ROOT',root),patch.object(actions,'qb',return_value=api),patch('media_hold.blocked',return_value={'hashes':[]}):
                with self.assertRaises(ValueError):actions.perform({'action':'torrent','machine':'pc','hash':'a'*40,'operation':'resume'})
            self.assertEqual(api.request.call_count,1)

    def test_resume_keeps_the_disk_reserve(self):
        value={'source_roots':['V:/HomeMedia-Media-Downloads'],'source_volume_guids':{'v:\\':'expected'},'min_pc_free_gib':100}
        with patch.object(actions,'cfg',return_value=value),patch.object(actions.pc_cleanup,'volume_guid',return_value='expected'),patch.object(actions.shutil,'disk_usage',return_value=types.SimpleNamespace(free=90*1024**3)):
            with self.assertRaises(ValueError):actions.can_resume({'save_path':'V:/HomeMedia-Media-Downloads/torrents/movies','category':'movies'},'pc')

    def test_local_actions_require_origin_and_token_and_reject_the_lan_proxy(self):
        httpd=server.http.server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
        thread=threading.Thread(target=httpd.serve_forever,daemon=True);thread.start()
        def request(extra):
            connection=http.client.HTTPConnection('127.0.0.1',httpd.server_port)
            headers={'Host':'127.0.0.1:18090','Content-Type':'application/json',**extra}
            connection.request('POST','/api/action',json.dumps({'action':'copy','operation':'pause'}),headers)
            response=connection.getresponse();response.read();connection.close();return response.status
        try:
            with patch.object(server.actions,'perform',return_value={'message':'test'}) as mutate,patch.object(server,'event'):
                self.assertEqual(request({}),403)
                self.assertEqual(request({'Origin':'https://unrelated.example','X-HomeMedia-Control':server.CONTROL_TOKEN}),403)
                self.assertEqual(request({'Origin':'http://127.0.0.1:18090','X-HomeMedia-Control':server.CONTROL_TOKEN,'X-HomeMedia-Read-Only':'1'}),403)
                mutate.assert_not_called()
                self.assertEqual(request({'Origin':'http://127.0.0.1:18090','X-HomeMedia-Control':server.CONTROL_TOKEN}),200)
                mutate.assert_called_once()
        finally:httpd.shutdown();httpd.server_close()


if __name__=='__main__':unittest.main()
