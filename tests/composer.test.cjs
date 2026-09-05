const {test}=require('node:test');
const assert=require('node:assert/strict');
const {JSDOM}=require(process.env.JSDOM_PATH || 'jsdom');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
function boot(auth=true, stored={}, hash='') {
 const dom=new JSDOM(fs.readFileSync(path.join(root,'index.html'),'utf8'),{url:'https://hub.test/'+hash,runScripts:'outside-only'});
 const w=dom.window; w.matchMedia=()=>({matches:false}); w.structuredClone=structuredClone;
 for(const [k,v] of Object.entries(stored))w.localStorage.setItem(k,v);
 const calls=[]; let resolve,reject,revision=0,remote={chats:[],messages:{},sessions:{}};
 w.hermesCloud={isConnected:()=>auth,ownerScope:()=>auth?'personal':null,isRevoking:()=>false,isLive:()=>auth,open(){},openVoice:async()=>{},storage:async(op,args={})=>{if(op==='identity')return{scope:'personal'};if(op==='getState')return{revision,snapshot:structuredClone(remote)};if(op==='putState'){if(args.expectedRevision!==revision){const error=Error('conflict');error.code='conflict';throw error;}remote=structuredClone(args.snapshot);return{revision:++revision,snapshot:structuredClone(remote)};}if(op==='putAudio')return{};throw Error(`unexpected mocked storage ${op}`);},chat(data){calls.push(data);return new Promise((a,b)=>{resolve=a;reject=b;});}};
 w.eval(fs.readFileSync(path.join(root,'cloud-sync.js'),'utf8'));
  w.eval(fs.readFileSync(path.join(root,'app.js'),'utf8'));
 const flush=()=>new Promise(r=>setImmediate(r));
 const waitFor=async(predicate)=>{for(let i=0;i<30;i++){if(predicate())return;await flush();}assert.fail('timed out waiting for app state');};
 const ready=async()=>{w.document.querySelector('#syncBtn').click();await waitFor(()=>!w.document.body.classList.contains('sync-locked'));};
 const reply=async()=>{resolve({text:'Respuesta de prueba'});await waitFor(()=>w.document.querySelector('#messageList').textContent.includes('Respuesta de prueba'));for(let i=0;i<5;i++)await flush();};
 return {w,dom,calls,$:s=>w.document.querySelector(s),ready,waitFor,reply,fail:()=>reject(Error('Fallo de prueba')),flush};
}

test('button, duplicate protection, history and reload',async()=>{
 const b=boot();try { await b.ready();
 b.$('#heroInput').value='Buenas, ¿cómo estás?'; b.$('#heroSendBtn').click();
 b.$('#heroInput').value='duplicate'; b.$('#heroSendBtn').click();
 await b.waitFor(()=>b.calls.length===1);
 assert.equal(b.calls.length,1); assert.equal(b.$('#heroSendBtn').disabled,true);
 const sentEntry=b.w.JSON.parse(b.w.localStorage.getItem('agenthub.conversations.v3')).messages[b.w.location.hash.slice(6)][0];
 assert.equal(b.calls[0].clientMessageId,sentEntry.id);
 assert.match(b.$('#chatList').textContent,/Buenas/); const hash=b.w.location.hash;
 await b.reply();
 const stored=Object.fromEntries(Object.keys(b.w.localStorage).map(k=>[k,b.w.localStorage.getItem(k)]));
 const c=boot(true,stored,hash);try{await c.ready();assert.equal(c.$('#viewHome').hidden,true);assert.equal(c.$('#messageList').querySelectorAll('.msg-user').length,1);}finally{c.dom.window.close();}
 }finally{b.dom.window.close();}
});
test('unauthenticated preserves draft without empty conversation or agent login reply',()=>{
 const b=boot(false);try{const before=b.$('#chatList').textContent;b.$('#heroInput').value='borrador';b.$('#heroSendBtn').click();assert.equal(b.calls.length,0);assert.equal(b.$('#heroInput').value,'borrador');assert.equal(b.$('#chatList').textContent,before);assert.equal(b.$('#viewHome').hidden,false);assert.equal(b.$('#loginOverlay').classList.contains('open'),true);assert.doesNotMatch(b.$('#messageList').textContent,/Inicia sesión/);}finally{b.dom.window.close();}
});
test('storage creation failure preserves draft and permits retry',async()=>{
 const b=boot();try{await b.ready();const proto=Object.getPrototypeOf(b.w.localStorage), original=proto.setItem;proto.setItem=function(k,v){if(k==='agenthub.conversations.v3')throw Error('quota');return original.call(this,k,v);};b.$('#heroInput').value='No perder';const before=b.$('#chatList').textContent;b.$('#heroSendBtn').click();assert.equal(b.calls.length,0);assert.equal(b.$('#heroInput').value,'No perder');assert.equal(b.$('#viewHome').hidden,false);assert.equal(b.$('#chatList').textContent,before);assert.equal(b.$('#heroSendBtn').disabled,false);proto.setItem=original;b.$('#sendError button').click();await b.waitFor(()=>b.calls.length===1);await b.reply();}finally{b.dom.window.close();}
});
test('mobile Enter sends; Shift Enter and IME do not',async()=>{
 const b=boot();try{await b.ready();b.w.matchMedia=()=>({matches:true});b.$('#heroInput').value='Móvil';for(const options of [{shiftKey:true},{isComposing:true}])b.$('#heroInput').dispatchEvent(new b.w.KeyboardEvent('keydown',{key:'Enter',...options,bubbles:true}));assert.equal(b.calls.length,0);b.$('#heroInput').dispatchEvent(new b.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await b.waitFor(()=>b.calls.length===1);await b.reply();}finally{b.dom.window.close();}
});
test('new-agent chat is listed on first send without losing selected agent',async()=>{
 const b=boot();try{await b.ready();b.w.eval("createChat('QA Limpatex')");b.$('#messageInput').value='Test';b.$('#sendBtn').click();assert.match(b.$('#chatList').textContent,/Chat con QA/);await b.waitFor(()=>b.calls.length===1);await b.reply();}finally{b.dom.window.close();}
});

test('Enter creates exactly one independent conversation and preserves settings',async()=>{
 const b=boot(true,{'agenthub.model.sso.v1':'gpt-5.6-luna','agenthub.effort.v1':'high'});
 try {
 await b.ready();
 b.$('#heroInput').value='Buenas, ¿cómo estás?';
 b.$('#heroInput').dispatchEvent(new b.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
 await b.waitFor(()=>b.calls.length===1);
 assert.equal(b.calls.length,1);
 assert.equal(b.$('#viewHome').hidden,true);
 assert.equal(b.$('#messageList').querySelectorAll('.msg-user').length,1);
 assert.equal(b.calls[0].model,'gpt-5.6-luna'); assert.equal(b.calls[0].effort,'high');
 await b.reply();assert.match(b.$('#messageList').textContent,/Respuesta de prueba/);
 }finally{b.dom.window.close();}
});
