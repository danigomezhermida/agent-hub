/* Real Chromium media/IndexedDB UI QA; only the remote bridge is a test double. */
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const voiceFixture = require('./voice-fixture.cjs')();
const artifactDir = require('node:path').resolve(process.env.ARTIFACT_DIR || 'test-results');
require('node:fs').mkdirSync(artifactDir, {recursive:true});
(async () => {
  const browser = await chromium.launch({executablePath: process.env.CHROMIUM_PATH, headless:true, args:['--no-sandbox','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--use-file-for-fake-audio-capture='+voiceFixture,'--autoplay-policy=no-user-gesture-required']});
  try {
    for (const width of [1280,390]) {
      const context = await browser.newContext({viewport:{width,height:850}, permissions:['microphone'], serviceWorkers:'block'});
      await context.addInitScript(() => {
        window.qaTracks=[];
        const capture=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia=async opts=>{ if(window.qaDeny) throw new DOMException('Denied','NotAllowedError'); let stream;try{stream=await capture(opts);}catch(e){window.qaCaptureError={name:e.name,message:e.message};throw e;} window.qaTracks.push(...stream.getTracks()); return stream; };
      });
      await context.route('**/cloud-connection.js*',route=>route.fulfill({contentType:'application/javascript',body:`(()=>{let revision=0,remote={chats:[],messages:{},sessions:{}};window.qaCalls=[];window.qaSTT=[];window.hermesCloud={isConnected:()=>window.qaAuth!==false,ownerScope:()=>window.qaAuth===false?null:'personal',isLive:()=>true,isRevoking:()=>false,open(){},disconnect:async()=>{},openVoice:async()=>{},closeVoice(){},storage:async(op,args={})=>{if(op==='identity')return{scope:'personal'};if(op==='getState')return{revision,snapshot:structuredClone(remote)};if(op==='putState'){if(args.expectedRevision!==revision){const e=Error('conflict');e.code='conflict';throw e;}remote=structuredClone(args.snapshot);return{revision:++revision,snapshot:structuredClone(remote)};}if(op==='putAudio')return{};if(op==='getAudio')return null;throw Error('unexpected mocked storage '+op);},transcribe:async d=>{qaSTT.push(d.chatId);if(window.qaFailSTT)throw Error('test');return{text:'Esta es una prueba de voz',chatId:d.chatId}},synthesize:async()=>({blob:await(await fetch('/qa-audio.wav')).blob()}),chat:async d=>{qaCalls.push(d);return{text:'Respuesta de prueba remota simulada',sessionId:'qa-session'}}};})();`}));
      await context.route('**/qa-audio.wav',route=>route.fulfill({path:voiceFixture,contentType:'audio/wav'}));
      const page=await context.newPage(); const errors=[]; page.on('pageerror',e=>{errors.push(e.message);console.error('BROWSER_ERROR',e.message);});
      await page.goto('http://127.0.0.1:8765/');
      if(width<600)await page.click('#openSidebar');
      await page.click('#syncBtn'); await page.waitForFunction(()=>!document.body.classList.contains('sync-locked'));
      if(width<600)await page.keyboard.press('Escape');
      await page.evaluate(()=>{const start=AgentVoice.Recorder.prototype.start;AgentVoice.Recorder.prototype.start=async function(){try{return await start.call(this);}catch(e){window.qaRecorderError={name:e.name,code:e.code,message:e.message,cause:e.cause?.message};throw e;}};});
      // Canonical authorization is checked before permission or local records.
      await page.evaluate(()=>window.qaAuth=false); await page.click('#heroMicBtn');
      assert.equal(await page.locator('#voiceDialog').isVisible(),false);
      assert.equal(await page.evaluate(()=>qaTracks.length),0);
      await page.evaluate(()=>{window.qaAuth=true;window.dispatchEvent(new Event('hermes-connection'));});
      if(width<600)await page.click('#openSidebar');
      await page.click('#syncBtn'); await page.waitForFunction(()=>!document.body.classList.contains('sync-locked'));
      if(width<600)await page.keyboard.press('Escape');
      // Denial is recoverable and creates no record.
      await page.evaluate(()=>window.qaDeny=true); await page.click('#heroMicBtn');
      await page.waitForFunction(()=>document.querySelector('#voiceStatus').textContent.includes('No se pudo abrir'));
      await page.click('#voiceCancel');
      assert.equal(await page.locator('#viewHome').isVisible(),true);
      await page.evaluate(()=>window.qaDeny=false);
      // Cancel a real recording and check every track is stopped.
      await page.click('#heroMicBtn'); await page.waitForFunction(()=>document.querySelector('#voiceStatus').textContent.includes('Grabando')).catch(async e=>{console.log(await page.evaluate(()=>({status:document.querySelector('#voiceStatus').textContent,tracks:qaTracks.map(t=>t.readyState),captureError:window.qaCaptureError,recorderError:window.qaRecorderError})));throw e;});
      await page.waitForTimeout(400); await page.click('#voiceCancel');
      assert.equal(await page.evaluate(()=>qaTracks.every(t=>t.readyState==='ended')),true);
      assert.equal(await page.evaluate(()=>qaCalls.length),0);
      // Record, review, send; failure remains one persistent audio message.
      await page.click('#heroMicBtn'); await page.waitForFunction(()=>document.querySelector('#voiceStatus').textContent.includes('Grabando')).catch(async e=>{console.log(await page.evaluate(()=>({status:document.querySelector('#voiceStatus').textContent,tracks:qaTracks.map(t=>t.readyState),captureError:window.qaCaptureError,recorderError:window.qaRecorderError})));throw e;});
      await page.waitForTimeout(1600); await page.screenshot({path:artifactDir+'/agenthub-voice-recording-'+width+'.png'});
      await page.click('#voiceFinish'); await page.waitForSelector('#voiceSend:visible');
      assert.equal(await page.locator('#voicePreview').isVisible(),true);
      await page.evaluate(()=>document.querySelector('#voicePreview').play());
      // Failed binary storage keeps the review draft and does not create a chat.
      await page.evaluate(()=>{const put=IDBObjectStore.prototype.put;window.qaRestoreStore=()=>IDBObjectStore.prototype.put=put;IDBObjectStore.prototype.put=function(...args){if(this.name==='audio')throw new DOMException('Full','QuotaExceededError');return put.apply(this,args);};});
      await page.click('#voiceSend'); await page.waitForFunction(()=>document.querySelector('#voiceStatus').textContent.includes('La grabación sigue aquí'));
      assert.equal(await page.locator('#voicePreview').isVisible(),true);
      assert.equal(await page.evaluate(()=>qaCalls.length),0);
      assert.equal(await page.evaluate(()=>Object.values(JSON.parse(localStorage.getItem('agenthub.conversations.v3')).messages).flat().filter(m=>m.role==='audio').length),0);
      await page.evaluate(()=>{qaRestoreStore();window.qaFailSTT=true;}); await page.click('#voiceSend');
      await page.waitForSelector('[data-retry-audio]');
      assert.equal(await page.locator('#viewHome').isVisible(),false);
      assert.equal(await page.locator('.msg-audio').count(),1);
      assert.equal(await page.evaluate(()=>qaCalls.length),0);
      await page.evaluate(()=>window.qaFailSTT=false); await page.click('[data-retry-audio]');
      await page.waitForFunction(()=>document.querySelector('.msg-agent')?.textContent.includes('Respuesta de prueba'));
      assert.equal(await page.locator('.msg-audio').count(),1);
      assert.equal(await page.evaluate(()=>qaCalls.length),1);
      assert.equal(await page.evaluate(()=>{const entry=Object.values(JSON.parse(localStorage.getItem('agenthub.conversations.v3')).messages).flat().find(m=>m.role==='audio');return qaCalls[0].clientMessageId===entry.id;}),true);
      const chatId=await page.evaluate(()=>qaCalls[0].chatId);
      await page.reload();if(width<600)await page.click('#openSidebar'); await page.click('#syncBtn'); await page.waitForSelector('audio[data-audio-id][src]');if(width<600)await page.mouse.click(380,400);
      assert.equal(await page.locator('.msg-audio').count(),1);
      assert.match(await page.locator('.transcript').textContent(),/Esta es una prueba/);
      assert.equal(await page.evaluate(()=>location.hash),'#chat='+chatId);
      await page.screenshot({path:artifactDir+'/agenthub-voice-note-'+width+'.png'});
      // Continuous call uses actual media capture/VAD; transport/TTS only mocked.
      await page.click('#voiceBtn'); await page.waitForFunction(()=>document.querySelector('#voiceDialog').dataset.state==='listening');
      await page.click('#voiceMute');
      assert.equal(await page.evaluate(()=>qaTracks.filter(t=>t.readyState==='live').every(t=>!t.enabled)),true);
      await page.click('#voiceMute');
      assert.equal(await page.evaluate(()=>qaTracks.filter(t=>t.readyState==='live').every(t=>t.enabled)),true);
      await page.screenshot({path:artifactDir+'/agenthub-voice-live-'+width+'.png'});
      await page.waitForFunction(()=>qaCalls.length>=1,{},{timeout:25000});
      await page.waitForFunction(()=>document.querySelector('#voiceDialog').dataset.state==='speaking',{},{timeout:15000});
      await page.click('#voiceInterrupt');
      assert.equal(await page.evaluate(()=>qaCalls.every(c=>c.chatId===location.hash.slice(6))),true);
      await page.evaluate(()=>window.dispatchEvent(new Event('hermes-voice-closed')));
      await page.waitForSelector('#voiceRetry:visible');
      await page.waitForFunction(()=>qaTracks.every(t=>t.readyState==='ended'));
      await page.click('#voiceRetry');
      await page.waitForFunction(()=>document.querySelector('#voiceStatus').textContent==='Escuchando');
      await page.click('#voiceCancel');
      assert.equal(await page.evaluate(()=>qaTracks.every(t=>t.readyState==='ended')),true);
      const count=await page.locator('#messageList .msg-user').count(); await page.reload();if(width<600)await page.click('#openSidebar'); await page.click('#syncBtn');await page.waitForFunction(()=>!document.body.classList.contains('sync-locked'));if(width<600)await page.mouse.click(380,400);
      assert.equal(await page.locator('#messageList .msg-user').count(),count);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      assert.deepEqual(errors,[]);
      console.log('PASS '+width+'px: denied/accepted, recording/cancel/review/send/STT retry, IndexedDB reload, VAD call/mute/interrupt/end/history/no overflow');
      await context.close();
    }
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
