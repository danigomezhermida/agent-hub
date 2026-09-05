/* Read-only inspection or exact persisted-result recovery; never sends a prompt. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.AgentTurnUI=api;})(typeof globalThis==='object'?globalThis:self,function(){
  'use strict';
  async function applyRecovery(result, chatId, message, list, persist) {
    if (!result || result.chatId !== chatId) throw new Error('La consulta no corresponde a esta conversación.');
    if (!['completed','rejected','uncertain'].includes(result.state)) throw new Error('Estado de turno inválido.');
    if (result.state === 'uncertain') return false;
    if (!message?.id || result.clientMessageId !== message.id) throw new Error('No se puede asociar este resultado al mensaje original.');
    if (result.state === 'completed') {
      if (typeof result.text !== 'string' || !result.text.trim()) throw new Error('La respuesta guardada está vacía.');
      const id=message.id+'-reply';
      const existing=list.find(item=>item.id===id);
      if (existing && existing.text !== result.text) throw new Error('La respuesta local difiere de la guardada. Revisa antes de continuar.');
      if(!existing)list.push({id,role:'assistant',text:result.text});
      message.delivery='complete';message.status='complete';
    } else { message.delivery='rejected';message.status='rejected'; }
    await persist();
    return true;
  }
  function create(host) {
    let running=false;
    return {async run(){
      if(running||host.isBusy())return;
      const chat=host.getChat();if(!chat)return;
      const list=host.getMessages(chat);
      const message=list.find(m=>['user','audio'].includes(m.role)&&['uncertain','sending'].includes(m.delivery)) || [...list].reverse().find(m=>['user','audio'].includes(m.role));
      if(!message?.id){host.notice('Este mensaje antiguo no tiene identificador verificable. Revísalo en Hermes; no se reenviará.');return;}
      running=true;host.setBusy(true);
      const ownedLease=!host.transport.isLive();
      // Popup opening is synchronous with the click, before the first await.
      try {
        const ready=host.transport.openVoice();
        await ready;
        await host.sync.ensureReady({allowOpen:false});
        const result=await host.transport.recover({chatId:chat.id,clientMessageId:message.id});
        const applied=await applyRecovery(result,chat.id,message,list,async()=>{host.persist(chat);await host.sync.afterTurn();});
        if(applied)host.render(chat);
        if(result.state==='completed')host.notice('Respuesta recuperada del registro del servidor. No se ha ejecutado de nuevo.');
        else if(result.state==='rejected')host.notice('Hermes rechazó ese intento antes de ejecutarlo. Puedes escribir un mensaje nuevo; no se ha reenviado nada.');
        else host.showEvidence(result);
      }catch(error){host.notice(error.message||'No se pudo consultar el resultado. No se ha reenviado nada.');}
      finally{if(ownedLease)host.transport.closeVoice();running=false;host.setBusy(false);}
    }};
  }
  return {applyRecovery,create};
});
