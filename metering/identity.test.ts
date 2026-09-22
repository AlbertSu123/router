import {test,expect} from 'bun:test';
import {generateKeyPairSync,sign,randomUUID} from 'node:crypto';
import {verifyIdentityToken,loopbackRedirect,CHATGPT_CLIENT_ID} from './identity.ts';
const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const kid=randomUUID(),jwk={...publicKey.export({format:'jwk'}),kid,use:'sig'};
const fetcher=(async()=>Response.json({keys:[jwk]}))as typeof fetch;
function token(values:any={},header:any={}){
 const h=Buffer.from(JSON.stringify({alg:'RS256',kid,...header})).toString('base64url');
 const now=Math.floor(Date.now()/1000);
 const c=Buffer.from(JSON.stringify({iss:'https://auth.openai.com',aud:[CHATGPT_CLIENT_ID],sub:'person-123',iat:now,exp:now+3600,email:'PERSON@example.com',email_verified:true,name:'Person',...values})).toString('base64url');
 return h+'.'+c+'.'+sign('RSA-SHA256',Buffer.from(h+'.'+c),privateKey).toString('base64url');
}
test('valid ChatGPT identity uses signed subject, verified email and expected audience',async()=>{
 const id=await verifyIdentityToken(token(),'chatgpt',CHATGPT_CLIENT_ID,undefined,fetcher);
 expect(id).toEqual({provider:'chatgpt',subject:'person-123',email:'person@example.com',emailVerified:true,name:'Person'});
});
test('rejects tampered, old, expired, future, wrong-audience and wrong-issuer identities',async()=>{
 const now=Date.now()/1000;
 for(const claims of [{aud:'another-client'},{iss:'https://evil.example'},{exp:now-1},{iat:now-1000},{iat:now+120},{nbf:now+120},{aud:[CHATGPT_CLIENT_ID,'other']},{sub:''}])await expect(verifyIdentityToken(token(claims),'chatgpt',CHATGPT_CLIENT_ID,undefined,fetcher)).rejects.toThrow();
 await expect(verifyIdentityToken(token({}, {alg:'none'}),'chatgpt',CHATGPT_CLIENT_ID,undefined,fetcher)).rejects.toThrow();
 const original=token().split('.');original[1]=Buffer.from(JSON.stringify({email:'attacker@example.com'})).toString('base64url');
 await expect(verifyIdentityToken(original.join('.'),'chatgpt',CHATGPT_CLIENT_ID,undefined,fetcher)).rejects.toThrow();
});
test('Google verifies nonce and client identity; callback cannot redirect off device',async()=>{
 const t=token({iss:'https://accounts.google.com',aud:'google-client',nonce:'expected'});
 expect((await verifyIdentityToken(t,'google','google-client','expected',fetcher)).provider).toBe('google');
 await expect(verifyIdentityToken(t,'google','google-client','wrong',fetcher)).rejects.toThrow();
 expect(loopbackRedirect('http://127.0.0.1:45678/callback')).toBe('http://127.0.0.1:45678/callback');
 for(const url of ['https://evil.example/callback','http://localhost:3456/callback','http://127.0.0.1:80/callback','http://127.0.0.1:45678/other','http://127.0.0.1:45678/callback?evil=yes','http://user@127.0.0.1:45678/callback'])expect(()=>loopbackRedirect(url)).toThrow();
});
