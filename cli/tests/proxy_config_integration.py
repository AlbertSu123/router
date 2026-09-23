"""Exercise real proxy commands in an isolated HOME; no credentials or launchd touched."""
import json, os, pathlib, shutil, subprocess, tempfile, unittest

REPO = pathlib.Path(__file__).resolve().parents[2]
BUN = shutil.which('bun')
TOKEN = 'a' * 64

class ProxyConfigTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='router-proxy-config-')
        self.root = pathlib.Path(self.tmp.name)
        self.state = self.root / '.router'; self.state.mkdir()
        self.codex = self.root / '.codex'; self.codex.mkdir()
        self.config = self.codex / 'config.toml'
        self.original = 'model_provider = "previous"\nmodel = "gpt-6-astra"\n[features]\nfoo = true\n'
        self.config.write_text(self.original)
        (self.state / 'codex-proxy.token').write_text(TOKEN)
        (self.state / 'codex-proxy.json').write_text('{"port":18789}')
        self.preload = self.root / 'preload.ts'
        self.preload.write_text('globalThis.fetch = (async () => Response.json({service:"router-codex-proxy", separateClientAuth:process.env.OLD_PROXY !== "1"})) as typeof fetch;')
        self.env = {**os.environ, 'HOME': str(self.root), 'CODEX_HOME': str(self.codex)}
    def run_cli(self, action, old=False):
        return subprocess.run([BUN, '--preload', str(self.preload), str(REPO/'cli/router.ts'), 'proxy', action],
                              env={**self.env, 'OLD_PROXY': '1' if old else '0'}, capture_output=True, text=True, timeout=10)
    def tearDown(self): self.tmp.cleanup()
    def test_enable_upgrade_repeat_and_disable_preserve_backup_and_unrelated_edits(self):
        self.assertEqual(self.run_cli('enable').returncode, 0)
        backup = self.state/'codex-config-before-proxy.toml'
        self.assertEqual(backup.read_text(), self.original)
        self.assertEqual(self.config.stat().st_mode & 0o777, 0o600)
        configured = self.config.read_text()
        self.assertIn('requires_openai_auth = true', configured)
        self.assertIn('"x-router-token" = "'+TOKEN+'"', configured)
        legacy = configured.replace('requires_openai_auth = true', 'requires_openai_auth = false')
        legacy = '\n'.join(line for line in legacy.split('\n') if not line.startswith('http_headers ='))
        legacy = legacy.replace('# router-proxy-provider: end', '[model_providers.router.auth]\ncommand = "/tmp/router"\nargs = ["proxy", "token"]\n# router-proxy-provider: end')
        legacy = legacy.replace('foo = true', 'foo = false')
        self.config.write_text(legacy)
        self.assertEqual(self.run_cli('enable').returncode, 0)
        upgraded = self.config.read_text()
        self.assertIn('foo = false', upgraded)
        self.assertNotIn('[model_providers.router.auth]', upgraded)
        self.assertIn('requires_openai_auth = true', upgraded)
        self.assertEqual(backup.read_text(), self.original)
        backups = list(self.state.glob('codex-config-before-auth-upgrade-*.toml'))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(), legacy)
        self.assertEqual(self.run_cli('enable').returncode, 0)
        self.assertEqual(self.config.read_text(), upgraded)
        self.assertEqual(len(list(self.state.glob('codex-config-before-auth-upgrade-*.toml'))), 1)
        self.assertEqual(self.run_cli('disable').returncode, 0)
        self.assertEqual(self.config.read_text(), self.original.replace('foo = true', 'foo = false'))
    def test_old_service_blocks_config_mutation(self):
        self.assertNotEqual(self.run_cli('enable', old=True).returncode, 0)
        self.assertEqual(self.config.read_text(), self.original)
        self.assertFalse((self.state/'codex-config-before-proxy.toml').exists())
    def test_terminal_launcher_scopes_provider_and_leaves_app_server_direct(self):
        binary=self.root/'codex-fixture'
        binary.write_text('#!/usr/bin/env python3\nimport json,sys\nprint("codex-fixture" if "--version" in sys.argv else json.dumps(sys.argv[1:]))\n')
        binary.chmod(0o700)
        def run(*args):
            p=subprocess.run([BUN,str(REPO/'cli/router.ts'),'codex',*args],env={**self.env,'ROUTER_CODEX_BIN':str(binary)},capture_output=True,text=True,timeout=10,check=True)
            return json.loads(p.stdout)
        self.assertEqual(run('resume','test-session'),['-c','model_provider="router"','resume','test-session'])
        self.assertEqual(run('app-server'),['app-server'])
        self.assertEqual(run('login'),['login'])
        self.assertEqual(self.config.read_text(),self.original)
    def test_doctor_detects_regression(self):
        self.assertEqual(self.run_cli('enable').returncode, 0)
        script = 'import {proxyDoctor} from '+json.dumps(str(REPO/'cli/proxy-control.ts'))+'; const result=[]; await proxyDoctor((ok,message)=>result.push({ok,message})); console.log(JSON.stringify(result));'
        def check():
            p=subprocess.run([BUN,'--preload',str(self.preload),'-e',script],env=self.env,capture_output=True,text=True,check=True)
            return json.loads(p.stdout)
        self.assertTrue(all(x['ok'] for x in check()))
        self.config.write_text(self.config.read_text().replace('requires_openai_auth = true','requires_openai_auth = false'))
        result=check(); self.assertFalse(result[1]['ok'])
        self.assertNotIn(TOKEN,json.dumps(result))

if __name__ == '__main__': unittest.main(verbosity=2)
