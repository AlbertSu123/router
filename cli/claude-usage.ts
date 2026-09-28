import {mkdirSync,readFileSync,writeFileSync,renameSync,statSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

const INTERVAL=120_000;
type State={nextPoll:number;failures:number;error?:string};
export type UsageReading={body?:unknown;observedAt?:number;stale:boolean;error?:string;retryAt?:number};
const read=(path:string)=>{try{return JSON.parse(readFileSync(path,'utf8'))}catch{return null}};
function save(path:string,value:unknown){const tmp=path+'.'+randomUUID()+'.tmp';writeFileSync(tmp,JSON.stringify(value),{mode:0o600});renameSync(tmp,path)}

// Coordinate the menu, manual refresh and other Router processes. A 429 is a
// usage-endpoint limit, not an inference limit or a reason to rotate accounts.
export async function pollClaudeUsage(options:{directory:string;profile:string;request:()=>Promise<Response>;valid:(body:unknown)=>boolean;now?:()=>number}):Promise<UsageReading>{
  const {directory,profile,request,valid}=options,now=options.now??Date.now;
  mkdirSync(directory,{recursive:true,mode:0o700});
  const key=createHash('sha256').update(profile).digest('hex');
  const statePath=join(directory,`usage-poll-${key}.json`),lock=statePath+'.lock';
  const cache=join(directory,`usage-limits-${profile}.json`);
  const cached=():UsageReading=>{
    const state:State|null=read(statePath);let body:unknown,observedAt:number|undefined;
    try{const value=read(cache),mtime=statSync(cache).mtimeMs;if(now()-mtime<2*3600_000&&valid(value)){body=value;observedAt=mtime/1000}}catch{}
    return {body,observedAt,stale:!observedAt||now()-observedAt*1000>=INTERVAL||!!state?.error,
      error:state?.error,retryAt:state?.nextPoll&&state.nextPoll>now()?state.nextPoll/1000:undefined};
  };
  const due=()=>{
    const state:State|null=read(statePath);if(state&&state.nextPoll>now())return false;
    // Share successful readings from the existing statusline cache as well.
    try{if(now()-statSync(cache).mtimeMs<INTERVAL&&valid(read(cache)))return false}catch{}
    return true;
  };
  if(!due())return cached();
  let fd:number;
  try{fd=openSync(lock,'wx',0o600)}catch{
    const owner=read(lock)?.pid;
    if(Number.isInteger(owner)&&owner>0){try{process.kill(owner,0)}catch(e:any){if(e.code==='ESRCH')try{unlinkSync(lock)}catch{}}}
    else try{if(now()-statSync(lock).mtimeMs>60_000)unlinkSync(lock)}catch{}
    return cached();
  }
  try{
    writeFileSync(fd,JSON.stringify({pid:process.pid}));closeSync(fd);
    if(!due())return cached();
    const previous:State|null=read(statePath);const failures=(previous?.failures??0)+1;
    try{
      const response=await request();
      if(response.ok){
        const body=await response.json();if(!valid(body))throw new Error('Invalid usage response');
        save(cache,body);save(statePath,{nextPoll:now()+INTERVAL,failures:0});
        return {body,observedAt:now()/1000,stale:false,retryAt:(now()+INTERVAL)/1000};
      }
      const retry=response.headers.get('retry-after');
      const specified=retry===null?0:/^\d+(\.\d+)?$/.test(retry)?Number(retry)*1000:Date.parse(retry)-now();
      const limited=response.status===429;
      const delay=Math.max(Number.isFinite(specified)?specified:0,Math.min(900_000,(limited?120_000:30_000)*2**Math.min(failures-1,5)));
      await response.body?.cancel();
      save(statePath,{nextPoll:now()+delay,failures,error:limited?'Claude limited usage refreshes':'Claude usage refresh unavailable'});
    }catch{
      save(statePath,{nextPoll:now()+Math.min(300_000,30_000*2**Math.min(failures-1,4)),failures,error:'Claude usage refresh unavailable'});
    }
    return cached();
  }finally{try{unlinkSync(lock)}catch{}}
}
