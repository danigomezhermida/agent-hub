const {chromium}=require('playwright');const assert=require('node:assert/strict');const fs=require('node:fs');
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
 try{for(const width of [1280,390]){
  const context=await browser.newContext({viewport:{width,height:844},serviceWorkers:'block'});const page=await context.newPage();
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/cloud-connection.js*',route=>route.fulfill({contentType:'application/javascript',body:`(() => {
   let live=false;let verified=false;let revision=0;
   let snapshot={chats:[{id:'recovery_chat',title:'Turno pendiente',desc:'',time:'ahora',agents:[],model:'default',effort:'medium'}],messages:{recovery_chat:[{id:'m1',role:'user',text:'Objetivo previo',delivery:'uncertain',status:'uncertain'}]},sessions:{}};
   window.qaSubmitCount=0;window.qaMode='uncertain';
   window.hermesCloud={isConnected:()=>true,isRevoking:()=>false,ownerScope:()=>verified?'personal':null,isLive:()=>live,openVoice:()=>{live=true;verified=true;return Promise.resolve()},closeVoice:()=>{live=false},open(){},disconnect(){},
    storage:async(op,args)=>{if(op==='identity')return{scope:'personal'};if(op==='getState')return{revision,snapshot:structuredClone(snapshot)};if(op==='putState'){if(args.expectedRevision!==revision)throw Object.assign(new Error('conflict'),{code:'conflict'});snapshot=structuredClone(args.snapshot);revision++;return{revision,snapshot:structuredClone(snapshot)}}throw new Error('unexpected storage '+op)},
    chat:async()=>{window.qaSubmitCount++;throw new Error('must not submit')},recover:async({chatId,clientMessageId})=>({chatId,clientMessageId,state:window.qaMode,text:window.qaMode==='completed'?'Respuesta recuperada':'',history:[{role:'assistant',text:'Evidencia no correlacionada'}]})};
  })();`}))
  await page.goto('http://127.0.0.1:8765/');
  assert.deepEqual(errors,[]);
  if(width<600)await page.locator('#openSidebar').click();
  await page.locator('#syncBtn').click();
  await page.waitForFunction(()=>!document.body.classList.contains('sync-locked'));
  await page.locator('#chatList').getByText('Turno pendiente',{exact:true}).click();
  await page.locator('#recoverBtn').click();await page.locator('dialog[data-turn-evidence]').waitFor({state:'visible'});
  assert.match(await page.locator('dialog[data-turn-evidence]').innerText(),/No se ha reenviado nada/);
  assert.equal(await page.evaluate(()=>window.qaSubmitCount),0);
  fs.mkdirSync('test-results',{recursive:true});await page.screenshot({path:'test-results/recovery-'+width+'.png',fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  page.once('dialog',dialog=>dialog.accept());
  await page.getByRole('button',{name:'Archivar y abrir conversación nueva',exact:true}).click();
  await page.waitForFunction(()=>!document.body.classList.contains('chat-open'));
  assert.equal(await page.evaluate(()=>window.qaSubmitCount),0);
  console.log('PASS '+width+'px recovery inspection and explicit archive/new-chat: zero prompt submissions. Remote mocked.');
  assert.deepEqual(errors,[]);await context.close();
 }}finally{await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
