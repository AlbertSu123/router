import {test,expect} from 'bun:test';
import {createServer} from 'node:http';
import {codexTransport} from './codex-transport.ts';
test('native transport uploads large bodies, streams immediately and cancels without leaking credentials',async()=>{
  let received=0,closed=false;
  const server=Bun.serve({hostname:'127.0.0.1',port:0,idleTimeout:0, maxRequestBodySize:16*1024*1024,
    async fetch(request){
      expect(request.headers.get('authorization')).toBe('Bearer test-secret');
      received=(await request.arrayBuffer()).byteLength;
      return new Response(new ReadableStream({
        start(controller){controller.enqueue(new TextEncoder().encode('data: first\n\n'))},
        cancel(){closed=true},
      }),{headers:{'content-type':'text/event-stream'}});
    }});
  try {
    const url=`http://127.0.0.1:${server.port}/test`;
    const response=await codexTransport(url,{method:'POST',body:new Uint8Array(8*1024*1024),headers:{authorization:'Bearer test-secret'}});
    expect(response.status).toBe(200);expect(received).toBe(8*1024*1024);
    const reader=response.body!.getReader();expect(new TextDecoder().decode((await reader.read()).value)).toContain('first');
    await reader.cancel();for(let i=0;i<20&&!closed;i++)await Bun.sleep(25);expect(closed).toBe(true);
    const canceled=new AbortController();canceled.abort();
    await expect(codexTransport(url,{signal:canceled.signal})).rejects.toThrow();
  } finally {await server.stop(true)}
});
test('keeps concurrent account headers and cancellation isolated',async()=>{
  const server=createServer((req,res)=>{
    res.writeHead(200);res.write(String(req.headers.authorization));
    if(req.url==='/finish')res.end(' done');
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const a=await codexTransport(url+'/hold',{headers:{authorization:'Bearer a'}});
    const reader=a.body!.getReader();expect(new TextDecoder().decode((await reader.read()).value)).toBe('Bearer a');
    const b=await codexTransport(url+'/finish',{headers:{authorization:'Bearer b'}});
    await reader.cancel();expect(await b.text()).toBe('Bearer b done');
  } finally {server.closeAllConnections();server.close()}
});
test('does not replay inference or expose stderr when the provider resets the connection',async()=>{
  let requests=0;
  const server=createServer((req)=>{requests++;req.socket.destroy()});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    await expect(codexTransport(`http://127.0.0.1:${(server.address() as any).port}/reset`,{method:'POST',body:'test'})).rejects.toThrow('Provider transport failed');
    expect(requests).toBe(1);
  } finally {server.closeAllConnections();server.close()}
});
test('concurrent uploads keep configuration and large payloads isolated without named body files',async()=>{
  const {randomBytes,createHash}=await import('node:crypto');
  const {readdirSync}=await import('node:fs');const {tmpdir}=await import('node:os');
  const namedBodies=()=>readdirSync(tmpdir()).filter(n=>n.startsWith('.router-body-')).sort();
  const before=namedBodies();let received=0;
  const server=Bun.serve({hostname:'127.0.0.1',port:0,idleTimeout:0,maxRequestBodySize:8*1024*1024,
    async fetch(request){
      const tag=new URL(request.url).pathname.slice(1);
      expect(request.headers.get('authorization')).toBe('Bearer credential-'+tag);
      expect(namedBodies()).toEqual(before);
      const body=await request.arrayBuffer();
      expect(createHash('sha256').update(new Uint8Array(body)).digest('hex')).toBe(request.headers.get('x-body-sha256'));
      received++;return new Response('ok');
    }});
  try{
    for(let batch=0;batch<5;batch++)await Promise.all(Array.from({length:10},async(_,i)=>{
      const tag=String(batch*10+i);const body=randomBytes(3*1024*1024+i);
      const response=await codexTransport(`http://127.0.0.1:${server.port}/${tag}`,{method:'POST',body,
        headers:{authorization:'Bearer credential-'+tag,'x-body-sha256':createHash('sha256').update(body).digest('hex')}});
      expect(response.status).toBe(200);expect(await response.text()).toBe('ok');
    }));
    expect(received).toBe(50);expect(namedBodies()).toEqual(before);
  }finally{await server.stop(true)}
});
