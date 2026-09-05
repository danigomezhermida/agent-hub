const {chromium}=require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true,args:['--no-sandbox']});
 try{for(const width of [1280,390]){
 const page=await browser.newPage({viewport:{width,height:844}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/cloud-connection.js*',route=>route.fulfill({contentType:'text/javascript',body:`window.hermesCloud={isConnected:()=>true,isLive:()=>false,isRevoking:()=>false,chat:async(data)=>{window.sent=data;await new Promise(r=>setTimeout(r,300));return {text:'Respuesta simulada para validar la interfaz'};}};`}));
 await page.goto('http://127.0.0.1:8765');await page.locator('#heroInput').fill('Buenas, ¿cómo estás?');await page.locator('#heroInput').press('Enter');
 await page.locator('#messageList').getByText('Respuesta simulada para validar la interfaz').waitFor();
 assert.equal(await page.locator('#viewHome').isVisible(),false);assert.equal(await page.locator('.msg-user').count(),1);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.screenshot({path:`/opt/data/agenthub-composer-${width}.png`});
 await page.reload();await page.locator('.msg-user').waitFor();assert.equal(await page.locator('#viewHome').isVisible(),false);
 assert.deepEqual(errors,[]);console.log(`PASS ${width}px: Enter, isolated chat, one message, response, reload, no overflow/errors`);await page.close();
 }}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
