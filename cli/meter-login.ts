import {mkdtempSync,readFileSync,writeFileSync,rmSync,openSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DIR,ensureDir} from './common.ts';
import {codex,codexEnv} from './codex.ts';
import {atomicJSON,readJSON,meterAPI} from './meter-client.ts';
const LOCK=join(DIR,'meter-personal-login.json');
export const PERSONAL_STATUS=join(DIR,'meter-personal-status.json');
export function cancelPersonalSignIn(session:string){
  const owner=readJSON(LOCK);
  if(!owner||owner.session!==session||!Number.isSafeInteger(owner.pid)||owner.pid<=1)return;
  const command=Bun.spawnSync(['ps','-p',String(owner.pid),'-o','command=']).stdout.toString();
  if(command.includes('router.ts')&&command.includes('meter')&&(command.includes('social-login')||command.includes('login'))) {
    try{process.kill(owner.pid,'SIGTERM')}catch{}
  }
}
export async function personalSignIn(provider:'chatgpt'|'google',session:string){
  if(!/^[a-zA-Z0-9-]{1,80}$/.test(session))throw new Error('Invalid sign-in session');
  ensureDir();
  const previous=readJSON(LOCK);
  if(previous){
    let alive=false;try{process.kill(previous.pid,0);alive=true}catch{}
    if(alive)throw new Error('A Router sign-in is already open. Finish or close it first.');
    rmSync(LOCK,{force:true});
  }
  let fd:number;
  try{fd=openSync(LOCK,'wx',0o600)}catch{throw new Error('A Router sign-in is already starting. Try again.')}
  writeFileSync(fd,JSON.stringify({pid:process.pid,session,provider}));closeSync(fd);
  const controller=new AbortController();const cancel=()=>controller.abort();
  process.on('SIGTERM',cancel);process.on('SIGINT',cancel);
  const timer=setTimeout(cancel,10*60000);
  const status=(value:object)=>{if(readJSON(LOCK)?.session===session)atomicJSON(PERSONAL_STATUS,{session,provider,...value})};
  status({phase:'starting'});
  try{
    const device=await meterAPI('/device/start',{},null);
    const ready=(url:string)=>status({phase:'waiting',url});
    if(provider==='chatgpt'){
      const idToken=await freshChatGPTIdentity(ready,controller.signal);
      if(controller.signal.aborted)throw new Error('Sign-in canceled');
      await meterAPI('/auth/chatgpt',{deviceSecret:device.secret,idToken},null);
    } else await googleIdentity(device.secret,ready,controller.signal);
    if(controller.signal.aborted)throw new Error('Sign-in canceled');
    const result=await meterAPI('/device/poll',{secret:device.secret},null);
    if(!result.token)throw new Error('Sign-in did not complete. Try again.');
    if(controller.signal.aborted){await meterAPI('/auth/logout',{},result).catch(()=>{});throw new Error('Sign-in canceled');}
    status({phase:'complete'});return result;
  }finally{
    clearTimeout(timer);process.off('SIGTERM',cancel);process.off('SIGINT',cancel);
    if(readJSON(LOCK)?.session===session){rmSync(LOCK,{force:true});rmSync(PERSONAL_STATUS,{force:true})}
  }
}
export async function freshChatGPTIdentity(ready:(url:string)=>void,signal:AbortSignal,runner?:{bin:string;env:Record<string,string>}){
  const home=mkdtempSync(join(tmpdir(),'router-personal-chatgpt-'));
  let child:ReturnType<typeof Bun.spawn>|undefined;
  try{
    const bin=runner?.bin??codex().bin;
    child=Bun.spawn([bin,'login','-c','cli_auth_credentials_store="file"'],{env:{...(runner?.env??codexEnv()),CODEX_HOME:home},stdin:'ignore',stdout:'pipe',stderr:'pipe'});
    const stop=()=>{try{child?.kill('SIGTERM')}catch{}};
    signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();
    let announced=false;
    const watch=async(stream:ReadableStream<Uint8Array>)=>{
      const decoder=new TextDecoder();let buffer='';
      for await(const chunk of stream){
        buffer=(buffer+decoder.decode(chunk,{stream:true})).slice(-32768);
        if(!announced){const match=buffer.match(/https:\/\/auth\.openai\.com\/[^\s\x1b]+/);if(match){announced=true;ready(match[0]!)}}
      }
    };
    let exit:number;
    try{[exit]=await Promise.all([child.exited,watch(child.stdout as ReadableStream<Uint8Array>),watch(child.stderr as ReadableStream<Uint8Array>)])}finally{signal.removeEventListener('abort',stop)}
    if(signal.aborted)throw new Error('Sign-in canceled or expired');
    if(exit!==0)throw new Error('ChatGPT sign-in did not finish. Try again, or continue with Google. Close other Codex sign-in windows if one is already open.');
    const auth=JSON.parse(readFileSync(join(home,'auth.json'),'utf8'));
    if(typeof auth.tokens?.id_token!=='string')throw new Error('ChatGPT did not return a personal identity. Try Google instead.');
    return auth.tokens.id_token as string;
  }finally{if(child&&child.exitCode===null)child.kill('SIGTERM');rmSync(home,{recursive:true,force:true})}
}
async function googleIdentity(deviceSecret:string,ready:(url:string)=>void,signal:AbortSignal){
  let resolve!:()=>void,reject!:(error:Error)=>void;
  const done=new Promise<void>((yes,no)=>{resolve=yes;reject=no});
  // Attach a handler immediately, including when canceled before the OAuth URL arrives.
  void done.catch(()=>{});
  let used=false;let expectedState:string|null=null;
  const server=Bun.serve({hostname:'127.0.0.1',port:0,maxRequestBodySize:4096,async fetch(request){
    const url=new URL(request.url);
    if(url.pathname!=='/callback'||request.method!=='GET'||used)return new Response('Not found',{status:404});
    const state=url.searchParams.get('state'),code=url.searchParams.get('code');
    if(!state||state!==expectedState)return new Response('Invalid sign-in callback',{status:400});
    if(url.searchParams.has('error')){reject(new Error('Google sign-in was canceled.'));return new Response('Sign-in canceled. Return to Router.',{status:400})}
    if(!code)return new Response('Sign-in was not completed. Return to Router to try again.',{status:400});
    used=true;
    try{
      await meterAPI('/auth/google/complete',{deviceSecret,state,code},null);
      resolve();return new Response('Signed in to Router. You can close this tab.',{headers:{'content-type':'text/plain; charset=utf-8','cache-control':'no-store'}});
    }catch{reject(new Error('Google sign-in failed. Please try again.'));return new Response('Sign-in failed. Return to Router to try again.',{status:400})}
  }});
  const abort=()=>reject(new Error('Sign-in canceled or expired'));
  signal.addEventListener('abort',abort,{once:true});
  try{
    if(signal.aborted)throw new Error('Sign-in canceled');
    const start=await meterAPI('/auth/google/start',{deviceSecret,redirectUri:`http://127.0.0.1:${server.port}/callback`},null);
    if(signal.aborted)throw new Error('Sign-in canceled');
    const url=new URL(start.url);if(url.origin!=='https://accounts.google.com')throw new Error('Unexpected Google sign-in URL');
    expectedState=url.searchParams.get('state');if(!expectedState)throw new Error('Google sign-in state is missing');
    ready(start.url);
    Bun.spawn(['open',start.url],{stdout:'ignore',stderr:'ignore'});
    await done;
  }finally{signal.removeEventListener('abort',abort);await server.stop(false)}
}
