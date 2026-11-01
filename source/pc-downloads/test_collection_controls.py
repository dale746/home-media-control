import unittest
from unittest.mock import patch
import bulk_policy


class CollectionControlTests(unittest.TestCase):
    def setUp(self):
        held=patch('media_hold.blocked',return_value={'keys':[],'hashes':[]})
        held.start();self.addCleanup(held.stop)

    def record(self,**changes):
        value={'kind':'movie','tmdbId':123456789,'originalLanguage':'en','title':'Film','managed':True,'genreAllowed':True,
               'releaseDate':'2020-01-01','rootQualified':True,'criticsScore':80}
        value.update(changes);return value

    def test_raising_then_lowering_score_preserves_verified_rating(self):
        state={'items':{'movie:1':self.record()}}
        with patch.object(bulk_policy,'config',return_value={'minimum_critics_score':95}):
            self.assertEqual(bulk_policy.pending_items(state),[])
        with patch.object(bulk_policy,'config',return_value={'minimum_critics_score':75}):
            self.assertEqual(len(bulk_policy.pending_items(state)),1)

    def test_filters_never_admit_horror_or_unverified_scores(self):
        state={'items':{'horror':self.record(genreAllowed=False,criticsScore=100,isSequel=True),
                        'unverified':self.record(rootQualified=False,ratingVerified=False,criticsScore=100)}}
        with patch.object(bulk_policy,'config',return_value={'minimum_critics_score':0}):
            self.assertEqual(bulk_policy.pending_items(state),[])

    def test_movie_tv_and_sequel_switches_are_respected(self):
        state={'items':{'sequel':self.record(criticsScore=40,rootQualified=False,isSequel=True),
                        'tv':self.record(kind='tv',seasonOneExists=True)}}
        with patch.object(bulk_policy,'config',return_value={'include_sequels':False,'bulk_tv_enabled':False}):
            self.assertEqual(bulk_policy.pending_items(state),[])


if __name__=='__main__':unittest.main()
