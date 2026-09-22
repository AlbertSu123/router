import {test,expect,afterEach} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createService} from './server.ts';
import {pressureWeight,validEvent} from './core.ts';
const cleanup:(()=>void)[]=[];afterEach(()=>cleanup.splice(0).forEach(f=>f()));
function service(){
  const dir=mkdtempSync(join(tmpdir(),'router-meter-test-'));
  const app=createService({path:join(dir,'test.sqlite'),origin:'https://test.example',identity:async(token,provider)=>{if(!token.startsWith('identity:'))throw new Error('Invalid');const handle=token.slice(9);return {provider,subject:handle,email:handle+'@example.com',emailVerified:true,name:handle}},verify:async b=>b.accessToken==='valid'?{id:b.accountId,label:`Account ${b.accountId}`,windows:[{key:'primary_window',reset:Math.floor(Date.now()/1000)+3600,pct:20}]}:null});
  cleanup.push(()=>{app.db.close();rmSync(dir,{recursive:true,force:true})});
  const request=async(path:string,body?:any,token?:string,cookie?:string)=>{
    const r=await app.fetch(new Request('https://test.example'+path,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'content-type':'application/json'}),...(token?{authorization:`Bearer ${token}`} : {}),...(cookie?{cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)}));
    return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};
  };
  const user=async(handle:string)=>{
    const start=await request('/device/start',{});
    expect((await request('/device/poll',{secret:start.data.secret})).data.pending).toBe(true);
    expect((await request('/auth/chatgpt',{deviceSecret:start.data.secret,idToken:'identity:'+handle})).status).toBe(200);
    const poll=await request('/device/poll',{secret:start.data.secret});
    expect((await request('/device/poll',{secret:start.data.secret})).status).toBe(410);
    const ticket=await request('/dashboard-ticket',{},poll.data.token);
    const browser=await app.fetch(new Request(ticket.data.url));
    return {token:poll.data.token,cookie:browser.headers.get('set-cookie')?.split(';')[0],user:poll.data.user};
  };
  const proof=(token:string,id:string)=>request('/subscriptions/verify',{provider:'codex',accessToken:'valid',accountId:id},token);
  return {app,request,user,proof};
}
const event=(id:string,reset=Math.floor(Date.now()/1000)+3600,pct=20)=>({id:randomUUID(),subscription:id,at:Date.now(),model:'test-model',input:100,cached:20,cacheWrite:0,output:100,status:200,complete:true,windows:[{key:'primary_window',reset,pct}]});
test('social sign-in, device pairing, single-use tickets and origin protection',async()=>{
  const {app,request,user}=service();const a=await user('alice');
  expect((await request('/auth/login',{handle:'alice',password:'incorrect-password'})).status).toBe(410);
  expect((await request('/auth/register',{handle:'alice',password:'test-password-long-enough'})).status).toBe(410);
  expect((await request('/me',undefined,a.token)).data.name).toBe('alice');
  const cross=await app.fetch(new Request('https://test.example/device/approve',{method:'POST',headers:{origin:'https://evil.example','content-type':'application/json',cookie:a.cookie!},body:'{}'}));expect(cross.status).toBe(403);
  const ticket=await request('/dashboard-ticket',{},a.token);const r=await app.fetch(new Request(ticket.data.url));expect(r.status).toBe(303);expect((await app.fetch(new Request(ticket.data.url))).status).toBe(401);
});
test('subscription isolation, shared visibility, dedupe, revocation and expiry',async()=>{
  const {app,request,user,proof}=service();const a=await user('alice'),b=await user('bob'),c=await user('carol');
  const one=(await proof(a.token,'one')).data;const two=(await proof(b.token,'two')).data;
  const e=event(one.id);
  expect((await request('/events',{events:[e]},a.token)).status).toBe(200);
  expect((await request('/events',{events:[e]},a.token)).status).toBe(200);
  expect((await request('/events',{events:[event(one.id)]},b.token)).status).toBe(403);
  expect((await request('/usage?subscription='+one.id,undefined,b.token)).status).toBe(403);
  let u=(await request('/usage',undefined,b.token)).data;expect(u.subscriptions.map((s:any)=>s.id)).toEqual([two.id]);expect(JSON.stringify(u)).not.toContain('alice');
  expect((await request('/subscriptions/verify',{provider:'codex',accessToken:'invalid',accountId:'one'},b.token)).status).toBe(403);
  await proof(c.token,'one');u=(await request('/usage',undefined,c.token)).data;expect(u.subscriptions[0].people[0].name).toBe('alice');expect(u.subscriptions[0].people[0].requests).toBe(1);
  await request('/subscriptions/retain',{ids:[]},c.token);expect((await request('/usage',undefined,c.token)).data.subscriptions).toEqual([]);
  app.db.run('UPDATE grants SET expires=0');expect((await request('/usage',undefined,a.token)).data.subscriptions).toEqual([]);
});
test('weighting retroactively includes later saturation in the same window, never unrelated windows',async()=>{
  const {request,user,proof}=service();const a=await user('alice'),b=await user('bob');const sub=(await proof(a.token,'shared')).data;await proof(b.token,'shared');
  const reset=sub.windows[0].reset;await request('/events',{events:[event(sub.id,reset,10)]},a.token);
  let people=(await request('/usage',undefined,a.token)).data.subscriptions[0].people;expect(people[0].weighted).toBeCloseTo(50);
  await request('/events',{events:[event(sub.id,reset,100)]},b.token);
  people=(await request('/usage',undefined,a.token)).data.subscriptions[0].people;expect(people.every((p:any)=>p.weighted===200)).toBe(true);
  const unknown={...event(sub.id),windows:[]};await request('/events',{events:[unknown]},a.token);
  people=(await request('/usage',undefined,a.token)).data.subscriptions[0].people;expect(people.find((p:any)=>p.name==='alice').unweighted).toBe(200);
  expect(pressureWeight(100,false)).toBe(.25);
  expect(pressureWeight(null)).toBeNull();expect(pressureWeight(0)).toBe(.25);expect(pressureWeight(100)).toBe(1);
});
test('invalid or unauthorized batches do not partially insert; sign-out revokes device visibility',async()=>{
  const {request,user,proof}=service();const a=await user('alice');const sub=(await proof(a.token,'one')).data;
  expect((await request('/events',{events:[event(sub.id),{...event(sub.id),input:-1}]},a.token)).status).toBe(400);
  expect((await request('/usage',undefined,a.token)).data.subscriptions[0].people).toEqual([]);
  expect(validEvent({...event(sub.id),cached:200})).toBe(false);
  expect((await request('/auth/logout',{},a.token)).status).toBe(200);
  expect((await request('/usage',undefined,a.token)).status).toBe(401);
  expect((await request('/usage',undefined,undefined,a.cookie)).data.subscriptions).toEqual([]);
});
test('solo saturation stays discounted; competing demand affects only matching reset windows',async()=>{
  const {request,user,proof}=service();const a=await user('alice'),b=await user('bob'),c=await user('carol');
  const sub=(await proof(a.token,'shared')).data;await proof(b.token,'shared');await proof(c.token,'shared');
  const reset=sub.windows[0].reset;
  await request('/events',{events:[event(sub.id,reset,100)]},a.token);
  await request('/events',{events:[event(sub.id,reset+3600,100)]},b.token);
  let people=(await request('/usage',undefined,a.token)).data.subscriptions[0].people;
  expect(people.every((p:any)=>p.weighted===50)).toBe(true);
  const blocked={...event(sub.id,reset,100),input:0,cached:0,output:0,status:429,complete:false};
  await request('/events',{events:[blocked]},c.token);
  people=(await request('/usage',undefined,a.token)).data.subscriptions[0].people;
  expect(people.find((p:any)=>p.name==='alice').weighted).toBe(200);
  expect(people.find((p:any)=>p.name==='bob').weighted).toBe(50);
  expect(people.find((p:any)=>p.name==='carol').limited).toBe(1);
});
