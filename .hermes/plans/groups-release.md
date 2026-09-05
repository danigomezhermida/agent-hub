# Grupos — entrega autorizada

Usuario: «continua y luego publica todo a producción».

## Regla de primera entrega
Coordinación real de análisis y propuestas. Herramientas deshabilitadas en servidor para cada turno: los grupos no ejecutan cambios de código, emails, cron ni operaciones de negocio. Mostrar este límite. Director planifica, especialistas aportan, director revisa y sintetiza. No fingir permisos interactivos que el puente no soporta.

## Contrato UI/puente/backend
Reusar `hermesCloud.openVoice()` desde gesto y `hermesCloud.storage(op,args)`, sin credenciales ni RPC arbitrario. Nuevas operaciones fijas:
- getGroupCatalog → {director:{id,label,available}, specialists:[{id,label,available}]}.
- getGroups → {revision,groups}; putGroups({expectedRevision,groups}) → mismo.
- startGroupRun({groupId,runId,message,expectedRevision}) → run.
- getGroupRun({runId}) → run.
`run`: {id,groupId,state,steps,text,error}; estados running/completed/failed/uncertain; steps [{profile,stage,status}] sin resultados crudos de especialistas. text solo resultado final del director; error seguro. Un ID generado antes de POST, nunca reintentar submit automáticamente. GET para recuperación.

Grupo: {id,name,director:'limpatexdev-cloud',members:[perfilEspecialista],objective}. Catálogo oficial de limpatex-bot-routing. Disponibilidad verificada en servidor antes de ejecutar. CAS para guardar y lanzar con revisión conocida; una ejecución pendiente por propietario. Configuración capturada por ejecución. No retomar automáticamente tras reinicio. Una nueva petición explícita no debe ejecutar el mismo runId otra vez.

## Fases
1. UI real (crear/editar, listado, detalle, mensaje, estado, resultado, consulta tras recarga) + puente fijo.
2. Runner real de perfiles aislados y sin herramientas + ledger durable.
3. Pruebas unitarias/SQLite/Chromium, contratos exactos, auditoría independiente.
4. Backup, activar plugin/backend (reinicio autorizado), canario autenticado real, publicar main/Vercel, readback. No claim móvil físico.

No modificar runtime Hermes ni configuraciones/memorias de otros perfiles. No activar schedulers/gateways ni reemplazar Little Hotelier. La autoridad de publicar esta entrega no autoriza acciones externas ejecutadas por grupos.
