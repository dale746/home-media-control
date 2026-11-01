import unittest
from bulk_feed import request_is_pending


class AdmissionTests(unittest.TestCase):
    def test_old_empty_search_does_not_block_next_titles(self):
        self.assertFalse(request_is_pending({'requestedAt':1000},[],now=5000))

    def test_new_search_gets_time_to_find_a_source(self):
        self.assertTrue(request_is_pending({'requestedAt':4900},[],now=5000))

    def test_real_byte_progress_occupies_a_slot(self):
        record={'requestedAt':1000,'lastObservedBytes':100}
        self.assertTrue(request_is_pending(record,[{'progress':.2,'completed':200}],now=5000))
        self.assertEqual(record['lastProgressAt'],5000)

    def test_stale_partial_file_does_not_hold_slot_forever(self):
        record={'requestedAt':1000,'lastProgressAt':2000,'lastObservedBytes':100}
        self.assertFalse(request_is_pending(record,[{'progress':.1,'completed':100,'dlspeed':0}],now=5000))

    def test_current_speed_counts_even_before_next_byte_sample(self):
        self.assertTrue(request_is_pending({'requestedAt':1000},[{'progress':.1,'dlspeed':1000}],now=5000))

    def test_completed_download_waiting_for_pi_does_not_hold_slot(self):
        self.assertFalse(request_is_pending({'requestedAt':4900},[{'progress':1}],now=5000))


if __name__=='__main__':unittest.main()
