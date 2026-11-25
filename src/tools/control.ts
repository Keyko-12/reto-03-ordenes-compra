import { appendFile, mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { ahora, rutas, type Ctx } from "./util.ts"

const ENCABEZADO = "solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts"

export type FilaControl = {
  solicitud_id: string
  resultado: "apta" | "bloqueada" | "pendiente_confirmacion" | "creada" | "idempotente"
  numero_oc: string | null
  retroactiva: boolean
  bloqueos: string[]
  confirmaciones: string[]
}

const celda = (v: string): string => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v)

/** Clave sin timestamp para no repetir filas idénticas consecutivas (p. ej. validar dos veces). */
const clave = (f: FilaControl): string =>
  [f.solicitud_id, f.resultado, f.numero_oc ?? "", f.retroactiva, f.bloqueos.join(";"), f.confirmaciones.join(";")].join("|")

/**
 * Agrega una fila a out/control.csv (consumido por Contabilidad / Auditoría).
 * Con `sinRepetir`, omite la fila si la última de esa solicitud es idéntica.
 */
export async function registrarControl(ctx: Ctx, fila: FilaControl, sinRepetir = false): Promise<void> {
  const archivo = join(rutas(ctx).out, "control.csv")
  await mkdir(rutas(ctx).out, { recursive: true })
  let existente = ""
  try {
    existente = await readFile(archivo, "utf8")
  } catch {
    // primer intento: se crea con encabezado
  }
  if (sinRepetir) {
    const previas = existente.split("\n").filter((l) => l.startsWith(`${fila.solicitud_id},`))
    const ultima = previas.at(-1)
    if (ultima) {
      const [id, resultado, oc, retro, bloq, conf] = ultima.split(",")
      if ([id, resultado, oc, retro, bloq, conf].join("|") === clave(fila)) return
    }
  }
  const linea = [
    fila.solicitud_id,
    fila.resultado,
    fila.numero_oc ?? "",
    String(fila.retroactiva),
    fila.bloqueos.join(";"),
    fila.confirmaciones.join(";"),
    ahora().toISOString(),
  ]
    .map(celda)
    .join(",")
  await appendFile(archivo, (existente ? "" : ENCABEZADO + "\n") + linea + "\n", "utf8")
}
