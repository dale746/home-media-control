import copy
import json
import pathlib
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import bulk_queue


def job(torrent_hash,progress=0,remaining=1000,state='queuedDL',category='movies'):
    return {'hash':torrent_hash,'name':torrent_hash,'progress':progress,'amount_left':remaining,
            'state':state,'category':category,'save_path':'V:/managed/torrents/'+category,
            'size':10000,'dlspeed':0,'num_seeds':1}


class QueueOrderTests(unittest.TestCase):
    def test_nearly_finished_old_and_manual_jobs_precede_new_downloads(self):
        torrents=[job('new'),job('old',.99,100),job('manual',.985,50),job('partial',.5,500)]
        candidates=[(1,'2026-11-01','New','new'),(1,'2001-01-01','Old','old')]
        self.assertEqual(bulk_queue.desired_queue(candidates,torrents),['manual','old','new'])

    def test_held_policy_storage_stopped_and_finished_jobs_stay_out(self):
        torrents=[job('user',.99),job('policy',.99),job('storage',.99),
                  job('stopped',.99,state='stoppedDL'),job('paused',.99,state='pausedDL'),
                  job('finished',1),job('other',.99,category='other'),job('allowed',.99)]
        candidates=[(1,'2026-11-01',t['name'],t['hash']) for t in torrents]
        self.assertEqual(bulk_queue.desired_queue(candidates,torrents,held=['user'],
                         policy_paused=['policy','storage'],urgent=[t['hash'] for t in torrents]),['allowed'])

    def test_new_downloads_keep_available_then_newest_date_order(self):
        torrents=[job(h) for h in ('older','newer','unavailable','same-a','same-b')]
        candidates=[(1,'2020-01-01','Old','older'),(1,'2026-10-30','New','newer'),
                    (0,'2026-11-01','No source','unavailable'),
                    (1,'2026-10-29','Same','same-a'),(1,'2026-10-29','Same','same-b')]
        self.assertEqual(bulk_queue.desired_queue(candidates,torrents),
                         [entry[3] for entry in sorted(candidates,reverse=True)])

    def test_urgent_iron_man_2_precedes_finishing_jobs_and_is_not_duplicated(self):
        iron_man_2='0000000000000000000000000000000000000002'
        torrents=[job(iron_man_2,.0018),job('finishing',.999,1),job('new')]
        candidates=[(1,'2026-11-01','New','new'),(1,'2010-01-01','Iron Man 2',iron_man_2)]
        self.assertEqual(bulk_queue.desired_queue(candidates,torrents,
                         urgent=['missing',iron_man_2.upper(),iron_man_2]),[iron_man_2,'finishing','new'])

    def test_remaining_bytes_then_progress_decide_finish_order(self):
        torrents=[job('bigger',.999,100),job('lower-progress',.98,20),job('higher-progress',.99,20)]
        self.assertEqual(bulk_queue.desired_queue([],torrents),['higher-progress','lower-progress','bigger'])

    def test_remaining_bytes_fall_back_to_completed_size(self):
        torrent=job('finishing',.99)
        torrent.pop('amount_left');torrent['completed']=9995
        self.assertEqual(bulk_queue.desired_queue([],[job('other',.99,10),torrent]),['finishing','other'])

    def test_hash_case_and_duplicate_records_do_not_duplicate_priorities(self):
        torrents=[job('ABC',.99,10),job('abc',.99,10),job('held',.99,1)]
        candidates=[(1,'2026-11-01','Same','ABC'),(1,'2026-11-01','Same','abc')]
        self.assertEqual(bulk_queue.desired_queue(candidates,torrents,held=['HELD'],urgent=['ABC']),['abc'])

    def test_helper_does_not_mutate_inputs_or_download_settings(self):
        candidates=[(1,'2026-11-01','New','new')]
        torrents=[job('new'),job('old',.99,10)]
        held=['held'];paused=['paused'];urgent=['new']
        before=copy.deepcopy((candidates,torrents,held,paused,urgent,bulk_queue.worker.CONFIG))
        bulk_queue.desired_queue(candidates,torrents,held,paused,urgent)
        self.assertEqual((candidates,torrents,held,paused,urgent,bulk_queue.worker.CONFIG),before)

    def test_run_only_changes_queue_priorities_and_keeps_existing_limits(self):
        torrents=[job('new'),job('manual',.99,10),job('iron-man-2',.0018)]
        record={'kind':'movie','tmdbId':1,'eligible':True,'releaseDate':'2026-11-01','title':'New'}
        calls=[]
        class Downloader:
            def request(self,method,path,**kwargs):
                calls.append((method,path,kwargs))
                return torrents if method=='GET' else None
        class Catalogue:
            def __init__(self,name):self.name=name
            def request(self,method,path,**kwargs):
                if self.name!='radarr':return {'records':[]} if '/queue?' in path else []
                if '/queue?' in path:return {'records':[{'movieId':1,'downloadId':'NEW'}]}
                return [{'id':1,'tmdbId':1}]
        with tempfile.TemporaryDirectory() as folder:
            root=pathlib.Path(folder)
            controls={'pcPaused':False,'pcJobs':[],'pcPriority':['iron-man-2']}
            config={'data':'V:/managed','source_roots':['V:/managed'],'pc_max_downloads':52}
            before=copy.deepcopy((torrents,controls,config))
            with patch.object(bulk_queue.worker,'ROOT',root), \
                 patch.object(bulk_queue.worker,'CONFIG',config), \
                 patch.object(bulk_queue.worker,'refresh_config'), \
                 patch.object(bulk_queue.worker,'protect_storage'), \
                 patch.object(bulk_queue.worker,'qb_api',return_value=Downloader()), \
                 patch.object(bulk_queue.policy,'load',return_value={'items':{'movie:1':record}}), \
                 patch.object(bulk_queue.policy,'pending_items'), \
                 patch.object(bulk_queue.policy,'key',side_effect=lambda kind,tmdb:f'{kind}:{tmdb}'), \
                 patch.object(bulk_queue.policy,'api',side_effect=Catalogue), \
                 patch.object(bulk_queue,'ORDER_FILE',root/'order.json'), \
                 patch.object(bulk_queue.shutil,'disk_usage',return_value=SimpleNamespace(free=1000*1024**3)), \
                 patch('control_state.read',return_value=controls), \
                 patch('media_hold.blocked',return_value={'hashes':[],'keys':[]}):
                report=bulk_queue.run()
            self.assertEqual(json.loads((root/'order.json').read_text())['lastOrder'],['iron-man-2','manual','new'])
            self.assertEqual(report['resumed'],0)
            self.assertEqual([call[1] for call in calls if call[0]=='POST'],
                             ['/api/v2/torrents/topPrio']*3)
            self.assertEqual((torrents,controls,config),before)


if __name__=='__main__':unittest.main()
