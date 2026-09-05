# Agent Hub · Limpatex

Interfaz de chat en https://agent-hub-theta-five.vercel.app.

## Conexión de texto actual: Hermes SSO

1. Abrir Agent Hub y pulsar **Conectar Hermes Cloud**.
2. En la ventana de Hermes, iniciar sesión con Nous si se solicita.
3. Pulsar **Conectar Agent Hub**. La autorización queda conservada en ese navegador y la ventana puede cerrarse.
4. Al enviar cada mensaje se abre un conector temporal, conserva la conversación y se cierra tras recibir la respuesta.

El navegador de Hermes obtiene un ticket WebSocket de un solo uso mediante su sesión autenticada y habla con `/api/ws`. El origen Vercel solo intercambia mensajes y respuestas con la ventana mediante `postMessage`. No recibe cookies, tickets ni claves. No se necesita `HERMES_CLOUD_API_KEY` para este modo.

La ventana solo permite el origen de producción indicado en el código, comprueba `event.source`, canal y correlación, conserva el consentimiento explícito en el origen Hermes para las aperturas temporales posteriores y únicamente acepta el verbo chat. No permite RPC arbitrario ni elegir IDs de sesiones ajenas. La revocación queda bloqueada como pendiente hasta que Hermes la confirma; una autorización antigua nunca se recupera silenciosamente. Las sesiones se crean bajo `limpatexdev-cloud` y su correspondencia se guarda en el origen Hermes.

## Componentes

- `cloud-connection.js`: cliente Vercel, conexión y solicitudes correlacionadas.
- `app.js`, `index.html`: interfaz y login SSO. Chats con UUID para evitar colisiones por título.
- `hermes-plugin/`: copia versionada del plugin UI instalado en Hermes.
- `sw.js`: caché de la interfaz; excluye las API y otros orígenes.
- `api/`: backend anterior, conservado por compatibilidad; el chat SSO no lo utiliza.

## Límites explícitos

- La autorización y la correspondencia de sesiones se conservan en el almacenamiento de cada origen. Cada turno abre un conector con identidad de ventana única; si se cierra antes de enviar o cae el WebSocket, el turno falla inmediatamente y no se reenvía automáticamente.
- La suspensión de pestañas en móviles puede interrumpir la conexión; requiere prueba en un móvil real.
- Listas locales: no hay sincronización multidispositivo del listado de Agent Hub.
- Solo el perfil `limpatexdev-cloud` está conectado; los otros agentes/grupos siguen siendo prototipos.
- Modelo y esfuerzo se envían al crear una sesión nueva; para cambiarlos, abrir un chat nuevo. `Modelo de Hermes` utiliza la configuración real del perfil.
- La implementación de notas y llamada continua por turnos está en [docs/voice.md](docs/voice.md). Usa STT/TTS de Hermes y necesita el plugin versionado 2.3.0 instalado junto al frontend; no implica que esté publicada. No es OpenAI Realtime/WebRTC. Audio persistido localmente, sin sincronización ni separación de cuentas en un navegador compartido.
- No se autorizan automáticamente acciones sensibles: si un turno pide aprobación, atenderlo en Hermes.

## Instalación del plugin

Copiar `hermes-plugin/` a `plugins/agent-hub/` del home del dashboard y del perfil abierto si difieren. Habilitar exclusivamente `agent-hub` mediante `hermes -p <perfil> plugins enable agent-hub`, sin conceder reemplazo de herramientas. Con sesión autenticada, abrir `/api/dashboard/plugins/rescan`. No hace falta reiniciar: este plugin solo sirve archivos de interfaz y no monta rutas backend ni registra proveedores token.

## Verificación

```sh
node --test tests/cloud-connection.test.js
node --check app.js
node --check cloud-connection.js
node --check sw.js
git diff --check
```

La prueba del navegador debe enviar un mensaje desde Agent Hub, recibir una respuesta real, enviar otro turno de memoria y reconectar conservando la sesión. No confundir pruebas con mocks con conexión de producción.

Despliegue: GitHub `main` activa Vercel. No hacer push sin autorización. Los secretos nunca van en el repositorio ni en el frontend.
