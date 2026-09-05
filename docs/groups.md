# Grupos reales — primera iteración local

## Alcance y estado
La UI ya consume exclusivamente el catálogo, configuraciones y ejecuciones reales del backend mediante operaciones fijas del puente autenticado. Se retiraron los grupos de demostración. Este repositorio no activa, publica ni reinicia Hermes por sí mismo.

## Flujo operativo objetivo
1. Dani define nombre, objetivo y especialistas.
2. `limpatexdev-cloud` es el director obligatorio y único interlocutor final.
3. Antes de ejecutar, el servidor deberá verificar disponibilidad de perfiles, permisos y composición vigente.
4. El director asigna subtareas con alcance; recibe evidencias; revisa y sintetiza. Los especialistas no hablan directamente con Dani.
5. Una selección de grupo nunca autoriza producción, mensajes externos, migraciones ni schedulers. Little Hotelier conserva sus jobs.

Casos documentados por `limpatex-bot-routing`: desarrollo + revisión QA; análisis operativo; documentación de decisiones/procesos; vigilancia Little Hotelier sin sustituir runners; investigación comercial sin envíos. No se crean grupos automáticos ni se inventan flujos empresariales.

## API de la entrega
- `GET /api/plugins/agent-hub/group-catalog`: director y especialistas con disponibilidad real; un error no se sustituye por disponibilidad inventada.
- `GET/PUT /api/plugins/agent-hub/groups`: lectura y sustitución completa con CAS mediante `expectedRevision`.
- `POST /api/plugins/agent-hub/groups/{groupId}/runs`: inicio idempotente con `runId` persistido previamente, mensaje y revisión esperada.
- `GET /api/plugins/agent-hub/group-runs/{runId}` y `GET /api/plugins/agent-hub/group-runs?groupId=...`: consulta segura de estado e historial reciente.
- Cada grupo contiene exclusivamente `id`, `name`, `director`, `members` y `objective`; el director fijo es `limpatexdev-cloud` y debe existir al menos un especialista.
- El servidor revalida disponibilidad, composición, propietario personal y revisión antes de aceptar una ejecución. Una ejecución pendiente por propietario.
- El cliente solo muestra pasos de estado y el texto final del director; no recibe resultados crudos de especialistas.
- La configuración de grupos mantiene una revisión independiente del snapshot de chats.

## Verificación reproducible
```sh
uv run --no-project --with pytest --with fastapi --with httpx python -m pytest tests/test_agenthub_storage.py tests/test_agenthub_groups.py -q
npm test
git diff --check
```
Pruebas usan SQLite temporal real y sesiones sintéticas de TestClient. No son una comprobación autenticada de producción. RED inicial 404 antes de implementar; RED validación 12 casos antes del validador; después GREEN. Cobertura adicional: rechazo de otras identidades y origen, colección inválida, CAS concurrente, reapertura de DB y preservación de chats.

## Cliente y seguridad
- Operaciones permitidas: `getGroupCatalog`, `getGroups`, `putGroups`, `startGroupRun`, `getGroupRun` y `getGroupRuns`; no existe RPC arbitrario desde el cliente.
- El formulario usa CAS y verifica cada escritura con un `getGroups` posterior antes de mostrar éxito.
- El `runId` se persiste antes del POST. Una recarga nunca repite el POST; la recuperación se hace solo mediante GET explícito, incluido el historial de otro dispositivo.
- Una respuesta HTTP definitiva al inicio queda como «no enviada»; una pérdida de transporte queda incierta y bloquea nuevas ejecuciones hasta consultar.
- Cada ejecución es una consulta independiente, sin contexto heredado. El servidor deshabilita herramientas y limita el resultado visible al texto final del director.
- Publicación únicamente con orden explícita en la tarea de integración.
