// Observe usage while forwarding bytes with backpressure. Never persist content.
export type MeterWindow = {key:string;reset:number;pct:number};
export type MeterEvent = {id:string;subscription:string;at:number;model:string;input:number;cached:number;cacheWrite:number;output:number;status:number;complete:boolean;windows:MeterWindow[]};
export function responseWindows(provider: string, headers: Headers): MeterWindow[] {
  const windows: MeterWindow[]=[];
  const add=(key:string,reset:string|null,pct:string|null,scale=1)=>{
    if(reset===null||pct===null)return;
    const r=Number(reset),p=Number(pct)*scale;
    if(Number.isFinite(r)&&r>Date.now()/1000&&Number.isFinite(p)&&p>=0&&p<=100)windows.push({key,reset:r,pct:p});
  };
  if(provider==='codex')for(const [key,prefix]of [['primary_window','x-codex-primary'],['secondary_window','x-codex-secondary']]) {
    let reset=headers.get(`${prefix}-reset-at`);
    const after=headers.get(`${prefix}-reset-after-seconds`);
    if(!reset&&after!==null&&Number.isFinite(Number(after)))reset=String(Math.floor(Date.now()/1000)+Number(after));
    add(key!,reset,headers.get(`${prefix}-used-percent`));
  }
  else for(const [key,prefix]of [['session','5h'],['weekly_all','7d']])add(key!,headers.get(`anthropic-ratelimit-unified-${prefix}-reset`),headers.get(`anthropic-ratelimit-unified-${prefix}-utilization`),100);
  return windows;
}
export function meterResponse(response: Response, provider: string, initial: Pick<MeterEvent,'id'|'subscription'|'at'|'windows'>, done:(e:MeterEvent)=>void, signal?:AbortSignal):Response {
  const live=responseWindows(provider,response.headers);
  const normalized = live.map(w => { const old = initial.windows.find(o => o.key === w.key && Math.abs(o.reset-w.reset) < 60); return {...w,reset:old?.reset ?? w.reset}; });
  const windows=[...initial.windows.filter(w=>w.reset*1000>initial.at&&!normalized.some(l=>l.key===w.key)),...normalized];
  const event:MeterEvent={...initial,windows,model:'unknown',input:0,cached:0,cacheWrite:0,output:0,status:response.status,complete:false};
  let finished=false,buffer='',dropped=false,sawUsage=false;
  const decoder=new TextDecoder();
  const finish=()=>{if(!finished){finished=true;signal?.removeEventListener('abort',onAbort);try{done({...event,complete:event.complete&&sawUsage})}catch{/* Local failure must not lose the response. */}}};
  function usage(u:any){
    if(!u||typeof u!=='object')return;
    const number=(n:any)=>Number.isSafeInteger(n)&&n>=0&&n<=1e9?n:undefined;
    const set=(key:'input'|'cached'|'cacheWrite'|'output',n:any)=>{const v=number(n);if(v!==undefined){event[key]=v;sawUsage=true}};
    set('input',u.input_tokens);set('output',u.output_tokens);
    set('cached',provider==='claude'?u.cache_read_input_tokens:u.input_tokens_details?.cached_tokens);
    set('cacheWrite',u.cache_creation_input_tokens);
  }
  function parse(raw:string){try{
    const o=JSON.parse(raw);const r=o.response??o.message??o;
    if(typeof r.model==='string')event.model=r.model.slice(0,160).replace(/[\x00-\x1f]/g,'');
    usage(r.usage);if(r!==o)usage(o.usage);
    if(o.type==='response.completed'||o.type==='message_stop'||(!o.type&&r.usage)||o.type==='message'||(o.object==='response'&&o.status==='completed')||(o.object==='response.compaction'&&o.usage))event.complete=response.ok;
    if(o.type==='error'||o.type==='response.failed'||o.type==='response.incomplete')event.complete=false;
  }catch{}}
  const sse=response.headers.get('content-type')?.includes('text/event-stream');
  function consume(chunk:Uint8Array){
    buffer+=decoder.decode(chunk,{stream:true});
    if(sse){let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end).replace(/\r$/,'');buffer=buffer.slice(end+1);if(!dropped&&line.startsWith('data:'))parse(line.slice(5).trim());dropped=false;}}
    if(buffer.length>8*1024*1024){buffer='';dropped=true;}
  }
  let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  const onAbort=()=>{
    event.complete=false;event.status=499;finish();
    // The client may never consume/cancel the returned stream. Request abort
    // must finalize accounting and release upstream independently of demand.
    void reader?.cancel(signal?.reason).catch(()=>{});
  };
  if(!response.body){if(signal?.aborted){event.status=499;event.complete=false}finish();return response}
  reader=response.body.getReader();
  signal?.addEventListener('abort',onAbort,{once:true});
  if(signal?.aborted)onAbort();
  const stream=new ReadableStream<Uint8Array>({
    async pull(controller){try{const next=await reader!.read();if(next.done){buffer+=decoder.decode();if(!dropped){if(sse&&buffer.startsWith('data:'))parse(buffer.slice(5).trim());else if(!sse)parse(buffer)}finish();controller.close()}else{consume(next.value);controller.enqueue(next.value)}}catch(e){event.complete=false;finish();controller.error(e)}},
    async cancel(reason){event.complete=false;event.status=499;finish();await reader!.cancel(reason)},
  });
  return new Response(stream,{status:response.status,statusText:response.statusText,headers:response.headers});
}
