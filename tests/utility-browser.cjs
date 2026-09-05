const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const base = process.env.BROWSER_BASE_URL || 'http://127.0.0.1:8765';
const evidence = process.env.EVIDENCE_DIR || '/opt/data/profiles/limpatexdev-cloud/reports/agenthub-utility-fixes';
const answer = '# Informe\n\n- Primera acción\n- Segunda acción\n\n```js\nconst estado = "verificado";\n```';
const mock = `(()=>{
 let revision=0,snapshot={chats:[],messages:{},sessions:{}},run=null,polls=0;
 const group={id:'development',name:'Desarrollo QA de interfaz',director:'limpatexdev-cloud',members:['limpatexqa'],objective:'Prueba UI con servicios simulados.'};
 window.uiTest={writes:0,polls:0};
 window.hermesCloud={isConnected:()=>true,isRevoking:()=>false,ownerScope:()=>'personal',isLive:()=>true,open(){},openVoice:async()=>{},closeVoice(){},
 storage:async(op,args={})=>{
  if(op==='identity')return{scope:'personal'};
  if(op==='getState')return{revision,snapshot:structuredClone(snapshot)};
  if(op==='putState'){if(args.expectedRevision!==revision)throw Error('CAS mismatch');snapshot=structuredClone(args.snapshot);return{revision:++revision,snapshot:structuredClone(snapshot)};}
  if(op==='getGroupCatalog')return{director:{id:'limpatexdev-cloud',label:'Director',available:true},specialists:[{id:'limpatexqa',label:'QA',available:true}]};
  if(op==='getGroups')return{revision:1,groups:[group]};
  if(op==='startGroupRun'){window.uiTest.writes++;run={id:args.runId,groupId:args.groupId,state:'running',steps:[],text:'',message:'Consulta actual'};return structuredClone(run);}
  if(op==='getGroupRun'){window.uiTest.polls++;run.state=++polls>=2?'completed':'running';run.text=run.state==='completed'?${JSON.stringify(answer)}:'';return structuredClone(run);}
  if(op==='getGroupRuns')return{runs:[run,{id:'old_result',groupId:'development',state:'completed',steps:[],message:'Consulta anterior',text:'Resultado anterior verificado'}].filter(Boolean)};
  throw Error('Unexpected mock operation '+op);
 },chat:async()=>({text:${JSON.stringify(answer)}})};
})();`;
(async()=>{
 fs.mkdirSync(evidence,{recursive:true});
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true,args:['--no-sandbox']});
 try {
 for(const width of [320,360,390,1280]){
  const ctx=await browser.newContext({viewport:{width,height:844},serviceWorkers:'block'});
  const page=await ctx.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  // Real local shell/client, no fake identity. Only external login page is a controlled test page.
  await ctx.route('https://future-rich-0308.agents.nousresearch.com/**',r=>r.fulfill({contentType:'text/html',body:'<p>Proveedor de acceso SIMULADO: cerrar esta ventana.</p>'}));
  await page.goto(base);
  await page.locator('#loginOverlay.open').waitFor();
  assert.equal(await page.locator('#loginOverlay').getAttribute('aria-hidden'),'false');
  for(let i=0;i<6;i++){await page.keyboard.press(i%2?'Shift+Tab':'Tab');assert.ok(await page.evaluate(()=>document.querySelector('#loginOverlay').contains(document.activeElement)));}
  assert.equal(await page.evaluate(()=>document.querySelector('.layout').inert),true);
  assert.doesNotMatch(await page.locator('#loginForm').textContent(),/Perfil conectado/);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  if(width===390)await page.screenshot({path:evidence+'/390-access.png'});
  const popupEvent=page.waitForEvent('popup');await page.locator('#loginForm button').click();const popup=await popupEvent;await popup.close();
  await page.waitForFunction(()=>document.querySelector('#loginStatus').textContent.includes('se cerró'));
  await page.locator('#closeLoginBtn').click();
  assert.equal(await page.evaluate(()=>document.querySelector('.layout').inert),false);
  assert.equal(await page.locator('#loginOverlay').getAttribute('aria-hidden'),'true');
  if(width<600){
   await page.locator('#openSidebar').click();
   const sidebarBackground=await page.locator('#sidebar').evaluate(el=>getComputedStyle(el).backgroundColor);
   const alphaMatch=sidebarBackground.match(/^rgba?\([^)]*(?:,|\s\/\s)([\d.]+)\)$/);
   const alpha=sidebarBackground.startsWith('rgba')&&alphaMatch?Number(alphaMatch[1]):1;
   assert.equal(alpha,1,`mobile sidebar must be opaque, got ${sidebarBackground}`);
   await page.keyboard.press('Escape');
  }
  assert.deepEqual(errors,[]);await ctx.close();
  console.log(`ACCESS PASS ${width}px: real client modal/focus/cancel; external login page simulated, NO authenticated E2E.`);

  const auth=await browser.newContext({viewport:{width,height:844},serviceWorkers:'block',permissions:['clipboard-read','clipboard-write']});
  const p=await auth.newPage();const uiErrors=[];p.on('pageerror',e=>uiErrors.push(e.message));
  await p.route('**/cloud-connection.js*',r=>r.fulfill({contentType:'text/javascript',body:mock}));
  await p.goto(base);
  if(width<600)await p.locator('#openSidebar').click();
  await p.locator('#syncBtn').click();await p.waitForFunction(()=>!document.body.classList.contains('sync-locked'));
  if(width<600)await p.keyboard.press('Escape');
  await p.locator('#heroInput').fill('Primera consulta');await p.locator('#heroSendBtn').click();
  await p.locator('.safe-content-body h1').waitFor();
  assert.match(await p.locator('#chatProfile').textContent(),/Director/);
  assert.ok((await p.locator('.thread-title').boundingBox()).width>=180,'mobile identity must retain readable width');
  await p.locator('.copy-answer').click();await p.waitForFunction(()=>document.querySelector('.copy-answer').dataset.copyState==='success');
  assert.equal(await p.evaluate(()=>navigator.clipboard.readText()),answer);
  await p.locator('.copy-code').click();await p.waitForFunction(()=>document.querySelector('.copy-code').dataset.copyState==='success');
  assert.equal(await p.evaluate(()=>navigator.clipboard.readText()),'const estado = "verificado";');
  await p.locator('#messageInput').fill('Borrador privado A');
  await p.locator('#chatNewBtn').click();await p.locator('#heroInput').fill('Segunda consulta');await p.locator('#heroSendBtn').click();
  await p.locator('.safe-content-body h1').waitFor();assert.equal(await p.locator('#messageInput').inputValue(),'');
  if(width<600){await p.locator('#backBtn').click();await p.locator('#openSidebar').click();}
  await p.locator('#chatList').getByRole('button',{name:'Primera consulta',exact:true}).click();
  assert.equal(await p.locator('#messageInput').inputValue(),'Borrador privado A');
  if(width<600)await p.waitForFunction(()=>document.querySelector('.sidebar').getBoundingClientRect().right<=1);
  assert.equal(await p.locator('#messageInput').inputValue(),'Borrador privado A','draft survives asynchronous rendering');
  assert.ok((await p.locator('#messageInput').boundingBox()).height>=40,'restored draft must be visibly readable');
  if(width===390)await p.screenshot({path:evidence+'/390-answer.png'});
  if(width<600){await p.locator('#backBtn').click();await p.locator('#openSidebar').click();}
  await p.locator('#groupList button').click();await p.locator('#groupMessage').fill('Consulta actual');await p.locator('#startGroupBtn').click();
  await p.locator('#groupObservationStatus').getByText(/activo/).waitFor();
  await p.locator('#groupRunResult .safe-content-body h1').waitFor({timeout:15000});
  assert.equal(await p.evaluate(()=>window.uiTest.writes),1);
  assert.equal(await p.evaluate(()=>window.uiTest.polls),2);
  await p.locator('#refreshGroupRunBtn').click();await p.locator('#groupRunHistory button').filter({hasText:'Consulta anterior'}).click();
  await p.locator('#groupRunResult').getByText('Resultado anterior verificado').waitFor();
  await p.locator('#groupRunCurrent').click();await p.locator('#groupRunResult .safe-content-body h1').waitFor();
  assert.equal(await p.evaluate(()=>window.uiTest.writes),1);
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  if(width===390)await p.screenshot({path:evidence+'/390-group.png'});
  assert.deepEqual(uiErrors,[]);await auth.close();
  console.log(`UTILITY PASS ${width}px: per-chat drafts, Director label, structured answer, real clipboard, readonly polling x2 / submit x1, selectable history; AUTH/BACKEND SIMULATED.`);
 }
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
