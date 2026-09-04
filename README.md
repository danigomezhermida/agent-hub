# Agent Hub — prototipo v0

Interfaz independiente, chat-first y simplificada para conversar con perfiles y grupos de agentes. No conecta todavía con Hermes ni modifica el dashboard existente.

## Estado
- Datos de demostración navegables.
- Abrir/seleccionar chats.
- Buscar conversaciones.
- Selector visual de modelo.
- Vista de agentes y grupos.
- Responsive para móvil.
- Preparado para añadir un adaptador de backend sin mezclarlo con la UI.

## Ejecutar en Windows
Desde CMD:

```bat
cd C:\ruta\a\agent-hub
python -m http.server 4173
```

Abrir: `http://127.0.0.1:4173/`

La conexión a Hermes se añadirá después mediante un adaptador seguro, sin exponer tokens en el navegador.
