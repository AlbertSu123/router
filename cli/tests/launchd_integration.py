"""Model launchd's delayed bootout using a fake executable, never the user's services."""
import json, os, pathlib, shutil, subprocess, tempfile, unittest
REPO = pathlib.Path(__file__).resolve().parents[2]

class LaunchdTests(unittest.TestCase):
    def test_bootstrap_waits_until_old_job_is_gone(self):
        with tempfile.TemporaryDirectory(prefix='router-launchd-') as tmp:
            root=pathlib.Path(tmp)
            launchctl=root/'launchctl'
            launchctl.write_text('''#!/usr/bin/env python3
import os,sys,json,pathlib
root=pathlib.Path(os.environ['FIXTURE_ROOT']); state=root/'state.json'
s=json.loads(state.read_text()) if state.exists() else {'polls':0,'calls':[]}
cmd=sys.argv[1];s['calls'].append(cmd);rc=0
if cmd=='print':
 s['polls']+=1;rc=0 if s['polls']<3 else 1
if cmd=='bootstrap' and s['polls']<3:rc=5
state.write_text(json.dumps(s));sys.exit(rc)
''');launchctl.chmod(0o700)
            script='import {reloadLaunchAgent} from '+json.dumps(str(REPO/'cli/common.ts'))+'; if(!await reloadLaunchAgent("fixture", "/fixture.plist")) process.exit(1);'
            p=subprocess.run([shutil.which('bun'),'-e',script],env={**os.environ,'PATH':tmp+':'+os.environ['PATH'],'FIXTURE_ROOT':tmp},capture_output=True,text=True,timeout=10)
            self.assertEqual(p.returncode,0,p.stderr)
            self.assertEqual(json.loads((root/'state.json').read_text())['calls'],['bootout','print','print','print','bootstrap'])

if __name__=='__main__':unittest.main(verbosity=2)
