# Agent Hub personal: sincronización y recuperación

## Alcance acordado

Una única cuenta autorizada, utilizada desde varios dispositivos. No es una plataforma SaaS multitenant y no separa herramientas o archivos de varios usuarios dentro de una instancia Hermes.

## Arquitectura

- Vercel sirve únicamente el cliente. No recibe cookies, claves de proveedor ni credenciales privadas de Hermes.
- El popup existente del plugin mantiene la autenticación en el origen Hermes.
- `plugin_api.py` utiliza la sesión canónica de Hermes (`request.state.session`). Una allowlist privada de **exactamente un propietario** bloquea todas las demás identidades; una configuración ausente, inválida o con varios propietarios falla cerrada.
- SQLite guarda instantáneas de chats/mensajes, audio vinculado a su chat, enlaces a sesiones Hermes y un registro durable de turnos. Está en `agenthub-data` del perfil del plugin, fuera de los assets y en almacenamiento persistente.
- Los endpoints de almacenamiento no ejecutan agentes y no aceptan rutas, identidades ni credenciales elegidas por el cliente. Las escrituras validan Origin, tamaño, MIME, esquema y pertenencia.
- Las llamadas al agente y STT/TTS siguen reutilizando el WebSocket y los endpoints existentes de Hermes.

## Sincronización

1. Autorizar Hermes en este navegador y pulsar **Sincronizar**.
2. Verificar al propietario en servidor antes de mostrar el historial almacenado.
3. En un dispositivo nuevo, cargar el estado remoto y descargar audio cuando se necesita.
4. Para importar datos locales, subir primero los audios referenciados, escribir una instantánea con control de versión y leerla de vuelta.
5. No sobrescribir datos distintos que compartan identificador durante una importación sin base común. Mostrar un conflicto y requerir una decisión explícita.
6. Guardar el mensaje y su audio antes de ejecutar el turno; guardar también la respuesta después.

**Conflictos:** «Cargar versión remota» requiere confirmación; no se reintenta una escritura con una versión nueva a espaldas del usuario. El borrador y el origen local se conservan.

La sincronización es explícita y se realiza también alrededor de los turnos; no es una edición colaborativa en tiempo real. La copia local heredada se conserva para evitar pérdidas. La protección del servidor y de la interfaz no sustituye la seguridad del perfil del navegador ni del sistema operativo: alguien que ya puede leer los archivos locales del dispositivo puede acceder a esa copia. Use un perfil de navegador privado.

## Turnos inciertos

- Cada mensaje tiene un identificador persistente y una huella del texto exacto.
- Antes de `prompt.submit`, se reserva el turno mediante una transacción del servidor.
- Repetir el mismo mensaje ya completado devuelve la respuesta guardada; no ejecuta de nuevo al agente.
- Un turno pendiente bloquea nuevos envíos al mismo hilo. No se deduce éxito a partir de texto parecido o marcas de tiempo.
- Solo una aceptación RPC `streaming` y el resultado final permiten registrar una respuesta completada.
- Los rechazos RPC demostrablemente anteriores a la ejecución se registran como rechazados, sin reintento automático.
- **Consultar resultado** recupera una respuesta que ya exista en el registro, o muestra evidencia de historial sin presentarla como respuesta confirmada.
- Si el resultado sigue sin poder confirmarse, el usuario puede **archivar el hilo y abrir una conversación nueva**, tras una advertencia explícita. No se reenvía el mensaje, no se marca completado y no se cancela una acción que pudiera seguir ejecutándose. La nueva conversación no hereda el contexto de la anterior.

El runtime actual no persiste el identificador del mensaje cliente en el historial canónico de Hermes. Por eso un resultado perdido antes de guardarse en el registro no puede asociarse automáticamente con certeza absoluta. Este caso tiene una salida manual segura, no una garantía falsa de recuperación.

## Verificación reproducible

```sh
npm test
uv run --no-project --with pytest --with fastapi --with httpx python -m pytest tests/test_agenthub_storage.py -q
CHROMIUM_PATH=/ruta/a/chromium npm run test:browser
git diff --check
```

Las pruebas de navegador automatizadas utilizan audio sintético y HTTP/WebSocket simulados salvo que el informe de ejecución indique expresamente lo contrario. Las pruebas Python ejercitan FastAPI y SQLite reales con identidades de prueba; no equivalen a una sesión de producción autenticada.

## Publicación y rollback

1. Copia verificada del plugin activo y conservación del commit público anterior.
2. Activar el backend con el reinicio del **dashboard** autorizado por Dani; no reiniciar el gateway ni tocar Little Hotelier.
3. Comprobar la ruta autenticada del backend antes de publicar un frontend que dependa de ella.
4. Instalar assets de plugin y publicar frontend coordinados; verificar versión y contenido servido.
5. Probar texto, nota/STT/turno/TTS y acceso desde otro dispositivo con la misma cuenta.
6. Prueba física móvil: permisos, reproducción, mute, interrupción, suspensión, reconexión y liberación del micrófono.

Rollback: restaurar el plugin anterior y el frontend anterior de forma coordinada. Conservar `agenthub-data`; nunca borrar chats ni audios como parte del rollback.

La fase de grupos continúa bloqueada hasta la validación completa de voz. Este documento describe el diseño y los criterios; no certifica por sí solo un despliegue o una prueba física.
