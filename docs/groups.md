# Grupos reales — primera iteración local

## Alcance y estado
Dani pidió empezar grupos tras publicar voz/sincronización. Esta iteración implementa **solo configuración persistente en backend**, sin activar ejecuciones, publicar ni reiniciar Hermes. Las pruebas físicas pendientes de voz siguen pendientes. La UI actual de grupos permanece como demostración local y NO usa este API todavía.

## Flujo operativo objetivo
1. Dani define nombre, objetivo y especialistas.
2. `limpatexdev-cloud` es el director obligatorio y único interlocutor final.
3. Antes de ejecutar, el servidor deberá verificar disponibilidad de perfiles, permisos y composición vigente.
4. El director asigna subtareas con alcance; recibe evidencias; revisa y sintetiza. Los especialistas no hablan directamente con Dani.
5. Una selección de grupo nunca autoriza producción, mensajes externos, migraciones ni schedulers. Little Hotelier conserva sus jobs.

Casos documentados por `limpatex-bot-routing`: desarrollo + revisión QA; análisis operativo; documentación de decisiones/procesos; vigilancia Little Hotelier sin sustituir runners; investigación comercial sin envíos. No se crean grupos automáticos ni se inventan flujos empresariales.

## API local implementada
- `GET /api/plugins/agent-hub/groups`: `{revision, groups}`.
- `PUT /api/plugins/agent-hub/groups`: `{expectedRevision, groups}`. Sustitución completa explícita con CAS; rechazo 409 de revisión obsoleta. No mezcla automática.
- Cada grupo contiene exclusivamente `id`, `name`, `director`, `members`, `objective`.
- Director fijo `limpatexdev-cloud`; miembros especialistas, sin duplicados y al menos uno.
- Catálogo permitido: `limpatexdevsenior`, `limpatexqa`, `limpatexops`, `limpatexlittlehotelier`, `limpatexcomercial`, `limpatexdiario`.
- El catálogo es una política de configuración, NO una certificación de salud/disponibilidad runtime.
- Hasta 100 grupos; nombre 120 caracteres, objetivo 2000; cuerpo 128 KiB.
- Autorización personal y comprobación Origin canónicas reutilizadas. Tabla `group_state` en la misma SQLite, particionada por propietario. Revisiones independientes del snapshot de chats.
- No ejecuta RPC ni crea sesiones de agentes. No importa grupos demo anteriores automáticamente.

## Verificación reproducible
```sh
uv run --no-project --with pytest --with fastapi --with httpx python -m pytest tests/test_agenthub_storage.py tests/test_agenthub_groups.py -q
npm test
git diff --check
```
Pruebas usan SQLite temporal real y sesiones sintéticas de TestClient. No son una comprobación autenticada de producción. RED inicial 404 antes de implementar; RED validación 12 casos antes del validador; después GREEN. Cobertura adicional: rechazo de otras identidades y origen, colección inválida, CAS concurrente, reapertura de DB y preservación de chats.

## Próximas iteraciones (no implementadas aquí)
1. Formulario real cliente: catálogo desde servidor, validación cliente, guardar/recargar autenticados, conflictos visibles. Retirar demos de la experiencia real.
2. Transporte fijo del puente SSO para grupos, sin exponer credenciales ni abrir RPC arbitrario.
3. Orquestación duradera y permisos de servidor: estado, correlación, límites de rondas, cancelación real o incertidumbre explícita, sin repetición automática de herramientas.
4. Ejecución real director + especialistas y pruebas independientes. Una llamada `prompt.submit` por sí sola no demuestra coordinación multiagente.
5. Publicación únicamente con orden explícita en esa tarea.
