"""Isolated CLI integration checks; never reads or writes the real Keychain."""
import json, os, pathlib, shutil, subprocess, tempfile, time, unittest

REPO = pathlib.Path(__file__).resolve().parents[2]
BUN = shutil.which('bun')

class LoginTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='router-integration-')
        self.root = pathlib.Path(self.tmp.name)
        self.bin = self.root / 'bin'; self.bin.mkdir()
        self.procs = []
        self.state = self.root / '.router'; self.state.mkdir()
        self.live = self.root / 'live'; self.live.mkdir()
        self.original = '{"untouched":"existing login"}'
        (self.live / 'auth.json').write_text(self.original)
        self.write_executable('security', '''#!/usr/bin/python3
import os,sys,json,pathlib
p=pathlib.Path(os.environ['HOME'])/'fake-keychain.json'
d=json.loads(p.read_text()) if p.exists() else {}
a=sys.argv; key=a[a.index('-s')+1]+':'+a[a.index('-a')+1]
if a[1]=='find-generic-password':
 if key not in d: sys.exit(1)
 print(d[key])
elif a[1]=='add-generic-password':
 d[key]=a[a.index('-w')+1]; p.write_text(json.dumps(d))
''')
        self.codex = self.write_executable('codex-fixture', '''#!/usr/bin/python3
import sys,os,json,pathlib,base64,time
if '--version' in sys.argv: print('codex-fixture 1'); sys.exit()
home=pathlib.Path(os.environ['CODEX_HOME'])
(pathlib.Path(os.environ['HOME'])/'last-temp-home').write_text(str(home))
assert 'cli_auth_credentials_store="file"' in sys.argv
mode=os.environ.get('FIXTURE_MODE','success')
if '--device-auth' in sys.argv:
 print('\\x1b[94mhttps://auth.openai.com/codex/device\\x1b[0m\\nABCD-12345\\n',flush=True)
else:
 print('https://auth.openai.com/authorize?fixture=yes',file=sys.stderr,flush=True)
if mode=='wait': time.sleep(30)
if mode=='expire':
 print('device auth timed out after 15 minutes',file=sys.stderr);sys.exit(1)
if mode=='failure':
 print('device code login is not enabled',file=sys.stderr);sys.exit(1)
if mode=='malformed':
 (home/'auth.json').write_text('{}');sys.exit()
time.sleep(.05)
jwt='x.'+base64.urlsafe_b64encode(json.dumps({'email':'fixture@example.test'}).encode()).decode()+'.x'
(home/'auth.json').write_text(json.dumps({'tokens':{'id_token':jwt,'access_token':'fake','refresh_token':'fake','account_id':'fixture-id'}}))
''')
        self.env = {**os.environ, 'HOME':str(self.root),'CODEX_HOME':str(self.live),
                    'ROUTER_CODEX_BIN':str(self.codex),'PATH':str(self.bin)+':'+os.environ['PATH']}
    def write_executable(self,name,content):
        p=self.bin/name;p.write_text(content);p.chmod(0o700);return p
    def command(self,*args,mode='success',preload=None):
        cmd=[BUN]
        if preload:cmd+=['--preload',str(preload)]
        return subprocess.Popen(cmd+[str(REPO/'cli/router.ts'),*args],env={**self.env,'FIXTURE_MODE':mode},stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    def run_login(self,device=True,mode='success'):
        p=self.command('auth','codex','login',*(['--device-auth'] if device else []),mode=mode)
        self.procs.append(p);out,err=p.communicate(timeout=10)
        return p.returncode,[json.loads(line) for line in out.splitlines()]
    def start_waiting(self,session,replace=False,preload=None):
        p=self.command('auth','codex','login','--device-auth','--session='+session,*(['--replace'] if replace else []),mode='wait',preload=preload)
        self.procs.append(p)
        for _ in range(200):
            try:
                v=json.loads((self.state/'codex-login-status.json').read_text())
                if v['session']==session:return p
            except (FileNotFoundError,json.JSONDecodeError):pass
            if p.poll() is not None:raise AssertionError('login ended before challenge')
            time.sleep(.02)
        self.fail('no challenge')
    def cancel(self,session=None):
        p=self.command('auth','codex','cancel',*(['--session='+session] if session else []))
        p.communicate(timeout=5);self.assertEqual(p.returncode,0)
    def assert_clean(self):
        for name in ['codex-login.pid','codex-login-status.json','codex-login-session']:
            self.assertFalse((self.state/name).exists(),name)
        temp=self.root/'last-temp-home'
        if temp.exists():self.assertFalse(pathlib.Path(temp.read_text()).exists())
        self.assertEqual((self.live/'auth.json').read_text(),self.original)
    def test_remote_success_and_readd(self):
        for _ in range(2):
            rc,events=self.run_login();self.assertEqual(rc,0);self.assertEqual(events[-1]['name'],'fixture')
            self.assertEqual(events[1]['code'],'ABCD-12345');self.assert_clean()
        self.assertEqual(len(json.loads((self.state/'codex-profiles.json').read_text())['profiles']),1)
        self.assertIn('router-codex:fixture',json.loads((self.root/'fake-keychain.json').read_text()))
    def test_local_browser_success(self):
        rc,events=self.run_login(device=False);self.assertEqual(rc,0)
        self.assertIn('authorize',events[0]['url']);self.assertEqual(events[-1]['name'],'fixture');self.assert_clean()
    def test_proxy_selection_survives_legacy_client_auth_writes(self):
        import base64
        def auth(name,stamp):
            jwt='x.'+base64.urlsafe_b64encode(json.dumps({'email':name+'@example.test'}).encode()).decode()+'.x'
            return {'tokens':{'id_token':jwt,'access_token':'fake-'+name,'refresh_token':'fake-'+name,'account_id':name},'last_refresh':stamp}
        a=auth('a','2026-01-01T00:00:00Z');b=auth('b','2026-02-01T00:00:00Z')
        (self.state/'codex-profiles.json').write_text(json.dumps({'profiles':{'a':{'accountId':'a'},'b':{'accountId':'b'}}}))
        (self.root/'fake-keychain.json').write_text(json.dumps({'router-codex:a':json.dumps(a),'router-codex:b':json.dumps(b)}))
        (self.state/'codex-current').write_text('a\n')
        (self.state/'codex-proxy-selection').write_text('a\n')
        (self.live/'auth.json').write_text(json.dumps(a))
        p=self.command('use','codex:b');p.communicate(timeout=5);self.assertEqual(p.returncode,0)
        self.assertEqual((self.state/'codex-proxy-selection').read_text().strip(),'b')
        self.assertEqual(json.loads((self.live/'auth.json').read_text()),a) # desktop identity stays put
        (self.live/'auth.json').write_text(json.dumps(a))
        p=self.command('list','--json');p.communicate(timeout=5);self.assertEqual(p.returncode,0)
        self.assertEqual((self.state/'codex-current').read_text().strip(),'b')
        # Selecting b again must use the freshest stored credential, not the
        # stale file a legacy client wrote before Router's refresh.
        stale=auth('b','2026-01-01T00:00:00Z');stale['tokens']['refresh_token']='stale'
        (self.live/'auth.json').write_text(json.dumps(stale))
        p=self.command('use','codex:b');p.communicate(timeout=5);self.assertEqual(p.returncode,0)
        self.assertEqual(json.loads((self.live/'auth.json').read_text())['tokens']['refresh_token'],'stale') # routed switches never rewrite desktop auth
        (self.state/'codex-proxy-selection').unlink()
        p=self.command('use','codex:b');p.communicate(timeout=5);self.assertEqual(p.returncode,0)
        self.assertEqual(json.loads((self.live/'auth.json').read_text())['tokens']['refresh_token'],'fake-b') # direct mode still swaps credentials
    def test_failure_expiry_and_bad_credentials(self):
        for mode in ['failure','expire','malformed']:
            with self.subTest(mode=mode):
                rc,events=self.run_login(mode=mode);self.assertNotEqual(rc,0)
                self.assertIn('error',events[-1]);self.assert_clean()
                self.assertFalse((self.state/'codex-profiles.json').exists())
    def test_cancel_and_retry(self):
        p=self.start_waiting('first');self.cancel('first');p.communicate(timeout=5);self.assert_clean()
        self.assertEqual(self.run_login()[0],0);self.assert_clean()
    def test_replace_and_stale_window_cancellation(self):
        first=self.start_waiting('old');second=self.start_waiting('new',replace=True)
        first.communicate(timeout=5)
        self.cancel('old');self.assertIsNone(second.poll())
        self.assertEqual(json.loads((self.state/'codex-login-status.json').read_text())['session'],'new')
        self.assertEqual((self.state/'codex-login-status.json').stat().st_mode & 0o777,0o600)
        self.cancel('new');second.communicate(timeout=5);self.assert_clean()
    def test_without_replace_preserves_pending_login(self):
        p=self.start_waiting('first');rc,events=self.run_login()
        self.assertNotEqual(rc,0);self.assertIn('already running',events[-1]['error'])
        self.assertIsNone(p.poll());self.cancel();p.communicate(timeout=5);self.assert_clean()
    def test_stale_pid_replaced(self):
        (self.state/'codex-login.pid').write_text('99999999\n')
        p=self.start_waiting('replacement',replace=True);self.cancel();p.communicate(timeout=5);self.assert_clean()
    def test_watchdog_cleanup(self):
        preload=self.root/'clock.ts'
        preload.write_text('const real = globalThis.setTimeout; globalThis.setTimeout = ((fn, ms, ...args) => real(fn, ms === 16 * 60 * 1000 ? 500 : ms, ...args)) as typeof setTimeout;')
        p=self.start_waiting('timeout',preload=preload);out,err=p.communicate(timeout=5)
        self.assertNotEqual(p.returncode,0);self.assertIn('error',json.loads(out.splitlines()[-1]));self.assert_clean()
    def tearDown(self):
        self.cancel()
        for p in self.procs:
            try:p.communicate(timeout=3)
            except subprocess.TimeoutExpired:p.kill();p.communicate()
        self.tmp.cleanup()

if __name__=='__main__':unittest.main(verbosity=2)
