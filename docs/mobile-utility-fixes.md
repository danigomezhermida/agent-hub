# Agent Hub — correcciones de utilidad móvil

## Estado de entrega
Correcciones locales completas y verificadas en la rama `fix/mobile-utility` del repositorio `/opt/data/agent-hub-github-sync-1788531677`. No se ha hecho commit, push, despliegue, migración ni modificación del backend instalado. Producción no incluye estas correcciones todavía.

## Problema resuelto y comportamiento nuevo

| Hallazgo | Corrección | Por qué mejora el uso |
|---|---|---|
| Diálogo de conexión sin accesibilidad correcta | Semántica de diálogo, estado ARIA sincronizado, fondo inerte, foco contenido, Escape y botón para volver | No permite perderse detrás del acceso; el teclado puede completar o abandonar el flujo |
| Texto «Perfil conectado» antes de autenticar | Distingue destino, permiso guardado, autorización y sincronización | No presenta una conexión verificada cuando aún falta acceder |
| Cierre de la ventana sin explicación | Mensaje explícito de cierre sin completar autorización, con reintento voluntario | Permite recuperarse sin borrar ni reenviar mensajes |
| Selector de especialistas engañoso en chats | Chats individuales muestran solo Hermes · Director; especialistas mediante grupos reales | La identidad visible corresponde al perfil que usa el conector, sin inventar enrutamiento |
| Borrador compartido entre hilos | Almacenamiento local v2 separado por ID de conversación e inicio, restauración tras verificar la cuenta, ocultación al revocar | Cambiar de hilo no mezcla textos ni borra borradores de otros chats |
| Grupos con actualización exclusivamente manual | Consultas GET automáticas cada 3 segundos mientras hay una observación válida, máximo 10 minutos; pausa por navegación, ocultación, voz u operación de primer plano | Sigue el trabajo sin pulsar repetidamente, sin abrir ventanas desde temporizadores ni repetir el envío |
| Resultados anteriores sin acceso seleccionable | Historial de hasta 20 ejecuciones devuelto por el servidor y selección de respuestas verificadas; botón para volver a la consulta actual | Permite revisar resultados sin perder el control de una ejecución pendiente |
| Respuestas largas y código poco reutilizables | Presentación segura de títulos, listas y bloques de código; copiar respuesta o código; alternativa manual si el navegador deniega el portapapeles | Hace legible y reutilizable el trabajo desde el móvil sin ejecutar HTML del modelo |

Los borradores antiguos sin identificador no se asignan a un hilo al azar: se conserva su fuente y existe recuperación explícita en inicio, sin sobrescribir texto ya escrito. Los borradores siguen siendo locales; esta corrección no añade sincronización de borradores entre dispositivos.

Durante integración se cerraron también regresiones con pruebas: temporizador que podía cerrar un recurso usado por otra operación; resultado histórico sustituido por la observación; limpieza del contenedor nuevo de resultados; cabecera móvil demasiado estrecha; campo restaurado de solo 8 px al medir una vista oculta. La cabecera ahora usa dos filas y el compositor mantiene un mínimo de 44 px y se recalcula cuando aparece.

## Archivos y áreas cambiados
- `app.js`: acceso, identidad del Director, borradores por conversación, renderizado de respuestas y tamaño del compositor.
- `cloud-connection.js`: explicación del cierre de autorización, sin cambiar endpoints ni permisos.
- `groups-ui.js`: observación acotada, coordinación con operaciones de primer plano e historial verificado.
- `safe-content.js` (nuevo): renderer por nodos DOM, sin `innerHTML` del modelo, y copia con fallback honesto.
- `index.html`, `styles.css`: accesibilidad, controles de recuperación/copia, cabecera móvil y estilos de resultados.
- `sw.js`: precaché de `safe-content.js`, caché de shell v13 y referencias de assets `20260905-9` consistentes con HTML.
- `package.json`: comprobación sintáctica del renderer y comando `npm run test:utility`.
- `tests/composer.test.cjs`, `tests/cloud-connection.test.js`, `tests/groups-ui.test.cjs`, `tests/safe-content.test.cjs` y `tests/utility-browser.cjs`: regresiones y recorrido móvil/escritorio.
- `docs/mobile-utility-fixes.md`: este informe dentro del proyecto.
- Skill interna `agenthub`: procedimiento de comprobación visual, medición de campos visibles y coordinación del seguimiento de grupos. Sin instrucciones de publicar automáticamente.

## Verificación realmente ejecutada
- `npm test`: **127/127 PASS**, incluyendo comprobaciones de sintaxis. Logs: `unit.log`.
- Suite Python de almacenamiento, grupos, ejecuciones y worker: **64/64 PASS**; **2 avisos de deprecación** de las dependencias de test. Logs: `backend.log`.
- `npm run test:browser` y `node tests/recovery-browser.cjs`: **PASS** en 1280 y 390 px para chat, grupos, voz y recuperación; HTTP/WS/proveedores remotos simulados. El recorrido cross-origin ejecuta cliente/conector reales con servicios remotos simulados. Logs: `browser.log`.
- `npm run test:utility`: **PASS en 320, 360, 390 y 1280 px**. Comprueba foco y cierre del acceso, identidad, cambio de hilo con borradores, geometría legible, títulos/listas/código, escritura y lectura real del portapapeles en Chromium, dos consultas automáticas GET frente a un único inicio de grupo, y selección de resultado anterior. Autenticación/servicios remotos simulados; la página externa de acceso de esta prueba también es una simulación. Logs: `utility.log`.
- Capturas finales de 390 px inspeccionadas visualmente; no solo comprobación de overflow.
- `git diff --check`: PASS sin errores.
- Revisión independiente del núcleo: PASS (`deleg_6fe8436f`). Revisión independiente posterior de geometría/compositor y recorrido final: PASS (`deleg_00de79e1`), con repetición de las 127 pruebas y del recorrido de utilidad.

## Límites y siguientes pasos
- Esta entrega es **local**, no está desplegada. Integrar/publicar requiere una orden explícita para esta corrección.
- No se ha repetido una sesión E2E autenticada contra producción para estas correcciones. No se ha eludido el login ni usado credenciales de pruebas como si fueran una cuenta real.
- Pendiente teléfono físico: teclado y viewport reales, micrófono/permisos, suspensión, regreso desde la ventana de Hermes y PWA instalada. Las capturas son emulación de Chromium.
- Historial limitado a las 20 ejecuciones más recientes que expone la API actual; no hay paginación adicional ni búsqueda global nueva.
- Si se pausa el seguimiento, se informa y se puede retomar con «Consultar estado e historial». No se cancela ni se reenvía una ejecución.
- Copiar depende de permisos del navegador; si falla, se selecciona el texto para copia manual y no se afirma éxito.
- El renderer cubre títulos, listas, párrafos y código; no es un procesador completo de Markdown. Los enlaces y HTML no se convierten en contenido ejecutable.
- Los grupos conservan su alcance de análisis/propuestas, sin herramientas ni acciones externas.

## Evidencia
Directorio: `/opt/data/profiles/limpatexdev-cloud/reports/agenthub-utility-fixes/`.
Incluye este informe, logs reales y `390-access.png`, `390-answer.png`, `390-group.png`.
