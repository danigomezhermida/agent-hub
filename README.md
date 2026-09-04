# Agent Hub · Limpatex

Interfaz independiente, chat-first y simplificada para conversar con perfiles y grupos de agentes desde ordenador o móvil.

## Acceso

Producción: <https://agent-hub-theta-five.vercel.app>

La app puede instalarse desde el navegador móvil mediante “Añadir a pantalla de inicio”. Usa HTTPS y una PWA básica para cargar el shell incluso con conectividad intermitente.

## Estado actual

- Login propio con cookie segura `HttpOnly` + `Secure` (`/api/login`, `/api/me`, `/api/logout`).
- `GET /api/health` comprueba configuración, sesión y disponibilidad de Hermes.
- `POST /api/chat` crea/reutiliza sesión y envía mensajes con modelo y esfuerzo.
- `POST /api/audio` recibe audio grabado, lo transcribe y lo envía a Hermes.
- `GET /api/voice` reserva el canal separado de voz en vivo.
- El frontend usa el backend real; ya no hay respuestas demo.
- Selector de modelo y esfuerzo dentro de cada conversación.
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
- `AGENT_HUB_PASSWORD`: contraseña privada de acceso a Agent Hub.
- `AGENT_HUB_SESSION_SECRET`: secreto de firma de cookies, mínimo 32 caracteres.
- `OPENAI_API_KEY`: necesaria solo para transcribir audio en `/api/audio`.
- `AGENT_HUB_ACCESS_TOKEN`: opcional, reserva para automatismos; el acceso normal usa cookie.

No debes enviarme ni pegar aquí ninguno de esos valores. Se configurarían directamente como variables privadas en Vercel cuando decidas activar el acceso.

Hasta que configures esas variables, los endpoints devuelven `503 backend_not_configured` o `401 unauthorized`, por diseño.

## Próxima fase: sincronización y voz en vivo

El audio grabado ya entra por `/api/audio`. La voz en vivo usará un canal separado (`/api/voice` como reserva + servidor realtime dedicado con WebRTC/WebSocket), sin mezclarlo con el endpoint de mensajes.
