# Voz de Agent Hub: implementación y validación

## Decisión y alcance

Se conserva la arquitectura publicada: navegador Agent Hub → popup del origen Hermes → cookie de Hermes → servicios y sesión del perfil `limpatexdev-cloud`. No se reutilizan `/api/audio` ni `/api/voice` de Vercel: pertenecen al antiguo login HMAC y al borrador de conexión servidor-a-servidor.

No se ha añadido un segundo agente Realtime. La llamada continua usa detección de actividad vocal (WebAudio RMS), fragmentos MediaRecorder, STT nativo de Hermes, el mismo `chatId`/sesión de texto y TTS nativo de Hermes. Tiene más latencia que audio streaming WebRTC. **No es OpenAI Realtime.** Implementar Realtime requeriría un backend autenticado que emita sesiones efímeras y una decisión sobre continuidad/herramientas; no se presume que el backend antiguo tenga esa capacidad.

## Responsabilidades

- `voice-engine.js`: captura acotada, selección MIME, permiso con timeout, IndexedDB, VAD, cola serializada, mute, interrupción, generación y teardown.
- `voice-ui.js`: revisión de notas, diálogo accesible, estado de llamada, coordinación de persistencia/STT/chat/TTS, reintento explícito.
- `app.js`: creación atómica de conversación+mensaje, una entrada de audio con transcripción, historial, renderizado del reproductor desde IndexedDB y respuesta por el controlador compartido con texto.
- `cloud-connection.js`: lease de popup de voz, IDs y correlación, rechazo de cierre/timeout y revocación.
- `hermes-plugin/dashboard/dist/connector.js`: único origen que llama a Hermes, con cookie del propio origen. Rutas verificadas en el runtime: `POST /api/audio/transcribe` y `POST /api/audio/speak`, perfil fijo. Devuelve texto o Blob, no credenciales ni rutas internas.

## Notas de voz

1. Micrófono solicita permiso; no graba automáticamente al entrar al chat.
2. Duración visible; finalizar o cancelar. Máximo 2 minutos/6 MiB.
3. Revisión con reproductor antes de enviar.
4. El envío abre el popup dentro del gesto de usuario y guarda el Blob en IndexedDB, ligado al ID de conversación. Solo después confirma juntos conversación y mensaje en el almacenamiento canónico del chat.
5. Transcripción y respuesta usan ese mismo mensaje y sesión. No se crea otro mensaje de texto del usuario.
6. Fallo de persistencia: revisión y grabación permanecen disponibles; no se crea un chat vacío. Fallo STT: queda el audio con reintento explícito en el mensaje. Fallo del turno: incertidumbre visible, sin reenvío automático.
7. Recarga recupera el Blob por `audioId` + `chatId`; no se persisten URLs temporales. Las URLs se revocan al retirar reproductores/salir.

## Llamada continua

- Ventana Hermes abierta durante la llamada. No se intenta abrir un popup nuevo desde cada evento VAD.
- Solicitud de permiso, conexión, escucha, procesamiento, habla, reconexión explícita, finalización y error.
- Speech onset interrumpe reproducción; turnos serializados y respuestas obsoletas no se reproducen. Cola acotada: al llenarse, pausa captura y comunica estado de procesamiento, no envía simultáneamente.
- Mute desactiva pistas de audio; terminar detiene todas las pistas, recorder, AudioContext, timers, reproducción y conexión.
- Duración máxima de llamada: 15 minutos. Reconexión manual limitada; nunca reenvía mensajes de resultado incierto.
- Historial de voz textual con ID único; terminar no lo elimina. Se conserva la respuesta completa en texto aunque la síntesis solo utilice los primeros 8.000 caracteres.

## Seguridad y límites reales

- Frontera de seguridad: orígenes exactos, ventana origen, canal aleatorio, request ID y chat ID. Sin lectura/exportación de `/api/audio/voice-config`, que puede contener configuración sensible para clientes directos.
- No se reciben IDs de sesión Hermes de otros usuarios para ejecutar audio/chat. El conector mantiene su propio mapa del perfil autorizado.
- Esta aplicación es de **un propietario/instancia fija**, no un servicio multitenant. El backend personal añade sincronización de chats/audio y bloquea otras identidades en servidor. Ver [sincronización personal](personal-sync.md) para migración, conflictos y límites de la copia local.
- Borrar datos del sitio elimina las notas que todavía no se hayan sincronizado. Las notas confirmadas en servidor se pueden cargar desde otro dispositivo; el servicio no sustituye una política de copias de seguridad empresarial.
- Los proveedores se configuran en Hermes; no se añaden claves al cliente o a Vercel.
- En móvil real, cambio a la ventana Hermes, suspensión en segundo plano, permisos y autoplay requieren prueba humana. La detección de eco del navegador depende del dispositivo; recomendamos auriculares.
- El plugin 2.4.0 requiere instalación coordinada con el frontend y activación de su backend mediante reinicio del dashboard. La publicación efectiva y la prueba autenticada deben verificarse en el informe de despliegue.

## Revisión del contrato real

La auditoría detectó dos incompatibilidades que se corrigieron antes de finalizar: `transcribe()` devuelve `{text, provider, chatId}` y `synthesize()` devuelve `{blob, mimeType, provider, chatId}`. La interfaz consume esos campos.

`tests/voice-cross-origin.cjs` ejecuta interfaz y ambos scripts reales en dos orígenes; solo sustituye HTTP/WS. Verifica nota→STT→un turno, TTS reproducible y cancelación con siguiente petición en menos de 2 s. `cancel-voice` exige el requestId/chatId de la síntesis activa; si no confirma en 2 s, se cierra la conexión. Los detalles internos de errores de proveedores no se devuelven al cliente.

El registro durable evita duplicados entre dispositivos y permite recuperar respuestas ya registradas. Si falta evidencia exacta, «Consultar resultado» muestra el historial sin inventar una confirmación; el usuario puede archivar el hilo y abrir una conversación nueva sin reenviar. La allowlist exige un único propietario. No se certifica SaaS multitenant ni protección frente a acceso directo a los archivos del navegador.

## Reproducción de pruebas

Requisitos: Node, Chromium/Playwright, Python para servidor estático (el fixture sintético se genera en Node). Instalación de dependencias de test: `npm ci`. No hay TypeScript ni bundler en este proyecto estático; `npm run check` valida sintaxis de sus scripts, `npm test` ejecuta suites focalizadas.

```sh
npm ci
npm test
python3 -m http.server 8765 --bind 127.0.0.1
# En otra terminal, con Chromium instalado para Playwright:
npm run test:browser
```

`CHROMIUM_PATH` permite seleccionar un Chromium existente. La suite de voz genera automáticamente un WAV PCM sintético con sonido y silencio en el directorio temporal, y lo elimina al salir. `VOICE_FIXTURE` permite usar un WAV de prueba alternativo. No usar grabaciones privadas como fixture. La suite de UI intercepta el puente remoto; la suite adicional entre orígenes usa ambos scripts reales e intercepta únicamente HTTP/WS. Las respuestas/transcripciones de test no son respuestas reales de Hermes.

La fase anterior aprobó 46 pruebas unitarias; el conteo actual debe leerse en la ejecución de `npm test`. Las pruebas de navegador cubren permisos, captura/cancelación, revisión, fallo de almacenamiento, fallo/reintento STT, persistencia y recarga, VAD, interrupción, mute, cierre inesperado, reconexión, liberación de pistas, deduplicación, binding del Blob al chat, origen/canal falsificado y regresión del compositor de texto. Capturas a 1280 y 390 píxeles.

### Evidencia adicional del proveedor real

En esta sesión se generó TTS con el proveedor OpenAI configurado en Hermes y se ejecutó `tools.voice_mode.transcribe_recording` con el perfil correcto sobre el archivo generado. Resultado real: `success: true`, proveedor STT `local`, transcripción «Esta es una prueba de voz de Agent Hub. Recuerda la palabra azul.».

Esto verifica los proveedores por separado; **no certifica una llamada autenticada E2E desde Agent Hub ni una prueba física en iOS/Android**.
