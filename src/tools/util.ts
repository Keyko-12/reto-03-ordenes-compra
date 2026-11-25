import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

/** Contexto que el backend (o demo.ts) entrega a cada herramienta. */
export type Ctx = {
  /** Raíz del proyecto. Todas las rutas se resuelven desde aquí. */
  directory: string
  sessionId: string
  /**
   * Carpeta de salida (control.csv, log.jsonl, sap/, <caso>/). Por defecto `<directory>/out`.
   * El servidor la fija por sesión (`out/sesiones/<id>`) para que dos usuarios no compartan órdenes ni registros.
   */
  outDir?: string
  /**
   * Guardia de confirmación humana (la pone el ciclo del agente).
   * Si no existe (demo.ts, pruebas), se confía en el argumento `confirmado`.
   */
  confirmar?: (caso: string) => boolean
}

/** Error de negocio con mensaje apto para mostrarse al usuario (sin traza). */
export class ErrorNegocio extends Error {}

export type Resultado<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; extra?: Record<string, unknown> }

export const exito = <T>(data: T): Resultado<T> => ({ ok: true, data })

export const falla = (error: string, extra?: Record<string, unknown>): Resultado<never> =>
  extra ? { ok: false, error, extra } : { ok: false, error }

/** Contrato de herramientas: siempre un string JSON con { ok, data } o { ok:false, error }. */
export function serializar(r: Resultado<unknown>): string {
  return JSON.stringify(r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error, ...(r.extra ?? {}) })
}

/** Ejecuta `fn` garantizando que nunca lance: convierte cualquier excepción en { ok:false }. */
export async function protegido(fn: () => Promise<Resultado<unknown>>): Promise<string> {
  try {
    return serializar(await fn())
  } catch (e) {
    const mensaje = e instanceof ErrorNegocio ? e.message : `Error interno: ${e instanceof Error ? e.message : String(e)}`
    return serializar(falla(mensaje))
  }
}

export function rutas(ctx: Ctx) {
  return {
    fixtures: join(ctx.directory, "fixtures", "reto-03"),
    out: ctx.outDir ?? join(ctx.directory, "out"),
  }
}

const ID_SESION = /^[A-Za-z0-9_-]{1,64}$/

/** Carpeta de salida aislada de una sesión. Valida el id para que no pueda escapar de `out/sesiones/`. */
export function dirSalidaSesion(directory: string, sessionId: string): string {
  if (!ID_SESION.test(sessionId)) throw new ErrorNegocio("Identificador de sesión inválido.")
  return join(directory, "out", "sesiones", sessionId)
}

const CASO_VALIDO = /^[A-Za-z0-9_-]{1,64}$/

/** Evita rutas arbitrarias (../) en el nombre del caso. */
export function validarNombreCaso(caso: string): void {
  if (!CASO_VALIDO.test(caso)) throw new ErrorNegocio(`Nombre de caso inválido: "${caso}".`)
}

export async function leerJson(ruta: string, etiqueta: string): Promise<unknown> {
  let texto: string
  try {
    texto = await readFile(ruta, "utf8")
  } catch {
    throw new ErrorNegocio(`No se pudo leer ${etiqueta}.`)
  }
  try {
    return JSON.parse(texto)
  } catch {
    throw new ErrorNegocio(`${etiqueta} no es un JSON válido (archivo malformado).`)
  }
}

export async function leerTextoOpcional(ruta: string): Promise<string | null> {
  try {
    return await readFile(ruta, "utf8")
  } catch {
    return null
  }
}

export const sha256 = (texto: string): string => createHash("sha256").update(texto, "utf8").digest("hex")

/** "900.555.111-2" → "900555111" (sin puntos ni dígito de verificación). */
export function normalizarNit(nit: string): string {
  const limpio = nit.trim().replace(/-\d$/, "")
  return limpio.replace(/\D/g, "")
}

const SUFIJOS_SOCIETARIOS = new Set(["sas", "sa", "ltda", "s", "a", "cia", "ltd", "inc"])

/** Nombre comparable: sin tildes, minúsculas, sin puntuación ni sufijos societarios. */
export function normalizarNombre(nombre: string): string {
  return nombre
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t && !SUFIJOS_SOCIETARIOS.has(t))
    .join(" ")
}

/** "11.400.000" → 11400000 · "1.234,50" → 1234.5 (formato colombiano). */
export function parseMonto(texto: string): number {
  return Number(texto.replace(/\./g, "").replace(",", "."))
}

/** 25000000 → "25.000.000" (determinista, sin depender del ICU del runtime). */
export function formatoMonto(n: number): string {
  const [entero = "0", decimales] = n.toFixed(2).replace(/\.00$/, "").split(".")
  const conPuntos = entero.replace(/\B(?=(\d{3})+(?!\d))/g, ".")
  return decimales ? `${conPuntos},${decimales}` : conPuntos
}

/** Parte de fecha (YYYY-MM-DD) de un ISO 8601 con o sin hora. */
export const soloFecha = (iso: string): string => iso.slice(0, 10)

export function sumarDias(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + dias)
  return d.toISOString().slice(0, 10)
}

/** Reloj inyectable: OC_NOW fija la fecha en pruebas. */
export function ahora(): Date {
  return process.env.OC_NOW ? new Date(process.env.OC_NOW) : new Date()
}

export function resumirErrorZod(error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues.map((i) => `${i.path.map(String).join(".") || "(raíz)"}: ${i.message}`).join("; ")
}
