import { createPublicKey, verify, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
export const CHATGPT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export type Identity = {provider:'chatgpt'|'google';subject:string;email:string;name:string;emailVerified:boolean};
export type GoogleClient = {clientId:string;clientSecret:string};
const keys = new Map<string,{expires:number;keys:any[]}>();
export function googleClient():GoogleClient|null {
  try {
    const raw=JSON.parse(readFileSync(process.env.ROUTER_GOOGLE_CLIENT_FILE??'/run/secrets/google-oauth.json','utf8'));
    const value=raw.installed;
    return typeof value?.client_id==='string'&&typeof value?.client_secret==='string'?{clientId:value.client_id,clientSecret:value.client_secret}:null;
  } catch {return null}
}
// Fixed issuer/key endpoints: no discovery URL, jku, or algorithm supplied by a token is trusted.
export async function verifyIdentityToken(token:string,provider:'chatgpt'|'google',audience:string,nonce?:string,fetcher:typeof fetch=fetch):Promise<Identity> {
  if(typeof token!=='string'||token.length>24000)throw new Error('Invalid identity token');
  const parts=token.split('.');if(parts.length!==3)throw new Error('Invalid identity token');
  const header=JSON.parse(Buffer.from(parts[0]!,'base64url').toString());
  const claims=JSON.parse(Buffer.from(parts[1]!,'base64url').toString());
  if(header.alg!=='RS256'||typeof header.kid!=='string')throw new Error('Unsupported identity signature');
  const endpoint=provider==='chatgpt'?'https://auth.openai.com/.well-known/jwks.json':'https://www.googleapis.com/oauth2/v3/certs';
  let set=keys.get(endpoint);
  if(!set||set.expires<Date.now()||!set.keys.some(k=>k.kid===header.kid)){
    const r=await fetcher(endpoint,{redirect:'error',signal:AbortSignal.timeout(10000)});
    if(!r.ok)throw new Error('Could not verify sign-in. Try again.');
    const body:any=await r.json();if(!Array.isArray(body.keys))throw new Error('Invalid identity keys');
    set={expires:Date.now()+3600000,keys:body.keys};keys.set(endpoint,set);
  }
  const jwk=set.keys.find(k=>k.kid===header.kid&&k.kty==='RSA'&&(!k.use||k.use==='sig'));
  if(!jwk||!verify('RSA-SHA256',Buffer.from(parts[0]+'.'+parts[1]),createPublicKey({key:jwk,format:'jwk'}),Buffer.from(parts[2]!,'base64url')))throw new Error('Invalid identity signature');
  const issuers=provider==='chatgpt'?['https://auth.openai.com']:['https://accounts.google.com','accounts.google.com'];
  const aud=Array.isArray(claims.aud)?claims.aud:[claims.aud];const now=Date.now()/1000;
  if(!issuers.includes(claims.iss)||!aud.includes(audience)||(aud.length>1&&claims.azp!==audience)
    ||!Number.isFinite(claims.exp)||claims.exp<=now||!Number.isFinite(claims.iat)||claims.iat>now+60||claims.iat<now-900
    ||(claims.nbf!==undefined&&(!Number.isFinite(claims.nbf)||claims.nbf>now+60))
    ||typeof claims.sub!=='string'||!claims.sub||claims.sub.length>256
    ||(nonce!==undefined&&claims.nonce!==nonce))throw new Error('Sign-in is expired or belongs to another app. Start again.');
  const email=typeof claims.email==='string'?claims.email.trim().toLowerCase():'';
  if(email.length>254||!email.includes('@'))throw new Error('The provider did not return an email address');
  return {provider,subject:claims.sub,email,emailVerified:claims.email_verified===true,name:typeof claims.name==='string'?claims.name.slice(0,80):email.split('@')[0]!};
}
export function loopbackRedirect(value:unknown):string {
  if(typeof value!=='string')throw new Error('Invalid callback');const u=new URL(value);
  if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||Number(u.port)<1024||Number(u.port)>65535||u.pathname!=='/callback'||u.search||u.hash||u.username||u.password)throw new Error('Invalid callback');
  return u.toString();
}
export const oauthSecret=()=>randomBytes(32).toString('base64url');
