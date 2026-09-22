import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {freshChatGPTIdentity} from './meter-login.ts';
test('personal ChatGPT login isolates auth files, returns identity only and cleans up',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'router-personal-test-'));const bin=join(dir,'fake-codex');
 try{
  writeFileSync(bin,`#!${process.execPath}\nimport{writeFileSync}from'node:fs';writeFileSync(process.env.TEST_REPORT,process.env.CODEX_HOME);writeFileSync(process.env.CODEX_HOME+'/auth.json',JSON.stringify({tokens:{id_token:'identity-only',access_token:'discard-access',refresh_token:'discard-refresh'}}));console.log('https://auth.openai.com/authorize?state=test');`,{mode:0o700});
  const urls:string[]=[];const result=await freshChatGPTIdentity(u=>urls.push(u),new AbortController().signal,{bin,env:{...process.env,TEST_REPORT:join(dir,'report')}as Record<string,string>});
  expect(result).toBe('identity-only');expect(urls).toEqual(['https://auth.openai.com/authorize?state=test']);
  const isolated=readFileSync(join(dir,'report'),'utf8');expect(isolated).toContain('router-personal-chatgpt-');expect(existsSync(isolated)).toBe(false);
 }finally{rmSync(dir,{recursive:true,force:true})}
});
