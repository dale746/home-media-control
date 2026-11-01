"""Standalone startup must find the installed configuration in any AppData context."""
import ast
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE=pathlib.Path(__file__).resolve().parent


class WorkerBootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=pathlib.Path(self.temp.name)
        tree=ast.parse((HERE/'worker.py').read_text())
        assignment=next(node for node in tree.body if isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='ROOT' for t in node.targets))
        self.assignment=compile(ast.Module(body=[assignment],type_ignores=[]),'worker.py','exec')

    def discover(self,environment,installed=False):
        adjacent=self.root/'installed';adjacent.mkdir(exist_ok=True)
        if installed:(adjacent/'settings.json').write_text('{}')
        namespace={'__file__':str(adjacent/'worker.py'),'pathlib':pathlib,'os':os}
        with patch.dict(os.environ,environment,clear=True):exec(self.assignment,namespace)
        return namespace['ROOT'],adjacent

    def test_explicit_override_wins_over_adjacent_install(self):
        wanted=self.root/'explicit'
        found,_=self.discover({'HMC_MEDIA_RUNTIME':str(wanted)},installed=True)
        self.assertEqual(found,wanted)

    def test_standalone_install_does_not_depend_on_localappdata(self):
        for environment in ({},{'LOCALAPPDATA':str(self.root/'wrong-context')},{'HMC_MEDIA_RUNTIME':''}):
            with self.subTest(environment=environment):
                found,adjacent=self.discover(environment,installed=True)
                self.assertEqual(found,adjacent)

    def test_source_checkout_preserves_localappdata_default(self):
        wanted=self.root/'legacy-context'
        found,_=self.discover({'LOCALAPPDATA':str(wanted)})
        self.assertEqual(found,wanted/'HomeMediaControl')

    def test_full_standalone_import_reads_only_adjacent_configuration(self):
        installed=self.root/'physical-runtime';installed.mkdir()
        for name in ('worker.py','windows_paths.py'):shutil.copyfile(HERE/name,installed/name)
        (installed/'settings.json').write_text(json.dumps({'bootstrapMarker':'adjacent-runtime'}))
        environment=os.environ.copy();environment.pop('HMC_MEDIA_RUNTIME',None)
        environment['LOCALAPPDATA']=str(self.root/'nonexistent-localappdata')
        program="""import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('isolated_worker',sys.argv[1]);worker=importlib.util.module_from_spec(spec);spec.loader.exec_module(worker)
print(json.dumps({'root':str(worker.ROOT),'marker':worker.CONFIG['bootstrapMarker'],'state':str(worker.STATE_FILE)}))
"""
        result=subprocess.run([sys.executable,'-c',program,str(installed/'worker.py')],env=environment,cwd=installed,capture_output=True,text=True,timeout=10,check=True)
        value=json.loads(result.stdout)
        self.assertEqual(pathlib.Path(value['root']),installed)
        self.assertEqual(value['marker'],'adjacent-runtime')
        self.assertEqual(pathlib.Path(value['state']),installed/'status.json')
        self.assertFalse((self.root/'nonexistent-localappdata').exists())


if __name__=='__main__':unittest.main()
