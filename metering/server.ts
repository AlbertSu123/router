import { Database } from 'bun:sqlite';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { hash, validEvent, pressureWeight } from './core.ts';
import {googleClient,verifyIdentityToken,loopbackRedirect,oauthSecret,CHATGPT_CLIENT_ID,type GoogleClient,type Identity} from './identity.ts';
const secret = () => randomBytes(32).toString('hex');
const json = (data: any, status = 200) => Response.json(data, { status });
export function createService(options: { path: string; origin: string; verify?: typeof verifyProvider; identity?: typeof verifyIdentityToken; google?: GoogleClient|null; oauthFetch?: typeof fetch }) {
  mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
  const db = new Database(options.path, { create: true });
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, handle TEXT UNIQUE NOT NULL, name TEXT NOT NULL, password TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS identities(provider TEXT NOT NULL, subject TEXT NOT NULL, user TEXT NOT NULL REFERENCES users(id), email TEXT NOT NULL, PRIMARY KEY(provider,subject));
    CREATE TABLE IF NOT EXISTS verified_emails(email TEXT PRIMARY KEY, user TEXT NOT NULL REFERENCES users(id));
    CREATE TABLE IF NOT EXISTS oauth_flows(device TEXT PRIMARY KEY, state TEXT NOT NULL, verifier TEXT NOT NULL, nonce TEXT NOT NULL, redirect TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user TEXT NOT NULL REFERENCES users(id), device TEXT, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY, secret TEXT UNIQUE, code TEXT UNIQUE, user TEXT, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS subscriptions(id TEXT PRIMARY KEY, provider TEXT NOT NULL, label TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS grants(user TEXT NOT NULL, device TEXT NOT NULL, subscription TEXT NOT NULL REFERENCES subscriptions(id), expires INTEGER NOT NULL, PRIMARY KEY(user,device,subscription));
    CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, user TEXT NOT NULL REFERENCES users(id), subscription TEXT NOT NULL REFERENCES subscriptions(id), at INTEGER NOT NULL, model TEXT NOT NULL, input INTEGER NOT NULL, cached INTEGER NOT NULL, cacheWrite INTEGER NOT NULL, output INTEGER NOT NULL, status INTEGER NOT NULL, complete INTEGER NOT NULL, windows TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS events_subscription_at ON events(subscription,at);
    CREATE TABLE IF NOT EXISTS window_users(subscription TEXT NOT NULL, window TEXT NOT NULL, reset INTEGER NOT NULL, user TEXT NOT NULL, PRIMARY KEY(subscription,window,reset,user));
    CREATE TABLE IF NOT EXISTS peaks(subscription TEXT NOT NULL, window TEXT NOT NULL, reset INTEGER NOT NULL, pct REAL NOT NULL, PRIMARY KEY(subscription,window,reset));`);
  const google=options.google===undefined?googleClient():options.google;
  const identityVerifier=options.identity??verifyIdentityToken;
  function identityUser(identity:Identity):string {
    // Only verified addresses may join the two trusted providers. Unverified
    // email can never claim an existing user's identity or history.
    return db.transaction(()=>{
      const known:any=db.query('SELECT user FROM identities WHERE provider=? AND subject=?').get(identity.provider,identity.subject);
      if(known)return known.user;
      const sameEmail:any=identity.emailVerified?db.query('SELECT user FROM verified_emails WHERE email=?').get(identity.email):null;
      const user=sameEmail?.user??randomUUID();
      if(!sameEmail){
        const handle=identity.email.split('@')[0]!.replace(/[^a-z0-9_.-]/g,'').slice(0,25)||'user';
        db.run('INSERT INTO users VALUES(?,?,?,?)',[user,handle+'-'+user.slice(0,8),identity.name,'!social-login-only']);
        if(identity.emailVerified)db.run('INSERT INTO verified_emails VALUES(?,?)',[identity.email,user]);
      }
      db.run('INSERT INTO identities VALUES(?,?,?,?)',[identity.provider,identity.subject,user,identity.email]);
      return user;
    })();
  }
  const limits = new Map<string, { n: number; reset: number }>();
  function limited(key: string, cap: number) {
    const now = Date.now(); let v = limits.get(key);
    if (!v || v.reset < now) { v = { n: 0, reset: now + 60000 }; limits.set(key, v); }
    if (limits.size > 10000) for (const [k, v] of limits) if (v.reset < now) limits.delete(k);
    return ++v.n > cap;
  }
  const session = (r: Request): any => {
    const bearer = r.headers.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    const cookie = r.headers.get('cookie')?.match(/(?:^|; )router_session=([a-f0-9]{64})(?:;|$)/)?.[1];
    return db.query('SELECT s.*,u.handle,u.name FROM sessions s JOIN users u ON s.user=u.id WHERE token=? AND expires>?').get(hash(bearer ?? cookie ?? ''), Date.now());
  };
  function issue(user: string, device: string | null = null) {
    const token = secret();
    db.run('INSERT INTO sessions VALUES(?,?,?,?)', [hash(token), user, device, Date.now() + 90 * 86400000]);
    return token;
  }
  const cookie = (token: string) => `router_session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=7776000`;
  const can = (s: any, id: string) => db.query('SELECT 1 FROM grants WHERE user=? AND subscription=? AND expires>? LIMIT 1').get(s.user, id, Date.now());
  function addPeaks(subscription: string, windows: any[]) {
    for (const w of windows) db.run('INSERT INTO peaks VALUES(?,?,?,?) ON CONFLICT(subscription,window,reset) DO UPDATE SET pct=MAX(pct,excluded.pct)', [subscription,w.key,w.reset,w.pct]);
  }
  const tickets = new Map<string, {user: string; expires: number}>();
  async function handle(r: Request): Promise<Response> {
    const url = new URL(r.url); const p = url.pathname; const s = session(r);
    const origin = r.headers.get('origin');
    if (origin && origin !== options.origin) return json({error:'Invalid origin'},403);
    if (r.method !== 'GET' && !r.headers.get('content-type')?.startsWith('application/json')) return json({error:'JSON required'},415);
    if (p === '/health') return json({service:'router-metering',version:1});
    if (p === '/' && r.method === 'GET') return new Response(await Bun.file(new URL('./dashboard.html', import.meta.url)).text(), {headers:{'content-type':'text/html; charset=utf-8'}});
    if (p === '/ticket' && r.method === 'GET') {
      const key = url.searchParams.get('t') ?? ''; const ticket = tickets.get(hash(key)); tickets.delete(hash(key));
      if (!ticket || ticket.expires < Date.now()) return json({error:'Link expired. Reopen Usage from Router.'},401);
      return new Response(null, {status:303,headers:{location:'/', 'set-cookie':cookie(issue(ticket.user))}});
    }
    if (['/auth/login','/auth/register','/device/start'].includes(p)) {
      if (limited(`auth:${r.headers.get('cf-connecting-ip') ?? 'local'}`,20)) return json({error:'Try again in a minute'},429);
    }
    if (p === '/auth/login' || p === '/auth/register') return json({error:'Use Sign in with ChatGPT or Google in the updated Router app.'},410);
    if (p === '/auth/providers' && r.method==='GET') return json({chatgpt:true,google:!!google});
    if (['/auth/chatgpt','/auth/google/start','/auth/google/complete'].includes(p) && r.method==='POST') {
      if(limited(`social:${r.headers.get('cf-connecting-ip')??'local'}`,30))return json({error:'Try again in a minute'},429);
      const b:any=await r.json();
      const device:any=db.query('SELECT * FROM devices WHERE secret=? AND expires>? AND user IS NULL').get(hash(String(b.deviceSecret)),Date.now());
      if(!device)return json({error:'Sign-in expired. Start again.'},410);
      let identity:Identity;
      if(p==='/auth/chatgpt') {
        identity=await identityVerifier(b.idToken,'chatgpt',CHATGPT_CLIENT_ID);
      } else {
        if(!google)return json({error:'Google sign-in is not configured'},503);
        if(p==='/auth/google/start') {
          const redirect=loopbackRedirect(b.redirectUri),state=oauthSecret(),verifier=oauthSecret(),nonce=oauthSecret();
          db.run('DELETE FROM oauth_flows WHERE expires<?',[Date.now()]);
          db.run('INSERT OR REPLACE INTO oauth_flows VALUES(?,?,?,?,?,?)',[device.id,hash(state),verifier,nonce,redirect,Date.now()+600000]);
          const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');
          const challenge=Buffer.from(hash(verifier),'hex').toString('base64url');
          url.search=new URLSearchParams({client_id:google.clientId,redirect_uri:redirect,response_type:'code',scope:'openid email profile',state,nonce,code_challenge:challenge,code_challenge_method:'S256',prompt:'select_account'}).toString();
          return json({url:url.toString()});
        }
        const flow:any=db.query('SELECT * FROM oauth_flows WHERE device=? AND state=? AND expires>?').get(device.id,hash(String(b.state)),Date.now());
        if(!flow||typeof b.code!=='string'||!b.code||b.code.length>4096)return json({error:'Invalid or expired sign-in callback'},400);
        db.run('DELETE FROM oauth_flows WHERE device=?',[device.id]);
        const res=await (options.oauthFetch??fetch)('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:google.clientId,client_secret:google.clientSecret,code:b.code,code_verifier:flow.verifier,redirect_uri:flow.redirect,grant_type:'authorization_code'}),redirect:'error',signal:AbortSignal.timeout(15000)});
        if(!res.ok)return json({error:'Google sign-in failed. Start again.'},401);
        const tokens:any=await res.json();
        identity=await identityVerifier(tokens.id_token,'google',google.clientId,flow.nonce);
        if(!identity.emailVerified)return json({error:'Google did not verify your email address'},401);
      }
      const user=identityUser(identity);
      const result=db.run('UPDATE devices SET user=? WHERE id=? AND user IS NULL AND expires>?',[user,device.id,Date.now()]);
      return result.changes?json({ok:true}):json({error:'Sign-in already completed or expired'},410);
    }
    if (p === '/device/start' && r.method === 'POST') {
      db.run('DELETE FROM devices WHERE expires<?',[Date.now()]);
      const id = randomUUID(), token = secret(), code = randomBytes(4).toString('hex').toUpperCase();
      db.run('INSERT INTO devices VALUES(?,?,?,?,?)',[id,hash(token),code,null,Date.now()+600000]);
      return json({id,secret:token,code,url:`${options.origin}/?code=${code}`});
    }
    if (p === '/device/poll' && r.method === 'POST') {
      const b: any = await r.json(); const device: any = db.query('SELECT * FROM devices WHERE secret=? AND expires>?').get(hash(String(b.secret)),Date.now());
      if (!device) return json({error:'Sign-in expired. Start again.'},410);
      if (!device.user) return json({pending:true});
      const token = issue(device.user,device.id);
      db.run('DELETE FROM devices WHERE id=?',[device.id]);
      db.run('DELETE FROM oauth_flows WHERE device=?',[device.id]);
      const user: any = db.query('SELECT id,name,handle FROM users WHERE id=?').get(device.user);
      return json({token,user,device:device.id});
    }
    if (!s) return json({error:'Sign in to Router'},401);
    if (p === '/me' && r.method === 'GET') return json({id:s.user,name:s.name,handle:s.handle});
    if (p === '/auth/logout' && r.method === 'POST') {
      db.run('DELETE FROM sessions WHERE token=?',[s.token]);
      if (s.device) db.run('DELETE FROM grants WHERE user=? AND device=?',[s.user,s.device]);
      return new Response('{}',{headers:{'set-cookie':'router_session=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0'}});
    }
    if (p === '/device/approve' && r.method === 'POST') {
      if (limited(`approve:${s.user}`,10)) return json({error:'Try again in a minute'},429);
      const b: any = await r.json(); const result = db.run('UPDATE devices SET user=? WHERE code=? AND expires>? AND user IS NULL',[s.user,String(b.code).toUpperCase(),Date.now()]);
      return result.changes ? json({ok:true}) : json({error:'Code expired or already used'},400);
    }
    if (p === '/dashboard-ticket' && r.method === 'POST') {
      for (const [k,v] of tickets) if (v.expires < Date.now()) tickets.delete(k);
      if (limited(`ticket:${s.user}`,20)) return json({error:'Try again shortly'},429);
      const t = secret(); tickets.set(hash(t),{user:s.user,expires:Date.now()+30000});
      return json({url:`${options.origin}/ticket?t=${t}`});
    }
    if (p === '/subscriptions/verify' && r.method === 'POST') {
      if (!s.device) return json({error:'Connect the Router app first'},403);
      if (limited(`verify:${s.device}`,80)) return json({error:'Try again shortly'},429);
      const b: any = await r.json();
      if (!['claude','codex'].includes(b.provider) || typeof b.accessToken !== 'string' || b.accessToken.length > 16000) return json({error:'Invalid subscription proof'},400);
      const proof = await (options.verify ?? verifyProvider)(b);
      if (!proof) return json({error:'Subscription sign-in could not be verified'},403);
      const id = hash(`${b.provider}:${proof.id}`);
      db.run('INSERT INTO subscriptions VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label',[id,b.provider,proof.label]);
      db.run('INSERT INTO grants VALUES(?,?,?,?) ON CONFLICT(user,device,subscription) DO UPDATE SET expires=excluded.expires',[s.user,s.device,id,Date.now()+3600000]);
      addPeaks(id,proof.windows);
      return json({id,label:proof.label,provider:b.provider,windows:proof.windows});
    }
    if (p === '/subscriptions/retain' && r.method === 'POST') {
      if (!s.device) return json({error:'Device required'},403);
      const b: any = await r.json(); if (!Array.isArray(b.ids) || b.ids.length>100) return json({error:'Invalid subscription list'},400);
      db.transaction(() => {
        const grants: any[] = db.query('SELECT subscription FROM grants WHERE user=? AND device=?').all(s.user,s.device);
        for (const g of grants) if (!b.ids.includes(g.subscription)) db.run('DELETE FROM grants WHERE user=? AND device=? AND subscription=?',[s.user,s.device,g.subscription]);
      })();
      return json({ok:true});
    }
    if (p === '/events' && r.method === 'POST') {
      if (!s.device) return json({error:'Device required'},403);
      const b: any = await r.json();
      if (!Array.isArray(b.events) || b.events.length > 200 || !b.events.every((e: any) => validEvent(e))) return json({error:'Invalid usage events'},400);
      // A device may only report subscriptions it has proved, even when another device has access.
      for (const e of b.events) if (!db.query('SELECT 1 FROM grants WHERE user=? AND device=? AND subscription=? AND expires>?').get(s.user,s.device,e.subscription,Date.now())) return json({error:'Refresh subscription sign-in before syncing'},403);
      db.transaction(() => {
        for (const e of b.events) {
          const result = db.run('INSERT OR IGNORE INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[e.id,s.user,e.subscription,e.at,e.model,e.input,e.cached,e.cacheWrite,e.output,e.status,+e.complete,JSON.stringify(e.windows)]);
          if (result.changes) {
            addPeaks(e.subscription,e.windows);
            for (const w of e.windows) db.run('INSERT OR IGNORE INTO window_users VALUES(?,?,?,?)',[e.subscription,w.key,w.reset,s.user]);
          }
        }
      })();
      return json({accepted:b.events.map((e: any)=>e.id)});
    }
    if (p === '/usage' && r.method === 'GET') {
      const days = Number(url.searchParams.get('days') ?? 7);
      if (![1,7,30].includes(days)) return json({error:'Invalid period'},400);
      const only = url.searchParams.get('subscription');
      if (only && !can(s,only)) return json({error:'Subscription unavailable'},403);
      const subs: any[] = db.query('SELECT DISTINCT x.* FROM subscriptions x JOIN grants g ON x.id=g.subscription WHERE g.user=? AND g.expires>?').all(s.user,Date.now());
      const result = subs.filter(x => !only || x.id===only).map(sub => {
        const rows: any[] = db.query('SELECT e.*,u.name,u.handle FROM events e JOIN users u ON u.id=e.user WHERE subscription=? AND at>=? ORDER BY at').all(sub.id,Date.now()-days*86400000);
        const people = new Map<string,any>();
        const peaks = new Map((db.query('SELECT * FROM peaks WHERE subscription=? AND reset>?').all(sub.id,Date.now()/1000-days*86400) as any[]).map(w=>[`${w.window}:${w.reset}`,w.pct]));
        const demand = new Map((db.query('SELECT window,reset,count(*) people FROM window_users WHERE subscription=? AND reset>? GROUP BY window,reset').all(sub.id,Date.now()/1000-days*86400) as any[]).map(w=>[`${w.window}:${w.reset}`,w.people]));
        for (const e of rows) {
          const row = people.get(e.user) ?? {name:e.name,handle:e.handle,input:0,cached:0,cacheWrite:0,output:0,tokens:0,weighted:0,unweighted:0,requests:0,incomplete:0,limited:0,models:Object.create(null)};
          const tokens = e.input+e.cacheWrite+e.output;
          const windows = JSON.parse(e.windows);
          const weight = windows.length ? Math.max(...windows.map((w: any)=>pressureWeight(peaks.get(`${w.key}:${w.reset}`) ?? w.pct,(demand.get(`${w.key}:${w.reset}`) ?? 0)>1)!)) : null;
          for (const k of ['input','cached','cacheWrite','output']) row[k]+=e[k];
          row.tokens+=tokens; row.requests++; row.incomplete+=!e.complete ? 1:0; row.limited+=e.status===429 ? 1:0;
          if (weight===null) row.unweighted+=tokens; else row.weighted+=tokens*weight;
          row.models[e.model]=(row.models[e.model]??0)+tokens; people.set(e.user,row);
        }
        return {...sub,people:[...people.values()].sort((a,b)=>b.weighted-a.weighted)};
      });
      return json({days,subscriptions:result,updatedAt:Date.now()});
    }
    return json({error:'Not found'},404);
  }
  return {db, async fetch(r: Request) {
    let res: Response;
    try { res = await handle(r); } catch(e) { res = e instanceof ProviderVerificationError ? json({error:e.message},e.status) : json({error:'Request failed. Try again.'},400); }
    res.headers.set('cache-control','no-store'); res.headers.set('referrer-policy','no-referrer'); res.headers.set('x-content-type-options','nosniff');
    res.headers.set('content-security-policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    return res;
  }};
}
export class ProviderVerificationError extends Error {
  constructor(message:string, readonly status:number) { super(message); }
}
function requireProviderResponse(r:Response) {
  if(r.ok)return;
  if(r.status===401)throw new ProviderVerificationError('Subscription sign-in expired; reconnect this account in Router',403);
  if(r.status===403)throw new ProviderVerificationError('Provider denied subscription verification; check account access',403);
  if(r.status===429)throw new ProviderVerificationError('Provider rate limited verification; retrying automatically',503);
  throw new ProviderVerificationError('Provider verification temporarily unavailable; retrying automatically',503);
}
export async function verifyProvider(b: any, upstream:typeof fetch=fetch): Promise<{id:string;label:string;windows:any[]}|null> {
  try {
    const headers: Record<string,string> = {authorization:`Bearer ${b.accessToken}`};
    if (b.provider==='claude') {
      headers['anthropic-beta']='oauth-2025-04-20';
      const r = await upstream('https://api.anthropic.com/api/oauth/profile',{headers,redirect:'error',signal:AbortSignal.timeout(10000)});
      requireProviderResponse(r); const p: any = await r.json();
      if (!p.account?.uuid || !p.organization?.uuid) return null;
      const usage = await upstream('https://api.anthropic.com/api/oauth/usage',{headers,redirect:'error',signal:AbortSignal.timeout(10000)});
      const u: any = usage.ok ? await usage.json() : {};
      const windows = (Array.isArray(u.limits)?u.limits:[]).filter((w: any)=>['session','weekly_all'].includes(w.kind)).map((w: any)=>({key:w.kind,reset:typeof w.resets_at==='number'?w.resets_at:Date.parse(w.resets_at)/1000,pct:w.percent})).filter(validWindow);
      return {id:`${p.organization.uuid}:${p.account.uuid}`,label:p.account.email ?? 'Claude subscription',windows};
    }
    if (typeof b.accountId!=='string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(b.accountId)) return null;
    headers['chatgpt-account-id']=b.accountId; headers.originator='codex_cli_rs';
    const r = await upstream('https://chatgpt.com/backend-api/codex/usage',{headers,redirect:'error',signal:AbortSignal.timeout(10000)});
    requireProviderResponse(r); const u: any = await r.json();
    // The provider must bind the returned usage to the requested account.
    if (u.account_id !== b.accountId) return null;
    const windows = ['primary_window','secondary_window'].map(key=>({key,reset:u.rate_limit?.[key]?.reset_at,pct:u.rate_limit?.[key]?.used_percent})).filter(validWindow);
    return {id:b.accountId,label:u.email ?? `Codex ${b.accountId.slice(-8)}`,windows};
  } catch(e) {
    if(e instanceof ProviderVerificationError)throw e;
    throw new ProviderVerificationError('Verification network request failed; retrying automatically',503);
  }
}
function validWindow(w: any) { return Number.isFinite(w.reset) && w.reset>Date.now()/1000 && Number.isFinite(w.pct) && w.pct>=0 && w.pct<=100; }
if (import.meta.main) {
  const service = createService({path:process.env.ROUTER_DB ?? './data/usage.sqlite',origin:process.env.ROUTER_ORIGIN ?? 'https://router-usage.gudvc.com'});
  Bun.serve({hostname:process.env.ROUTER_BIND ?? '127.0.0.1',port:Number(process.env.PORT ?? 8791),maxRequestBodySize:512*1024,fetch:service.fetch});
  console.log('Router metering ready');
}
