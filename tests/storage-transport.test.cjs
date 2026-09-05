const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('hermes-plugin/dashboard/dist/storage-transport.js','utf8');
function harness(response={ok:true,json:async()=>({scope:'personal'})}) {
 const requests=[];
 const context={Blob,AbortController,encodeURIComponent,fetch:async(url,options)=>{requests.push({url,options});return response;}};
 context.window=context;vm.runInNewContext(source,context);
 return {api:context.AgentHubStorage,requests};
}
test('storage uses only the authenticated fixed plugin prefix and forwards cancellation',async()=>{
 const h=harness(), c=new AbortController();
 assert.deepEqual(await h.api.request('identity',{},c.signal),{scope:'personal'});
 assert.equal(h.requests[0].url,'/api/plugins/agent-hub/identity');
 assert.equal(h.requests[0].options.credentials,'same-origin');
 assert.equal(h.requests[0].options.cache,'no-store');
 assert.equal(h.requests[0].options.signal,c.signal);
});
test('arbitrary operations and path-like IDs never reach fetch',async()=>{
 const h=harness();
 await assert.rejects(h.api.request('https://evil.invalid'));
 await assert.rejects(h.api.request('getAudio',{id:'../private',chatId:'chat'}));
 await assert.rejects(h.api.request('putBinding',{chatId:'a/b',sessionId:'safe'}));
 assert.equal(h.requests.length,0);
});
test('CAS version and snapshot are explicitly serialized',async()=>{
 const h=harness(); const snapshot={chats:[],messages:{},sessions:{}};
 await h.api.request('putState',{expectedRevision:3,snapshot});
 const r=h.requests[0];assert.equal(r.options.method,'PUT');
 assert.equal(r.options.headers['Content-Type'],'application/json');
 assert.deepEqual(JSON.parse(r.options.body),{expectedRevision:3,snapshot});
});
test('backend errors are typed and never expose response body',async()=>{
 for(const [status,code] of [[403,'identity'],[409,'conflict'],[500,'storage']]){
  const h=harness({ok:false,status,json:async()=>{throw Error('must not read');},text:async()=>{throw Error('must not read');}});
  await assert.rejects(h.api.request('identity'),e=>e.code===code&&e.httpStatus===status&&!e.message.includes('must not read'));
 }
});
test('audio validates size before upload and retrieves native Blob',async()=>{
 const blob=new Blob(['sound'],{type:'audio/webm'}),h=harness({ok:true,blob:async()=>blob,json:async()=>({ok:true})});
 await assert.rejects(h.api.request('putAudio',{id:'audio',chatId:'chat',blob:new Blob([])}));
 await assert.rejects(h.api.request('putAudio',{id:'audio',chatId:'chat',blob:new Blob([new Uint8Array(6*1024*1024+1)])}));
 assert.equal(h.requests.length,0);
 assert.equal(await h.api.request('getAudio',{id:'audio',chatId:'chat'}),blob);
 await h.api.request('putAudio',{id:'audio',chatId:'chat',blob});
 assert.equal(h.requests[1].options.body,blob);
});
test('turn claim carries immutable message identity and prompt digest',async()=>{
 const h=harness(); const args={chatId:'chat',clientMessageId:'message',requestId:'request',promptDigest:'a'.repeat(64)};
 await h.api.request('claimTurn',args);
 assert.equal(h.requests[0].url,'/api/plugins/agent-hub/turns/chat');
 assert.deepEqual(JSON.parse(h.requests[0].options.body),{clientMessageId:'message',requestId:'request',promptDigest:'a'.repeat(64)});
 await h.api.request('finishTurn',{...args,state:'completed',text:'Respuesta'});
 assert.equal(h.requests[1].options.method,'PATCH');
 assert.deepEqual(JSON.parse(h.requests[1].options.body),{requestId:'request',state:'completed',text:'Respuesta'});
});

test('group operations use only fixed paths and exact write payloads',async()=>{
 const h=harness();
 await h.api.request('getGroupCatalog');
 await h.api.request('getGroups');
 await h.api.request('putGroups',{expectedRevision:7,groups:[{id:'g_1'}]});
 await h.api.request('startGroupRun',{groupId:'g_1',runId:'run_1',message:'Analiza',expectedRevision:7});
 await h.api.request('getGroupRun',{runId:'run_1'});
 await h.api.request('getGroupRuns',{groupId:'g_1'});
 assert.deepEqual(h.requests.map(r=>r.url),[
  '/api/plugins/agent-hub/group-catalog',
  '/api/plugins/agent-hub/groups',
  '/api/plugins/agent-hub/groups',
  '/api/plugins/agent-hub/groups/g_1/runs',
  '/api/plugins/agent-hub/group-runs/run_1',
  '/api/plugins/agent-hub/group-runs?groupId=g_1'
 ]);
 assert.deepEqual(JSON.parse(h.requests[2].options.body),{expectedRevision:7,groups:[{id:'g_1'}]});
 assert.equal(h.requests[3].options.method,'POST');
 assert.deepEqual(JSON.parse(h.requests[3].options.body),{runId:'run_1',message:'Analiza',expectedRevision:7});
});

test('invalid group and run ids never reach fetch',async()=>{
 const h=harness();
 await assert.rejects(h.api.request('startGroupRun',{groupId:'../g',runId:'run',message:'x',expectedRevision:0}));
 await assert.rejects(h.api.request('getGroupRun',{runId:'a/b'}));
 assert.equal(h.requests.length,0);
});
