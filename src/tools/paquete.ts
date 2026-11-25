import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod/v4"
import {
  AprobacionJsonSchema,
  CentroCostoSchema,
  CondicionPagoSchema,
  CorreoSchema,
  IndicadorIvaSchema,
  ProveedorSchema,
  SolicitudSchema,
  type Aprobacion,
  type Cotizacion,
  type Factura,
  type Maestros,
  type Paquete,
} from "./tipos.ts"
import {
  ErrorNegocio,
  leerJson,
  leerTextoOpcional,
  normalizarNit,
  parseMonto,
  resumirErrorZod,
  rutas,
  soloFecha,
  sumarDias,
  validarNombreCaso,
  type Ctx,
} from "./util.ts"

/* ---------- Maestros ---------- */

export async function cargarMaestros(ctx: Ctx): Promise<Maestros> {
  const dir = join(rutas(ctx).fixtures, "maestros")
  const leer = async <T>(archivo: string, schema: z.ZodType<T>): Promise<T[]> => {
    const crudo = await leerJson(join(dir, archivo), `maestros/${archivo}`)
    const r = z.array(schema).safeParse(crudo)
    if (!r.success) throw new ErrorNegocio(`maestros/${archivo} no cumple el esquema: ${resumirErrorZod(r.error)}`)
    return r.data
  }
  return {
    proveedores: await leer("proveedores.json", ProveedorSchema),
    centros: await leer("centros-costo.json", CentroCostoSchema),
    indicadoresIva: await leer("indicadores-iva.json", IndicadorIvaSchema),
    condicionesPago: await leer("condiciones-pago.json", CondicionPagoSchema),
  }
}

/* ---------- Parsers de texto ---------- */

const primero = (texto: string, re: RegExp): string | null => re.exec(texto)?.[1]?.trim() ?? null

/** Extrae los datos de cotizacion.txt. Lanza ErrorNegocio si no hay un total legible. */
export function parsearCotizacion(texto: string): Cotizacion {
  const total = /^TOTAL[^:\n]*:\s*([A-Z]{3})\s*([\d.,]+)/m.exec(texto)
  if (!total?.[1] || !total[2]) throw new ErrorNegocio("cotizacion.txt no contiene un TOTAL legible.")
  const monto = parseMonto(total[2])
  if (!Number.isFinite(monto)) throw new ErrorNegocio("cotizacion.txt tiene un TOTAL no numérico.")

  const fecha = primero(texto, /^Fecha:\s*(\d{4}-\d{2}-\d{2})/m)
  const diasValidez = primero(texto, /Validez de la oferta:\s*(\d+)\s*d[ií]as/i)
  const nit = primero(texto, /^NIT:\s*([\d.\-]+)/m)
  const iva = primero(texto, /^IVA\s*(\d+(?:[.,]\d+)?)\s*%/m)

  return {
    proveedor: primero(texto, /^Proveedor:\s*(.+)$/m) ?? "",
    nit: nit ? normalizarNit(nit) : null,
    total: monto,
    moneda: total[1],
    validez_hasta: fecha && diasValidez ? sumarDias(fecha, Number(diasValidez)) : null,
    texto,
    referencia: primero(texto, /^COTIZACI[ÓO]N\s+(\S+)/mi),
    fecha,
    iva_tasa: iva ? Number(iva.replace(",", ".")) / 100 : null,
    item_descripcion: primero(texto, /^\s*\d+\.\s*(.+?)\s*\|/m),
  }
}

/** "Aprobado" sin negación inmediata ("no aprobado", "no está aprobado"). */
export function esAprobado(cuerpo: string): boolean {
  return /\baprobad[oa]\b/i.test(cuerpo) && !/\bno\s+(?:est[aá]\s+)?aprobad[oa]\b/i.test(cuerpo)
}

export function parsearFactura(texto: string): Factura {
  const numero = primero(texto, /No\.\s*([A-Za-z0-9-]+)/)
  const fecha = primero(texto, /Fecha de emisi[óo]n:\s*(\d{4}-\d{2}-\d{2})/)
  const total = primero(texto, /^TOTAL:\s*[A-Z]{3}\s*([\d.,]+)/m)
  if (!numero || !fecha || !total) throw new ErrorNegocio("factura.txt no contiene número, fecha de emisión o total legibles.")
  return { numero, fecha, total: parseMonto(total) }
}

/* ---------- Casos ---------- */

export async function listarCasos(ctx: Ctx): Promise<string[]> {
  try {
    const entradas = await readdir(join(rutas(ctx).fixtures, "solicitudes"), { withFileTypes: true })
    return entradas.filter((e) => e.isDirectory()).map((e) => e.name).sort()
  } catch {
    return []
  }
}

export type PaqueteLeido = { paquete: Paquete; faltantes: string[] }

/** Lee y normaliza el paquete de un caso. Un adjunto ausente queda en `null` y se lista en `faltantes`. */
export async function leerPaquete(ctx: Ctx, caso: string): Promise<PaqueteLeido> {
  validarNombreCaso(caso)
  const dir = join(rutas(ctx).fixtures, "solicitudes", caso)
  const casos = await listarCasos(ctx)
  if (!casos.includes(caso)) {
    throw new ErrorNegocio(`El caso "${caso}" no existe. Casos disponibles: ${casos.join(", ") || "(ninguno)"}.`)
  }

  const correo = CorreoSchema.safeParse(await leerJson(join(dir, "correo.json"), "correo.json"))
  if (!correo.success) throw new ErrorNegocio(`correo.json no cumple el esquema: ${resumirErrorZod(correo.error)}`)

  const sol = SolicitudSchema.safeParse(await leerJson(join(dir, "solicitud.json"), "solicitud.json"))
  if (!sol.success) throw new ErrorNegocio(`solicitud.json inválida: ${resumirErrorZod(sol.error)}`)

  const faltantes: string[] = []

  const textoCotizacion = await leerTextoOpcional(join(dir, "cotizacion.txt"))
  const cotizacion = textoCotizacion === null ? null : parsearCotizacion(textoCotizacion)
  if (!cotizacion) faltantes.push("cotizacion.txt")

  let aprobacion: Aprobacion | null = null
  try {
    const crudo = await leerJson(join(dir, "aprobacion.json"), "aprobacion.json")
    const a = AprobacionJsonSchema.safeParse(crudo)
    if (!a.success) throw new ErrorNegocio(`aprobacion.json inválida: ${resumirErrorZod(a.error)}`)
    aprobacion = {
      de: a.data.de.trim().toLowerCase(),
      para: a.data.para,
      asunto: a.data.asunto,
      fecha: a.data.fecha,
      aprobado: esAprobado(a.data.cuerpo),
      texto: a.data.cuerpo,
    }
  } catch (e) {
    // Un archivo ausente es "faltante"; uno malformado sí es un error que el usuario debe conocer.
    if (e instanceof ErrorNegocio && e.message.startsWith("No se pudo leer")) faltantes.push("aprobacion.json")
    else throw e
  }

  const textoFactura = await leerTextoOpcional(join(dir, "factura.txt"))
  const factura = textoFactura === null ? null : parsearFactura(textoFactura)

  return {
    paquete: { correo: correo.data, solicitud: sol.data, cotizacion, aprobacion, factura },
    faltantes,
  }
}

export { soloFecha }
