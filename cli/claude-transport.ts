import {codexTransport} from './codex-transport.ts';
import {setTimeout as delay} from 'node:timers/promises';

// Retry ONLY when curl proves that the JSON request upload was incomplete and
// no response started. Never replay a fully uploaded request, a stream, or an
// ambiguous failure. Every attempt retains the exact same body and credentials.
export function createClaudeTransport(upstream:typeof fetch=codexTransport,
  pause:(ms:number,signal?:AbortSignal|null)=>Promise<unknown>=(ms,signal)=>delay(ms,undefined,{signal:signal??undefined})):typeof fetch {
  return (async(input,init)=>{
    const bytes=init?.body instanceof ArrayBuffer?init.body.byteLength
      :ArrayBuffer.isView(init?.body)?init.body.byteLength:undefined;
    for(let attempt=1;;attempt++){
      init?.signal?.throwIfAborted();
      try{
        const response=await upstream(input,init);
        const headers=new Headers(response.headers);headers.set('x-router-upload-attempts',String(attempt));
        return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
      }catch(error){
        const e=error as {code?:string;uploadedBytes?:number;httpStatus?:number;responseStarted?:boolean;uploadAttempts?:number};
        if(e&&typeof e==='object')e.uploadAttempts=attempt;
        const incomplete=bytes!==undefined&&bytes>0&&Number.isSafeInteger(e?.uploadedBytes)
          &&e.uploadedBytes!>=0&&e.uploadedBytes!<bytes&&e.httpStatus===0&&e.responseStarted===false;
        if(init?.signal?.aborted||attempt>=5||!incomplete||!['CURL_55','CURL_56'].includes(e?.code??''))throw error;
        await pause(200*2**(attempt-1),init?.signal);
      }
    }
  }) as typeof fetch;
}
export const claudeTransport=createClaudeTransport();
