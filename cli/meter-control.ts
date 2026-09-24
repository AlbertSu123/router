import {readFileSync,existsSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {gzip} from 'node:zlib';
import {promisify} from 'node:util';
import {claudeTransport} from './claude-transport.ts';
import {personalSignIn,cancelPersonalSignIn} from './meter-login.ts';
import {DIR,HOME,exitOnSigterm,reloadLaunchAgent} from './common.ts';
import {meterAPI,meterSession,meterStatus,saveSession,syncMeter,beginMeter,readJSON,atomicJSON,type MeterCredential} from './meter-client.ts';
const gzipAsync=promisify(gzip);
const PENDING=join(DIR,'meter-login.json'), LABEL='dev.bryan.router.metering';
const CLAUDE_SETTINGS=join(HOME,'.claude/settings.json');
const BASE='http://127.0.0.1:18790';
const xml=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
export function configureClaudeSettings(settings:any):any {
  const previous=settings.env?.ANTHROPIC_BASE_URL;
  if(previous&&previous!==BASE)throw new Error('Claude uses a custom endpoint. Remove that override before enabling Router metering.');
  return {...settings,env:{...settings.env,ANTHROPIC_BASE_URL:BASE}};
}
async function enableClaude(){
  const original=existsSync(CLAUDE_SETTINGS)?readFileSync(CLAUDE_SETTINGS,'utf8'):'{}';
  const next=configureClaudeSettings(JSON.parse(original));
  if(!existsSync(join(DIR,'claude-settings-before-meter.json')))writeFileSync(join(DIR,'claude-settings-before-meter.json'),original,{mode:0o600});
  mkdirSync(join(HOME,'.claude'),{recursive:true});atomicJSON(CLAUDE_SETTINGS,next);
}
export type ClaudeObservation={at:string;path:string;status:number;bytes:number;wireBytes:number;encoding:string|null;elapsedMs:number;failure?:string;uploadAttempts:number};
export function createClaudeHandler(options:{observe?:(event:ClaudeObservation)=>void;credentials:(force?:boolean)=>Promise<MeterCredential[]>;upstream?:typeof fetch;capture?:typeof beginMeter}){
  return async(request:Request)=>{
    if(request.headers.has('origin'))return new Response('Browser requests are not allowed',{status:403});
    const url=new URL(request.url);
    if(url.pathname==='/health'&&request.method==='GET')return Response.json({service:'router-claude-meter',version:4,requestCompression:'gzip',uploadRecovery:'incomplete-only',requestBodyTransport:'anonymous-fd'});
    if(!['/v1/messages','/v1/messages/count_tokens','/v1/models'].includes(url.pathname)||!['GET','POST'].includes(request.method))return new Response('Not found',{status:404});
    const token=request.headers.get('authorization')?.replace(/^Bearer /,'')??request.headers.get('x-api-key');
    if(!token)return new Response('Claude subscription sign-in required',{status:401});
    let credential=(await options.credentials()).find(c=>c.provider==='claude'&&c.accessToken===token);
    if(!credential)credential=(await options.credentials(true)).find(c=>c.provider==='claude'&&c.accessToken===token);
    if(!credential)return new Response('This Claude credential is not signed into Router. Refresh or add it in Router.',{status:401});
    let wrap=(r:Response)=>r;
    if(url.pathname==='/v1/messages'&&request.method==='POST'){
      try{wrap=await (options.capture??beginMeter)(credential,request.signal)}catch{return Response.json({type:'error',error:{type:'api_error',message:'Router could not verify usage attribution. Open Router to refresh subscription access.'}},{status:503})}
    }
    const headers=new Headers();
    for(const [name,value]of request.headers)if(['authorization','x-api-key','accept','content-type','content-encoding','user-agent'].includes(name)||name.startsWith('anthropic-')||name.startsWith('x-stainless-'))headers.set(name,value);
    const started=Date.now();let bytes=0,wireBytes=0,uploadAttempts=1;
    const observe=(status:number,failure?:string)=>{try{options.observe?.({at:new Date().toISOString(),path:url.pathname,status,bytes,wireBytes,uploadAttempts,encoding:headers.get('content-encoding')?.slice(0,24)??null,elapsedMs:Date.now()-started,...(failure?{failure}:{})})}catch{/* Diagnostics must not interrupt a request. */}};
    try{
      let body:ArrayBuffer|Uint8Array|undefined=request.method==='POST'?await request.arrayBuffer():undefined;
      bytes=body?.byteLength??0;wireBytes=bytes;
      // Long Claude histories can exceed 25 MB. Anthropic accepts gzip request
      // bodies; compress losslessly before sending, never trim conversation data.
      // Preserve a client's encoding verbatim and skip unhelpful compression.
      if(body&&bytes>=4096&&!headers.has('content-encoding')){
        const compressed=await gzipAsync(new Uint8Array(body));
        if(compressed.byteLength<bytes){body=compressed;headers.set('content-encoding','gzip');wireBytes=body.byteLength;}
      }
      request.signal.throwIfAborted();
      // Retry only uploads proven incomplete; never replay an accepted request.
      const upstream=await(options.upstream??claudeTransport)(`https://api.anthropic.com${url.pathname}${url.search}`,{method:request.method,headers,body,redirect:'error',signal:request.signal});
      const outgoing=new Headers(upstream.headers);for(const name of ['content-encoding','content-length','transfer-encoding','connection','set-cookie'])outgoing.delete(name);
      outgoing.set('cache-control','no-store');
      uploadAttempts=Number(upstream.headers.get('x-router-upload-attempts'))||1;
      observe(upstream.status);
      return wrap(new Response(upstream.body,{status:upstream.status,headers:outgoing}));
    }catch(error){
      const attempts=(error as {uploadAttempts?:number})?.uploadAttempts;
      if(Number.isSafeInteger(attempts)&&attempts!>=1&&attempts!<=5)uploadAttempts=attempts!;
      const code=(error as {code?:unknown})?.code;
      const canceled=request.signal.aborted;
      const failure=canceled?'client_canceled':typeof code==='string'&&/^[A-Z_0-9]{1,64}$/.test(code)?code:'transport_error';
      const status=canceled?499:502;observe(status,failure);
      return wrap(Response.json({type:'error',error:{type:'api_error',message:canceled?'Router request canceled by client':`Router could not reach Claude (${failure}); retry this request.`}},{status}));
    }
  };
}
export async function meterCommand(args:string[],credentials:()=>Promise<MeterCredential[]>){
  const cmd=args[0]??'status';
  if(cmd==='status'){console.log(JSON.stringify(meterStatus()));return}
  if(cmd==='login'){await meterCommand(['social-login',args.includes('--google')?'google':'chatgpt',...args.slice(1)],credentials);return}
  if(cmd==='cancel-login'){cancelPersonalSignIn(args.find(a=>a.startsWith('--session='))?.slice(10)??'');console.log(JSON.stringify({ok:true}));return}
  if(cmd==='social-login'){
    const provider=args[1];if(provider!=='chatgpt'&&provider!=='google')throw new Error('Choose ChatGPT or Google');
    const session=args.find(a=>a.startsWith('--session='))?.slice(10)??randomUUID();
    const next=await personalSignIn(provider,session);
    await completeSignIn(next,credentials);return;
  }
  if(cmd==='finish'){
    const pending=readJSON(PENDING);if(!pending)throw new Error('Start Router sign-in first');
    const next=await meterAPI('/device/poll',{secret:pending.secret},null);
    if(next.pending){console.log(JSON.stringify(next));return}
    await completeSignIn(next,credentials);return;
  }
  if(cmd==='sync'){console.log(JSON.stringify(await syncMeter(await credentials())));return}
  if(cmd==='dashboard'){
    if(!meterSession())throw new Error('Choose Sign in to Router, then ChatGPT or Google.');
    console.log(JSON.stringify(await meterAPI('/dashboard-ticket',{})));return;
  }
  if(cmd==='logout'){
    // A failed server sign-out must remain visible, not leave silent access behind.
    if(meterSession())await meterAPI('/auth/logout',{});
    saveSession(null);atomicJSON(join(DIR,'meter-subscriptions.json'),[]);console.log(JSON.stringify({ok:true}));return;
  }
  if(cmd==='enable'){await enableClaude();console.log(JSON.stringify({ok:true,restart:'Restart existing Claude sessions once to use the metered endpoint.'}));return}
  if(cmd==='disable'){
    const settings=readJSON(CLAUDE_SETTINGS,{});
    if(settings.env?.ANTHROPIC_BASE_URL===BASE){delete settings.env.ANTHROPIC_BASE_URL;atomicJSON(CLAUDE_SETTINGS,settings)}
    console.log(JSON.stringify({ok:true}));return;
  }
  if(cmd==='install'){
    try { const r=await fetch(BASE+'/health',{signal:AbortSignal.timeout(1000)}); const body:any=await r.json(); if(body.service==='router-claude-meter')return; } catch {}
    const plist=join(HOME,'Library/LaunchAgents',`${LABEL}.plist`);mkdirSync(join(HOME,'Library/LaunchAgents'),{recursive:true});
    const log=join(DIR,'metering.log');
    writeFileSync(plist,`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(join(DIR,'lib/router.ts'))}</string><string>meter</string><string>serve</string></array>
<key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(HOME)}</string><key>USER</key><string>${xml(process.env.USER??'')}</string><key>PATH</key><string>${xml(process.env.PATH??'/usr/bin:/bin')}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(log)}</string></dict></plist>`,{mode:0o600});
    if(!await reloadLaunchAgent(LABEL,plist))throw new Error('Could not start the usage service');return;
  }
  if(cmd==='serve'){
    let cached:MeterCredential[]=[],last=0;let pending:Promise<MeterCredential[]>|null=null;
    const current=async(force=false)=>{
      if(!force&&Date.now()-last<5000)return cached;
      if(!pending)pending=credentials().then(value=>{cached=value;last=Date.now();return value}).finally(()=>pending=null);
      return pending;
    };
    let syncing=false;
    const sync=async()=>{if(syncing||!meterSession())return;syncing=true;try{await syncMeter(await current())}catch{atomicJSON(join(DIR,'meter-sync-status.json'),{error:'Usage sync failed; data remains queued locally'})}finally{syncing=false}};
    const server=Bun.serve({hostname:'127.0.0.1',port:18790,idleTimeout:0,maxRequestBodySize:64*1024*1024,fetch:createClaudeHandler({credentials:current,observe:event=>{const file=join(DIR,'claude-proxy-status.json');const previous=readJSON(file,{recent:[]});atomicJSON(file,{recent:[...(Array.isArray(previous.recent)?previous.recent:[]).slice(-49),event]})}}),error:()=>Response.json({error:'Router request failed'},{status:500})});
    void sync();const timer=setInterval(sync,60000);
    exitOnSigterm(server,()=>clearInterval(timer));return;
  }
  throw new Error('usage: router meter <login|finish|status|dashboard|sync|logout|install|enable|disable>');
}

async function completeSignIn(next:any,credentials:()=>Promise<MeterCredential[]>){
    // Clear the old person's mappings before publishing a new identity.
    atomicJSON(join(DIR,'meter-subscriptions.json'),[]);saveSession(next);rmSync(PENDING,{force:true});
    let warning:string|null=null;
    try{
      await meterCommand(['install'],credentials);await enableClaude();
      if((await credentials()).some(c=>c.provider==='codex')) {
        for(const action of ['install','enable']) {
          const child=Bun.spawn([process.execPath,join(DIR,'lib/router.ts'),'proxy',action],{stdout:'pipe',stderr:'pipe'});
          await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text()]);
          if(await child.exited)throw new Error('Codex routing could not be enabled. Run router proxy install and router proxy enable.');
        }
      }
    }catch(e){warning=e instanceof Error?e.message:'Could not enable metering'}
    // The background service verifies all accounts. Do not hold up the sign-in UI.
    atomicJSON(join(DIR,'meter-setup.json'),{warning,restartRequired:true});
    console.log(JSON.stringify({ok:true,user:next.user,warning}));return;
}
