const test=require('node:test');const assert=require('node:assert/strict');
const {applyRecovery,create}=require('../recovery-ui.js');
test('recovery restores a completed exact message once, without resubmission',async()=>{
 const message={id:'m',role:'user',text:'hola',delivery:'uncertain'},list=[message];let saved=0;
 const result={chatId:'c',clientMessageId:'m',state:'completed',text:'Buenas'};
 await applyRecovery(result,'c',message,list,async()=>{saved++;});
 await applyRecovery(result,'c',message,list,async()=>{saved++;});
 assert.equal(list.length,2);assert.equal(list[1].id,'m-reply');assert.equal(message.delivery,'complete');assert.equal(saved,2);
});
test('uncertain history is never promoted to an answer',async()=>{
 const message={id:'m',delivery:'uncertain'},list=[message];let saved=0;
 assert.equal(await applyRecovery({chatId:'c',state:'uncertain',history:[{role:'assistant',text:'Maybe'}]},'c',message,list,async()=>{saved++;}),false);
 assert.equal(list.length,1);assert.equal(saved,0);assert.equal(message.delivery,'uncertain');
});
test('mismatched message/chat and conflicting local answer fail closed',async()=>{
 const m={id:'m'},list=[m,{id:'m-reply',role:'assistant',text:'original'}];let saved=0;
 for(const result of [{chatId:'other',clientMessageId:'m',state:'completed',text:'x'},{chatId:'c',clientMessageId:'other',state:'completed',text:'x'},{chatId:'c',clientMessageId:'m',state:'completed',text:'different'}]){
  await assert.rejects(applyRecovery(result,'c',m,list,async()=>{saved++;}));
 }
 assert.equal(saved,0);assert.equal(list[1].text,'original');
});
test('definite rejection changes status but never creates an assistant answer',async()=>{
 const m={id:'m',delivery:'uncertain'},list=[m];
 await applyRecovery({chatId:'c',clientMessageId:'m',state:'rejected'},'c',m,list,async()=>{});
 assert.equal(m.delivery,'rejected');assert.equal(list.length,1);
});
test('query opens popup synchronously and cleans up even when opening throws',async()=>{
 let busy=false,closed=0,opened=0;const notices=[];
 const ui=create({isBusy:()=>busy,getChat:()=>({id:'c'}),getMessages:()=>[{id:'m',role:'user',delivery:'uncertain'}],setBusy:v=>{busy=v;},notice:t=>notices.push(t),transport:{isLive:()=>false,openVoice(){opened++;throw Error('blocked');},closeVoice(){closed++;}}});
 const done=ui.run();assert.equal(opened,1);await done;
 assert.equal(busy,false);assert.equal(closed,1);assert.equal(notices[0],'blocked');
});
