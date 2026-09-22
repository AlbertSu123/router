import { spawn } from 'node:child_process';
import { type Writable } from 'node:stream';

// Use macOS's native libcurl transport for HTTP/2 uploads. Credentials travel
// through an inherited pipe, never argv, a shell, a temporary file, or logs.
// Do not retry inference: a failed upload might already have been accepted.
export const codexTransport: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : input);
  const signal = init?.signal;
  signal?.throwIfAborted();
  const args = ['--disable','--silent','--show-error',url.protocol==='https:'?'--http2':'--http1.1','--no-buffer','--include',
    '--connect-timeout','15','--speed-time','300','--speed-limit','1',
    '--request',init?.method ?? 'GET','--config','/dev/fd/3'];
  if(init?.body != null)args.push('--data-binary','@-');
  args.push('--url',url.href);
  const child=spawn('/usr/bin/curl',args,{stdio:['pipe','pipe','pipe','pipe']});
  let spawnError:Error|undefined;
  const exited=new Promise<number>(resolve=>{
    child.once('error',e=>{spawnError=e;resolve(-1)});
    child.once('close',code=>resolve(code??-1));
  });
  const abort=()=>{child.kill('SIGTERM')};
  signal?.addEventListener('abort',abort,{once:true});
  child.once('close',()=>signal?.removeEventListener('abort',abort));
  // Drain stderr without exposing provider details or credentials.
  child.stderr!.resume();
  child.stdin!.on('error',()=>{});
  const config=child.stdio[3] as Writable;
  config.on('error',()=>{});
  const headers=new Headers(init?.headers);
  headers.set('accept-encoding','identity');
  headers.set('expect','');
  const quoted=(s:string)=>'"'+s.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('\n','\\n').replaceAll('\r','\\r')+'"';
  config.end([...headers].map(([key,value])=>`header = ${quoted(key+': '+value)}\n`).join(''));
  child.stdin!.end(init?.body instanceof ArrayBuffer?Buffer.from(init.body):init?.body??undefined);
  if(signal?.aborted)abort();
  const failure=(code:number)=>Object.assign(new Error(signal?.aborted?'Client canceled request':'Provider transport failed'),
    {code:signal?.aborted?'ABORT_ERR':code===28?'ETIMEDOUT':`CURL_${code}`,routerPhase:'request'});
  const iterator=child.stdout![Symbol.asyncIterator]();
  let buffer=Buffer.alloc(0),status=0;
  const responseHeaders=new Headers();
  try {
    while(!status) {
      const next=await iterator.next();
      if(next.done)throw spawnError??failure(await exited);
      buffer=Buffer.concat([buffer,Buffer.from(next.value)]);
      while(true){
        const boundary=buffer.indexOf('\r\n\r\n');
        if(boundary<0){if(buffer.length>65536)throw new Error('Provider headers too large');break}
        const lines=buffer.subarray(0,boundary).toString().split('\r\n');
        buffer=buffer.subarray(boundary+4);
        const match=/^HTTP\/[\d.]+ (\d{3})(.*)$/.exec(lines.shift()??'');
        if(!match)throw new Error('Invalid provider response headers');
        const code=Number(match[1]);
        // An HTTPS proxy tunnel or 100-continue can precede the real response.
        if(code<200||/connection established/i.test(match[2]!))continue;
        if(code>=300&&code<400)throw new Error('Provider redirect refused');
        status=code;
        for(const line of lines){const colon=line.indexOf(':');if(colon>0)responseHeaders.append(line.slice(0,colon),line.slice(colon+1).trim())}
        break;
      }
    }
    if([204,205,304].includes(status)){abort();return new Response(null,{status,headers:responseHeaders})}
    const stream=new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          if(buffer.length){const first=buffer;buffer=Buffer.alloc(0);controller.enqueue(first);return}
          const next=await iterator.next();
          if(!next.done){controller.enqueue(next.value);return}
          const code=await exited;if(code!==0)throw spawnError??failure(code);
          controller.close();
        } catch(e){abort();controller.error(e)}
      },
      async cancel(){abort();await iterator.return?.()},
    });
    return new Response(stream,{status,headers:responseHeaders});
  } catch(e) {abort();await iterator.return?.();throw e;}
}) as typeof fetch;
