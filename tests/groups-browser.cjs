const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox'] });
  try {
    for (const width of [1280, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 844 }, serviceWorkers: 'block' });
      const page = await context.newPage(); const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/cloud-connection.js*', route => route.fulfill({ contentType: 'text/javascript', body: `
        (()=>{let revision=0,chat={chats:[],messages:{},sessions:{}},groups={revision:2,groups:[{id:'development',name:'Desarrollo real',director:'limpatexdev-cloud',members:['limpatexdevsenior','limpatexqa'],objective:'Analizar y revisar.'}]};
        window.hermesCloud={isConnected:()=>true,ownerScope:()=>'personal',isLive:()=>true,isRevoking:()=>false,openVoice:()=>Promise.resolve(),closeVoice:()=>{},open(){},storage:async(op,args={})=>{if(op==='identity')return{scope:'personal'};if(op==='getState')return{revision,snapshot:structuredClone(chat)};if(op==='putState'){chat=structuredClone(args.snapshot);return{revision:++revision,snapshot:structuredClone(chat)}};if(op==='getGroupCatalog')return{director:{id:'limpatexdev-cloud',label:'Director',available:true},specialists:[{id:'limpatexdevsenior',label:'Senior',available:true},{id:'limpatexqa',label:'QA',available:true}]};if(op==='getGroups')return structuredClone(groups);if(op==='putGroups'){groups={revision:args.expectedRevision+1,groups:structuredClone(args.groups)};return structuredClone(groups)};if(op==='startGroupRun')return{id:args.runId,groupId:args.groupId,state:'completed',steps:[{profile:'limpatexdevsenior',stage:'análisis',status:'completed'}],text:'Síntesis del director',error:''};if(op==='getGroupRuns')return{runs:[]};if(op==='putAudio')return{};throw Error('unexpected '+op)},chat:async()=>({text:'ok'})};})();
      ` }));
      await page.goto(process.env.BROWSER_BASE_URL || 'http://127.0.0.1:8765');
      if (width < 600) await page.locator('#openSidebar').click();
      await page.locator('#syncBtn').click();
      await page.getByRole('button', { name: 'Desarrollo real' }).waitFor();
      await page.getByRole('button', { name: 'Desarrollo real' }).click();
      await page.locator('#groupMessage').fill('Consulta independiente');
      await page.locator('#startGroupBtn').click();
      await page.getByText('Síntesis del director').waitFor();
      assert.match(await page.locator('#groupNotice').textContent(), /independiente/);
      assert.match(await page.locator('#groupNotice').textContent(), /herramientas están deshabilitadas/);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual(errors, []);
      console.log(`PASS groups ${width}px: UI list/detail/run, disclosure, no overflow/errors. Remote simulated`);
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
