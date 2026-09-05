# Grupos reales de Agent Hub

## Alcance de la primera entrega
Grupos personales de **análisis y propuestas**. El director `limpatexdev-cloud`
prepara un plan, consulta a todos los especialistas configurados y redacta una
respuesta final revisada. Las aportaciones intermedias no se muestran como
respuestas del director. Se muestran etapas y estado real.

Cada ejecución es una consulta independiente; no hereda conversaciones anteriores.
No usa mocks de producción. No ejecuta herramientas, cambios de código, despliegues,
correos, WhatsApp, scheduler ni jobs de Little Hotelier. Los grupos no añaden una
nueva autorización para esas acciones. No modifica perfiles ni sus configuraciones.
La validación física pendiente de voz no se considera completada por publicar grupos.

## Contrato de servidor
Todos los endpoints se montan bajo `/api/plugins/agent-hub`. Reutilizan la sesión
canónica y el propietario único del plugin. Escrituras exigen Origin igual al
dominio público configurado por la plataforma; nunca se confía en forwarded headers
aportadas por el cliente.

- `GET /group-catalog`: director y especialistas permitidos, disponibilidad de sus
  directorios/configuración (no garantiza salud del proveedor), `mode: analysis-only`.
- `GET /groups`: `{revision, groups}`.
- `PUT /groups`: `{expectedRevision, groups}`. CAS transaccional; 409 ante cambios
  concurrentes. Nunca fusionar automáticamente una copia antigua.
- `POST /groups/{groupId}/runs`: `{runId, message, expectedRevision}`. Devuelve un run.
- `GET /group-runs/{runId}`: consulta sin reenviar ni continuar ejecución.
- `GET /group-runs?groupId=...`: últimas 20 ejecuciones, más recientes primero,
  permitiendo recuperar resultados desde otro dispositivo.

Grupo: `{id,name,director,members,objective}`. Schema cerrado. IDs únicos y seguros;
name 1–120 caracteres, objective 1–2000, director fijo, 1–6 especialistas únicos
permitidos, máximo 100 grupos. Texto no blanco. Catálogo: `limpatexdevsenior`,
`limpatexqa`, `limpatexops`, `limpatexlittlehotelier`, `limpatexcomercial`, `limpatexdiario`.
Un perfil fuera del catálogo no se activa por existir en el sistema.

Run público: `{id,groupId,state,steps,text,error}`; step `{profile,stage,status}`.
Estados: running/completed/failed/uncertain. Solo `completed` tiene respuesta final.
Errores del proveedor se convierten en mensajes genéricos: no se exponen logs,
excepciones, rutas, credenciales, hashes de identidad ni aportaciones internas.

## Ejecución y seguridad
- SQLite durable: tablas separadas `group_state` y `group_runs`. No se cambia el
  snapshot de chats/audio ni sus revisiones. WAL, transacciones y permisos existentes.
- Se reserva runId y digest de consulta antes de llamar al proveedor. Repetir mismo
  ID/consulta devuelve estado existente; distinto contenido con el mismo ID → 409.
- Una ejecución activa por propietario; el índice único y la transacción impiden
  dobles lanzamientos concurrentes.
- Se captura configuración validada en la reserva. La disponibilidad de cada perfil
  se vuelve a comprobar inmediatamente antes de invocarlo.
- Director plan → especialistas secuenciales → director review. 600 segundos totales,
  100 por subproceso, 80 de presupuesto interno, una iteración, respuesta ≤16000
  caracteres por etapa. Consulta ≤12000 caracteres; body ≤32 KiB.
- `group_worker.py` es un proceso aislado con `HERMES_HOME` fijado antes de importar
  Hermes. Su entorno contiene solo HOME, PATH, LANG, HERMES_HOME y PYTHONPATH:
  no hereda claves de otros perfiles ni secretos del dashboard. Usa resolución
  canónica de credenciales y AIAgent, no interpreta stdout CLI.
- `enabled_toolsets=[]`, asserts de tools y valid_tool_names vacíos, sin memoria,
  contexto de ficheros, sesión persistida, revisión de fondo ni fallback de modelo.
  Permite solo chat_completions/anthropic_messages/codex_responses. ACP y runtimes
  Codex externos se rechazan: podrían disponer de herramientas ajenas a Hermes.
- IPC por archivo temporal privado. stdout/stderr descartados antes de imports.
  El padre mata el grupo de procesos al vencer el tiempo; en Linux el worker se
  termina también al morir su padre (PDEATHSIG).
- Al cambiar la generación del backend, runs todavía running pasan a uncertain.
  Nunca se retoman/reenvían automáticamente. Cerrar ventana o desconectar no cancela
  una consulta ya aceptada. La consulta de estado sí es segura.
- No es un sandbox general ni multitenancy: solo una cuenta autorizada y transportes
  sin herramientas. La futura ejecución de acciones requiere otro diseño de permisos.

## Verificación reproducible
```sh
uv run --no-project --with pytest --with fastapi --with httpx python -m pytest tests/test_agenthub_storage.py tests/test_agenthub_groups.py tests/test_agenthub_group_runs.py tests/test_agenthub_group_worker.py -q
npm test
git diff --check
```
`tests/group-real-canary.py` es OPT-IN: usa SQLite temporal e identidad TestClient,
pero proveedores reales sin sustitutos. Consume inferencia; no equivale a autorización
real de producción. La prueba autenticada y los hashes desplegados se registran aparte.
No usar `/opt/data/profiles/...` como directorio temporal de tests.

## Publicación y rollback
Backend primero; verificar catálogo y canary autenticado. Luego frontend y assets/SW.
Guardar backup del plugin instalado antes de copiar. No reiniciar gateway ni jobs.
El frontend anterior tolera las tablas nuevas. Rollback: restaurar ficheros del plugin
respaldados y frontend anterior sin borrar SQLite. Una ejecución interrumpida no se
certifica completada ni se reenvía después del rollback.
