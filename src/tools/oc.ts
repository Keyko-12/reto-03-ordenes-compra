import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod/v4"
import { OrdenCompraSchema } from "../sap/orden.ts"
import { SapMock } from "../sap/mock.ts"
import type { SapAdapter } from "../sap/adapter.ts"
import { registrarControl } from "./control.ts"
import { validarPaquete } from "./controles.ts"
import { cargarMaestros, leerPaquete } from "./paquete.ts"
import { construirOrden, escribirEvidencia, escribirTrazabilidad, huellaPayload } from "./payload.ts"
import { ErrorNegocio, exito, falla, protegido, resumirErrorZod, rutas, validarNombreCaso, type Ctx } from "./util.ts"

/**
 * Herramientas del agente. Cada export `x` se publica al modelo como `oc_x`.
 * Contrato: `execute` devuelve un string JSON { ok, data } o { ok:false, error } y NUNCA lanza.
 * Son la ÚNICA fuente de valores que el agente puede afirmar (CA2): por eso siempre re-leen
 * la fuente a partir de `caso` y no confían en datos que el modelo les devuelva.
 */

const sapDe = (ctx: Ctx): SapAdapter => new SapMock(rutas(ctx).fixtures, rutas(ctx).out)

type Def<S extends z.ZodRawShape> = {
  description: string
  args: S
  execute: (args: z.infer<z.ZodObject<S>>, ctx: Ctx) => Promise<string>
}
const definir = <S extends z.ZodRawShape>(def: Def<S>): Def<S> => def

const caso = z.string().describe("Nombre de la carpeta del caso en fixtures/reto-03/solicitudes/, p. ej. sol-001")

/** Lee el caso, aplica los controles y devuelve todo lo necesario para decidir. Sin efectos secundarios. */
async function evaluar(ctx: Ctx, nombre: string) {
  const { paquete, faltantes } = await leerPaquete(ctx, nombre)
  const validacion = await validarPaquete(paquete, await cargarMaestros(ctx), sapDe(ctx))
  return { paquete, faltantes, validacion }
}

const codigos = (h: { codigo: string }[]): string[] => h.map((x) => x.codigo)

/* ------------------------------------------------------------------ */

export const leer_paquete = definir({
  description: "Lee y normaliza el paquete de una solicitud de compra (correo, solicitud, cotización, aprobación y factura si existe).",
  args: { caso },
  execute: (args, ctx) =>
    protegido(async () => {
      const { paquete, faltantes } = await leerPaquete(ctx, args.caso)
      return exito({ ...paquete, faltantes })
    }),
})

export const validar = definir({
  description: "Aplica los controles RC1-RC10 a un caso y devuelve apta, bloqueos, confirmaciones requeridas, valores derivados y si es retroactiva.",
  args: {
    caso,
    paquete: z.record(z.string(), z.unknown()).optional().describe("Opcional: el paquete de oc_leer_paquete. El servidor siempre vuelve a leer la fuente."),
  },
  execute: (args, ctx) =>
    protegido(async () => {
      const { paquete, validacion } = await evaluar(ctx, args.caso)
      const resultado = !validacion.apta ? "bloqueada" : validacion.confirmaciones.length ? "pendiente_confirmacion" : "apta"
      await registrarControl(
        ctx,
        {
          solicitud_id: paquete.solicitud.solicitud_id,
          resultado,
          numero_oc: "",
          retroactiva: validacion.retroactiva,
          bloqueos: codigos(validacion.bloqueos),
          confirmaciones: codigos(validacion.confirmaciones),
        },
        true,
      )
      const { proveedor: _proveedor, ...resto } = validacion
      return exito(resto)
    }),
})

export const construir_payload = definir({
  description: "Construye la orden de compra tal como quedaría en SAP (con trazabilidad de cada valor). No la crea. Falla si el caso tiene bloqueos.",
  args: {
    caso,
    paquete: z.record(z.string(), z.unknown()).optional().describe("Opcional; se ignora y se vuelve a leer la fuente."),
    derivados: z.record(z.string(), z.unknown()).optional().describe("Opcional; se ignora: los derivados se recalculan desde los maestros."),
  },
  execute: (args, ctx) =>
    protegido(async () => {
      const { paquete, validacion } = await evaluar(ctx, args.caso)
      const { orden, trazabilidad } = construirOrden(paquete, validacion)
      const ruta_trazabilidad = await escribirTrazabilidad(ctx, args.caso, orden, trazabilidad)
      return exito({ orden, ruta_trazabilidad })
    }),
})

export const generar_evidencia = definir({
  description: "Genera la evidencia de aprobación (aprobacion.txt con su sha256, y aprobacion.pdf) que se adjunta a la OC.",
  args: { caso },
  execute: (args, ctx) =>
    protegido(async () => {
      const { paquete } = await leerPaquete(ctx, args.caso)
      if (!paquete.aprobacion) throw new ErrorNegocio("El paquete no tiene correo de aprobación; no hay evidencia que generar.")
      return exito(await escribirEvidencia(ctx, args.caso, paquete.aprobacion))
    }),
})

export const crear = definir({
  description:
    "Crea la OC en SAP (simulado). Solo procede si el caso es apto y, si hay confirmaciones pendientes, solo con confirmado=true dado por el usuario. Es idempotente por solicitud.",
  args: {
    caso,
    payload: z.record(z.string(), z.unknown()).optional().describe("Opcional: el `orden` de oc_construir_payload. Si se envía y fue alterado, se rechaza."),
    confirmado: z.boolean().optional().describe("true SOLO si el usuario acaba de confirmar explícitamente las excepciones en su mensaje anterior."),
    confirmado_por: z.string().optional().describe("Quién confirma (por defecto, la sesión del analista)."),
  },
  execute: (args, ctx) =>
    protegido(async () => {
      const sap = sapDe(ctx)
      const { paquete, validacion } = await evaluar(ctx, args.caso)
      const id = paquete.solicitud.solicitud_id
      const base = { solicitud_id: id, retroactiva: validacion.retroactiva, bloqueos: codigos(validacion.bloqueos), confirmaciones: codigos(validacion.confirmaciones) }

      // 1) Idempotencia: la misma solicitud nunca genera una segunda OC.
      const existente = await sap.buscarOrdenPorReferencia(id)
      if (existente) {
        await registrarControl(ctx, { ...base, resultado: "idempotente", numero_oc: existente.numero_oc })
        return exito({ numero_oc: existente.numero_oc, fecha: existente.fecha ?? null, idempotente: true })
      }

      // 2) Bloqueos: no se crea nada, se devuelve la razón y la acción sugerida.
      if (!validacion.apta) {
        await registrarControl(ctx, { ...base, resultado: "bloqueada", numero_oc: "" }, true)
        return falla(`No se crea la OC de ${id}: ${validacion.bloqueos.map((b) => `${b.codigo} ${b.detalle}`).join(" | ")}`, {
          bloqueada: true,
          bloqueos: validacion.bloqueos,
        })
      }

      // 3) Confirmaciones: requieren al usuario, en un turno posterior a la petición.
      const pendientes = validacion.confirmaciones
      if (pendientes.length > 0) {
        const detalleConf = pendientes.map((c) => `${c.codigo}: ${c.detalle}`).join(" | ")
        const sinConfirmar = (motivo: string) =>
          registrarControl(ctx, { ...base, resultado: "pendiente_confirmacion", numero_oc: "" }, true).then(() =>
            falla(`requiere confirmación explícita: ${motivo}`, { requiere_confirmacion: true, confirmaciones: pendientes }),
          )
        if (!args.confirmado) return sinConfirmar(detalleConf)
        if (ctx.confirmar && !ctx.confirmar(args.caso)) {
          return sinConfirmar(`la confirmación debe venir del usuario en el mensaje siguiente a la petición. Pendiente: ${detalleConf}`)
        }
      }

      // 4) Payload: se recalcula; si el modelo envió uno distinto, se rechaza.
      const { orden, trazabilidad } = construirOrden(paquete, validacion)
      if (args.payload) {
        const enviado = OrdenCompraSchema.safeParse(args.payload)
        if (!enviado.success) throw new ErrorNegocio(`El payload enviado no cumple el esquema: ${resumirErrorZod(enviado.error)}`)
        if (huellaPayload(enviado.data) !== huellaPayload(orden)) {
          throw new ErrorNegocio("El payload enviado no coincide con el validado por el servidor; no se crea la OC.")
        }
      }
      const confirmador = args.confirmado_por ?? `analista (sesión ${ctx.sessionId})`
      orden.excepciones = orden.excepciones.map((e) => ({ ...e, confirmado_por: confirmador }))

      // 5) Evidencia + SAP + control.
      if (!paquete.aprobacion) throw new ErrorNegocio("Falta la aprobación; no se crea la OC.")
      const evidencia = await escribirEvidencia(ctx, args.caso, paquete.aprobacion)
      await escribirTrazabilidad(ctx, args.caso, orden, trazabilidad)
      const { numero_oc, fecha } = await sap.crearOrden(orden)
      await registrarControl(ctx, { ...base, resultado: "creada", numero_oc })
      return exito({ numero_oc, fecha, idempotente: false, retroactiva: validacion.retroactiva, evidencia: evidencia.ruta })
    }),
})

export const consultar_proceso = definir({
  description: "Consulta el conocimiento del proceso de órdenes de compra (reglas de control, flujo, glosario). Sin tema, lista los temas disponibles.",
  args: { tema: z.string().optional().describe("Texto a buscar en los títulos, p. ej. 'RC5' o 'retroactiva'.") },
  execute: (args, ctx) =>
    protegido(async () => {
      let md: string
      try {
        md = await readFile(join(ctx.directory, "src", "knowledge", "ordenes-compra.md"), "utf8")
      } catch {
        throw new ErrorNegocio("No se encontró el documento de conocimiento del proceso.")
      }
      const secciones = md.split(/^(?=## )/m).filter((s) => s.startsWith("## "))
      const titulo = (s: string) => s.split("\n")[0]?.replace(/^##\s*/, "") ?? ""
      if (!args.tema) return exito({ temas: secciones.map(titulo) })
      const t = args.tema.toLowerCase()
      const hallados = secciones.filter((s) => s.toLowerCase().includes(t))
      return hallados.length ? exito({ secciones: hallados.map((s) => s.trim()) }) : falla(`Sin resultados para "${args.tema}". Temas: ${secciones.map(titulo).join("; ")}`)
    }),
})

export { validarNombreCaso }
