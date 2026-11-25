import type { OrdenCompra } from "./orden.ts"

/**
 * Contrato con SAP. El agente y las herramientas solo conocen esta interfaz:
 * `mock.ts` la implementa sobre archivos y en producción se reemplaza por un
 * adaptador real (OData / BAPI) sin tocar las herramientas (ver SOLUCION.md §6).
 */
export interface SapAdapter {
  consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null>
  crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }>
  buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string; fecha?: string } | null>
}

export type { OrdenCompra }
