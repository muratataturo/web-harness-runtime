"""No Colab access: verify the pinned proxy cannot allocate or bridge a replacement."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('guard', ROOT/'infra/strata/proxy.py')
guard = importlib.util.module_from_spec(spec); spec.loader.exec_module(guard)

class ProxyGuardTests(unittest.TestCase):
    def test_missing_and_replaced_sessions_never_allocate_or_bridge(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'state.json';path.write_text(json.dumps({'session':'example-qwen','endpoint':'owned','sshKeyFile':'/not-a-real-key'}))
            for selected in ('missing','replacement','owned'):
                bridged=[]
                ssh=types.ModuleType('colab_cli.commands.ssh')
                ssh._resolve_session=lambda name:types.SimpleNamespace(endpoint=selected)
                ssh._auto_create_session=lambda *a,**k: self.fail('allocation called')
                ssh._run_proxy_bridge=lambda session,key,remove:bridged.append(session.endpoint)
                def cli_main():
                    if selected=='missing':ssh._auto_create_session(None,None)
                    else: ssh._run_proxy_bridge(ssh._resolve_session('example-qwen'),'/not-a-real-key',False)
                cli=types.ModuleType('colab_cli.cli');cli.main=cli_main
                commands=types.ModuleType('colab_cli.commands');commands.ssh=ssh
                modules={'colab_cli':types.ModuleType('colab_cli'),'colab_cli.commands':commands,'colab_cli.commands.ssh':ssh,'colab_cli.cli':cli}
                with patch.dict(sys.modules,modules),patch('importlib.metadata.version',return_value='0.7.5'),patch.object(sys,'argv',['proxy',str(path)]):
                    if selected=='owned':guard.main();self.assertEqual(bridged,['owned'])
                    else:
                        with self.assertRaises(SystemExit):guard.main()
                        self.assertEqual(bridged,[])

if __name__=='__main__':unittest.main()
