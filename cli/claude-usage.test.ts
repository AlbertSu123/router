import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,readdirSync,writeFileSync,utimesSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pollClaudeUsage} from './claude-usage.ts';

const valid=(body:any)=>Array.isArray(body?.limits);
const payload=(percent=12)=>({limits:[{kind:'session',percent}]});
function setup(){const directory=mkdtempSync(join(tmpdir(),'usage-poll-test-'));let clock=Date.now();return {directory,now:()=>clock,advance:(ms:number)=>clock+=ms,clean:()=>rmSync(directory,{recursive:true,force:true})}}
test('manual and automatic callers share success and respect a zero Retry-After rate limit',async()=>{
  const s=setup();let calls=0,limited=false;
  const options={...s,profile:'main',valid,request:async()=>{calls++;return limited?new Response(null,{status:429,headers:{'retry-after':'0'}}):Response.json(payload())}};
  try{
    expect((await pollClaudeUsage(options)).stale).toBe(false);
    limited=true;
    for(let i=0;i<5;i++)expect((await pollClaudeUsage(options)).body).toEqual(payload());
    expect(calls).toBe(1);s.advance(121_000);
    const first=await pollClaudeUsage(options);expect(first.stale).toBe(true);expect(first.error).toContain('limited');expect(first.retryAt!*1000-s.now()).toBe(120_000);
    const observed=first.observedAt;
    for(let i=0;i<10;i++)await pollClaudeUsage(options);
    expect(calls).toBe(2);s.advance(120_001);
    const second=await pollClaudeUsage(options);expect(second.retryAt!*1000-s.now()).toBe(240_000);expect(second.observedAt).toBe(observed);
    s.advance(240_001);limited=false;
    const recovered=await pollClaudeUsage(options);expect(recovered.stale).toBe(false);expect(recovered.error).toBeUndefined();expect(calls).toBe(4);
  }finally{s.clean()}
});
test('Retry-After dates and long provider delays are honored across callers without cached data',async()=>{
  for(const date of [false,true]){
    const s=setup();let calls=0;
    const retry=date?new Date(s.now()+3600_000).toUTCString():'3600';
    try{
      const options={...s,profile:'main',valid,request:async()=>{calls++;return new Response(null,{status:429,headers:{'retry-after':retry}})}};
      const reading=await pollClaudeUsage(options);expect(reading.body).toBeUndefined();expect(reading.retryAt!*1000-s.now()).toBeGreaterThan(3599_000);
      s.advance(900_001);await pollClaudeUsage(options);expect(calls).toBe(1);
    }finally{s.clean()}
  }
});
test('concurrent refreshes coalesce while separate accounts remain isolated',async()=>{
  const s=setup();let release!:()=>void;let calls=0;
  const gate=new Promise<void>(r=>release=r);
  const options={...s,profile:'main',valid,request:async()=>{calls++;await gate;return Response.json(payload(42))}};
  try{
    const pending=pollClaudeUsage(options);await Promise.resolve();
    const duplicate=await pollClaudeUsage(options);expect(duplicate.body).toBeUndefined();expect(calls).toBe(1);
    const other=await pollClaudeUsage({...options,profile:'other',request:async()=>Response.json(payload(5))});expect(other.body).toEqual(payload(5));
    release();await pending;expect((await pollClaudeUsage(options)).body).toEqual(payload(42));expect(calls).toBe(1);
    expect(readdirSync(s.directory).some(p=>p.endsWith('.lock'))).toBe(false);
  }finally{release();s.clean()}
});
test('network or invalid response failures preserve readings and do not claim freshness',async()=>{
  for(const invalid of [false,true]){
    const s=setup();const cache=join(s.directory,'usage-limits-main.json');writeFileSync(cache,JSON.stringify(payload(21)));utimesSync(cache,new Date(s.now()-180_000),new Date(s.now()-180_000));
    try{
      let calls=0;const options={...s,profile:'main',valid,request:async()=>{calls++;if(invalid)return Response.json({unexpected:'value'});throw new Error('private bearer value')}};
      const reading=await pollClaudeUsage(options);expect(reading.body).toEqual(payload(21));expect(reading.stale).toBe(true);expect(reading.error).toBe('Claude usage refresh unavailable');
      await pollClaudeUsage(options);expect(calls).toBe(1);
      expect(readdirSync(s.directory).map(p=>readFileSync(join(s.directory,p),'utf8')).join('')).not.toContain('private bearer');
    }finally{s.clean()}
  }
});
