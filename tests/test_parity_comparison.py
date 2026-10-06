import gzip
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('strict_parity', Path(__file__).resolve().parents[1] / 'scripts/compare-parity-traces.py')
parity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(parity)


class FullTraceComparisonTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.actual = Path(self.temp.name) / 'actual.repsim'
        self.reference = Path(self.temp.name) / 'game.repsim.gz'

    @staticmethod
    def row(frame):
        return {'kind':'state', 'frame':frame, 'core':{'frame':frame, 'alive_dots':[0]},
                'dots':[{'id':0, 'position':[0,0], 'health':1}]}

    def write(self, rows, reference=None):
        self.actual.write_text(''.join(json.dumps(r)+'\n' for r in rows))
        with gzip.open(self.reference, 'wt') as stream:
            stream.write(''.join(json.dumps(r)+'\n' for r in (reference if reference is not None else [self.row(i) for i in range(3)])))

    def test_complete_compressed_reference_matches(self):
        self.write([self.row(i) for i in range(3)])
        self.assertTrue(parity.compare(self.actual,self.reference,2)['exact_full_state_parity'])

    def test_infinitesimal_position_change_fails(self):
        rows=[self.row(i) for i in range(3)]
        rows[1]['dots'][0]['position'][0]=1e-15
        self.write(rows)
        self.assertFalse(parity.compare(self.actual,self.reference,2)['passed'])

    def test_missing_tick_fails_even_when_both_traces_share_the_gap(self):
        rows=[self.row(0),self.row(2)]
        self.write(rows,rows)
        self.assertFalse(parity.compare(self.actual,self.reference,2)['passed'])

    def test_missing_tail_fails_even_when_both_traces_end_early(self):
        rows=[self.row(0),self.row(1)]
        self.write(rows,rows)
        self.assertFalse(parity.compare(self.actual,self.reference,2)['passed'])

    def test_empty_traces_fail(self):
        self.write([],[])
        self.assertFalse(parity.compare(self.actual,self.reference,2)['passed'])

    def test_recovered_orders_fail(self):
        rows=[self.row(i) for i in range(3)]
        rows[1]['compatibility']={'deferred_orders':1}
        self.write(rows)
        self.assertFalse(parity.compare(self.actual,self.reference,2)['passed'])

    def test_identity_and_economy_changes_fail(self):
        for field in ('alive_dots','economy'):
            rows=[self.row(i) for i in range(3)]
            rows[1]['core'][field]=[] if field=='alive_dots' else {'funds':[100,0]}
            self.write(rows)
            if field=='alive_dots':
                with self.assertRaises(ValueError):parity.compare(self.actual,self.reference,2)
            else:
                self.assertFalse(parity.compare(self.actual,self.reference,2)['passed'])

    def test_fast_comparison_preserves_numeric_and_boolean_rules(self):
        cases=[(1,1.0),(0,False),(True,1),(True,True),(None,None),
               (1e-15,0),(float('inf'),float('inf')),(float('nan'),float('nan')),
               ({'a':[1,False,None]},{'a':[1.0,False,None]}),
               ({'a':[1,False]},{'a':[1,0]}),([1],(1,))]
        for actual,reference in cases:
            with self.subTest(actual=actual,reference=reference):
                self.assertEqual(parity.equivalent(actual,reference),
                                 parity.difference(actual,reference) is None)

    def test_fast_comparison_matches_original_rules_for_generated_nested_values(self):
        import random
        rng=random.Random(4361)
        def value(depth=0):
            if depth<3 and rng.randrange(3)==0:
                return [value(depth+1) for _ in range(rng.randrange(5))]
            if depth<3 and rng.randrange(3)==0:
                return {str(i):value(depth+1) for i in range(rng.randrange(5))}
            return rng.choice([None,True,False,-1,0,1,1.0,.088901,1e-15,'tank',''])
        for _ in range(1000):
            actual=value();reference=actual if rng.randrange(2) else value()
            self.assertEqual(parity.equivalent(actual,reference),
                             parity.difference(actual,reference) is None)
