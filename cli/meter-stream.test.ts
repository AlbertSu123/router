import {test,expect} from 'bun:test';
import {meterResponse,type MeterEvent,responseWindows} from './meter-stream.ts';
import {createClaudeHandler,configureClaudeSettings} from './meter-control.ts';
import {randomUUID} from 'node:crypto';
import {createProxyHandler} from './codex-proxy.ts';
const initial=()=>({id:randomUUID(),subscription:'a'.repeat(64),at:Date.now(),windows:[]});
const sse=(events:any[])=>events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join('');
test('request abort preserves partial usage exactly once and leaves completed usage untouched',async()=>{
  const controller=new AbortController();const events:MeterEvent[]=[];let canceled=false;
  const response=meterResponse(new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(sse([{type:'message_start',message:{usage:{input_tokens:50,output_tokens:3}}}])))} ,cancel(){canceled=true}}),{headers:{'content-type':'text/event-stream'}}),'claude',initial(),e=>events.push(e),controller.signal);
  const reader=response.body!.getReader();await reader.read();controller.abort();await reader.cancel();
  expect(events).toHaveLength(1);expect(events[0]).toMatchObject({input:50,output:3,status:499,complete:false});expect(canceled).toBe(true);
  const completed=new AbortController();const success:MeterEvent[]=[];
  await meterResponse(Response.json({type:'message',usage:{input_tokens:10,output_tokens:2}}),'claude',initial(),e=>success.push(e),completed.signal).text();
  completed.abort();expect(success).toHaveLength(1);expect(success[0]).toMatchObject({status:200,complete:true,input:10,output:2});
});
test('both proxy handlers pass request cancellation to accounting before upstream headers',async()=>{
  for(const provider of ['claude','codex']){
    const controller=new AbortController();let captured:AbortSignal|undefined;let canceled=false;
    const capture=async(_credential:unknown,signal?:AbortSignal)=>{captured=signal;signal?.addEventListener('abort',()=>{canceled=true});return (r:Response)=>r};
    const upstream=(async()=>{controller.abort();throw new Error('canceled')}) as typeof fetch;
    const handler=provider==='claude'?createClaudeHandler({credentials:async()=>[{provider:'claude',profile:'one',accessToken:'secret'}],capture,upstream}):createProxyHandler({token:'secret',credential:async()=>({name:'one',accessToken:'secret',accountId:'a'}),meter:capture,upstream});
    const request=new Request('http://localhost/v1/'+(provider==='claude'?'messages':'responses'),{method:'POST',headers:{authorization:'Bearer secret'},body:'{}',signal:controller.signal});
    expect((await handler(request)).status).toBe(499);expect(captured).toBe(request.signal);expect(canceled).toBe(true);
  }
});
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
test('Claude transport failures expose only safe codes, never replay, and distinguish cancellation',async()=>{
  for(const canceled of [false,true]){
    let calls=0;const events:any[]=[];const controller=new AbortController();
    const handler=createClaudeHandler({credentials:async()=>[{provider:'claude',profile:'one',accessToken:'secret'}],capture:async()=>r=>r,observe:e=>events.push(e),upstream:(async()=>{
      calls++;if(canceled)controller.abort();throw Object.assign(new Error('private prompt and token'),{code:'ECONNRESET'});
    }) as typeof fetch});
    const response=await handler(new Request('http://localhost/v1/messages',{method:'POST',headers:{authorization:'Bearer secret'},body:'PRIVATE',signal:controller.signal}));
    expect(response.status).toBe(canceled?499:502);expect(calls).toBe(1);
    const result=await response.text();expect(result).not.toContain('private prompt');expect(result).not.toContain('secret');
    expect(events[0].failure).toBe(canceled?'client_canceled':'ECONNRESET');expect(events[0].bytes).toBe(7);
    expect(JSON.stringify(events)).not.toContain('PRIVATE');
  }
});
test('Claude preserves rate limits and streams without replay; diagnostics cannot fail requests',async()=>{
  for(const status of [200,429]){
    let calls=0;const payload=status===200?'data: {"type":"message_stop"}\n\n':'{"type":"error","error":{"type":"rate_limit_error"}}';
    const handler=createClaudeHandler({credentials:async()=>[{provider:'claude',profile:'one',accessToken:'secret'}],capture:async()=>r=>r,observe:()=>{throw new Error('disk unavailable')},upstream:(async()=>{
      calls++;return new Response(payload,{status,headers:{'content-type':status===200?'text/event-stream':'application/json','retry-after':'60'}});
    })as typeof fetch});
    const response=await handler(new Request('http://localhost/v1/messages',{method:'POST',headers:{authorization:'Bearer secret'},body:'{}'}));
    expect(response.status).toBe(status);expect(response.headers.get('retry-after')).toBe('60');expect(await response.text()).toBe(payload);expect(calls).toBe(1);
  }
});
test('large Claude histories are compressed losslessly and encoded client bodies remain untouched',async()=>{
  const {gzipSync,gunzipSync}=await import('node:zlib');
  const original=Buffer.from(JSON.stringify({model:'test',messages:[{role:'user',content:'all conversation data stays present '.repeat(250000)}]}));
  for(const preencoded of [false,true]){
    const payload=preencoded?gzipSync(original):original;const events:any[]=[];let calls=0;
    const handler=createClaudeHandler({credentials:async()=>[{provider:'claude',profile:'one',accessToken:'secret'}],capture:async()=>r=>r,observe:e=>events.push(e),upstream:(async(_url,init)=>{
      calls++;expect(new Headers(init!.headers).get('content-encoding')).toBe('gzip');
      const sent=Buffer.from(init!.body as Uint8Array);expect(gunzipSync(sent).equals(original)).toBe(true);
      if(preencoded)expect(sent.equals(payload)).toBe(true);else expect(sent.length).toBeLessThan(original.length/10);
      return new Response('data: {"type":"message_stop"}\n\n',{headers:{'content-type':'text/event-stream'}});
    })as typeof fetch});
    const response=await handler(new Request('http://localhost/v1/messages',{method:'POST',headers:{authorization:'Bearer secret',...(preencoded?{'content-encoding':'gzip'}:{})},body:payload}));
    expect(response.status).toBe(200);expect(await response.text()).toContain('message_stop');expect(calls).toBe(1);
    expect(events[0].bytes).toBe(payload.length);expect(events[0].encoding).toBe('gzip');
    expect(events[0].wireBytes).toBeLessThanOrEqual(payload.length);
  }
});
test('Claude leaves small or incompressible bodies unencoded',async()=>{
  const {randomBytes}=await import('node:crypto');
  for(const payload of [Buffer.from('{}'),randomBytes(65536)]){
    const handler=createClaudeHandler({credentials:async()=>[{provider:'claude',profile:'one',accessToken:'secret'}],upstream:(async(_url,init)=>{
      expect(new Headers(init!.headers).has('content-encoding')).toBe(false);
      expect(Buffer.from(init!.body as ArrayBuffer).equals(payload)).toBe(true);return Response.json({input_tokens:1});
    })as typeof fetch});
    expect((await handler(new Request('http://localhost/v1/messages/count_tokens',{method:'POST',headers:{authorization:'Bearer secret'},body:payload}))).status).toBe(200);
  }
});
