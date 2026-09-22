import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
test('durable queue survives offline sync and personal switches without misattribution or early upload',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'router-queue-test-'));
  try {
    const module=new URL('./meter-client.ts',import.meta.url).pathname;
    const script=`
      import {Database} from 'bun:sqlite';
      const {saveSession,atomicJSON,fingerprint,beginMeter,syncMeter}=await import(${JSON.stringify(module)});
      const check=(v,m)=>{if(!v)throw new Error(m)};
      const dir=process.env.ROUTER_METER_STATE_DIR;
      const alice={token:'alice-session',user:{id:'alice',name:'Alice',handle:'alice'},device:'alice-device'};
      const bob={token:'bob-session',user:{id:'bob',name:'Bob',handle:'bob'},device:'bob-device'};
      const credential={provider:'codex',profile:'shared',accessToken:'fake-access',accountId:'account'};
      const sub='a'.repeat(64);
      const mapping={id:sub,label:'shared',provider:'codex',profile:'shared',fingerprint:fingerprint('fake-accessaccount'),verifiedAt:Date.now(),windows:[]};
      saveSession(alice);atomicJSON(dir+'/meter-subscriptions.json',[mapping]);
      let offline=true;const sent=[];
      globalThis.fetch=async(url,init)=>{
        if(String(url).endsWith('/events')){const body=JSON.parse(init.body);sent.push(body.events);if(offline)throw new Error('Network offline');return Response.json({accepted:body.events.map(e=>e.id)})}
        return Response.json({ok:true});
      };
      const wrap=await beginMeter(credential);
      await syncMeter([credential]);check(sent.length===0,'An in-flight request uploaded too early');
      saveSession(bob);
      const text='data: '+JSON.stringify({type:'response.completed',response:{model:'test',usage:{input_tokens:100,input_tokens_details:{cached_tokens:60},output_tokens:25}}})+'\\n\\n';
      await wrap(new Response(text,{headers:{'content-type':'text/event-stream'}})).text();
      const db=new Database(dir+'/meter-queue.sqlite');let row=db.query('SELECT * FROM queue').get();
      check(row.user==='alice','Request was reattributed after personal sign-in changed');check(JSON.parse(row.event).subscription===sub,'Subscription changed');
      await syncMeter([credential]);check(sent.length===0,'Bob uploaded Alice usage');
      saveSession(alice);await syncMeter([credential]);check(sent.length===1,'Offline upload not attempted');check(db.query('SELECT count(*) n FROM queue').get().n===1,'Offline usage lost');
      offline=false;await syncMeter([credential]);check(sent.length===2,'Retry missing');check(sent[0][0].id===sent[1][0].id,'Retry changed event identity');
      check(sent[1][0].input===100&&sent[1][0].cached===60&&sent[1][0].output===25,'Counters changed');check(db.query('SELECT count(*) n FROM queue').get().n===0,'Acknowledged usage remained queued');
      await syncMeter([credential]);check(sent.length===2,'Acknowledged usage replayed');db.close();console.log('queue integration passed');
    `;
    const child=Bun.spawn([process.execPath,'-e',script],{env:{...process.env,ROUTER_METER_STATE_DIR:dir},stdout:'pipe',stderr:'pipe'});
    const [stdout,stderr]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect({exit:await child.exited,stderr}).toEqual({exit:0,stderr:''});expect(stdout).toContain('queue integration passed');
  }finally{rmSync(dir,{recursive:true,force:true})}
});
