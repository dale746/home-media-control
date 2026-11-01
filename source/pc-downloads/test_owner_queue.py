"""Owner commands win over automatic sorting; no live download mutations."""
import copy,json,pathlib,tempfile,unittest
from types import SimpleNamespace
from unittest.mock import patch
import bulk_queue,worker


def job(identifier,state='queuedDL',forced=False):
    return {'hash':identifier,'name':identifier,'category':'movies','progress':.5,
            'state':state,'force_start':forced,'save_path':'V:/managed/torrents/movies',
            'size':1000,'amount_left':500,'dlspeed':0,'num_seeds':1}


class OwnerQueueTests(unittest.TestCase):
    def run_queue(self,torrents,eligible=False,book=None,storage_paused=(),controls=None):
        calls=[]
        records={f'movie:{i}':{'kind':'movie','tmdbId':i,'eligible':eligible,
                 'releaseDate':'2026-01-01','title':t['name']} for i,t in enumerate(torrents,1)}
        class Downloader:
            def request(self,method,path,**kwargs):
                calls.append((method,path,kwargs))
                return torrents if method=='GET' else None
        class Catalogue:
            def __init__(self,name):self.name=name
            def request(self,method,path,**kwargs):
                if self.name!='radarr':return {'records':[]} if '/queue?' in path else []
                if '/queue?' in path:return {'records':[{'movieId':i,'downloadId':t['hash']} for i,t in enumerate(torrents,1)]}
                return [{'id':i,'tmdbId':i} for i in range(1,len(torrents)+1)]
        with tempfile.TemporaryDirectory() as folder:
            root=pathlib.Path(folder)
            if book:(root/'order.json').write_text(json.dumps(book))
            if storage_paused:(root/'storage-paused.json').write_text(json.dumps(list(storage_paused)))
            with patch.object(worker,'ROOT',root),patch.object(worker,'refresh_config'), \
                 patch.object(worker,'CONFIG',{'data':'V:/managed','source_roots':['V:/managed']}), \
                 patch.object(worker,'qb_api',return_value=Downloader()),patch.object(worker,'protect_storage'), \
                 patch.object(bulk_queue.policy,'load',return_value={'items':records}), \
                 patch.object(bulk_queue.policy,'pending_items'), \
                 patch.object(bulk_queue.policy,'key',side_effect=lambda kind,i:f'{kind}:{i}'), \
                 patch.object(bulk_queue.policy,'api',side_effect=Catalogue), \
                 patch.object(bulk_queue,'ORDER_FILE',root/'order.json'), \
                 patch.object(bulk_queue.shutil,'disk_usage',return_value=SimpleNamespace(free=1000*1024**3)), \
                 patch('control_state.read',return_value=controls or {'pcPaused':False,'pcJobs':[]}), \
                 patch('media_hold.blocked',return_value={'hashes':[],'keys':[]}):
                report=bulk_queue.run()
        return calls,report

    def test_forced_job_outside_bulk_policy_is_neither_stopped_nor_reordered(self):
        for state,flag in [('forcedDL',False),('metaDL',True)]:
            with self.subTest(state=state):
                torrents=[job('manual',state,flag)];before=copy.deepcopy(torrents)
                calls,report=self.run_queue(torrents)
                self.assertFalse([x for x in calls if x[0]=='POST'])
                self.assertEqual(torrents,before)

    def test_forced_jobs_are_outside_automatic_priority_sorting(self):
        torrents=[job('manual','forcedDL'),job('automatic')]
        self.assertEqual(bulk_queue.desired_queue([(1,'2026-01-01','Manual','manual'),
                         (1,'2025-01-01','Automatic','automatic')],torrents),['automatic'])

    def test_stopped_jobs_stay_stopped_even_when_old_policy_or_storage_records_would_restart_them(self):
        for stopped_state in ['stoppedDL','pausedDL']:
            with self.subTest(state=stopped_state):
                torrents=[job('stopped',stopped_state)]
                book={'started':[],'policyPaused':['stopped'],'lastOrder':[]}
                calls,report=self.run_queue(torrents,eligible=True,book=book,storage_paused=['stopped'])
                self.assertEqual(report['resumed'],0);self.assertEqual(report['manualStopped'],1)
                self.assertFalse([x for x in calls if x[0]=='POST'])

    def test_forced_job_is_not_repeatedly_stopped_after_master_pause(self):
        calls,report=self.run_queue([job('manual','forcedDL'),job('ordinary')],
                                   controls={'pcPaused':True,'pcJobs':[]})
        mutations=[x for x in calls if x[0]=='POST']
        self.assertEqual(len(mutations),1)
        self.assertEqual(mutations[0][2]['form']['hashes'],'ordinary')

    def test_disk_reserve_still_protects_against_forced_download_exhausting_the_drive(self):
        with tempfile.TemporaryDirectory() as folder:
            root=pathlib.Path(folder);torrent=job('forced','forcedDL',True)
            torrent['save_path']=str(root/'torrents/movies');calls=[]
            class Queue:
                def request(self,method,path,**kwargs):calls.append((path,kwargs))
            with patch.object(worker,'ROOT',root), \
                 patch.object(worker,'CONFIG',{'source_roots':[str(root)],'data':str(root),'min_pc_free_gib':100}), \
                 patch.object(worker.shutil,'disk_usage',return_value=SimpleNamespace(free=99*1024**3)):
                self.assertEqual(worker.protect_storage(Queue(),[torrent]),['forced'])
            self.assertEqual(calls[0][1]['form']['hashes'],'forced')


if __name__=='__main__':unittest.main()
