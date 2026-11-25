import { appendFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod/v4"
import * as oc from "./oc.ts"
import { ahora, resumirErrorZod, rutas, serializar, falla, type Ctx } from "./util.ts"

type Herramienta = {
  description: string
  args: z.ZodRawShape
  execute: (args: never, ctx: Ctx) => Promise<string>
}

/** Todas las herramientas, con el nombre que ve el modelo: <archivo>_<export>. */
export const herramientas: Record<string, Herramienta> = Object.fromEntries(
  Object.entries(oc)
    .filter(([, v]) => typeof v === "object" && v !== null && "execute" in v)
    .map(([nombre, def]) => [`oc_${nombre}`, def as unknown as Herramienta]),
)

export type DefinicionHerramienta = { nombre: string; descripcion: string; esquema: Record<string, unknown> }

/** Definiciones para el adaptador LLM (JSON Schema generado desde los esquemas zod). */
export function definiciones(): DefinicionHerramienta[] {
  return Object.entries(herramientas).map(([nombre, h]) => {
    const { $schema: _ignorado, ...esquema } = z.toJSONSchema(z.object(h.args)) as Record<string, unknown>
    return { nombre, descripcion: h.description, esquema }
  })
}

function resumir(texto: string): { ok: boolean; resumen: string } {
  let r: { ok?: boolean; error?: string; data?: Record<string, unknown> } & Record<string, unknown>
  try {
    r = JSON.parse(texto)
  } catch {
    return { ok: false, resumen: "respuesta no JSON" }
  }
  if (!r.ok) return { ok: false, resumen: String(r.error ?? "error").slice(0, 300) }
  const d = r.data ?? {}
  if ("apta" in d) {
    const b = (d.bloqueos as { codigo: string }[]).map((x) => x.codigo)
    const c = (d.confirmaciones as { codigo: string }[]).map((x) => x.codigo)
    return { ok: true, resumen: `apta=${d.apta}; bloqueos=[${b}]; confirmaciones=[${c}]; retroactiva=${d.retroactiva}` }
  }
  if ("numero_oc" in d) return { ok: true, resumen: `OC ${d.numero_oc}${d.idempotente ? " (ya existía)" : ""}` }
  if ("orden" in d) return { ok: true, resumen: `payload listo; trazabilidad en ${d.ruta_trazabilidad}` }
  if ("sha256" in d) return { ok: true, resumen: `evidencia ${d.ruta}; sha256 ${String(d.sha256).slice(0, 12)}…` }
  if ("solicitud" in d) return { ok: true, resumen: `paquete leído; faltantes=[${(d.faltantes as string[]).join(",")}]` }
  return { ok: true, resumen: Object.keys(d).join(", ") }
}

async function registrarLlamada(ctx: Ctx, linea: Record<string, unknown>): Promise<void> {
  try {
    const out = rutas(ctx).out
    await mkdir(out, { recursive: true })
    await appendFile(join(out, "log.jsonl"), JSON.stringify(linea) + "\n", "utf8")
  } catch {
    /* el log nunca debe romper la herramienta */
  }
}

/**
 * Punto único de ejecución: valida los argumentos con zod, ejecuta, registra en out/log.jsonl (CA4)
 * y devuelve siempre un string JSON. Nunca lanza.
 */
export async function ejecutarHerramienta(nombre: string, argsCrudos: unknown, ctx: Ctx): Promise<string> {
  const h = herramientas[nombre]
  let resultado: string
  if (!h) {
    resultado = serializar(falla(`Herramienta desconocida: ${nombre}. Disponibles: ${Object.keys(herramientas).join(", ")}`))
  } else {
    const v = z.object(h.args).safeParse(argsCrudos ?? {})
    if (!v.success) {
      resultado = serializar(falla(`Argumentos inválidos para ${nombre}: ${resumirErrorZod(v.error)}`))
    } else {
      try {
        resultado = await h.execute(v.data as never, ctx)
      } catch (e) {
        resultado = serializar(falla(`Error interno: ${e instanceof Error ? e.message : String(e)}`))
      }
    }
  }
  const { ok, resumen } = resumir(resultado)
  const argsLog = JSON.stringify(argsCrudos ?? {})
  await registrarLlamada(ctx, {
    ts: ahora().toISOString(),
    sessionId: ctx.sessionId,
    herramienta: nombre,
    args: argsLog.length > 400 ? `${argsLog.slice(0, 400)}…` : JSON.parse(argsLog),
    ok,
    resumen,
  })
  return resultado
}

export { resumir }
