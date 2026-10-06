import importlib.util
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location('parity_audit',Path(__file__).resolve().parents[1]/'scripts/audit-parity-completion.py')
audit=importlib.util.module_from_spec(spec);spec.loader.exec_module(audit)


class NativeVersionProvenanceTests(unittest.TestCase):
    def test_present_native_label_must_match(self):
        self.assertTrue(audit.native_version_matches({'native_version':'1.4.1'},{},'1.4.1','binary'))
        self.assertFalse(audit.native_version_matches({'native_version':'1.3.4'},{},'1.4.1','binary'))

    def test_missing_label_requires_exact_binary_and_verified_absent_export(self):
        metadata={'native_version':None,'binary_sha256':'binary'}
        inspection={'ok':True,'binary_sha256':'binary','main_names':['ReplayManager','VERSION']}
        self.assertTrue(audit.native_version_matches(metadata,inspection,'1.4.1','binary'))
        for changed in ({'ok':False},{'binary_sha256':'other'},{'main_names':['version']},{'main_names':None}):
            candidate=inspection|changed
            if candidate.get('main_names') is None:candidate.pop('main_names')
            self.assertFalse(audit.native_version_matches(metadata,candidate,'1.4.1','binary'))
        self.assertFalse(audit.native_version_matches(metadata,{},'1.4.1','binary'))
        self.assertFalse(audit.native_version_matches(metadata|{'binary_sha256':'other'},inspection,'1.4.1','binary'))


if __name__=='__main__':unittest.main()
