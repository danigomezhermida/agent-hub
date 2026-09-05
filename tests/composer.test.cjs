const {test}=require('node:test');
const assert=require('node:assert/strict');
const {JSDOM}=require(process.env.JSDOM_PATH || 'jsdom');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
function boot(auth=true, stored={}, hash='') {
 const dom=new JSDOM(fs.readFileSync(path.join(root,'index.html'),'utf8'),{url:'https://hub.test/'+hash,runScripts:'outside-only'});
 const w=dom.window; w.matchMedia=()=>({matches:false});
 for(const [k,v] of Object.entries(stored))w.localStorage.setItem(k,v);
 const calls=[]; let resolve,reject;
 w.hermesCloud={isConnected:()=>auth,isRevoking:()=>false,isLive:()=>false,open(){},chat(data){calls.push(data);return new Promise((a,b)=>{resolve=a;reject=b;});}};
 w.eval(fs.readFileSync(path.join(root,'app.js'),'utf8'));
 return {w,dom,calls,$:s=>w.document.querySelector(s),reply:()=>resolve({text:'Respuesta de prueba'}),fail:()=>reject(Error('Fallo de prueba')),flush:()=>new Promise(r=>setImmediate(r))};
}

test('button, duplicate protection, history and reload',async()=>{
 const b=boot();try {
 b.$('#heroInput').value='Buenas, ¿cómo estás?'; b.$('#heroSendBtn').click();
 b.$('#heroInput').value='duplicate'; b.$('#heroSendBtn').click();
 assert.equal(b.calls.length,1); assert.equal(b.$('#heroSendBtn').disabled,true);
 assert.match(b.$('#chatList').textContent,/Buenas/); const hash=b.w.location.hash;
 b.reply();await b.flush();
 const stored=Object.fromEntries(Object.keys(b.w.localStorage).map(k=>[k,b.w.localStorage.getItem(k)]));
 const c=boot(true,stored,hash);try{assert.equal(c.$('#viewHome').hidden,true);assert.equal(c.$('#messageList').querySelectorAll('.msg-user').length,1);}finally{c.dom.window.close();}
 }finally{b.dom.window.close();}
});
test('unauthenticated preserves draft without empty conversation or agent login reply',()=>{
 const b=boot(false);try{const before=b.$('#chatList').textContent;b.$('#heroInput').value='borrador';b.$('#heroSendBtn').click();assert.equal(b.calls.length,0);assert.equal(b.$('#heroInput').value,'borrador');assert.equal(b.$('#chatList').textContent,before);assert.equal(b.$('#viewHome').hidden,false);assert.equal(b.$('#loginOverlay').classList.contains('open'),true);assert.doesNotMatch(b.$('#messageList').textContent,/Inicia sesión/);}finally{b.dom.window.close();}
});
test('storage creation failure preserves draft and permits retry',async()=>{
 const b=boot();try{const proto=Object.getPrototypeOf(b.w.localStorage), original=proto.setItem;proto.setItem=function(k,v){if(k==='agenthub.conversations.v3')throw Error('quota');return original.call(this,k,v);};b.$('#heroInput').value='No perder';const before=b.$('#chatList').textContent;b.$('#heroSendBtn').click();assert.equal(b.calls.length,0);assert.equal(b.$('#heroInput').value,'No perder');assert.equal(b.$('#viewHome').hidden,false);assert.equal(b.$('#chatList').textContent,before);assert.equal(b.$('#heroSendBtn').disabled,false);proto.setItem=original;b.$('#sendError button').click();assert.equal(b.calls.length,1);b.reply();await b.flush();}finally{b.dom.window.close();}
});
test('mobile Enter sends; Shift Enter and IME do not',async()=>{
 const b=boot();try{b.w.matchMedia=()=>({matches:true});b.$('#heroInput').value='Móvil';for(const options of [{shiftKey:true},{isComposing:true}])b.$('#heroInput').dispatchEvent(new b.w.KeyboardEvent('keydown',{key:'Enter',...options,bubbles:true}));assert.equal(b.calls.length,0);b.$('#heroInput').dispatchEvent(new b.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));assert.equal(b.calls.length,1);b.reply();await b.flush();}finally{b.dom.window.close();}
});
test('new-agent chat is listed on first send without losing selected agent',async()=>{
 const b=boot();try{b.w.eval("createChat('QA Limpatex')");b.$('#messageInput').value='Test';b.$('#sendBtn').click();assert.match(b.$('#chatList').textContent,/Chat con QA/);b.reply();await b.flush();}finally{b.dom.window.close();}
});

test('Enter creates exactly one independent conversation and preserves settings',async()=>{
 const b=boot(true,{'agenthub.model.sso.v1':'gpt-5.6-luna','agenthub.effort.v1':'high'});
 try {
 b.$('#heroInput').value='Buenas, ¿cómo estás?';
 b.$('#heroInput').dispatchEvent(new b.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
 assert.equal(b.calls.length,1);
 assert.equal(b.$('#viewHome').hidden,true);
 assert.equal(b.$('#messageList').querySelectorAll('.msg-user').length,1);
 assert.equal(b.calls[0].model,'gpt-5.6-luna'); assert.equal(b.calls[0].effort,'high');
 b.reply();await b.flush();assert.match(b.$('#messageList').textContent,/Respuesta de prueba/);
 }finally{b.dom.window.close();}
});
