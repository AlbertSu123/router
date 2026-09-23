import {test,expect} from 'bun:test';
import {createServer} from 'node:http';
import {createClaudeTransport} from './claude-transport.ts';
const incomplete=()=>Object.assign(new Error('network failure'),{code:'CURL_56',uploadedBytes:4,httpStatus:0,responseStarted:false});
test('retries only proven incomplete uploads, with unchanged credentials and body',async()=>{
  let calls=0;const body=new Uint8Array(10),headers={authorization:'Bearer test'};
  const transport=createClaudeTransport((async(_input,init)=>{
    expect(init!.body).toBe(body);expect(init!.headers).toBe(headers);
    if(++calls<3)throw incomplete();return new Response('ok');
  })as typeof fetch,async()=>{});
  const response=await transport('https://api.anthropic.com/v1/messages',{method:'POST',body,headers});
  expect(await response.text()).toBe('ok');expect(calls).toBe(3);expect(response.headers.get('x-router-upload-attempts')).toBe('3');
});
test('never retries fully uploaded, ambiguous, started, canceled or rejected requests',async()=>{
  for(const patch of [{uploadedBytes:10},{uploadedBytes:undefined},{httpStatus:200},{responseStarted:true},{code:'ABORT_ERR'},{code:'CURL_60'},{uploadedBytes:-1}]){
    let calls=0;const transport=createClaudeTransport((async()=>{calls++;throw Object.assign(incomplete(),patch)})as typeof fetch,async()=>{});
    await expect(transport('https://api.anthropic.com/v1/messages',{method:'POST',body:new Uint8Array(10)})).rejects.toThrow();expect(calls).toBe(1);
  }
  let calls=0;const transport=createClaudeTransport((async()=>{calls++;return new Response('limit',{status:429})})as typeof fetch);
  expect((await transport('https://api.anthropic.com/v1/messages',{method:'POST',body:new Uint8Array(10)})).status).toBe(429);expect(calls).toBe(1);
});
test('incomplete retry budget is bounded and cancellation stops the next upload',async()=>{
  let calls=0;const transport=createClaudeTransport((async()=>{calls++;throw incomplete()})as typeof fetch,async()=>{});
  try{await transport('https://api.anthropic.com/v1/messages',{method:'POST',body:new Uint8Array(10)});throw new Error('must fail')}catch(e:any){expect(e.uploadAttempts).toBe(5)}
  expect(calls).toBe(5);
  calls=0;const controller=new AbortController();
  const canceled=createClaudeTransport((async()=>{calls++;throw incomplete()})as typeof fetch,async()=>{controller.abort()});
  await expect(canceled('https://api.anthropic.com/v1/messages',{method:'POST',body:new Uint8Array(10),signal:controller.signal})).rejects.toThrow();expect(calls).toBe(1);
});
test('native curl counters distinguish partial uploads, accepted requests and broken streams',async()=>{
  let calls=0;
  const server=createServer((req,res)=>{
    calls++;
    if(req.url==='/partial'&&calls===1){req.once('data',()=>req.socket.destroy());return}
    req.resume();req.on('end',()=>{
      if(req.url==='/accepted'){req.socket.destroy();return}
      if(req.url==='/stream'){res.writeHead(200);res.write('first');setTimeout(()=>req.socket.destroy(),30);return}
      res.end('ok');
    });
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${(server.address() as any).port}`;
  const transport=createClaudeTransport(undefined,async()=>{});
  try{
    expect(await (await transport(url+'/partial',{method:'POST',body:new Uint8Array(16*1024*1024)})).text()).toBe('ok');expect(calls).toBe(2);
    calls=0;await expect(transport(url+'/accepted',{method:'POST',body:new Uint8Array(10)})).rejects.toThrow();expect(calls).toBe(1);
    calls=0;const response=await transport(url+'/stream',{method:'POST',body:new Uint8Array(10)});
    await expect(response.text()).rejects.toThrow();expect(calls).toBe(1);
  }finally{server.closeAllConnections();server.close()}
});
