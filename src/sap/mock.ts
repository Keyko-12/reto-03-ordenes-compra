import { appendFile, mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { ProveedorSchema } from "../tools/tipos.ts"
import { ahora, normalizarNit } from "../tools/util.ts"
import { z } from "zod/v4"
import type { SapAdapter } from "./adapter.ts"
import type { OrdenCompra } from "./orden.ts"

const PRIMER_NUMERO = 4500000001

type RegistroOrden = { numero_oc: string; fecha: string; orden: OrdenCompra }

/** Cola simple: serializa las escrituras para que dos solicitudes simultáneas no reciban el mismo número. */
let cola: Promise<unknown> = Promise.resolve()
function enCola<T>(tarea: () => Promise<T>): Promise<T> {
  const siguiente = cola.then(tarea, tarea)
  cola = siguiente.catch(() => undefined)
  return siguiente
}

/** SAP simulado: lee proveedores de los fixtures y escribe las órdenes en out/sap/ordenes.jsonl. */
export class SapMock implements SapAdapter {
  private readonly archivo: string

  constructor(
    private readonly fixturesDir: string,
    private readonly outDir: string,
  ) {
    this.archivo = join(outDir, "sap", "ordenes.jsonl")
  }

  async consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null> {
    const crudo = JSON.parse(await readFile(join(this.fixturesDir, "maestros", "proveedores.json"), "utf8"))
    const proveedores = z.array(ProveedorSchema).parse(crudo)
    const buscado = normalizarNit(nit)
    const p = proveedores.find((x) => normalizarNit(x.nit) === buscado)
    return p ? { codigo_sap: p.codigo_sap, activo: p.activo } : null
  }

  async buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string; fecha?: string } | null> {
    const registros = await this.leerRegistros()
    const r = registros.find((x) => x.orden.referencia.solicitud_id === solicitud_id)
    return r ? { numero_oc: r.numero_oc, fecha: r.fecha } : null
  }

  crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }> {
    return enCola(async () => {
      const registros = await this.leerRegistros()
      // Idempotencia también a nivel de adaptador: nunca dos OC para la misma solicitud.
      const existente = registros.find((x) => x.orden.referencia.solicitud_id === orden.referencia.solicitud_id)
      if (existente) return { numero_oc: existente.numero_oc, fecha: existente.fecha }

      const mayor = registros.reduce((m, r) => Math.max(m, Number(r.numero_oc)), PRIMER_NUMERO - 1)
      const registro: RegistroOrden = {
        numero_oc: String(mayor + 1),
        fecha: ahora().toISOString().slice(0, 10),
        orden,
      }
      await mkdir(join(this.outDir, "sap"), { recursive: true })
      await appendFile(this.archivo, JSON.stringify(registro) + "\n", "utf8")
      return { numero_oc: registro.numero_oc, fecha: registro.fecha }
    })
  }

  private async leerRegistros(): Promise<RegistroOrden[]> {
    let texto: string
    try {
      texto = await readFile(this.archivo, "utf8")
    } catch {
      return []
    }
    return texto
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as RegistroOrden)
  }
}
