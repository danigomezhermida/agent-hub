const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const crypto = require('node:crypto').webcrypto;
const source = fs.readFileSync('cloud-connection.js','utf8');
function setup() {
  const listeners = {}, sent = []; let tick;
  const popup = {closed:false, postMessage:(d,o)=>sent.push([d,o]), focus() {}};
  const window = {addEventListener:(n,f)=>listeners[n]=f, dispatchEvent() {}, open:()=>popup};
  vm.runInNewContext(source, {window, crypto, Event:class{}, Map, Date, Error, Promise, setInterval:f=>tick=f, setTimeout, clearTimeout});
  window.hermesCloud.open(); tick();
  const hello = sent[0][0];
  const ready = {origin:'https://future-rich-0308.agents.nousresearch.com', source:popup, data:{channel:hello.channel,channelId:hello.channelId,type:'ready',connected:true}};
  return {api:window.hermesCloud,listeners,popup,sent,ready,tick};
}
test('rejects forged origin, source and channel', () => {
  const x=setup();
  x.listeners.message({...x.ready,origin:'https://evil.example'}); assert.equal(x.api.isConnected(),false);
  x.listeners.message({...x.ready,source:{}}); assert.equal(x.api.isConnected(),false);
  x.listeners.message({...x.ready,data:{...x.ready.data,channelId:'wrong'}}); assert.equal(x.api.isConnected(),false);
  x.listeners.message(x.ready); assert.equal(x.api.isConnected(),true);
});
test('chat only after authenticated connector handshake', async () => {
  const x=setup(); await assert.rejects(x.api.chat({message:'hello'}),/Conecta/);
});
test('messages target the exact Hermes origin; matching result resolves', async () => {
  const x=setup(); x.listeners.message(x.ready);
  const result=x.api.chat({message:'hello',chatId:'test'});
  const [request,origin]=x.sent.at(-1); assert.equal(origin,x.ready.origin);
  x.listeners.message({...x.ready,data:{...x.ready.data,type:'result',requestId:request.requestId,ok:true,result:{text:'real result'}}});
  assert.equal((await result).text,'real result');
});
test('disconnect rejects in-flight request and closes readiness', async () => {
  const x=setup(); x.listeners.message(x.ready); const result=x.api.chat({message:'hello'});
  x.api.disconnect(); await assert.rejects(result,/cerrada/); assert.equal(x.api.isConnected(),false);
});
test('service worker excludes API and foreign origins', () => {
  const sw=fs.readFileSync('sw.js','utf8'); assert.match(sw,/url\.pathname\.startsWith\('\/api\/'\)/); assert.match(sw,/url\.origin !== self\.location\.origin/);
});
