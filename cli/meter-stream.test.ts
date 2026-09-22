import {test,expect} from 'bun:test';
import {meterResponse,type MeterEvent,responseWindows} from './meter-stream.ts';
import {createClaudeHandler,configureClaudeSettings} from './meter-control.ts';
import {randomUUID} from 'node:crypto';
const initial=()=>({id:randomUUID(),subscription:'a'.repeat(64),at:Date.now(),windows:[]});
const sse=(events:any[])=>events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join('');
test('Codex chunks stream unchanged and only usage metadata is collected',async()=>{
  const raw=sse([{type:'response.output_text.delta',delta:'PRIVATE TEXT'},{type:'response.completed',response:{model:'model',usage:{input_tokens:120,input_tokens_details:{cached_tokens:80},output_tokens:30}}}]);
  const bytes=new TextEncoder().encode(raw);let i=0;let result:MeterEvent|undefined;
  const r=meterResponse(new Response(new ReadableStream({pull(c){if(i<bytes.length)c.enqueue(bytes.slice(i,i+=7));else c.close()}}),{headers:{'content-type':'text/event-stream'}}),'codex',initial(),e=>result=e);
  expect(await r.text()).toBe(raw);expect(result?.input).toBe(120);expect(result?.cached).toBe(80);expect(result?.output).toBe(30);expect(result?.complete).toBe(true);expect(JSON.stringify(result)).not.toContain('PRIVATE');
});
test('Claude cumulative usage is not double counted; cache categories preserved',async()=>{
  const raw=sse([{type:'message_start',message:{model:'claude-test',usage:{input_tokens:20,cache_read_input_tokens:100,cache_creation_input_tokens:40,output_tokens:1}}},{type:'message_delta',usage:{output_tokens:9}},{type:'message_delta',usage:{output_tokens:15}},{type:'message_stop'}]);
  let result:MeterEvent|undefined;const r=meterResponse(new Response(raw,{headers:{'content-type':'text/event-stream'}}),'claude',initial(),e=>result=e);expect(await r.text()).toBe(raw);expect(result?.input).toBe(20);expect(result?.cached).toBe(100);expect(result?.cacheWrite).toBe(40);expect(result?.output).toBe(15);expect(result?.complete).toBe(true);
});
test('cancellation records partial usage once and cancels upstream',async()=>{
  let canceled=false;const events:MeterEvent[]=[];
  const r=meterResponse(new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(sse([{type:'message_start',message:{usage:{input_tokens:50}}}])));},cancel(){canceled=true}}),{headers:{'content-type':'text/event-stream'}}),'claude',initial(),e=>events.push(e));
  const reader=r.body!.getReader();await reader.read();await reader.cancel();expect(canceled).toBe(true);expect(events.length).toBe(1);expect(events[0]?.complete).toBe(false);expect(events[0]?.input).toBe(50);
});
test('JSON responses, missing usage, errors and stale windows remain honest',async()=>{
  const out:MeterEvent[]=[];const emit=(e:MeterEvent)=>out.push(e);
  await meterResponse(Response.json({type:'message',model:'claude',usage:{input_tokens:20,output_tokens:10}}),'claude',initial(),emit).text();expect(out[0]?.complete).toBe(true);
  await meterResponse(new Response('rate limited',{status:429}),'codex',initial(),emit).text();expect(out[1]?.complete).toBe(false);expect(out[1]?.status).toBe(429);
  const reset=String(Math.floor(Date.now()/1000)+500);
  expect(responseWindows('claude',new Headers({'anthropic-ratelimit-unified-5h-reset':reset,'anthropic-ratelimit-unified-5h-utilization':'.8'}))[0]?.pct).toBe(80);
});
test('Claude proxy authenticates exact credentials, fixes upstream host, rejects browser and unrelated paths',async()=>{
  let calls=0,captures=0;
  const handler=createClaudeHandler({credentials:async()=>[{provider:'claude',profile:'one',accessToken:'secret'}],capture:async c=>{expect(c.profile).toBe('one');captures++;return r=>r},upstream:(async(url,init)=>{calls++;expect(String(url)).toBe('https://api.anthropic.com/v1/messages?beta=true');expect(new Headers(init!.headers).get('cookie')).toBeNull();return Response.json({type:'message',usage:{input_tokens:10,output_tokens:5}})})as typeof fetch});
  const request=(path:string,extra:any={})=>new Request('http://localhost:18790'+path,{method:'POST',headers:{authorization:'Bearer secret','content-type':'application/json',cookie:'do-not-forward',...extra},body:'{}'});
  expect((await handler(request('/v1/messages?beta=true'))).status).toBe(200);expect(captures).toBe(1);
  expect((await handler(request('/v1/messages',{authorization:'Bearer another'}))).status).toBe(401);
  expect((await handler(request('/v1/messages',{origin:'https://evil.example'}))).status).toBe(403);
  expect((await handler(request('/unrelated'))).status).toBe(404);expect(calls).toBe(1);
  expect(configureClaudeSettings({env:{KEEP:'yes'},hooks:{x:1}}).env.KEEP).toBe('yes');expect(()=>configureClaudeSettings({env:{ANTHROPIC_BASE_URL:'https://custom.example'}})).toThrow();
});
