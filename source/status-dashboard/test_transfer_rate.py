import pathlib,sys,unittest
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'pc-downloads'))
from server import CopyRate


class TransferRateTests(unittest.TestCase):
    def test_cached_observation_does_not_produce_a_false_zero(self):
        meter=CopyRate();meter.observe(('a','file'),0,0,0,True)
        self.assertEqual(meter.observe(('a','file'),200,2,2,True),100)
        self.assertEqual(meter.observe(('a','file'),200,2,4,True),100)

    def test_recent_measured_rate_survives_the_start_of_another_file(self):
        meter=CopyRate();meter.observe(('a','one'),0,0,0,True);meter.observe(('a','one'),200,2,2,True)
        self.assertEqual(meter.observe(('b','two'),10,3,3,True),100)

    def test_paused_or_stale_copy_does_not_show_an_old_speed(self):
        meter=CopyRate();meter.observe(('a','one'),0,0,0,True);meter.observe(('a','one'),200,2,2,True)
        self.assertEqual(meter.observe(None,None,3,33,True),0)
        self.assertEqual(meter.observe(('a','one'),300,3,34,False),0)


if __name__=='__main__':unittest.main()
