import { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync,writeFileSync,renameSync,mkdirSync,existsSync,chmodSync } from 'node:fs';
import {join} from 'node:path';
import {DIR as DEFAULT_DIR} from './common.ts';
// An isolated state location also lets integration tests exercise the actual client.
const DIR=process.env.ROUTER_METER_STATE_DIR ?? DEFAULT_DIR;
const ensureDir=()=>mkdirSync(DIR,{recursive:true,mode:0o700});
import {meterResponse,type MeterEvent,type MeterWindow} from './meter-stream.ts';
export const METER_ORIGIN='https://router-usage.gudvc.com';
const STATE=join(DIR,'meter-session.json'), MAP=join(DIR,'meter-subscriptions.json');
export type MeterCredential={provider:'claude'|'codex';profile:string;accessToken:string;accountId?:string};
type Session={token:string;user:{id:string;name:string;handle:string};device:string};
type Mapping={id:string;label:string;provider:string;profile:string;fingerprint:string;windows:MeterWindow[];verifiedAt:number};
export const fingerprint=(value:string)=>createHash('sha256').update(value).digest('hex');
export function readJSON(path:string,fallback:any=null):any{try{return JSON.parse(readFileSync(path,'utf8'))}catch{return fallback}}
export function atomicJSON(path:string,value:unknown){ensureDir();const tmp=`${path}.${randomUUID()}.tmp`;writeFileSync(tmp,JSON.stringify(value)+'\n',{mode:0o600});renameSync(tmp,path)}
export function meterSession():Session|null{return readJSON(STATE)}
export function saveSession(session:Session|null){atomicJSON(STATE,session)}
export async function meterAPI(path:string,body?:unknown,session=meterSession()):Promise<any>{
  const res=await fetch(METER_ORIGIN+path,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'content-type':'application/json'}),...(session?{authorization:`Bearer ${session.token}`}:{})},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(25000)});
  const data:any=await res.json();if(!res.ok)throw new Error(data.error??`Usage server returned ${res.status}`);return data;
}
let queue:Database|undefined;
function db(){
  if(queue)return queue;ensureDir();const path=join(DIR,'meter-queue.sqlite');queue=new Database(path,{create:true});chmodSync(path,0o600);
  queue.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS queue(id TEXT PRIMARY KEY,user TEXT NOT NULL,event TEXT NOT NULL,ready INTEGER NOT NULL DEFAULT 1,owner INTEGER);');return queue;
}
export function meterStatus(){const s=meterSession();return {signedIn:!!s,user:s?.user??null,pending:existsSync(join(DIR,'meter-queue.sqlite'))?(db().query('SELECT count(*) n FROM queue').get() as any).n:0,...readJSON(join(DIR,'meter-sync-status.json'),{}),url:METER_ORIGIN}}
export async function syncMeter(credentials:MeterCredential[]){
  const session=meterSession();if(!session)return meterStatus();
  const old:Mapping[]=readJSON(MAP,[]);const next:Mapping[]=[];const errors:string[]=[];
  for(const credential of credentials){
    const fp=fingerprint(credential.accessToken+(credential.accountId??''));
    const previous=old.find(m=>m.fingerprint===fp&&m.profile===credential.profile&&m.provider===credential.provider);
    if(previous&&Date.now()-previous.verifiedAt<10*60000){next.push(previous);continue}
    try{const proof=await meterAPI('/subscriptions/verify',credential,session);next.push({...proof,profile:credential.profile,fingerprint:fp,verifiedAt:Date.now()})}
    catch(e){if(previous)next.push(previous);errors.push(`${credential.provider}:${credential.profile}: ${e instanceof Error?e.message:"Subscription verification failed; retrying automatically"}`)}
  }
  // A sign-out or a new personal sign-in during this sync must not publish its mappings.
  if(meterSession()?.token!==session.token)return meterStatus();
  atomicJSON(MAP,next);
  try{
    await meterAPI('/subscriptions/retain',{ids:[...new Set(next.map(m=>m.id))]},session);
    // Batch per subscription, so a revoked grant cannot block other subscriptions.
    for(const sub of new Set(next.map(m=>m.id))){
      try {
      for(let batch=0;batch<20;batch++){
        // Recover requests interrupted by a process crash as incomplete, never fabricate tokens.
        const pending:any[]=db().query('SELECT id,owner FROM queue WHERE ready=0').all();
        for(const row of pending){try{process.kill(row.owner,0)}catch{db().run('UPDATE queue SET ready=1 WHERE id=?',[row.id])}}
        const rows:any[]=db().query("SELECT id,event FROM queue WHERE user=? AND ready=1 AND json_extract(event,'$.subscription')=? AND json_extract(event,'$.at')>=? LIMIT 200").all(session.user.id,sub,Date.now()-30*86400000);
        if(!rows.length)break;
        const result=await meterAPI('/events',{events:rows.map(r=>JSON.parse(r.event))},session);
        db().transaction(()=>{for(const id of result.accepted)db().run('DELETE FROM queue WHERE id=? AND user=?',[id,session.user.id])})();
      }
      } catch(e) { errors.push(e instanceof Error?e.message:'Usage upload failed'); }
    }
    atomicJSON(join(DIR,'meter-sync-status.json'),{lastSync:Date.now(),error:errors.join('; ')||null,subscriptions:next.length});
  }catch(e){atomicJSON(join(DIR,'meter-sync-status.json'),{error:e instanceof Error?e.message:'Usage sync failed',subscriptions:next.length})}
  return meterStatus();
}
// Snapshot the person and subscription BEFORE inference; a switch mid-stream cannot reattribute it.
export async function beginMeter(credential:MeterCredential):Promise<(response:Response)=>Response>{
  const session=meterSession();if(!session)return r=>r;
  const fp=fingerprint(credential.accessToken+(credential.accountId??''));
  let mapping:Mapping|undefined=(readJSON(MAP,[]) as Mapping[]).find(m=>m.fingerprint===fp&&m.provider===credential.provider);
  if(!mapping){
    // Do not invent attribution from the selected profile; prove the credential actually used.
    const proof=await meterAPI('/subscriptions/verify',credential,session);
    mapping={...proof,profile:credential.profile,fingerprint:fp,verifiedAt:Date.now()} as Mapping;
  }
  const capture={id:randomUUID(),subscription:mapping.id,at:Date.now(),windows:mapping.windows.filter(w=>w.reset*1000>Date.now())};
  // Open the durable queue before the request so a disk error cannot silently discard usage.
  db().run('INSERT INTO queue(id,user,event,ready,owner) VALUES(?,?,?,0,?)',[capture.id,session.user.id,JSON.stringify({...capture,model:'unknown',input:0,cached:0,cacheWrite:0,output:0,status:499,complete:false}),process.pid]);
  return response=>meterResponse(response,credential.provider,capture,(event:MeterEvent)=>{
    // Claude's input_tokens excludes cache reads; normalize to inclusive input.
    if(credential.provider==='claude')event.input+=event.cached;
    try { db().run('UPDATE queue SET event=?,ready=1 WHERE id=? AND user=?',[JSON.stringify(event),event.id,session.user.id]); } catch { atomicJSON(join(DIR,'meter-sync-status.json'),{error:'Could not save request token counts. Check available disk space.'}); }
  });
}
