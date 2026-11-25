import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { PDFDocument, StandardFonts, rgb } from "pdf-lib"
import { OrdenCompraSchema, type OrdenCompra } from "../sap/orden.ts"
import type { Aprobacion, Paquete, Validacion } from "./tipos.ts"
import { ErrorNegocio, resumirErrorZod, rutas, sha256, type Ctx } from "./util.ts"

/* ---------- Evidencia de aprobación (HU-4) ---------- */

/** Contenido canónico de la evidencia. El sha256 se calcula sobre exactamente este texto. */
export function contenidoEvidencia(a: Aprobacion): string {
  return [`De: ${a.de}`, `Para: ${a.para}`, `Fecha: ${a.fecha}`, `Asunto: ${a.asunto}`, "", a.texto].join("\n")
}

export function evidenciaSha(a: Aprobacion): string {
  return sha256(contenidoEvidencia(a))
}

/** Escribe out/<caso>/aprobacion.txt (P0) y aprobacion.pdf (P1). Es idempotente. */
export async function escribirEvidencia(ctx: Ctx, caso: string, a: Aprobacion): Promise<{ ruta: string; ruta_pdf: string; sha256: string }> {
  const dir = join(rutas(ctx).out, caso)
  await mkdir(dir, { recursive: true })
  const contenido = contenidoEvidencia(a)
  const hash = sha256(contenido)
  const ruta = join(dir, "aprobacion.txt")
  await writeFile(ruta, `${contenido}\n\n---\nsha256: ${hash}\n`, "utf8")

  const ruta_pdf = join(dir, "aprobacion.pdf")
  await writeFile(ruta_pdf, await construirPdf(a, hash))
  return { ruta: relativo(ctx, ruta), ruta_pdf: relativo(ctx, ruta_pdf), sha256: hash }
}

const relativo = (ctx: Ctx, ruta: string): string => ruta.slice(ctx.directory.length + 1).replaceAll("\\", "/")

/** PDF simple con el mismo contenido que el .txt (fuente estándar: solo caracteres WinAnsi). */
async function construirPdf(a: Aprobacion, hash: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const fuente = await pdf.embedFont(StandardFonts.Helvetica)
  const negrita = await pdf.embedFont(StandardFonts.HelveticaBold)
  const pagina = pdf.addPage([595, 842])
  const margen = 56
  let y = 842 - margen

  const escribir = (texto: string, tam: number, bold = false) => {
    for (const linea of ajustar(texto, bold ? negrita : fuente, tam, 595 - margen * 2)) {
      pagina.drawText(linea, { x: margen, y, size: tam, font: bold ? negrita : fuente, color: rgb(0.1, 0.1, 0.1) })
      y -= tam + 5
    }
  }
  escribir("Evidencia de aprobación de compra", 16, true)
  y -= 8
  for (const [k, v] of [["De", a.de], ["Para", a.para], ["Fecha", a.fecha], ["Asunto", a.asunto]] as const) escribir(`${k}: ${v}`, 11)
  y -= 10
  for (const parrafo of a.texto.split("\n")) {
    escribir(parrafo || " ", 11)
  }
  y -= 14
  escribir(`SHA-256 del contenido: ${hash}`, 8)
  return pdf.save()
}

function ajustar(texto: string, fuente: { widthOfTextAtSize(t: string, s: number): number }, tam: number, ancho: number): string[] {
  const limpio = texto.replace(/[^\x20-\x7EÀ-ÿ]/g, "?")
  const lineas: string[] = []
  let actual = ""
  for (const palabra of limpio.split(" ")) {
    const prueba = actual ? `${actual} ${palabra}` : palabra
    if (fuente.widthOfTextAtSize(prueba, tam) > ancho && actual) {
      lineas.push(actual)
      actual = palabra
    } else {
      actual = prueba
    }
  }
  lineas.push(actual)
  return lineas
}

/* ---------- Payload (HU-3) ---------- */

export type Fuente = "solicitud" | "cotizacion" | "maestro.proveedores" | "maestro.centros-costo" | "derivado"
export type Trazabilidad = Record<string, { valor: unknown; fuente: Fuente; detalle?: string }>

/** Unidad de medida SAP a partir del texto del ítem: "Hora..." → H, "Mes/Mensualidad..." → MES, otro → UN. */
export function inferirUnidad(texto: string): { unidad: "UN" | "H" | "MES"; detalle: string } {
  const t = texto.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase()
  if (/^horas?\b/.test(t)) return { unidad: "H", detalle: `El ítem comienza con "hora" (${texto})` }
  if (/^(mes|meses|mensualidad)\b/.test(t)) return { unidad: "MES", detalle: `El ítem comienza con "mes" (${texto})` }
  return { unidad: "UN", detalle: "Unidad por defecto (el ítem se cobra por unidad)" }
}

export function recortar(texto: string, max: number): string {
  return texto.length <= max ? texto : texto.slice(0, max).trimEnd()
}

/**
 * Construye la OrdenCompra desde el paquete y la validación. Todo valor es trazable a una fuente.
 * Una solicitud con bloqueos NO produce payload.
 */
export function construirOrden(paquete: Paquete, validacion: Validacion): { orden: OrdenCompra; trazabilidad: Trazabilidad } {
  const { solicitud: sol, cotizacion, aprobacion, correo } = paquete
  if (!validacion.apta || !validacion.proveedor || !aprobacion) {
    throw new ErrorNegocio(
      `La solicitud ${sol.solicitud_id} tiene bloqueos (${validacion.bloqueos.map((b) => b.codigo).join(", ")}); no se construye el payload.`,
    )
  }
  const t: Trazabilidad = {}
  const marca = (ruta: string, valor: unknown, fuente: Fuente, detalle?: string) => {
    t[ruta] = detalle ? { valor, fuente, detalle } : { valor, fuente }
    return valor
  }

  const indicador = sol.indicador_iva ?? validacion.derivados.indicador_iva?.valor
  const condiciones = sol.condiciones_pago ?? validacion.derivados.condiciones_pago?.valor
  if (!indicador || !condiciones) throw new ErrorNegocio("No fue posible determinar el indicador de IVA o las condiciones de pago.")

  const textoItem = cotizacion?.item_descripcion ?? sol.descripcion
  const { unidad, detalle: detalleUnidad } = inferirUnidad(textoItem)
  const descripcion = recortar(sol.descripcion, 40)

  const referencia = {
    solicitud_id: marca("referencia.solicitud_id", sol.solicitud_id, "solicitud") as string,
    correo_id: marca("referencia.correo_id", correo.id, "solicitud", "id del correo de entrada") as string,
    cotizacion_ref: marca("referencia.cotizacion_ref", cotizacion?.referencia ?? null, "cotizacion") as string | null,
  }
  marca("sociedad", "1000", "derivado", "constante del esquema 7.4")
  marca("organizacion_compras", "1000", "derivado", "constante del esquema 7.4")

  const orden: OrdenCompra = {
    referencia,
    sociedad: "1000",
    organizacion_compras: "1000",
    proveedor: {
      codigo_sap: marca("proveedor.codigo_sap", validacion.proveedor.codigo_sap, "maestro.proveedores") as string,
      nit: marca("proveedor.nit", validacion.proveedor.nit, "maestro.proveedores") as string,
      nombre: marca("proveedor.nombre", validacion.proveedor.nombre, "maestro.proveedores") as string,
    },
    moneda: marca("moneda", sol.moneda, "solicitud") as "COP" | "USD",
    condiciones_pago: sol.condiciones_pago
      ? (marca("condiciones_pago", condiciones, "solicitud") as string)
      : (marca("condiciones_pago", condiciones, "derivado", validacion.derivados.condiciones_pago?.detalle) as string),
    aprobador: {
      email: marca("aprobador.email", aprobacion.de, "solicitud", "remitente del correo de aprobación") as string,
      fecha_aprobacion: marca("aprobador.fecha_aprobacion", aprobacion.fecha, "solicitud", "fecha del correo de aprobación") as string,
      evidencia_sha256: marca("aprobador.evidencia_sha256", evidenciaSha(aprobacion), "derivado", "sha256 del contenido de aprobacion.txt") as string,
    },
    posiciones: [
      {
        numero: marca("posiciones[0].numero", 10, "derivado", "primera posición") as number,
        descripcion: sol.descripcion.length > 40
          ? (marca("posiciones[0].descripcion", descripcion, "derivado", `Recortada a 40 caracteres (límite SAP); original: "${sol.descripcion}"`) as string)
          : (marca("posiciones[0].descripcion", descripcion, "solicitud") as string),
        cantidad: marca("posiciones[0].cantidad", sol.cantidad, "solicitud") as number,
        unidad: marca("posiciones[0].unidad", unidad, "derivado", detalleUnidad) as "UN" | "H" | "MES",
        precio_unitario: marca("posiciones[0].precio_unitario", sol.valor_unitario, "solicitud", "Se transmite tal como viene en la solicitud (IVA incluido según la cotización)") as number,
        centro_costo: marca("posiciones[0].centro_costo", sol.centro_costo, "solicitud") as string,
        subarea: marca("posiciones[0].subarea", sol.subarea, "solicitud") as string,
        indicador_iva: sol.indicador_iva
          ? (marca("posiciones[0].indicador_iva", indicador, "solicitud") as string)
          : (marca("posiciones[0].indicador_iva", indicador, "derivado", validacion.derivados.indicador_iva?.detalle) as string),
      },
    ],
    // El detalle de cada confirmación queda en la OC; `confirmado_por` se completa al crear.
    excepciones: validacion.confirmaciones.map((c) => ({ codigo: c.codigo, detalle: c.detalle, confirmado_por: null })),
  }
  t["excepciones"] = { valor: orden.excepciones.map((e) => e.codigo), fuente: "derivado", detalle: "Confirmaciones pendientes del control (RC5, RC6, RC8...)" }

  const r = OrdenCompraSchema.safeParse(orden)
  if (!r.success) throw new ErrorNegocio(`El payload no cumple el esquema de la OC: ${resumirErrorZod(r.error)}`)
  return { orden: r.data, trazabilidad: t }
}

export async function escribirTrazabilidad(ctx: Ctx, caso: string, orden: OrdenCompra, t: Trazabilidad): Promise<string> {
  const dir = join(rutas(ctx).out, caso)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "payload.json"), JSON.stringify(orden, null, 2) + "\n", "utf8")
  const ruta = join(dir, "trazabilidad.json")
  await writeFile(ruta, JSON.stringify(t, null, 2) + "\n", "utf8")
  return relativo(ctx, ruta)
}

/** Forma canónica para comparar payloads ignorando quién confirmó cada excepción. */
export function huellaPayload(orden: OrdenCompra): string {
  const sinConfirmador = { ...orden, excepciones: orden.excepciones.map((e) => ({ ...e, confirmado_por: null })) }
  return sha256(JSON.stringify(sinConfirmador))
}
