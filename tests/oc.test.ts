import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ejecutarHerramienta } from "../src/tools/registro.ts"
import { esAprobado, parsearCotizacion } from "../src/tools/paquete.ts"
import { normalizarNit, normalizarNombre } from "../src/tools/util.ts"

const raiz = join(import.meta.dir, "..")
const dirs: string[] = []

/** Proyecto temporal con los fixtures copiados: cada prueba tiene su propio out/. */
function proyecto() {
  const directory = mkdtempSync(join(tmpdir(), "reto03-"))
  dirs.push(directory)
  cpSync(join(raiz, "fixtures"), join(directory, "fixtures"), { recursive: true })
  mkdirSync(join(directory, "src", "knowledge"), { recursive: true })
  cpSync(join(raiz, "src", "knowledge"), join(directory, "src", "knowledge"), { recursive: true })
  return { directory, sessionId: "test" }
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

type Ctx = ReturnType<typeof proyecto>
const llamar = async (ctx: Ctx, nombre: string, args: object = {}) => JSON.parse(await ejecutarHerramienta(nombre, args, ctx))

describe("controles RC1-RC10 sobre los 6 casos", () => {
  const esperado: Record<string, { apta: boolean; bloqueos: string[]; confirmaciones: string[]; retroactiva: boolean }> = {
    "sol-001": { apta: true, bloqueos: [], confirmaciones: [], retroactiva: false },
    "sol-002": { apta: false, bloqueos: ["RC1"], confirmaciones: [], retroactiva: false },
    "sol-003": { apta: false, bloqueos: ["RC2", "RC3"], confirmaciones: [], retroactiva: false },
    "sol-004": { apta: true, bloqueos: [], confirmaciones: ["RC5"], retroactiva: false },
    "sol-005": { apta: true, bloqueos: [], confirmaciones: ["RC8"], retroactiva: true },
    "sol-006": { apta: true, bloqueos: [], confirmaciones: ["RC6"], retroactiva: false },
  }
  for (const [caso, e] of Object.entries(esperado)) {
    test(caso, async () => {
      const r = await llamar(proyecto(), "oc_validar", { caso })
      expect(r.ok).toBe(true)
      expect(r.data.apta).toBe(e.apta)
      expect(r.data.bloqueos.map((b: { codigo: string }) => b.codigo)).toEqual(e.bloqueos)
      expect(r.data.confirmaciones.map((b: { codigo: string }) => b.codigo)).toEqual(e.confirmaciones)
      expect(r.data.retroactiva).toBe(e.retroactiva)
    })
  }

  test("sol-006 deriva IVA y condiciones de pago desde el maestro del proveedor", async () => {
    const r = await llamar(proyecto(), "oc_validar", { caso: "sol-006" })
    expect(r.data.derivados.indicador_iva.valor).toBe("C1")
    expect(r.data.derivados.condiciones_pago.valor).toBe("Z030")
  })
})

describe("creación de la OC", () => {
  test("sol-001 se crea sin intervención y es idempotente", async () => {
    const ctx = proyecto()
    const a = await llamar(ctx, "oc_crear", { caso: "sol-001" })
    expect(a.data.numero_oc).toBe("4500000001")
    expect(a.data.idempotente).toBe(false)
    const b = await llamar(ctx, "oc_crear", { caso: "sol-001" })
    expect(b.data).toMatchObject({ numero_oc: "4500000001", idempotente: true })
    expect(readFileSync(join(ctx.directory, "out/sap/ordenes.jsonl"), "utf8").trim().split("\n")).toHaveLength(1)
  })

  test("casos bloqueados no crean OC ni payload", async () => {
    const ctx = proyecto()
    for (const caso of ["sol-002", "sol-003"]) {
      const c = await llamar(ctx, "oc_crear", { caso })
      expect(c.ok).toBe(false)
      expect(c.bloqueada).toBe(true)
      expect((await llamar(ctx, "oc_construir_payload", { caso })).ok).toBe(false)
    }
  })

  test("sol-004 exige confirmación y solo entonces crea", async () => {
    const ctx = proyecto()
    const sin = await llamar(ctx, "oc_crear", { caso: "sol-004" })
    expect(sin.ok).toBe(false)
    expect(sin.requiere_confirmacion).toBe(true)
    const con = await llamar(ctx, "oc_crear", { caso: "sol-004", confirmado: true })
    expect(con.ok).toBe(true)
  })

  test("la guardia del agente rechaza una confirmación no dada por el usuario", async () => {
    const ctx = { ...proyecto(), confirmar: () => false }
    const r = await llamar(ctx, "oc_crear", { caso: "sol-004", confirmado: true })
    expect(r.ok).toBe(false)
    expect(r.requiere_confirmacion).toBe(true)
  })

  test("sol-005 queda marcada como retroactiva en control.csv", async () => {
    const ctx = proyecto()
    await llamar(ctx, "oc_crear", { caso: "sol-005", confirmado: true })
    const csv = readFileSync(join(ctx.directory, "out/control.csv"), "utf8")
    expect(csv).toContain("SOL-2026-005,creada,4500000001,true,,RC8")
  })

  test("un payload alterado por el modelo se rechaza", async () => {
    const ctx = proyecto()
    const p = await llamar(ctx, "oc_construir_payload", { caso: "sol-001" })
    const alterado = { ...p.data.orden, posiciones: [{ ...p.data.orden.posiciones[0], precio_unitario: 1 }] }
    const r = await llamar(ctx, "oc_crear", { caso: "sol-001", payload: alterado })
    expect(r.ok).toBe(false)
    expect(r.error).toContain("no coincide")
  })

  test("el payload es trazable y la descripción respeta el límite de 40 caracteres", async () => {
    const ctx = proyecto()
    const p = await llamar(ctx, "oc_construir_payload", { caso: "sol-001" })
    expect(p.data.orden.posiciones[0].descripcion.length).toBeLessThanOrEqual(40)
    const t = JSON.parse(readFileSync(join(ctx.directory, p.data.ruta_trazabilidad), "utf8"))
    expect(t["proveedor.codigo_sap"].fuente).toBe("maestro.proveedores")
    expect(t["posiciones[0].descripcion"].fuente).toBe("derivado")
  })

  test("evidencia: sha256 del contenido en txt y pdf generado", async () => {
    const ctx = proyecto()
    const e = await llamar(ctx, "oc_generar_evidencia", { caso: "sol-001" })
    expect(e.data.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(readFileSync(join(ctx.directory, e.data.ruta), "utf8")).toContain(`sha256: ${e.data.sha256}`)
    expect(readFileSync(join(ctx.directory, e.data.ruta_pdf)).subarray(0, 4).toString()).toBe("%PDF")
  })
})

describe("manejo de errores (HU-6): nunca lanzan", () => {
  test("caso inexistente, nombre malicioso y argumentos inválidos", async () => {
    const ctx = proyecto()
    expect((await llamar(ctx, "oc_leer_paquete", { caso: "sol-999" })).error).toContain("no existe")
    expect((await llamar(ctx, "oc_leer_paquete", { caso: "../../etc" })).ok).toBe(false)
    expect((await llamar(ctx, "oc_validar", {})).error).toContain("Argumentos inválidos")
    expect((await llamar(ctx, "oc_inexistente", {})).ok).toBe(false)
  })

  test("monto no numérico y JSON malformado devuelven error legible", async () => {
    const ctx = proyecto()
    const dir = join(ctx.directory, "fixtures/reto-03/solicitudes")
    cpSync(join(dir, "sol-001"), join(dir, "sol-malo"), { recursive: true })
    const archivo = join(dir, "sol-malo/solicitud.json")
    const s = JSON.parse(readFileSync(archivo, "utf8"))
    writeFileSync(archivo, JSON.stringify({ ...s, valor_total: "mucho" }))
    const r = await llamar(ctx, "oc_leer_paquete", { caso: "sol-malo" })
    expect(r.ok).toBe(false)
    expect(r.error).toContain("valor_total")
    writeFileSync(archivo, "{ no es json")
    expect((await llamar(ctx, "oc_leer_paquete", { caso: "sol-malo" })).error).toContain("malformado")
  })

  test("un adjunto ausente se reporta como null con su nombre", async () => {
    const ctx = proyecto()
    const dir = join(ctx.directory, "fixtures/reto-03/solicitudes")
    cpSync(join(dir, "sol-001"), join(dir, "sol-sin-cot"), { recursive: true })
    rmSync(join(dir, "sol-sin-cot/cotizacion.txt"))
    const r = await llamar(ctx, "oc_leer_paquete", { caso: "sol-sin-cot" })
    expect(r.data.cotizacion).toBeNull()
    expect(r.data.faltantes).toEqual(["cotizacion.txt"])
    const v = await llamar(ctx, "oc_validar", { caso: "sol-sin-cot" })
    expect(v.data.confirmaciones.map((c: { codigo: string }) => c.codigo)).toContain("RC5")
  })
})

describe("utilidades", () => {
  test("normalizarNit / normalizarNombre", () => {
    expect(normalizarNit("900.555.111-2")).toBe("900555111")
    expect(normalizarNit("900555111")).toBe("900555111")
    expect(normalizarNombre("Papelería Central Ltda.")).toBe("papeleria central")
    expect(normalizarNombre("TecnoSuministros S.A.S.")).toBe("tecnosuministros")
  })
  test("esAprobado reconoce negaciones", () => {
    expect(esAprobado("Aprobado, proceder.")).toBe(true)
    expect(esAprobado("No aprobado todavía")).toBe(false)
    expect(esAprobado("Lo reviso mañana")).toBe(false)
  })
  test("parsearCotizacion", () => {
    const c = parsearCotizacion("COTIZACIÓN X-1\nFecha: 2026-01-10\nProveedor: A\nNIT: 900.555.111-2\n1. Hora de arquitecto | Cantidad: 1\nIVA 19%: COP 1\nTOTAL (IVA incluido): COP 1.234.500\nValidez de la oferta: 20 días")
    expect(c).toMatchObject({ total: 1234500, nit: "900555111", referencia: "X-1", validez_hasta: "2026-01-30", iva_tasa: 0.19 })
  })
})
