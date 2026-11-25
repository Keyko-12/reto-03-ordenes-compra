import { z } from "zod/v4"

const fechaISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "debe tener formato YYYY-MM-DD")

/** solicitud.json (el Excel de solicitud ya normalizado). Los campos con `?` pueden faltar. */
export const SolicitudSchema = z.object({
  solicitud_id: z.string().min(1),
  solicitante: z.string(),
  proveedor_nombre: z.string(),
  proveedor_nit: z.string().optional(),
  descripcion: z.string(),
  centro_costo: z.string(),
  subarea: z.string(),
  cantidad: z.number({ error: "debe ser numérico" }),
  valor_unitario: z.number({ error: "debe ser numérico" }),
  valor_total: z.number({ error: "debe ser numérico" }),
  moneda: z.enum(["COP", "USD"], { error: "moneda no soportada (solo COP o USD)" }),
  indicador_iva: z.string().optional(),
  condiciones_pago: z.string().optional(),
  fecha_solicitud: fechaISO,
})
export type Solicitud = z.infer<typeof SolicitudSchema>

export const CorreoSchema = z.object({
  id: z.string(),
  de: z.string(),
  asunto: z.string(),
  fecha: z.string(),
})

export const AprobacionJsonSchema = z.object({
  de: z.string(),
  para: z.string(),
  fecha: z.string(),
  asunto: z.string(),
  cuerpo: z.string(),
})

export type Cotizacion = {
  proveedor: string
  nit: string | null
  total: number
  moneda: string
  validez_hasta: string | null
  texto: string
  // Campos adicionales que se extraen del mismo texto y alimentan trazabilidad y controles.
  referencia: string | null
  fecha: string | null
  iva_tasa: number | null
  item_descripcion: string | null
}

export type Aprobacion = {
  de: string
  para: string
  asunto: string
  fecha: string
  aprobado: boolean
  texto: string
}

export type Factura = { numero: string; fecha: string; total: number }

/** Paquete normalizado (sección 7.2 del PRD). */
export type Paquete = {
  correo: { id: string; de: string; asunto: string; fecha: string }
  solicitud: Solicitud
  cotizacion: Cotizacion | null
  aprobacion: Aprobacion | null
  factura: Factura | null
}

/* ---------- Maestros ---------- */

export const ProveedorSchema = z.object({
  codigo_sap: z.string(),
  nit: z.string(),
  nombre: z.string(),
  condiciones_pago_default: z.string(),
  indicador_iva_default: z.string(),
  activo: z.boolean(),
})
export type Proveedor = z.infer<typeof ProveedorSchema>

export const CentroCostoSchema = z.object({
  centro_costo: z.string(),
  nombre: z.string(),
  subareas: z.array(z.string()),
  aprobadores: z.array(z.object({ email: z.string(), nombre: z.string(), tope: z.number() })),
})
export type CentroCosto = z.infer<typeof CentroCostoSchema>

export const IndicadorIvaSchema = z.object({ codigo: z.string(), descripcion: z.string(), tasa: z.number() })
export const CondicionPagoSchema = z.object({ codigo: z.string(), descripcion: z.string(), dias: z.number() })

export type Maestros = {
  proveedores: Proveedor[]
  centros: CentroCosto[]
  indicadoresIva: z.infer<typeof IndicadorIvaSchema>[]
  condicionesPago: z.infer<typeof CondicionPagoSchema>[]
}

/* ---------- Validación ---------- */

export type Hallazgo = { codigo: string; detalle: string; accion_sugerida?: string }
export type Derivado = { valor: string; fuente: string; detalle?: string }

export type Validacion = {
  apta: boolean
  bloqueos: Hallazgo[]
  confirmaciones: Hallazgo[]
  derivados: Record<string, Derivado>
  retroactiva: boolean
  proveedor: { codigo_sap: string; nit: string; nombre: string } | null
}
