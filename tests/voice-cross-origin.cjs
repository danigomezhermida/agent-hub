/* Real UI + both actual bridge scripts and two real browser origins.
   Only authenticated HTTP/WS services are simulated; never reaches production. */
const {chromium}=require('playwright');
const fs=require('node:fs'); const path=require('node:path'); const assert=require('node:assert/strict');
const APP='https://agent-hub-theta-five.vercel.app', HERMES='https://future-rich-0308.agents.nousresearch.com';
(async()=>{
 const fixture=require('./voice-fixture.cjs')();
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true,args:['--no-sandbox','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream',`--use-file-for-fake-audio-capture=${fixture}`,'--autoplay-policy=no-user-gesture-required']});
 const context=await browser.newContext({serviceWorkers:'block'}); const errors=[]; const submitted=[]; let revision=0;let snapshot={chats:[],messages:{},sessions:{}};const bindings={};const ledger=new Map();
 context.on('page',page=>page.on('pageerror',e=>errors.push(e.message)));
 await context.addInitScript(()=>{if(!location.protocol.startsWith('http'))return;localStorage.setItem('agenthub.hermes.authorized.v1','1');localStorage.setItem('agenthub.connector.granted.v1','1');});
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url()); const pathname=url.pathname;
  if(url.origin===APP){
   const name=pathname==='/'?'index.html':pathname.slice(1);
   if(!['index.html','app.js','cloud-sync.js','cloud-connection.js','voice-ui.js','voice-engine.js','styles.css','manifest.webmanifest','sw.js'].includes(name))return route.fulfill({status:404,body:''});
   return route.fulfill({path:path.resolve(name)});
  }
  if(url.origin!==HERMES)return route.abort();
  const json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  if(pathname==='/api/plugins/agent-hub/identity')return json({scope:'personal'});
  if(pathname==='/api/plugins/agent-hub/state'&&route.request().method()==='GET')return json({revision,snapshot});
  if(pathname==='/api/plugins/agent-hub/state'&&route.request().method()==='PUT'){
   const body=route.request().postDataJSON();if(body.expectedRevision!==revision)return json({error:'conflict'},409);snapshot=body.snapshot;revision+=1;return json({revision,snapshot});
  }
  if(pathname==='/api/plugins/agent-hub/bindings')return json({bindings});
  if(pathname.startsWith('/api/plugins/agent-hub/bindings/')&&route.request().method()==='PUT'){
   const chatId=decodeURIComponent(pathname.split('/').at(-1)),body=route.request().postDataJSON();if((bindings[chatId]??null)!==body.expectedSessionId)return json({error:'conflict'},409);bindings[chatId]=body.sessionId;return json({chatId,sessionId:body.sessionId});
  }
  if(pathname.startsWith('/api/plugins/agent-hub/turns/')){
   const parts=pathname.split('/').filter(Boolean),chatId=decodeURIComponent(parts[4]),clientId=parts[5]&&decodeURIComponent(parts[5]);
   if(route.request().method()==='POST'){const body=route.request().postDataJSON(),turn={chatId,...body,state:'pending'};ledger.set(`${chatId}:${body.clientMessageId}`,turn);return json({claimed:true,turn});}
   if(route.request().method()==='PATCH'){const body=route.request().postDataJSON(),turn=ledger.get(`${chatId}:${clientId}`);Object.assign(turn,{state:body.state,...(body.state==='completed'?{text:body.text}:{})});return json({turn});}
   return json({turn:ledger.get(`${chatId}:${url.searchParams.get('clientMessageId')}`)||null});
  }
  if(pathname.startsWith('/api/plugins/agent-hub/audio/'))return json({ok:true});
  if(pathname==='/api/auth/ws-ticket')return route.fulfill({json:{ticket:'test-only-ticket'}});
  if(pathname==='/api/audio/transcribe')return route.fulfill({json:{ok:true,transcript:'Prueba real del contrato entre orígenes',provider:'test'}});
  if(pathname==='/api/audio/speak'){
   if(route.request().postDataJSON().text==='DELAY')await new Promise(r=>setTimeout(r,4000));
   return route.fulfill({json:{ok:true,data_url:'data:audio/wav;base64,'+fs.readFileSync(fixture).toString('base64'),mime_type:'audio/wav',provider:'test'}}).catch(()=>{});
  }
  if(pathname.endsWith('/connect.html')){const html=fs.readFileSync(path.resolve('hermes-plugin/dashboard/connect.html'),'utf8').replace('<script src="dist/connector.js','<script src="dist/turn-recovery.js"></script><script src="dist/connector.js');return route.fulfill({contentType:'text/html',body:html});}
  if(pathname.endsWith('/dist/storage-transport.js'))return route.fulfill({path:path.resolve('hermes-plugin/dashboard/dist/storage-transport.js')});
  if(pathname.endsWith('/dist/turn-recovery.js'))return route.fulfill({path:path.resolve('hermes-plugin/dashboard/dist/turn-recovery.js')});
  if(pathname.endsWith('/dist/connector.js'))return route.fulfill({path:path.resolve('hermes-plugin/dashboard/dist/connector.js')});
  return route.fulfill({status:404,body:''});
 });
 await context.routeWebSocket(HERMES.replace('https','wss')+'/**',ws=>{
  ws.onMessage(raw=>{const d=JSON.parse(raw);let result={};
   if(d.method==='session.create'||d.method==='session.resume')result={session_id:'live-test',stored_session_id:'stored-test'};
   if(d.method==='prompt.submit')result={status:'streaming'};
   ws.send(JSON.stringify({jsonrpc:'2.0',id:d.id,result}));
   if(d.method==='prompt.submit'){submitted.push(d.params.text);setTimeout(()=>{try{ws.send(JSON.stringify({jsonrpc:'2.0',method:'event',params:{type:'message.complete',session_id:'live-test',payload:{text:'Respuesta simulada del servicio, puente real'}}}));}catch{}},20);}
  });
 });
 try{
  const page=await context.newPage();await page.goto(APP);
  await page.click('#syncBtn');await page.waitForFunction(()=>!document.body.classList.contains('sync-locked'));
  await page.click('#heroMicBtn');await page.waitForFunction(()=>document.querySelector('#voiceStatus').textContent.includes('Grabando'));
  await page.waitForTimeout(800);await page.click('#voiceFinish');await page.click('#voiceSend');
  await page.waitForFunction(()=>document.querySelector('#messageList').textContent.includes('Respuesta simulada del servicio, puente real'));
  assert.equal(await page.locator('#messageList .msg-user').count(),1);assert.equal(submitted.length,1);
  assert.match(await page.locator('#messageList').textContent(),/Prueba real del contrato/);
  await page.waitForFunction(()=>!voiceUI.busy);
  // Delay synthesis, cancel, and reuse the same bridge for STT without waiting four seconds.
  const elapsed=await page.evaluate(async()=>{
   await hermesCloud.openVoice(); const id=location.hash.slice(6);const c=new AbortController();const start=performance.now();
   const pending=hermesCloud.synthesize({chatId:id,text:'DELAY',signal:c.signal});setTimeout(()=>c.abort(),100);
   try{await pending;throw Error('expected cancellation');}catch{}
   const next=await hermesCloud.transcribe({chatId:id,blob:new Blob(['fixture'],{type:'audio/webm'})});
   if(!next.text)throw Error('new turn did not start');const elapsed=performance.now()-start;
   const audio=await hermesCloud.synthesize({chatId:id,text:'PLAY'});
   if(!(audio.blob instanceof Blob))throw Error('wrong TTS contract');
   hermesCloud.closeVoice();return elapsed;
  });
  assert.ok(elapsed<2000,'interruption must not wait for delayed synthesis');
  await page.click('#voiceBtn');await page.waitForFunction(()=>document.querySelector('#voiceDialog').dataset.state==='speaking',null,{timeout:15000});
  await page.waitForFunction(()=>voiceUI.playback && !voiceUI.playback.paused);
  await page.click('#voiceInterrupt');await page.click('#voiceCancel');await page.reload();await page.click('#syncBtn');await page.waitForSelector('#messageList audio');
  assert.equal(await page.locator('#messageList audio').count(),1);
  assert.deepEqual(errors,[]);
  console.log('PASS actual UI/client/connector cross-origin: STT contract, one note/turn, TTS Blob playback, abort <2s, next request, reload. Remote HTTP/WS simulated.');
 }finally{await context.close();await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
