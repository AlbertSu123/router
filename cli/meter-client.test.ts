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
test('abandoned clients finalize accounting before headers and without reading the response',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'router-abort-test-'));
  try{
    const module=new URL('./meter-client.ts',import.meta.url).pathname;
    const script=`
      import {Database} from 'bun:sqlite';
      const {saveSession,atomicJSON,fingerprint,beginMeter}=await import(${JSON.stringify(module)});
      const dir=process.env.ROUTER_METER_STATE_DIR;
      const check=(v,m)=>{if(!v)throw new Error(m)};
      saveSession({token:'fake-session',user:{id:'alice',name:'Alice',handle:'alice'},device:'device'});
      const credential={provider:'claude',profile:'shared',accessToken:'fake'};
      atomicJSON(dir+'/meter-subscriptions.json',[{id:'a'.repeat(64),fingerprint:fingerprint('fake'),provider:'claude',profile:'shared',windows:[],verifiedAt:Date.now()}]);
      const db=new Database(dir+'/meter-queue.sqlite',{create:true});
      const controller=new AbortController();const wrap=await beginMeter(credential,controller.signal);
      controller.abort();
      let rows=db.query('SELECT ready,event FROM queue').all();
      check(rows.length===1&&rows[0].ready===1,'Canceled pre-header request stayed in flight');
      check(JSON.parse(rows[0].event).status===499&&!JSON.parse(rows[0].event).complete,'Cancellation not represented honestly');
      await wrap(Response.json({type:'message',usage:{input_tokens:99,output_tokens:20}})).text();
      check(JSON.parse(db.query('SELECT event FROM queue').get().event).input===0,'Late response overwrote canceled accounting');
      const second=new AbortController();const wrap2=await beginMeter(credential,second.signal);let canceled=false;
      wrap2(new Response(new ReadableStream({cancel(){canceled=true}}),{headers:{'content-type':'text/event-stream'}}));
      second.abort();await new Promise(r=>setTimeout(r,10));
      rows=db.query('SELECT ready,event FROM queue').all();
      check(rows.every(r=>r.ready===1),'Unread canceled stream stayed in flight');check(canceled,'Unread upstream was not canceled');
      // Exercise Bun's real HTTP disconnect signal, not only a synthetic abort.
      const {createClaudeHandler}=await import(${JSON.stringify(new URL('./meter-control.ts',import.meta.url).pathname)});
      for(const phase of ['before-headers','streaming']){
        let entered;const started=new Promise(r=>entered=r);let stopped=false;
        const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:createClaudeHandler({credentials:async()=>[credential],upstream:async(_url,init)=>{
          entered();
          if(phase==='before-headers')return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>{stopped=true;reject(new Error('client left'))},{once:true}));
          return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('data: {"type":"message_start","message":{"usage":{"input_tokens":7}}}\\n\\n'))},cancel(){stopped=true}}),{headers:{'content-type':'text/event-stream'}});
        }})});
        try{
          const client=new AbortController();
          const pending=fetch('http://127.0.0.1:'+server.port+'/v1/messages',{method:'POST',headers:{authorization:'Bearer fake'},body:'{}',signal:client.signal}).catch(()=>null);
          await started;if(phase==='streaming'){const response=await pending;await response.body.getReader().read()}
          client.abort();await pending;
          for(let i=0;i<100;i++){if(stopped&&db.query('SELECT count(*) n FROM queue WHERE ready=0').get().n===0)break;await Bun.sleep(10)}
          check(stopped,'Real HTTP disconnect did not stop '+phase);
          check(db.query('SELECT count(*) n FROM queue WHERE ready=0').get().n===0,'Real HTTP disconnect left accounting open '+phase);
        }finally{await server.stop(true)}
      }
      db.close();console.log('abort integration passed');
    `;
    const child=Bun.spawn([process.execPath,'-e',script],{env:{...process.env,ROUTER_METER_STATE_DIR:dir},stdout:'pipe',stderr:'pipe'});
    const [stdout,stderr]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect({exit:await child.exited,stderr}).toEqual({exit:0,stderr:''});expect(stdout).toContain('abort integration passed');
  }finally{rmSync(dir,{recursive:true,force:true})}
});
