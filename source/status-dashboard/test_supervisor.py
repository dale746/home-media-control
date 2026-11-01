"""Isolated supervisor checks; no live processes, locks or services are changed."""
import json
import pathlib
import tempfile
import unittest
from unittest.mock import Mock,patch
import supervisor as s


class SupervisorTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=pathlib.Path(self.temp.name)
        self.owned=Mock(return_value=False)
        self.child=Mock();self.child.poll.return_value=None
        self.launch=Mock(return_value=self.child)
        self.watch=s.Supervisor(self.root,owned=self.owned,launch=self.launch)

    def value(self):return json.loads((self.root/'supervisor-status.json').read_text())

    def test_existing_dashboard_is_adopted_without_launch_or_http_poll(self):
        self.owned.return_value=True
        for now in (0,5,100):self.watch.step(now)
        self.launch.assert_not_called();self.assertEqual(self.value()['phase'],'running')

    def test_missing_dashboard_is_launched_once_and_live_startup_is_not_restarted(self):
        for now in (0,5,300):self.watch.step(now)
        self.launch.assert_called_once_with(self.root)
        self.child.kill.assert_not_called();self.child.terminate.assert_not_called()

    def test_early_exit_retries_with_backoff_instead_of_tight_loop(self):
        self.watch.step(0);self.child.poll.return_value=1;self.watch.step(1)
        self.assertEqual(self.value()['retrySeconds'],5)
        self.watch.step(5);self.assertEqual(self.launch.call_count,1)
        self.watch.step(6);self.assertEqual(self.launch.call_count,2)
        self.watch.step(7);self.assertEqual(self.value()['retrySeconds'],10)
        self.watch.step(16);self.assertEqual(self.launch.call_count,2)
        self.watch.step(17);self.assertEqual(self.launch.call_count,3)

    def test_backoff_is_capped_and_resets_only_after_stable_ownership(self):
        for now in range(0,30000,1000):
            self.watch.step(now);self.child.poll.return_value=2;self.watch.step(now+1)
        self.assertEqual(self.watch.retry_delay,300)
        self.owned.return_value=True;self.watch.step(31000);self.watch.step(31059)
        self.assertEqual(self.watch.retry_delay,300)
        self.watch.step(31060);self.assertEqual(self.watch.retry_delay,5)

    def test_adopted_dashboard_exit_is_recovered_after_delay(self):
        self.owned.return_value=True;self.watch.step(0)
        self.owned.return_value=False;self.watch.step(2);self.watch.step(6)
        self.launch.assert_not_called();self.watch.step(7);self.launch.assert_called_once()

    def test_start_failure_exposes_only_exception_type(self):
        self.launch.side_effect=OSError('private credential or command details')
        self.watch.step(0)
        value=self.value();self.assertEqual(value['error'],'OSError');self.assertNotIn('private',json.dumps(value))

    def test_status_is_written_only_on_transition(self):
        self.owned.return_value=True;self.watch.step(0)
        before=(self.root/'supervisor-status.json').read_bytes();self.watch.step(5)
        self.assertEqual(before,(self.root/'supervisor-status.json').read_bytes())

    def test_dashboard_lock_is_released_only_when_it_was_acquired(self):
        handle=Mock()
        with patch.object(s,'acquire_lock',return_value=handle),patch.object(s,'release_lock') as release:
            self.assertFalse(s.dashboard_owned(self.root));release.assert_called_once_with(handle)
        with patch.object(s,'acquire_lock',return_value=None),patch.object(s,'release_lock') as release:
            self.assertTrue(s.dashboard_owned(self.root));release.assert_not_called()

    def test_second_supervisor_exits_without_launch_or_monitor_loop(self):
        with patch.object(s,'__file__',str(self.root/'supervisor.py')),patch.object(s,'acquire_lock',return_value=None),patch.object(s,'Supervisor') as watcher,patch.object(s.time,'sleep') as sleep:
            s.main();watcher.assert_not_called();sleep.assert_not_called()

    def test_launch_uses_hidden_current_python_and_dashboard_only(self):
        with patch.object(s.subprocess,'Popen',return_value=self.child) as launch:
            self.assertIs(s.launch_dashboard(self.root),self.child)
        self.assertEqual(launch.call_args.args[0],[s.sys.executable,str(self.root/'server.py')])
        self.assertEqual(launch.call_args.kwargs['cwd'],str(self.root))
        self.assertEqual(launch.call_args.kwargs['creationflags'],getattr(s.subprocess,'CREATE_NO_WINDOW',0))

    def test_logs_are_bounded_and_keep_recent_tail(self):
        log=self.root/'dashboard.stderr.log';log.write_bytes(b'a'*s.LOG_LIMIT+b'z'*s.LOG_TAIL)
        s.bound_log(log);self.assertEqual(log.read_bytes(),b'z'*s.LOG_TAIL)


if __name__=='__main__':unittest.main()
