"""Cross-context runtime discovery without importing live configuration/tasks."""
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


def assignment_prefix(path,stop):
    tree=ast.parse(path.read_text(encoding='utf-8'))
    statements=[]
    for node in tree.body:
        if stop(node):break
        statements.append(node)
    return compile(ast.Module(body=statements,type_ignores=[]),str(path),'exec')


class RuntimeBootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=pathlib.Path(self.temp.name).resolve()
        self.server_prefix=assignment_prefix(HERE/'server.py',lambda n:isinstance(n,ast.Import) and any(a.name=='worker' for a in n.names))
        worker_path=HERE.parent/'pc-downloads/worker.py'
        worker_tree=ast.parse(worker_path.read_text())
        root_assignment=next(n for n in worker_tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='ROOT' for t in n.targets))
        self.worker_root=compile(ast.Module(body=[root_assignment],type_ignores=[]),str(worker_path),'exec')

    def bootstrap(self,files=()):
        installed=self.root/'physical-runtime';dashboard=installed/'status-dashboard';dashboard.mkdir(parents=True)
        for name in files:(installed/name).write_text('{}')
        namespace={'__file__':str(dashboard/'server.py')}
        with patch.dict(os.environ,{},clear=False),patch('pathlib.Path.home',return_value=self.root/'ordinary-user-home'):
            original_sys_path=list(__import__('sys').path)
            try:
                exec(self.server_prefix,namespace)
                environment=os.environ['HMC_MEDIA_RUNTIME']
            finally:__import__('sys').path[:]=original_sys_path
        return namespace,environment,installed

    def test_installed_dashboard_prefers_its_actual_adjacent_runtime(self):
        namespace,environment,installed=self.bootstrap(['worker.py','settings.json'])
        self.assertEqual(namespace['ROOT'],installed)
        self.assertEqual(environment,str(installed))

    def test_source_checkout_keeps_legacy_runtime_when_adjacent_install_is_absent(self):
        namespace,environment,_=self.bootstrap()
        wanted=self.root/'ordinary-user-home/AppData/Local/HomeMediaControl'
        self.assertEqual(namespace['ROOT'],wanted);self.assertEqual(environment,str(wanted))

    def test_partial_adjacent_folder_is_not_mistaken_for_installed_runtime(self):
        namespace,_,installed=self.bootstrap(['worker.py'])
        self.assertNotEqual(namespace['ROOT'],installed)

    def test_worker_honors_physical_runtime_override_without_using_localappdata(self):
        wanted=self.root/'physical-runtime'
        with patch.dict(os.environ,{'HMC_MEDIA_RUNTIME':str(wanted)},clear=True):
            namespace={'__file__':str(self.root/'source/worker.py'),'pathlib':pathlib,'os':os};exec(self.worker_root,namespace)
        self.assertEqual(namespace['ROOT'],wanted)

    def test_worker_default_and_empty_override_keep_previous_localappdata_behavior(self):
        wanted=self.root/'logical-local'
        for override in ({},{'HMC_MEDIA_RUNTIME':''}):
            with self.subTest(override=override),patch.dict(os.environ,{'LOCALAPPDATA':str(wanted),**override},clear=True):
                namespace={'__file__':str(self.root/'source/worker.py'),'pathlib':pathlib,'os':os};exec(self.worker_root,namespace)
                self.assertEqual(namespace['ROOT'],wanted/'HomeMediaControl')

    def test_dashboard_propagates_selected_runtime_to_worker_before_import(self):
        namespace,environment,installed=self.bootstrap(['worker.py','settings.json'])
        with patch.dict(os.environ,{'HMC_MEDIA_RUNTIME':environment,'LOCALAPPDATA':str(self.root/'wrong-context')},clear=True):
            worker={'__file__':str(installed/'worker.py'),'pathlib':pathlib,'os':os};exec(self.worker_root,worker)
        self.assertEqual(worker['ROOT'],installed)

    def test_complete_isolated_install_imports_with_unusable_logical_appdata(self):
        installed=self.root/'physical-install';dashboard=installed/'status-dashboard';dashboard.mkdir(parents=True)
        for name in ('server.py','actions.py','server_power.py','progress_model.py'):
            shutil.copyfile(HERE/name,dashboard/name)
        for name in ('worker.py','windows_paths.py','pc_cleanup.py','control_state.py'):
            shutil.copyfile(HERE.parent/'pc-downloads'/name,installed/name)
        (installed/'settings.json').write_text('{}')
        (installed/'manual-controls.json').write_text('{"copyPaused":true}')
        environment=os.environ.copy();environment.pop('HMC_MEDIA_RUNTIME',None)
        environment['LOCALAPPDATA']=str(self.root/'nonexistent-logical-appdata')
        script="""import importlib.util,json,pathlib,sys
pathlib.Path.home=classmethod(lambda cls:pathlib.Path(sys.argv[2]))
sys.path.insert(0,str(pathlib.Path(sys.argv[1]).parent))
spec=importlib.util.spec_from_file_location('isolated_server',sys.argv[1]);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
print(json.dumps({'server':str(module.ROOT),'worker':str(module.worker.ROOT),'actions':str(module.actions.ROOT),'power':str(module.server_power.ROOT),'copyPaused':module.control_state.read(module.ROOT)['copyPaused']}))
"""
        result=subprocess.run([sys.executable,'-c',script,str(dashboard/'server.py'),str(self.root/'nonexistent-home')],env=environment,capture_output=True,text=True,timeout=15,check=True)
        value=json.loads(result.stdout)
        for key in ('server','worker','actions','power'):self.assertEqual(pathlib.Path(value[key]),installed)
        self.assertTrue(value['copyPaused'])


if __name__=='__main__':unittest.main()
