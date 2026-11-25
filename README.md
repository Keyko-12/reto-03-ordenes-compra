# Reto 03 · Agente de Órdenes de Compra SAP

Agente conversacional en TypeScript que lee un paquete de compra (correo, solicitud, cotización, aprobación y factura si existe), lo valida contra los maestros y los controles **RC1–RC10**, construye la orden de compra tal como quedaría en SAP, genera la evidencia de aprobación y crea la OC en un **SAP simulado**. Lo que no cumple control no se fuerza: se bloquea o se devuelve a la analista para que confirme.

- Documentación técnica y decisiones: [`SOLUCION.md`](./SOLUCION.md)
- **Link de prueba:** `PENDIENTE: pegar aquí la URL pública una vez desplegado` (ver [Despliegue](#despliegue))
- **Acceso:** la aplicación es pública, sin clave de acceso.

## Probarlo en 2 minutos (sin clave de ningún modelo)

```bash
bun install && bun run demo.ts
```

`demo.ts` llama directamente a las herramientas sobre los 6 casos de `fixtures/reto-03/solicitudes/` **sin modelo de lenguaje**. Imprime por caso `apta`, bloqueos, confirmaciones, `retroactiva` y el número de OC o el motivo, demuestra la idempotencia (ejecuta `sol-001` dos veces) y una confirmación explícita para `sol-004`. Sale con código 1 si algún resultado no coincide con lo esperado. Es determinista: `out/` se limpia al inicio.

Resultado esperado:

| Caso | Qué prueba | Resultado |
|---|---|---|
| sol-001 | Camino feliz | OC creada sin intervención (`4500000001`); segunda llamada → misma OC (idempotente) |
| sol-002 | Proveedor inexistente (RC1) | Bloqueada, con acción sugerida |
| sol-003 | Aprobador sin autoridad (RC2, RC3) | Bloqueada, con acción sugerida |
| sol-004 | Cotización ≠ solicitud (RC5, 6 %) | Pide confirmación con ambos valores; crea tras confirmar |
| sol-005 | Factura anterior a la solicitud (RC8) | Retroactiva: crea solo con confirmación y queda `retroactiva=true` en `out/control.csv` |
| sol-006 | IVA no informado (RC6) | Deriva C1 del proveedor, pide confirmación; informa condiciones de pago derivadas (RC7) |

## Levantar la aplicación en local

Requisitos: [Bun](https://bun.sh) 1.1+ (o Node 20+ con `tsx`).

```bash
bun install
cp .env.example .env      # y completa la clave del proveedor elegido
bun run dev               # http://localhost:3000
```

Bun lee `.env` automáticamente. Sin clave, el servidor arranca igual y el chat avisa que el modelo no está configurado.

Para probar el chat completo **sin gastar tokens** usa el modelo guionado:

```bash
LLM_PROVIDER=mock bun run dev
```

### Variables de entorno

| Variable | Por defecto | Descripción |
|---|---|---|
| `LLM_PROVIDER` | `anthropic` | `anthropic`, `openai` (cualquier API compatible con Chat Completions) o `mock` |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | — / `claude-haiku-5-5` | Proveedor Anthropic |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` | — / `https://api.openai.com/v1` / `gpt-4.1-mini` | Proveedor compatible con OpenAI (Gemini, Groq, OpenRouter, Ollama…) |
| `PORT` | `3000` | Puerto HTTP |
| `MAX_ITERACIONES` | `25` | Tope de iteraciones herramienta → modelo por turno |
| `MAX_TOKENS_SESION` | `150000` | Tope de tokens por sesión |
| `MAX_TOKENS_DIA` | `1500000` | Tope diario global del servidor (protege tu clave) |
| `RATE_LIMIT_POR_MINUTO` | `20` | Peticiones por minuto y por IP a `/api/chat` |
| `LLM_TIMEOUT_MS` | `60000` | Timeout de cada llamada al modelo |

La clave solo se lee en el backend: nunca llega al front, a los logs ni a las respuestas de la API.

## Pruebas y verificación de tipos

```bash
bun test            # 35 pruebas: controles, herramientas, ciclo del agente y API
bun run typecheck   # tsc --noEmit (TypeScript estricto, sin any)
```

## API

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId, message }` → `{ reply, toolCalls[], needsConfirmation }` |
| `GET` | `/api/sessions/:id` | Historial completo de la sesión (sin el system prompt) |
| `GET` | `/api/health` | `{ ok, provider, model, configured }` — sin claves |
| `GET` | `/api/casos` | Casos disponibles en los fixtures |
| `GET` | `/api/control` | Contenido de `out/control.csv` (solo lectura) |
| `GET` | `/api/sap` | Órdenes creadas en el SAP simulado (solo lectura) |

`toolCalls[]` trae, por cada herramienta: `nombre`, `args`, `ok`, `resumen` y `resultado`. `needsConfirmation` es `true` cuando el agente cerró el turno pidiendo confirmación humana; el front lo resalta.

## Estructura

```
agent/prompt.md            Comportamiento: system prompt del agente
src/knowledge/             Conocimiento del proceso (reglas RC1–RC10, flujo, glosario)
src/tools/oc.ts            Ejecución: herramientas tipadas con zod (oc_<export>)
src/tools/controles.ts     Reglas RC1–RC10
src/sap/adapter.ts         Interfaz SapAdapter · src/sap/mock.ts: SAP simulado sobre archivos
src/llm/                   Interfaz del proveedor + Anthropic, OpenAI-compatible y mock
src/agent.ts               Ciclo del agente (tope de iteraciones, confirmación humana)
src/server.ts              API HTTP + estáticos
web/                       Front de chat
fixtures/                  Entregados por Periferia (no se modifican)
out/                       Generado en ejecución (no se versiona)
demo.ts                    Verificación sin modelo
```

Un cambio de reglas de negocio toca `src/knowledge/` y `src/tools/controles.ts`, no el servidor.

## Despliegue

El repositorio incluye un `Dockerfile` (imagen `oven/bun`). Con cualquier plataforma que construya desde Dockerfile (Render, Railway, Fly.io…):

1. Crea un servicio web desde este repositorio de GitHub.
2. Configura las variables de entorno: `LLM_PROVIDER` y la clave del proveedor (`ANTHROPIC_API_KEY` u `OPENAI_API_KEY`, y su modelo). Opcional: los límites de la tabla anterior.
3. Puerto `3000` (o el que asigne la plataforma vía `PORT`).
4. Comprueba `GET /api/health` → `configured: true` y pega la URL en este README.

> `out/` vive en el disco del contenedor: se pierde al reiniciar. Es intencional (el reto no pide base de datos).

## Salidas generadas (`out/`)

- `control.csv` — una fila por intento (`solicitud_id, resultado, numero_oc, retroactiva, bloqueos, confirmaciones, ts`) para Contabilidad / Auditoría.
- `log.jsonl` — toda llamada a herramienta (`ts, sessionId, herramienta, args, ok, resumen`).
- `sap/ordenes.jsonl` — órdenes del SAP simulado (numeración desde `4500000001`).
- `<caso>/payload.json`, `<caso>/trazabilidad.json` — la OC y de dónde sale cada valor.
- `<caso>/aprobacion.txt` (con `sha256`) y `aprobacion.pdf` — evidencia de aprobación.
