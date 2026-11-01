import unittest
from progress_model import matching_copy_bytes


class CopyObservationTests(unittest.TestCase):
    def test_matching_file_accepts_measurement(self):
        self.assertEqual(matching_copy_bytes({'hash':'ABC','file':'season\\one.mkv'},
            {'copyHash':'abc','copyFile':'season/one.mkv','copyBytes':123}),123)

    def test_file_transition_does_not_apply_previous_file_bytes(self):
        self.assertIsNone(matching_copy_bytes({'hash':'abc','file':'two.mkv'},
            {'copyHash':'abc','copyFile':'one.mkv','copyBytes':999}))

    def test_job_transition_and_missing_identity_reject_measurement(self):
        self.assertIsNone(matching_copy_bytes({'hash':'new','file':'film.mp4'},
            {'copyHash':'old','copyFile':'film.mp4','copyBytes':999}))
        self.assertIsNone(matching_copy_bytes({},{}))


if __name__=='__main__':unittest.main()
