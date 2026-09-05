/* Voice presentation and orchestration. Credentials never enter this module. */
(() => {
  'use strict';
  const STATES = { requesting: 'Solicitando permiso de micrófono…', connecting: 'Conectando con Hermes…', listening: 'Escuchando', processing: 'Procesando tu mensaje…', speaking: 'El agente está hablando', reconnecting: 'Reconectando…', ended: 'Llamada finalizada', error: 'No se pudo continuar. Puedes volver a conectar.' };
  const formatTime = ms => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
  class VoiceUI {
    constructor(host) {
      this.host = host; this.store = new AgentVoice.AudioStore(); this.busy = false;
      this.chat = null; this.recorder = null; this.live = null; this.draft = null;
      this.epoch = 0; this.previewURL = null; this.playback = null; this.playURL = null;
      this.playGeneration = 0; this.processing = false; this.cancelled = false;
      this.dialog = document.getElementById('voiceDialog');
      this.status = document.getElementById('voiceStatus');
      this.preview = document.getElementById('voicePreview');
      this.duration = document.getElementById('voiceDuration');
      this.finishBtn = document.getElementById('voiceFinish');
      this.sendBtn = document.getElementById('voiceSend');
      this.cancelBtn = document.getElementById('voiceCancel');
      this.muteBtn = document.getElementById('voiceMute');
      this.interruptBtn = document.getElementById('voiceInterrupt');
      this.retryBtn = document.getElementById('voiceRetry');
      this.finishBtn.onclick = () => this.finishNote();
      this.sendBtn.onclick = () => this.sendNote();
      this.cancelBtn.onclick = () => this.end();
      this.muteBtn.onclick = () => { this.muted = !this.muted; this.live?.setMuted(this.muted); this.muteBtn.setAttribute('aria-pressed', String(this.muted)); this.muteBtn.textContent = this.muted ? 'Reactivar micrófono' : 'Silenciar micrófono'; };
      this.interruptBtn.onclick = () => this.interrupt();
      this.retryBtn.onclick = () => { if (!this.retryReady || this.retries >= 2) return; this.retries++; this.busy = false; this.startLive(this.chat, true); };
      this.dialog.addEventListener('cancel', e => { e.preventDefault(); this.end(); });
      window.addEventListener('pagehide', () => this.end());
      window.addEventListener('hermes-connection', () => {
        if (this.busy && !host.transport.isConnected()) this.end();
      });
      window.addEventListener('hermes-voice-closed', () => { if (this.live) this.failLive(); });
    }
    canNavigate(chat) { return !this.busy || (chat && this.chat?.id === chat.id); }
    set busy(value) {
      this._busy = Boolean(value);
      document.querySelectorAll('#heroMicBtn,#micBtn,#heroVoiceBtn,#voiceBtn,#heroSendBtn,#sendBtn').forEach(button => { button.disabled = this._busy; });
      document.querySelectorAll('#heroMicBtn,#micBtn,#heroVoiceBtn,#voiceBtn').forEach(button => button.setAttribute('aria-pressed', String(this._busy && (button.id.toLowerCase().includes('mic') ? this.mode === 'note' : this.mode === 'live'))));
    }
    get busy() { return this._busy; }
    show(mode, chat) {
      this.mode = mode; this.busy = true; this.chat = chat; this.cancelled = false;
      this.host.lock(); this.dialog.hidden = false;
      if (!this.dialog.open) this.dialog.showModal();
      document.getElementById('voiceTitle').textContent = mode === 'note' ? 'Nota de voz' : 'Conversación de voz';
      this.preview.hidden = true; this.duration.textContent = '0:00';
      this.finishBtn.hidden = mode !== 'note'; this.finishBtn.disabled = true;
      this.sendBtn.hidden = true; this.sendBtn.disabled = false;
      this.muteBtn.hidden = mode !== 'live'; this.muteBtn.disabled = true;
      this.interruptBtn.hidden = mode !== 'live'; this.interruptBtn.disabled = true;
      this.retryBtn.hidden = true; this.cancelBtn.disabled = false;
      this.cancelBtn.textContent = mode === 'note' ? 'Cancelar' : 'Finalizar llamada';
      this.muted = false; this.muteBtn.setAttribute('aria-pressed', 'false'); this.muteBtn.textContent = 'Silenciar micrófono';
      this.status.textContent = STATES.requesting;
    }
    async startNote(chat) {
      if (this.busy || !this.host.authorize()) return;
      const epoch = ++this.epoch;
      this.show('note', chat); this.draft = null;
      this.recorder = new AgentVoice.Recorder();
      try {
        await this.recorder.start();
        if (epoch !== this.epoch) return;
        this.status.textContent = 'Grabando · máximo 2 minutos'; this.finishBtn.disabled = false;
        this.started = Date.now();
        this.timer = setInterval(() => {
          const elapsed = Date.now() - this.started; this.duration.textContent = formatTime(elapsed);
          if (elapsed >= 119000) this.finishNote();
        }, 200);
      } catch {
        if (epoch !== this.epoch) return;
        this.status.textContent = 'No se pudo abrir el micrófono. Revisa el permiso del navegador y vuelve a intentarlo.';
        await this.recorder?.cancel(); this.finishBtn.hidden = true;
      }
    }
    async finishNote() {
      if (this.finishing || !this.recorder || this.finishBtn.disabled) return;
      this.finishing = true; this.finishBtn.disabled = true; clearInterval(this.timer);
      const epoch = this.epoch;
      try {
        const draft = await this.recorder.finish();
        if (epoch !== this.epoch) return;
        this.draft = draft;
        if (!draft.blob.size) throw new Error('empty');
        this.previewURL = URL.createObjectURL(draft.blob); this.preview.src = this.previewURL;
        this.preview.hidden = false; this.duration.textContent = formatTime(draft.duration);
        this.status.textContent = 'Escucha la nota antes de enviarla.';
        this.finishBtn.hidden = true; this.sendBtn.hidden = false;
      } catch { if (epoch === this.epoch) this.status.textContent = 'No se pudo finalizar la grabación. Cancela y vuelve a grabar.'; }
      finally { this.finishing = false; }
    }
    async sendNote() {
      if (!this.draft || this.processing || !this.host.authorize()) return;
      this.processing = true; this.sendBtn.disabled = true; this.cancelBtn.disabled = true;
      const chat = this.chat, draft = this.draft, id = crypto.randomUUID();
      const entry = { id, role: 'audio', audioId: id, duration: draft.duration, text: '', status: 'uploading' };
      let committed = false; const epoch = this.epoch;
      // Preserve user activation for the Hermes window, before IndexedDB awaits.
      const ready = this.host.transport.openVoice(); ready.catch(() => {});
      try {
        this.status.textContent = 'Guardando audio en este dispositivo…';
        await this.store.put(id, chat.id, draft.blob);
        if (epoch !== this.epoch) { await this.store.remove(id); return; }
        this.host.commit(chat, entry); committed = true;
        await ready;
        if (epoch !== this.epoch) return;
        this.dialog.close(); this.dialog.hidden = true;
        await this.processNote(chat, entry, draft.blob);
      } catch {
        if (!committed) { await this.store.remove(id).catch(() => {}); this.status.textContent = 'No se pudo guardar o conectar. La grabación sigue aquí; pulsa Enviar para reintentar.'; }
        else if (entry.delivery !== 'uncertain') { entry.status = 'transcription_error'; this.host.persist(chat); }
      } finally {
        this.host.transport.closeVoice(); this.processing = false;
        this.sendBtn.disabled = false; this.cancelBtn.disabled = false;
        if (committed) await this.end();
      }
    }
    async processNote(chat, entry, blob) {
      const epoch = this.epoch;
      entry.status = 'transcribing'; this.host.persist(chat);
      try {
        const result = await this.host.transport.transcribe({ blob, chatId: chat.id });
        if (epoch !== this.epoch || !result.text?.trim()) throw new Error('silence');
        entry.text = result.text.trim(); entry.status = 'processing'; this.host.persist(chat);
      } catch {
        entry.status = 'transcription_error'; this.host.persist(chat);
        this.host.notify('No se pudo transcribir. El audio está guardado; puedes reintentar desde el mensaje.');
        return;
      }
      try { await this.host.respond(chat, entry); }
      catch { this.host.notify('Respuesta sin confirmar. Comprueba Hermes; no se reenviará automáticamente.'); }
    }
    async retryNote(chat, entry) {
      if (this.busy || this.host.isSending() || entry.status !== 'transcription_error' || !this.host.authorize()) return;
      this.busy = true; this.chat = chat; this.host.lock();
      const ready = this.host.transport.openVoice(); ready.catch(() => {});
      try {
        const blob = await this.store.get(entry.audioId, chat.id);
        if (!blob) throw new Error('missing');
        await ready; await this.processNote(chat, entry, blob);
      } catch { this.host.notify('No se pudo recuperar el audio o conectar. Vuelve a intentarlo.'); }
      finally { this.host.transport.closeVoice(); this.busy = false; this.host.lock(); }
    }
    async startLive(chat, retrying = false) {
      if (this.busy || this.host.isSending() || !this.host.authorize()) return;
      this.show('live', chat); const epoch = ++this.epoch;
      if (!retrying) this.retries = 0;
      this.retryReady = false;
      this.started = Date.now(); clearInterval(this.timer);
      this.timer = setInterval(() => { this.duration.textContent = formatTime(Date.now() - this.started); }, 250);
      if (retrying) this.status.textContent = STATES.reconnecting;
      const ready = this.host.transport.openVoice(); ready.catch(() => {});
      this.live = new AgentVoice.Live({
        connect: () => ready,
        close: () => this.host.transport.closeVoice(),
        interrupt: () => this.interrupt(),
        speak: (text, options) => this.speak(text, chat, epoch, options),
        onTurn: async turn => {
          if (epoch !== this.epoch) return '';
          const result = await this.host.transport.transcribe({ blob: turn.blob, chatId: chat.id });
          if (epoch !== this.epoch || !result.text?.trim()) return '';
          const entry = { id: turn.id, role: 'user', source: 'voice', text: result.text.trim(), duration: turn.duration };
          if (!this.host.commit(chat, entry)) return '';
          // The standard Hermes session mapping keeps the previous text/voice context.
          return this.host.respond(chat, entry);
        },
        onState: (state) => {
          if (epoch !== this.epoch) return;
          this.status.textContent = STATES[state] || state;
          this.dialog.dataset.state = state;
          this.muteBtn.disabled = ['requesting', 'connecting', 'ended', 'error'].includes(state);
          this.interruptBtn.disabled = state !== 'speaking';
          if (state === 'error') this.failLive();
          if (state === 'ended') this.end();
        }
      });
      try { await this.live.start(); }
      catch { if (epoch === this.epoch) await this.failLive(); }
    }
    async failLive() {
      if (this.failing) return;
      this.failing = true; this.retryReady = false;
      const current = this.live; this.live = null;
      ++this.epoch; clearInterval(this.timer); this.interrupt();
      await current?.end();
      this.host.transport.closeVoice();
      this.retryReady = true; this.failing = false;
      this.status.textContent = 'Se perdió la conexión. Finaliza o vuelve a conectar; no se reenviarán turnos anteriores.';
      this.retryBtn.hidden = this.retries >= 2; this.muteBtn.disabled = true; this.interruptBtn.disabled = true;
    }
    async speak(text, chat, epoch, options = {}) {
      const generation = ++this.playGeneration;
      const controller = new AbortController(); this.synthController = controller;
      const abort = () => controller.abort();
      if (options.signal?.aborted) controller.abort();
      options.signal?.addEventListener('abort', abort, {once:true});
      let result;
      try { result = await this.host.transport.synthesize({ text: text.slice(0, 8000), chatId: chat.id, signal:controller.signal }); }
      catch (error) { if (controller.signal.aborted) return; throw error; }
      finally { options.signal?.removeEventListener('abort', abort); if (this.synthController === controller) this.synthController = null; }
      if (controller.signal.aborted) return;
      if (epoch !== this.epoch || generation !== this.playGeneration) return;
      this.playURL = URL.createObjectURL(result.blob);
      const audio = new Audio(this.playURL); this.playback = audio;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { this.interrupt(); reject(new Error('La reproducción tardó demasiado.')); }, 180000);
        const done = () => { clearTimeout(timer); this.playResolve = null; audio.onended = audio.onerror = null; audio.pause(); audio.removeAttribute('src'); if (this.playURL) URL.revokeObjectURL(this.playURL); this.playURL = null; this.playback = null; resolve(); };
        this.playResolve = done; audio.onended = done;
        audio.onerror = () => { done(); this.host.notify('No se pudo reproducir la voz. La respuesta está en el chat.'); };
        audio.play().catch(() => { done(); this.host.notify('El navegador bloqueó el audio. Revisa los permisos de reproducción.'); });
      });
    }
    interrupt() {
      this.synthController?.abort();
      ++this.playGeneration;
      this.playback?.pause(); this.playResolve?.();
      if (this.playURL) URL.revokeObjectURL(this.playURL);
      this.playURL = null; this.playback = null;
    }
    async end() {
      if (this.ending) return;
      this.ending = true; ++this.epoch; clearInterval(this.timer); this.interrupt();
      const live = this.live; this.live = null;
      await this.recorder?.cancel(); this.recorder = null;
      await live?.end();
      this.preview.pause(); this.preview.removeAttribute('src');
      if (this.previewURL) URL.revokeObjectURL(this.previewURL);
      this.previewURL = null; this.draft = null;
      this.host.transport.closeVoice(); this.dialog.close(); this.dialog.hidden = true;
      this.busy = false; this.host.lock(); this.ending = false;
      if (this.mode === 'live') this.host.notify('Llamada finalizada. El historial se conserva.');
    }
  }
  window.AgentVoiceUI = VoiceUI;
})();
