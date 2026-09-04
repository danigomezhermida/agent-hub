# Agent Hub · Limpatex

Interfaz independiente, chat-first y simplificada para conversar con perfiles y grupos de agentes desde ordenador o móvil.

## Acceso

Producción: <https://agent-hub-theta-five.vercel.app>

La app puede instalarse desde el navegador móvil mediante “Añadir a pantalla de inicio”. Usa HTTPS y una PWA básica para cargar el shell incluso con conectividad intermitente.

## Estado actual

- Backend serverless preparado en `api/` con conexión saliente a Hermes Cloud, sin exponer la clave al navegador.
- `GET /api/health` comprueba configuración y disponibilidad del upstream.
- `POST /api/chat` crea/reutiliza sesión y envía mensajes con modelo y esfuerzo.
- El backend permanece **cerrado por defecto** hasta configurar autenticación propia.

El almacenamiento local sigue siendo temporal: todavía no sustituye una cuenta ni una base de datos compartida.

## Desarrollo local en Windows

Desde CMD:

```bat
cd C:\ruta\a\agent-hub
python -m http.server 4173
```

Abrir: <http://127.0.0.1:4173/>

## Backend Hermes Cloud

La capa `api/` usa estas variables exclusivamente en el servidor de Vercel:

- `HERMES_CLOUD_URL`: URL base del gateway Hermes Cloud.
- `HERMES_CLOUD_API_KEY`: clave Bearer del API server de Hermes. Nunca se coloca en `app.js`.
- `AGENT_HUB_ACCESS_TOKEN`: control temporal para impedir que `/api/chat` sea un proxy público.

No debes enviarme ni pegar aquí ninguno de esos valores. Se configurarían directamente como variables privadas en Vercel cuando decidamos el mecanismo de login de Agent Hub.

El siguiente paso funcional es sustituir el control temporal por autenticación propia con cookie segura y conectar el frontend a `/api/chat`. Hasta entonces, el endpoint no acepta mensajes, por diseño.

## Próxima fase: audio y sincronización

El audio grabado se añadirá como otra ruta backend (`/api/audio`) y no se conectará directamente desde la PWA a Hermes. La voz en vivo usará posteriormente un canal de streaming separado, preferiblemente WebRTC o WebSocket, sin mezclarlo con el endpoint de mensajes.
