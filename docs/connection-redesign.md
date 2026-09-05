# Agent Hub — Rediseño del sistema de conexión y sincronización

## Problema (reportado por Dani)
Cada vez que abro Agent Hub tras sincronizar tengo que volver a abrir el panel
lateral y pulsar «Sincronizar». Ese botón solo funciona a veces; en móvil casi
nunca. Quiero un sistema más rápido, fiable y cómodo: al volver a abrir la app
con una autorización guardada, **verificar y sincronizar al primer toque**, sin
cazar el botón en un cajón oculto.

## Causas raíz (verificadas en código)
1. **Sincronizar usa la maquinaria de «voz».** `cloud-sync.syncFromUserGesture()`
   llama a `openVoice()` → abre popup `?mode=voice` que exige abrir WebSocket y
   confirmar `ready` en ≤15 s. Pero sincronizar solo hace operaciones de
   almacenamiento HTTP (`identity/getState/putState/audio`) que NO necesitan
   WebSocket. Resultado: depende de una conexión pesada y frágil, propensa a
   timeout y bloqueos, sobre todo en móvil/PWA.
2. **El estado «autorizado pero no verificado» es ambiguo.** Tras una recarga con
   el bit de autorización guardado, la app no muestra el aviso de conexión (lo
   suprime porque `isConnected()` es true), deja la historia oculta (`sync-locked`)
   y no explica que hay que re-verificar → el usuario pulsa cosas y nada ocurre.
3. **Verificar y sincronizar son dos gestos/ventanas separadas.** Autorizar abre
   una ventana y cierra; sincronizar abre OTRA. En móvil, varias ventanas
   emergentes seguidas son poco fiables.
4. **Un solo popup y una sola operación a la vez.** `request()` rechaza si hay
   otro popup abierto o `pending.size` > 0 («Termina la operación actual»); una
   ventana colgada de un turno anterior bloquea el siguiente sync.

## Objetivo de diseño
La app debe, con un **único gesto** tras cada recarga (tocar cualquier
interacción útil o un botón claro), abrir **una** ventana ligera que:
1. Verifica al propietario (`identity`).
2. Carga el estado remoto y sincroniza (storage HTTP, sin WebSocket).
3. Cierra sola.
Y todo ello sin exigir la conexión de voz.

## Arquitectura propuesta
Separar en el cliente dos leases de popup independientes:
- **Lease de almacenamiento/sync (ligero):** operaciones `storage` que corren por
  fetch same-origin en el origen Hermes; sin socket. Se usa para sync, grupos,
  recuperación y audio bajo demanda.
- **Lease de voz/turno (existente):** para `chat`/`transcribe`/`synthesize`, que
  sí necesitan WebSocket/mic. Se mantiene intacto.

### Cambios por archivo
- `hermes-plugin/dashboard/dist/connector.js` + `connect.html`: un modo ligero de
  almacenamiento que auto-verifica al propietario cuando ya existe grant
  (`allowed`), procesa `storage` y se cierra; sin exigir socket para `ready`.
- `cloud-connection.js` (cliente): nueva operación `hermesCloud.sync()` /
  `storage` que abre el popup ligero, sin `voiceLease`, sin requisito de socket;
  correlación de requestId y cierre tras drenar la cola. Reutilizar canal si ya
  hay popup abierto (no rechazar por `pending.size` cuando es el mismo lease).
- `cloud-sync.js`: `syncFromUserGesture`/`ensureReady` pasan a usar el lease de
  almacenamiento, no `openVoice`. `beforeTurn`/`afterTurn` idem.
- `app.js`: en cada recarga con autorización guardada, presentar un estado claro
  («Tu cuenta está guardada») y **disparar verify+sync al primer gesto** de
  interacción (o con un botón «Conectar y sincronizar» único, también accesible
  en la vista de inicio en móvil). Botón de re-conexión visible en móvil sin abrir
  el cajón lateral.
- `app.js`/`index.html`/`styles.css`: UI de estado inequívoco + acceso al sync en
  la cabecera/portada móvil.
- `plugin_api.py`/SQLite: solo si hace falta (p. ej. exponer un `ready` ligero).
  Por defecto NO se espera necesario; el storage ya es HTTP.

### Seguridad (mantener fail-closed)
- Popup con nombre único por canal; origen limitado a los dos exactos.
- `authorize` siempre requiere clic explícito; nunca recuperar un grant previo
  en silencio para autorizar. (El modo de almacenamiento con grant previo sí
  verifica identidad por `identity` y no concede nada nuevo.)
- Revocación persiste `revoking`, bloquea y solo se limpia tras `revoked`.
- No exportar cookies/tickets/claves; storage solo en el origen Hermes.

## Fases de entrega
1. Cambios cliente + conector en el repo; tests locales (`npm test`, checks).
2. Verificación local de regresiones (127 + nuevas) y recorrido de navegador.
3. Plan para activar el conector en el perfil cloud → **requiere reiniciar el
   dashboard con autorización explícita y separada** (acción protegida).
4. Push a `main` → Vercel (autorizado por Dani al terminar) tras validación.
5. Smoke público y, si procede, comprobación móvil física separada.

## Fuera de alcance / pendientes
- No tocar jobs de Little Hotelier. No tocar runtime de /opt/hermes.
- Móvil físico (permisos, PWA) es evidencia separada de QA local.
