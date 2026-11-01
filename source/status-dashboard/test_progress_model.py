import unittest
from progress_model import transfer_totals


def job(key, progress=1, size=100):
    return {'hash':key,'category':'movies','progress':progress,'size':size}


class ProgressTests(unittest.TestCase):
    def test_an_unavailable_worker_still_reports_the_waiting_queue(self):
        result=transfer_totals([job('ready')],{}, {},[],None,None)
        self.assertEqual(result['waitingTransfers'],1)

    def test_live_copies_continue_past_the_old_244_batch(self):
        copied={str(i):{} for i in range(300)}
        result=transfer_totals([job('new'),job('downloading',.5)],copied,{},[],None,False)
        self.assertEqual((result['completedTransfers'],result['waitingTransfers']), (300,1))
        self.assertEqual(result['batchTotal'],301)
        self.assertEqual(result['phase'],'waiting')

    def test_partial_season_and_current_file_reduce_the_remaining_bytes(self):
        files=[{'name':'one','size':100},{'name':'two','size':200}]
        result=transfer_totals([job('new',size=300)],{}, {'hash':'new','file':'two'},files,50,True)
        self.assertEqual(result['remainingBytes'],150)
        self.assertEqual(result['phase'],'copying')

    def test_cleaned_jobs_count_and_new_completions_change_the_counter(self):
        result=transfer_totals([job('ready')],{'already-cleaned':{}},{},[],None,False)
        self.assertEqual(result['completedTransfers'],1)
        after=transfer_totals([job('ready')],{'already-cleaned':{},'ready':{}},{},[],None,False)
        self.assertEqual(after['completedTransfers'],2)
        self.assertEqual(after['waitingTransfers'],0)
        self.assertEqual(after['remainingBytes'],0)

    def test_skipped_files_duplicate_jobs_and_stale_progress_are_not_counted(self):
        jobs=[job('a'),job('a'),job('b',.5)]
        files=[{'name':'skip','size':900,'priority':0},{'name':'movie','size':100}]
        result=transfer_totals(jobs,{}, {'hash':'a','file':'movie'},files,25,True)
        self.assertEqual(result['remainingBytes'],75)
        paused=transfer_totals(jobs,{}, {'hash':'a','file':'movie'},files,25,False)
        self.assertEqual(paused['remainingBytes'],100)
        self.assertEqual(paused['waitingTransfers'],1)


if __name__=='__main__':unittest.main()
