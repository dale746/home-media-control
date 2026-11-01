import pathlib,tempfile,unittest
from control_state import read,save,held_hashes
from failover_guard import client_layout,seerr_server_update


class ManualControlsTests(unittest.TestCase):
    def test_discovery_update_omits_read_only_id_and_preserves_connection_settings(self):
        server={'id':0,'name':'Movies','apiKey':'test-key','tags':[],'isDefault':True}
        body=seerr_server_update(server,[2])
        self.assertNotIn('id',body)
        self.assertEqual(body['tags'],[2])
        self.assertEqual(body['apiKey'],'test-key')
        self.assertEqual(server['tags'],[])

    def test_individual_pause_is_persistent_and_does_not_stop_other_jobs(self):
        with tempfile.TemporaryDirectory() as folder:
            state=read(folder);state['pcJobs']=['a'];save(state,folder)
            jobs=[{'hash':'a','progress':.2,'state':'downloading'},{'hash':'b','progress':.4,'state':'downloading'}]
            self.assertEqual(held_hashes(jobs,read(folder)),['a'])

    def test_later_force_start_overrides_repeat_pause_enforcement(self):
        self.assertEqual(held_hashes([{'hash':'active','progress':.2,'state':'forcedDL'},
                                    {'hash':'ordinary','progress':.3,'state':'downloading'},
                                    {'hash':'done','progress':1,'state':'uploading'}],{'pcPaused':True}),['ordinary'])

    def test_force_start_flag_also_overrides_a_previous_individual_pause(self):
        self.assertEqual(held_hashes([{'hash':'manual','progress':.2,'state':'metaDL','force_start':True}],
                                    {'pcJobs':['manual']}),[])

    def test_independent_manual_and_bulk_destinations(self):
        for bulk in ('computer','pi'):
            for manual in ('computer','pi'):
                layout=client_layout({'bulk_destination':bulk,'manual_destination':manual},1,2,99,True)
                self.assertEqual(1 in layout['computer']['tags'],bulk=='computer')
                self.assertEqual(2 in layout['computer']['tags'],manual=='computer')
                self.assertEqual(layout['manual']['tags'],[2])

    def test_disabling_fallback_removes_unwanted_pi_routes_without_disabling_imports(self):
        layout=client_layout({'bulk_destination':'computer','manual_destination':'pi','pi_fallback':False},1,2,99,False)
        self.assertEqual(layout['backup']['tags'],[99])
        self.assertEqual(layout['manual'],{'tags':[2],'priority':1})
        self.assertNotIn('enable',layout['computer'])

    def test_offline_computer_promotes_pi_backup(self):
        layout=client_layout({'manual_destination':'computer'},1,2,99,False)
        self.assertEqual(layout['computer']['priority'],20)
        self.assertEqual(layout['backup']['priority'],1)
        self.assertEqual(layout['manual']['priority'],1)


if __name__=='__main__':unittest.main()
