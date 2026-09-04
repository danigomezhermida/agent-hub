# Agent Hub · Limpatex

Interfaz independiente, chat-first y simplificada para conversar con perfiles y grupos de agentes desde ordenador o móvil.

## Acceso

Producción: <https://agent-hub-theta-five.vercel.app>

La app puede instalarse desde el navegador móvil mediante “Añadir a pantalla de inicio”. Usa HTTPS y una PWA básica para cargar el shell incluso con conectividad intermitente.

## Estado actual

- Chats y grupos demo navegables.
- Creación de chats y grupos guardada en el navegador.
- Mensajes y modelo seleccionado guardados localmente.
- Diseño responsive y PWA (`manifest.webmanifest` + `sw.js`).
- Despliegue automático mediante GitHub `main` → Vercel.
- **Todavía no conecta con Hermes ni ofrece sincronización multi-dispositivo.**

El almacenamiento local permite continuar en el mismo dispositivo/navegador, pero no sustituye una cuenta ni una base de datos compartida.

## Desarrollo local en Windows

Desde CMD:

```bat
cd C:\ruta\a\agent-hub
python -m http.server 4173
```

Abrir: <http://127.0.0.1:4173/>

## Próxima fase: conexión real

La conexión prevista es:

```text
Agent Hub en Vercel → backend/proxy seguro → Hermes Cloud o Hermes local
```

No poner tokens, cookies, contraseñas, claves API, archivos `auth.json` ni contenido de `.env` en el frontend o en este repositorio. Antes de implementar la conexión hay que confirmar el endpoint, autenticación y alcance de Hermes Cloud.
