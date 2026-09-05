const {chromium}=require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true,args:['--no-sandbox']});
 try{for(const width of [1280,390]){
 const context=await browser.newContext({viewport:{width,height:844},serviceWorkers:'block'});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/cloud-connection.js*',route=>route.fulfill({contentType:'text/javascript',body:`(()=>{let revision=0,remote={chats:[],messages:{},sessions:{}};window.hermesCloud={isConnected:()=>true,ownerScope:()=>'personal',isLive:()=>true,isRevoking:()=>false,openVoice:async()=>{},storage:async(op,args={})=>{if(op==='identity')return{scope:'personal'};if(op==='getState')return{revision,snapshot:structuredClone(remote)};if(op==='putState'){if(args.expectedRevision!==revision){const e=Error('conflict');e.code='conflict';throw e;}remote=structuredClone(args.snapshot);return{revision:++revision,snapshot:structuredClone(remote)};}if(op==='putAudio')return{};throw Error('unexpected mocked storage '+op);},chat:async(data)=>{window.sent=data;await new Promise(r=>setTimeout(r,300));return {text:'Respuesta simulada para validar la interfaz'};}};})();`}));
 await page.goto('http://127.0.0.1:8765');
 if(width<600)await page.locator('#openSidebar').click();
 await page.locator('#syncBtn').click(); await page.waitForFunction(()=>document.body.classList.contains('sync-locked')===false);
 if(width<600)await page.keyboard.press('Escape');
 await page.locator('#heroInput').fill('Buenas, ¿cómo estás?');await page.locator('#heroInput').press('Enter');
 await page.locator('#messageList').getByText('Respuesta simulada para validar la interfaz').waitFor();
 assert.equal(await page.locator('#viewHome').isVisible(),false);assert.equal(await page.locator('.msg-user').count(),1);
 assert.equal(await page.evaluate(()=>{const snapshot=JSON.parse(localStorage.getItem('agenthub.conversations.v3'));const id=Object.values(snapshot.messages).flat().find(m=>m.role==='user').id;return sent.clientMessageId===id;}),true,'bridge receives the durable message id');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.screenshot({path:`/opt/data/agenthub-composer-${width}.png`});
 await page.reload();if(width<600)await page.locator('#openSidebar').click();await page.locator('#syncBtn').click();await page.locator('.msg-user').waitFor();assert.equal(await page.locator('#viewHome').isVisible(),false);
 assert.deepEqual(errors,[]);console.log(`PASS ${width}px: Enter, isolated chat, one message, response, reload, no overflow/errors`);await context.close();
 }}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
