const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox'] });
  const errors = [];
  try {
    for (const width of [1280, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 844 }, serviceWorkers: 'block' });
      const page = await context.newPage();
      page.on('pageerror', e => errors.push(e.message));
      // Cuenta guardada pero aún NO sincronizada: isConnected true, pero la app debe
      // mostrar la tarjeta de reconexión y no dar por sincronizado el historial.
      await page.route('**/cloud-connection.js*', route => route.fulfill({
        contentType: 'text/javascript',
        body: `(()=>{let revision=0,remote={chats:[],messages:{},sessions:{}};window.hermesCloud={isConnected:()=>true,ownerScope:()=>'personal',isLive:()=>true,isRevoking:()=>false,openVoice:async()=>{},openSync:async()=>{},storage:async(op,args={})=>{if(op==='identity')return{scope:'personal'};if(op==='getState')return{revision,snapshot:structuredClone(remote)};if(op==='putState'){if(args.expectedRevision!==revision){const e=Error('conflict');e.code='conflict';throw e;}remote=structuredClone(args.snapshot);return{revision:++revision,snapshot:structuredClone(remote)};}if(op==='putAudio')return{};throw Error('unexpected mocked storage '+op);},chat:async()=>{throw Error('no voice path expected in reconnect tour');}};})();`
      }));
      await page.goto('http://127.0.0.1:8765');
      // 1) Tarjeta de reconexión visible SIN abrir el panel lateral (móvil incluido)
      await page.waitForSelector('#reconnectCard:not([hidden])', { timeout: 5000 });
      const cardVisible = await page.locator('#reconnectCard').isVisible();
      assert.equal(cardVisible, true, `reconnect card visible without sidebar at ${width}px`);
      // 2) El botón único está presente y accesible
      const btnVisible = await page.locator('#reconnectNowBtn').isVisible();
      assert.equal(btnVisible, true, `reconnect button visible at ${width}px`);
      // 3) PRIMER TOQUE real (pointerdown en el cuerpo) dispara sync automático sin abrir cajón
      await page.mouse.move(width / 2, 300);
      await page.mouse.down();
      await page.mouse.up();
      // Tras sincronizar, la tarjeta debe ocultarse sola
      await page.waitForFunction(() => document.getElementById('reconnectCard').hidden === true, null, { timeout: 6000 });
      // 4) Estado de conexión sincronizada
      await page.waitForFunction(() => document.getElementById('connText').textContent.toLowerCase().includes('sincronizad'), null, { timeout: 6000 });
      assert.deepEqual(errors, []);
      await page.screenshot({ path: `/opt/data/agenthub-reconnect-${width}.png` });
      console.log(`PASS ${width}px: reconnect card visible without sidebar, first real touch auto-syncs, card hides on ready`);
      await context.close();
    }
    // 5) Recarga con autorización: el BOTÓN de reconexión también funciona solo
    const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    const p2 = await ctx2.newPage();
    p2.on('pageerror', e => errors.push(e.message));
    await p2.route('**/cloud-connection.js*', route => route.fulfill({
      contentType: 'text/javascript',
      body: `(()=>{let revision=0,remote={chats:[],messages:{},sessions:{}};window.hermesCloud={isConnected:()=>true,ownerScope:()=>'personal',isLive:()=>true,isRevoking:()=>false,openVoice:async()=>{},openSync:async()=>{},storage:async(op,args={})=>{if(op==='identity')return{scope:'personal'};if(op==='getState')return{revision,snapshot:structuredClone(remote)};if(op==='putState'){if(args.expectedRevision!==revision){const e=Error('conflict');e.code='conflict';throw e;}remote=structuredClone(args.snapshot);return{revision:++revision,snapshot:structuredClone(remote)};}if(op==='putAudio')return{};throw Error('unexpected mocked storage '+op);},chat:async()=>{throw Error('no voice path expected');}};})();`
    }));
    await p2.goto('http://127.0.0.1:8765');
    await p2.waitForSelector('#reconnectCard:not([hidden])', { timeout: 5000 });
    await p2.locator('#reconnectNowBtn').click();
    await p2.waitForFunction(() => document.getElementById('reconnectCard').hidden === true, null, { timeout: 6000 });
    await p2.waitForFunction(() => document.getElementById('connText').textContent.toLowerCase().includes('sincronizad'), null, { timeout: 6000 });
    assert.deepEqual(errors, []);
    console.log('PASS 390px (botón): single reconnect button syncs from home without opening sidebar');
    await ctx2.close();
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
