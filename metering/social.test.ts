import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createService} from './server.ts';
test('Google PKCE, state, nonce, one-use callback and verified-email fallback retain one identity without subscription grants',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'router-social-'));let expectedNonce='',exchangeCount=0;
 const app=createService({path:join(dir,'test.sqlite'),origin:'https://test.example',google:{clientId:'google-id',clientSecret:'test-secret'},identity:async(token,provider,aud,nonce)=>{
   if(provider==='google'){expect(aud).toBe('google-id');expect(nonce).toBe(expectedNonce)}
   return {provider,subject:provider+':'+token,email:'same@example.com',name:'Person',emailVerified:token!=='unverified'};
 },oauthFetch:(async(_url,init)=>{exchangeCount++;const body=new URLSearchParams(String(init!.body));expect(body.get('code_verifier')?.length).toBeGreaterThan(40);expect(body.get('redirect_uri')).toBe('http://127.0.0.1:45678/callback');return Response.json({id_token:'verified-google'})})as typeof fetch});
 const request=async(path:string,body?:any,bearer?:string)=>{const r=await app.fetch(new Request('https://test.example'+path,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'content-type':'application/json'}),...(bearer?{authorization:'Bearer '+bearer}:{})},body:body===undefined?undefined:JSON.stringify(body)}));return {status:r.status,data:await r.json()}};
 try{
  const a=(await request('/device/start',{})).data;
  expect((await request('/auth/chatgpt',{deviceSecret:a.secret,idToken:'verified-chatgpt'})).status).toBe(200);
  const alice=(await request('/device/poll',{secret:a.secret})).data;
  const b=(await request('/device/start',{})).data;
  expect((await request('/auth/google/start',{deviceSecret:b.secret,redirectUri:'https://evil.example'})).status).toBe(400);
  const start=(await request('/auth/google/start',{deviceSecret:b.secret,redirectUri:'http://127.0.0.1:45678/callback'})).data;
  const url=new URL(start.url);expectedNonce=url.searchParams.get('nonce')!;
  expect(url.origin).toBe('https://accounts.google.com');expect(url.searchParams.get('scope')).toBe('openid email profile');expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  const params={deviceSecret:b.secret,code:'google-code',state:url.searchParams.get('state')};
  expect((await request('/auth/google/complete',{...params,state:'forged'})).status).toBe(400);expect(exchangeCount).toBe(0);
  expect((await request('/auth/google/complete',params)).status).toBe(200);expect(exchangeCount).toBe(1);
  expect((await request('/auth/google/complete',params)).status).toBe(410);
  const google=(await request('/device/poll',{secret:b.secret})).data;expect(google.user.id).toBe(alice.user.id);
  expect((await request('/usage',undefined,google.token)).data.subscriptions).toEqual([]);
  const c=(await request('/device/start',{})).data;
  await request('/auth/chatgpt',{deviceSecret:c.secret,idToken:'unverified'});
  const other=(await request('/device/poll',{secret:c.secret})).data;expect(other.user.id).not.toBe(alice.user.id);
 }finally{app.db.close();rmSync(dir,{recursive:true,force:true})}
});
