import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { mensajeDeError, type LlmAdapter, type Mensaje } from "./llm/adapter.ts"
import { definiciones, ejecutarHerramienta, resumir } from "./tools/registro.ts"

/** Estado de una conversación. En memoria: suficiente para el reto (sin base de datos). */
export type Sesion = {
  id: string
  creada: string
  mensajes: Mensaje[]
  /** Número del turno en curso (1, 2, 3…). */
  turno: number
  tokens: number
  /** caso → turno en que se pidió confirmación. Solo vale para el turno inmediatamente siguiente. */
  pendientes: Record<string, number>
  ocupada: boolean
}

export type EventoHerramienta = { nombre: string; args: unknown; ok: boolean; resumen: string; resultado: unknown }

export type RespuestaTurno = {
  reply: string
  toolCalls: EventoHerramienta[]
  needsConfirmation: boolean
  tokensSesion: number
}

export type ConfigAgente = {
  directory: string
  /** CA1: tope de iteraciones herramienta → modelo por turno. */
  maxIteraciones: number
  /** Tope de tokens por sesión (protege la clave del modelo). */
  maxTokensSesion: number
  /** Se avisa de cada consumo de tokens (para el tope diario global del servidor). */
  alConsumir?: (tokens: number) => void
}

export async function cargarSystemPrompt(directory: string): Promise<string> {
  return readFile(join(directory, "agent", "prompt.md"), "utf8")
}

export function nuevaSesion(id: string, systemPrompt: string): Sesion {
  return {
    id,
    creada: new Date().toISOString(),
    mensajes: [{ rol: "sistema", texto: systemPrompt }],
    turno: 0,
    tokens: 0,
    pendientes: {},
    ocupada: false,
  }
}

const MAX_RESULTADO_UI = 6000

function parsear(texto: string): Record<string, any> {
  try {
    return JSON.parse(texto) as Record<string, any>
  } catch {
    return {}
  }
}

/**
 * Un turno del agente: mensaje del usuario → (modelo → herramientas)* → respuesta.
 *
 * - CA1: se detiene en `maxIteraciones` y responde con lo que tiene.
 * - CA3: la confirmación humana se hace cumplir aquí, no solo en el prompt. `oc_crear` con
 *   `confirmado: true` solo procede si la confirmación se pidió en el turno INMEDIATAMENTE anterior.
 * - CA5: un fallo del proveedor LLM se convierte en un mensaje claro; la sesión sigue viva.
 */
export async function ejecutarTurno(sesion: Sesion, texto: string, llm: LlmAdapter, cfg: ConfigAgente): Promise<RespuestaTurno> {
  const toolCalls: EventoHerramienta[] = []
  const terminar = (reply: string, pendientes: Set<string>): RespuestaTurno => {
    for (const caso of Object.keys(sesion.pendientes)) if (!pendientes.has(caso)) delete sesion.pendientes[caso]
    for (const caso of pendientes) sesion.pendientes[caso] = sesion.turno
    return { reply, toolCalls, needsConfirmation: pendientes.size > 0, tokensSesion: sesion.tokens }
  }

  if (sesion.tokens >= cfg.maxTokensSesion) {
    return { reply: "Esta sesión alcanzó su tope de tokens. Abre una sesión nueva para continuar.", toolCalls, needsConfirmation: false, tokensSesion: sesion.tokens }
  }

  sesion.turno += 1
  sesion.mensajes.push({ rol: "usuario", texto })
  const pendientesAlCierre = new Set<string>()
  const defs = definiciones()

  for (let iteracion = 1; iteracion <= cfg.maxIteraciones; iteracion++) {
    let respuesta
    try {
      respuesta = await llm.enviar(sesion.mensajes, defs)
    } catch (e) {
      return terminar(`⚠️ ${mensajeDeError(e)}`, pendientesAlCierre)
    }
    const consumo = respuesta.uso.entrada + respuesta.uso.salida
    sesion.tokens += consumo
    cfg.alConsumir?.(consumo)

    if (respuesta.llamadas.length === 0) {
      sesion.mensajes.push({ rol: "asistente", texto: respuesta.texto, llamadas: [] })
      return terminar(respuesta.texto || "(Sin respuesta del modelo.)", pendientesAlCierre)
    }

    sesion.mensajes.push({ rol: "asistente", texto: respuesta.texto, llamadas: respuesta.llamadas })
    for (const llamada of respuesta.llamadas) {
      const ctx = {
        directory: cfg.directory,
        sessionId: sesion.id,
        confirmar: (caso: string) => sesion.pendientes[caso] === sesion.turno - 1,
      }
      const crudo = await ejecutarHerramienta(llamada.nombre, llamada.args, ctx)
      sesion.mensajes.push({ rol: "herramienta", id: llamada.id, nombre: llamada.nombre, resultado: crudo })

      const json = parsear(crudo)
      const { ok, resumen } = resumir(crudo)
      toolCalls.push({
        nombre: llamada.nombre,
        args: llamada.args,
        ok,
        resumen,
        resultado: crudo.length > MAX_RESULTADO_UI ? `${crudo.slice(0, MAX_RESULTADO_UI)}…` : json,
      })

      const caso = typeof llamada.args.caso === "string" ? llamada.args.caso : null
      if (caso) {
        const data = (json.data ?? {}) as Record<string, any>
        const pideConfirmar =
          (llamada.nombre === "oc_validar" && json.ok && data.apta === true && Array.isArray(data.confirmaciones) && data.confirmaciones.length > 0) ||
          (llamada.nombre === "oc_crear" && json.requiere_confirmacion === true)
        if (pideConfirmar) pendientesAlCierre.add(caso)
        if (llamada.nombre === "oc_crear" && json.ok) pendientesAlCierre.delete(caso)
      }
    }
  }

  // CA1: tope alcanzado. Se pide un resumen sin permitir más herramientas.
  try {
    const nota: Mensaje = {
      rol: "usuario",
      texto: "[sistema] Se alcanzó el tope de iteraciones de este turno. No llames más herramientas: resume lo que lograste y lo que falta.",
    }
    const cierre = await llm.enviar([...sesion.mensajes, nota], defs)
    sesion.tokens += cierre.uso.entrada + cierre.uso.salida
    cfg.alConsumir?.(cierre.uso.entrada + cierre.uso.salida)
    const textoCierre = cierre.texto || "Alcancé el tope de pasos de este turno. Dime si quieres que continúe."
    sesion.mensajes.push({ rol: "asistente", texto: textoCierre, llamadas: [] })
    return terminar(textoCierre, pendientesAlCierre)
  } catch (e) {
    return terminar(`⚠️ Alcancé el tope de pasos de este turno y no pude resumir: ${mensajeDeError(e)}`, pendientesAlCierre)
  }
}
