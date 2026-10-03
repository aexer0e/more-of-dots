"""Regression checks for recovering unit IDs without guessing ambiguous layouts."""
import runpy
from pathlib import Path
import unittest

recover = runpy.run_path(str(Path(__file__).resolve().parents[1] / "scripts/recover-replay-deployments.py"))["recover_infantry"]


class DeploymentRecoveryTests(unittest.TestCase):
    def test_observed_motorised_slot_restores_classic_order(self):
        self.assertEqual(recover([[1, 1], [3, 3]], [[2, 2]], {1: (2, 2)}), [[1, 1], [2, 2], [3, 3]])

    def test_missing_retained_infantry_id_has_only_one_solution(self):
        self.assertEqual(recover([[1, 1], [3, 3]], [[2, 2]], {0: (1, 1), 1: (2, 2)}), [[1, 1], [2, 2], [3, 3]])

    def test_ambiguous_motorised_positions_are_not_guessed(self):
        self.assertIsNone(recover([[1, 1]], [[2, 2], [3, 3]], {0: (1, 1)}))

    def test_conflicting_relative_order_is_rejected(self):
        self.assertIsNone(recover([[1, 1], [3, 3]], [[2, 2]], {0: (3, 3)}))

    def test_unknown_position_cannot_create_a_unit(self):
        self.assertIsNone(recover([[1, 1]], [[2, 2]], {0: (99, 99)}))

    def test_experimental_selection_order_does_not_determine_classic_ids(self):
        self.assertEqual(recover([[1, 1], [4, 4]], [[3, 3], [2, 2]], {1: (2, 2), 2: (3, 3)}),
                         [[1, 1], [2, 2], [3, 3], [4, 4]])


if __name__ == "__main__":
    unittest.main()
