import {test,expect} from 'bun:test';
import {verifyProvider} from './server.ts';
const proof={provider:'codex',accountId:'account',accessToken:'test'};
test('verification distinguishes revoked credentials, rate limiting and network failures',async()=>{
  for(const [status,message] of [[401,'expired'],[403,'denied'],[429,'rate limited'],[503,'temporarily unavailable']] as const){
    await expect(verifyProvider(proof,(async()=>new Response('',{status})) as typeof fetch)).rejects.toThrow(message);
  }
  await expect(verifyProvider(proof,(async()=>{throw new Error('secret provider details')}) as typeof fetch)).rejects.toThrow('Verification network request failed');
});
test('verification still rejects mismatched subscription identity',async()=>{
  expect(await verifyProvider(proof,(async()=>Response.json({account_id:'different'})) as typeof fetch)).toBeNull();
});
