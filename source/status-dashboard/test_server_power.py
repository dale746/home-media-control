"""Power controls use mocked SSH/commands only; no machine is shut down."""
import contextlib
import http.client
import io
import json
import pathlib
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import Mock,patch

HERE=pathlib.Path(__file__).resolve().parent
sys.path.insert(0,str(pathlib.Path.home()/'AppData/Local/HomeMediaControl'))
sys.path.insert(0,str(HERE))
import server_power as power
import actions
import server

BOOT='93bc5123-b094-5444-b1e7-ebc090f84bf0'
NEXT_BOOT='92e1524d-97c7-569f-9fbc-0e563b29af98'
IDENTITY={'hostname':'media-server','architecture':'x86_64','bootId':BOOT}
REQUEST={'action':'server-power','operation':'shutdown','confirmation':'SHUTDOWN'}


class PowerTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.root=pathlib.Path(self.temp.name)
        self.root_patch=patch.object(power,'ROOT',self.root);self.root_patch.start()
    def tearDown(self):self.root_patch.stop();self.temp.cleanup()
    def responses(self):return [json.dumps(IDENTITY),json.dumps({'accepted':True,'bootId':BOOT})]

    def test_only_exact_shutdown_action_and_confirmation_can_reach_ssh(self):
        invalid=[{},dict(REQUEST,confirmation='shutdown'),dict(REQUEST,confirmation='SHUTDOWN '),
                 dict(REQUEST,operation='reboot'),dict(REQUEST,machine='pc'),dict(REQUEST,command='anything')]
        with patch.object(power.worker,'pi_python') as ssh:
            for body in invalid:
                with self.subTest(body=body),self.assertRaises(ValueError):power.request_shutdown(body)
            ssh.assert_not_called()
        self.assertFalse((self.root/'server-power.json').exists())

    def test_original_pi_or_an_unidentified_host_cannot_be_powered_off(self):
        for identity in [dict(IDENTITY,hostname='raspberrypi'),dict(IDENTITY,architecture='aarch64'),{},[]]:
            with self.subTest(identity=identity),patch.object(power.worker,'pi_python',return_value=json.dumps(identity)) as ssh:
                with self.assertRaisesRegex(ValueError,'not the verified'):power.request_shutdown(REQUEST)
                self.assertEqual(ssh.call_count,1)
        self.assertFalse((self.root/'server-power.json').exists())

    def test_accepted_request_is_delayed_graceful_and_preserves_pause_preferences(self):
        preferences=self.root/'manual-controls.json';preferences.write_text('{"copyPaused":true,"pcPaused":false}')
        with patch.object(power.worker,'pi_python',side_effect=self.responses()) as ssh:
            result=power.request_shutdown(REQUEST)
        self.assertTrue(result['accepted']);self.assertEqual(result['serverPower']['phase'],'pending')
        self.assertFalse(result['serverPower']['canShutdown']);self.assertEqual(ssh.call_count,2)
        source=ssh.call_args_list[1].args[0];compile(source,'<mocked power source>','exec')
        self.assertIn('--on-active=15s',source);self.assertIn("'/usr/bin/systemctl','poweroff'",source)
        self.assertNotIn('--force',source);self.assertEqual(preferences.read_text(),'{"copyPaused":true,"pcPaused":false}')
        self.assertEqual(power.read()['bootId'],BOOT)

    def test_repeated_click_and_reloaded_state_do_not_schedule_another_shutdown(self):
        with patch.object(power.worker,'pi_python',side_effect=self.responses()) as ssh:
            power.request_shutdown(REQUEST);again=power.request_shutdown(REQUEST)
        self.assertEqual(ssh.call_count,2);self.assertTrue(again['accepted']);self.assertIn('already',again['message'])
        with patch.object(power.worker,'pi_python') as ssh:
            self.assertEqual(power.public_status({'reachable':True,**IDENTITY})['phase'],'pending')
            power.request_shutdown(REQUEST);ssh.assert_not_called()

    def test_unreachable_preflight_does_not_claim_shutdown_was_sent(self):
        with patch.object(power.worker,'pi_python',side_effect=TimeoutError('private transport detail')):
            with self.assertRaisesRegex(ValueError,'Shutdown was not requested') as error:power.request_shutdown(REQUEST)
        self.assertNotIn('private',str(error.exception));self.assertFalse(power.read())

    def test_lost_schedule_response_reports_uncertainty_and_blocks_duplicate_request(self):
        with patch.object(power.worker,'pi_python',side_effect=[json.dumps(IDENTITY),TimeoutError('/private/detail')]):
            with self.assertRaisesRegex(ValueError,'may already be shutting down') as error:power.request_shutdown(REQUEST)
        self.assertNotIn('/private',str(error.exception));self.assertEqual(power.read()['phase'],'unconfirmed')
        self.assertEqual(power.public_status({'reachable':True,**IDENTITY})['phase'],'unconfirmed')
        with patch.object(power.worker,'pi_python') as ssh:
            with self.assertRaisesRegex(ValueError,'previous shutdown'):power.request_shutdown(REQUEST)
            ssh.assert_not_called()

    def test_malformed_or_wrong_boot_acknowledgement_cannot_claim_accepted(self):
        for response in ['[]','not json',json.dumps({'accepted':True,'bootId':NEXT_BOOT})]:
            power.save({})
            with self.subTest(response=response),patch.object(power.worker,'pi_python',side_effect=[json.dumps(IDENTITY),response]):
                with self.assertRaisesRegex(ValueError,'could not be confirmed'):power.request_shutdown(REQUEST)
                self.assertEqual(power.read()['phase'],'unconfirmed')

    def test_status_does_not_equate_unreachable_with_safe_to_unplug(self):
        power.save({'phase':'pending','requestedAt':100,'bootId':BOOT})
        result=power.public_status({'reachable':False,**IDENTITY},now=120)
        self.assertEqual(result['phase'],'offline');self.assertFalse(result['canShutdown'])
        self.assertIn('Check its power light',result['message'])

    def test_new_boot_clears_request_without_changing_any_pause_or_download_setting(self):
        power.save({'phase':'pending','requestedAt':100,'bootId':BOOT})
        result=power.public_status({'reachable':True,**dict(IDENTITY,bootId=NEXT_BOOT)},now=200)
        self.assertEqual(result['phase'],'online');self.assertTrue(result['canShutdown']);self.assertIsNone(result['requestedAt']);self.assertEqual(power.read(),{})
        self.assertEqual([p.name for p in self.root.iterdir()],['server-power.json'])

    def test_old_pending_request_stays_unconfirmed_instead_of_enabling_repeated_shutdown(self):
        power.save({'phase':'pending','requestedAt':100,'bootId':BOOT})
        result=power.public_status({'reachable':True,**IDENTITY},now=400)
        self.assertEqual(result['phase'],'unconfirmed');self.assertFalse(result['canShutdown'])

    def test_only_verified_online_server_enables_button_and_status_never_calls_ssh(self):
        with patch.object(power.worker,'pi_python') as ssh:
            self.assertTrue(power.public_status({'reachable':True,**IDENTITY})['canShutdown'])
            self.assertFalse(power.public_status({'reachable':True,**dict(IDENTITY,hostname='other')})['canShutdown'])
            self.assertFalse(power.public_status({'reachable':False,**IDENTITY})['canShutdown'])
            ssh.assert_not_called()

    def test_lightweight_identity_can_enable_power_without_claiming_media_health(self):
        health={'reachable':False,'error':'TimeoutError','drive':{'available':False},'services':[]}
        with patch.object(power.worker,'pi_python',return_value=json.dumps(IDENTITY)) as ssh:
            result=power.identity_after_health_failure(health)
        ssh.assert_called_once_with(power.IDENTITY_SOURCE,timeout=4)
        self.assertFalse(result['reachable']);self.assertFalse(result['drive']['available']);self.assertEqual(result['error'],'TimeoutError')
        self.assertTrue(result['powerReachable']);self.assertEqual(result['bootId'],BOOT)
        status=power.public_status(result)
        self.assertEqual(status['phase'],'online');self.assertTrue(status['canShutdown']);self.assertIn('detailed media status is delayed',status['message'])

    def test_identity_fallback_failure_or_wrong_host_cannot_enable_power(self):
        for value in [None,{},dict(IDENTITY,hostname='raspberrypi'),dict(IDENTITY,architecture='aarch64')]:
            with self.subTest(value=value),patch.object(power.worker,'pi_python',return_value=json.dumps(value)):
                result=power.identity_after_health_failure({'reachable':False})
            self.assertFalse(result['powerReachable']);self.assertFalse(power.public_status(result)['canShutdown'])
        with patch.object(power.worker,'pi_python',side_effect=TimeoutError('private detail')):
            result=power.identity_after_health_failure({'reachable':False})
        self.assertEqual(result,{'reachable':False,'powerReachable':False})

    def test_shutdown_state_tracks_new_boot_from_lightweight_fallback(self):
        power.save({'phase':'pending','requestedAt':100,'bootId':BOOT})
        status=power.public_status({'reachable':False,'powerReachable':True,**dict(IDENTITY,bootId=NEXT_BOOT)},now=200)
        self.assertEqual(status['phase'],'online');self.assertTrue(status['canShutdown']);self.assertIsNone(status['requestedAt'])

    def run_schedule_fixture(self,identity=IDENTITY,active=False):
        fake=Mock(side_effect=[types.SimpleNamespace(stdout='active' if active else 'inactive',returncode=0),types.SimpleNamespace(stdout='',returncode=0)])
        output=io.StringIO()
        with patch('socket.gethostname',return_value=identity['hostname']),patch('platform.machine',return_value=identity['architecture']),patch.object(pathlib.Path,'read_text',return_value=identity['bootId']),patch('subprocess.run',fake),contextlib.redirect_stdout(output):
            try:exec(power.SCHEDULE_SOURCE.replace('EXPECTED_BOOT',repr(BOOT)),{})
            except SystemExit:pass
        return json.loads(output.getvalue()),fake

    def test_remote_program_uses_fixed_commands_and_normal_systemd_poweroff(self):
        result,command=self.run_schedule_fixture()
        self.assertTrue(result['accepted']);self.assertEqual(command.call_count,2)
        self.assertEqual(command.call_args_list[1].args[0],['sudo','-n','/usr/bin/systemd-run','--unit=hmc-dashboard-poweroff','--on-active=15s','--timer-property=AccuracySec=1s','/usr/bin/systemctl','poweroff'])

    def test_remote_identity_or_boot_change_prevents_every_command(self):
        for override in [{'hostname':'raspberrypi'},{'architecture':'aarch64'},{'bootId':NEXT_BOOT}]:
            result,command=self.run_schedule_fixture(dict(IDENTITY,**override))
            self.assertIn('error',result);command.assert_not_called()

    def test_remote_timer_deduplicates_a_lost_acknowledgement(self):
        result,command=self.run_schedule_fixture(active=True)
        self.assertTrue(result['accepted']);self.assertEqual(command.call_count,1)
        self.assertEqual(command.call_args.args[0],['/usr/bin/systemctl','is-active','hmc-dashboard-poweroff.timer'])

    def test_action_dispatch_is_the_only_new_operation(self):
        with patch.object(actions,'ROOT',self.root),patch.object(power,'request_shutdown',return_value={'accepted':True,'message':'Mock only'}) as shutdown:
            self.assertTrue(actions.perform(REQUEST)['accepted']);shutdown.assert_called_once_with(REQUEST)

    def test_power_action_retains_localhost_origin_token_and_read_only_checks(self):
        httpd=server.http.server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
        threading.Thread(target=httpd.serve_forever,daemon=True).start()
        def request(extra):
            connection=http.client.HTTPConnection('127.0.0.1',httpd.server_port)
            headers={'Host':'127.0.0.1:18090','Content-Type':'application/json',**extra}
            connection.request('POST','/api/action',json.dumps(REQUEST),headers)
            response=connection.getresponse();response.read();connection.close();return response.status
        try:
            with patch.object(server.actions,'perform',return_value={'message':'Mock shutdown only'}) as mutate,patch.object(server,'event'):
                for headers in [{},{'Origin':'https://unrelated.example','X-HomeMedia-Control':server.CONTROL_TOKEN},
                                {'Origin':'http://127.0.0.1:18090','X-HomeMedia-Control':'wrong'},
                                {'Origin':'http://127.0.0.1:18090','X-HomeMedia-Control':server.CONTROL_TOKEN,'X-HomeMedia-Read-Only':'1'},
                                {'Host':'192.0.2.10:18090','Origin':'http://127.0.0.1:18090','X-HomeMedia-Control':server.CONTROL_TOKEN}]:
                    self.assertEqual(request(headers),403)
                mutate.assert_not_called()
                self.assertEqual(request({'Origin':'http://127.0.0.1:18090','X-HomeMedia-Control':server.CONTROL_TOKEN}),200)
                mutate.assert_called_once_with(REQUEST)
        finally:httpd.shutdown();httpd.server_close()


if __name__=='__main__':unittest.main()
