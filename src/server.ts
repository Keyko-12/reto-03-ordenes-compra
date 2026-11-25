import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { readFile } from "node:fs/promises"
import { extname, join, normalize, sep } from "node:path"
import { cargarSystemPrompt, ejecutarTurno, nuevaSesion, type ConfigAgente, type Sesion } from "./agent.ts"
import { crearLlm, type LlmAdapter } from "./llm/index.ts"
import { listarCasos } from "./tools/paquete.ts"

export type OpcionesServidor = {
  directory: string
  llm: LlmAdapter
  maxIteraciones: number
  maxTokensSesion: number
  maxTokensDia: number
  limitePorMinuto: number
}

const TIPOS: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
}

const ID_SESION = /^[A-Za-z0-9_-]{8,64}$/
const MAX_SESIONES = 500
const MAX_MENSAJE = 2000

export function opcionesDesdeEnv(directory: string, env: Record<string, string | undefined> = process.env): OpcionesServidor {
  return {
    directory,
    llm: crearLlm(env),
    maxIteraciones: Number(env.MAX_ITERACIONES ?? 25),
    maxTokensSesion: Number(env.MAX_TOKENS_SESION ?? 150_000),
    maxTokensDia: Number(env.MAX_TOKENS_DIA ?? 1_500_000),
    limitePorMinuto: Number(env.RATE_LIMIT_POR_MINUTO ?? 20),
  }
}

function json(res: ServerResponse, estado: number, cuerpo: unknown): void {
  res.writeHead(estado, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" })
  res.end(JSON.stringify(cuerpo))
}

async function leerCuerpo(req: IncomingMessage, limite = 32 * 1024): Promise<unknown> {
  const trozos: Buffer[] = []
  let total = 0
  for await (const t of req) {
    total += (t as Buffer).length
    if (total > limite) throw new Error("cuerpo demasiado grande")
    trozos.push(t as Buffer)
  }
  try {
    return JSON.parse(Buffer.concat(trozos).toString("utf8") || "{}")
  } catch {
    throw new Error("JSON inválido")
  }
}

export function crearServidor(opts: OpcionesServidor): Server {
  const sesiones = new Map<string, Sesion>()
  const visitas = new Map<string, number[]>()
  const dia = { fecha: "", tokens: 0 }
  let systemPrompt: Promise<string> | null = null

  const cfg = (): ConfigAgente => ({
    directory: opts.directory,
    maxIteraciones: opts.maxIteraciones,
    maxTokensSesion: opts.maxTokensSesion,
    alConsumir: (n) => {
      dia.tokens += n
    },
  })

  function excedeRitmo(ip: string): boolean {
    const ahora = Date.now()
    const recientes = (visitas.get(ip) ?? []).filter((t) => ahora - t < 60_000)
    recientes.push(ahora)
    visitas.set(ip, recientes)
    if (visitas.size > 5000) visitas.clear()
    return recientes.length > opts.limitePorMinuto
  }

  function topeDiarioAlcanzado(): boolean {
    const hoy = new Date().toISOString().slice(0, 10)
    if (dia.fecha !== hoy) {
      dia.fecha = hoy
      dia.tokens = 0
    }
    return dia.tokens >= opts.maxTokensDia
  }

  async function chat(req: IncomingMessage, res: ServerResponse, ip: string): Promise<void> {
    if (excedeRitmo(ip)) return json(res, 429, { error: "Demasiadas solicitudes. Espera un minuto e intenta de nuevo." })
    let cuerpo: { sessionId?: unknown; message?: unknown }
    try {
      cuerpo = (await leerCuerpo(req)) as typeof cuerpo
    } catch (e) {
      return json(res, 400, { error: e instanceof Error ? e.message : "solicitud inválida" })
    }
    const { sessionId, message } = cuerpo
    if (typeof sessionId !== "string" || !ID_SESION.test(sessionId)) return json(res, 400, { error: "sessionId inválido (8-64 caracteres: letras, números, - o _)." })
    if (typeof message !== "string" || !message.trim()) return json(res, 400, { error: "El mensaje no puede estar vacío." })
    if (message.length > MAX_MENSAJE) return json(res, 400, { error: `El mensaje supera ${MAX_MENSAJE} caracteres.` })
    if (topeDiarioAlcanzado()) {
      return json(res, 200, { reply: "El servicio alcanzó su tope diario de uso del modelo. Vuelve a intentar mañana.", toolCalls: [], needsConfirmation: false })
    }

    systemPrompt ??= cargarSystemPrompt(opts.directory)
    let sesion = sesiones.get(sessionId)
    if (!sesion) {
      if (sesiones.size >= MAX_SESIONES) sesiones.delete(sesiones.keys().next().value as string)
      sesion = nuevaSesion(sessionId, await systemPrompt)
      sesiones.set(sessionId, sesion)
    }
    if (sesion.ocupada) return json(res, 409, { error: "La sesión está procesando un mensaje. Espera su respuesta." })

    sesion.ocupada = true
    try {
      const r = await ejecutarTurno(sesion, message.trim(), opts.llm, cfg())
      json(res, 200, { reply: r.reply, toolCalls: r.toolCalls, needsConfirmation: r.needsConfirmation })
    } finally {
      sesion.ocupada = false
    }
  }

  async function estatico(ruta: string, res: ServerResponse): Promise<void> {
    const web = join(opts.directory, "web")
    const pedido = normalize(ruta === "/" ? "/index.html" : ruta).replace(/^([/\\])+/, "")
    const archivo = join(web, pedido)
    if (!archivo.startsWith(web + sep)) return json(res, 403, { error: "prohibido" })
    try {
      const contenido = await readFile(archivo)
      res.writeHead(200, {
        "content-type": TIPOS[extname(archivo)] ?? "application/octet-stream",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:",
      })
      res.end(contenido)
    } catch {
      json(res, 404, { error: "no encontrado" })
    }
  }

  async function leerSalida(archivo: string): Promise<string> {
    try {
      return await readFile(join(opts.directory, "out", archivo), "utf8")
    } catch {
      return ""
    }
  }

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost")
      const ip = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "?").split(",")[0]!.trim()

      if (req.method === "GET" && url.pathname === "/api/health") {
        return json(res, 200, { ok: true, provider: opts.llm.proveedor, model: opts.llm.modelo, configured: opts.llm.configurado })
      }
      if (req.method === "GET" && url.pathname === "/api/casos") {
        return json(res, 200, { casos: await listarCasos({ directory: opts.directory, sessionId: "api" }) })
      }
      if (req.method === "POST" && url.pathname === "/api/chat") return await chat(req, res, ip)

      const m = /^\/api\/sessions\/([^/]+)$/.exec(url.pathname)
      if (req.method === "GET" && m) {
        const s = sesiones.get(m[1] ?? "")
        if (!s) return json(res, 404, { error: "Sesión no encontrada." })
        return json(res, 200, { id: s.id, creada: s.creada, turno: s.turno, tokens: s.tokens, mensajes: s.mensajes.filter((x) => x.rol !== "sistema") })
      }
      // Salidas de solo lectura para revisar el resultado sin acceso al servidor.
      if (req.method === "GET" && url.pathname === "/api/control") return json(res, 200, { csv: await leerSalida("control.csv") })
      if (req.method === "GET" && url.pathname === "/api/sap") {
        const lineas = (await leerSalida(join("sap", "ordenes.jsonl"))).split("\n").filter(Boolean)
        return json(res, 200, { ordenes: lineas.map((l) => JSON.parse(l)) })
      }

      if (req.method === "GET" && !url.pathname.startsWith("/api/")) return await estatico(url.pathname, res)
      json(res, 404, { error: "no encontrado" })
    } catch (e) {
      // Nunca se expone la traza al cliente.
      console.error("[server]", e instanceof Error ? e.message : e)
      if (!res.headersSent) json(res, 500, { error: "Error interno del servidor." })
    }
  })
}

if (import.meta.main) {
  const directory = join(import.meta.dir, "..")
  const opts = opcionesDesdeEnv(directory)
  const puerto = Number(process.env.PORT ?? 3000)
  crearServidor(opts).listen(puerto, () => {
    const estado = opts.llm.configurado ? "listo" : "SIN CLAVE: configura la variable de entorno del proveedor"
    console.log(`Agente de OC en http://localhost:${puerto} · proveedor=${opts.llm.proveedor} modelo=${opts.llm.modelo} (${estado})`)
  })
}
