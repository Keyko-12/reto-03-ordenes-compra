/**
 * Verificación SIN modelo de lenguaje: procesa los 6 casos llamando directamente a las herramientas.
 * Uso:  bun install && bun run demo.ts
 * Sale con código 1 si algún resultado no coincide con lo esperado.
 */
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { ejecutarHerramienta } from "./src/tools/registro.ts"
import { listarCasos } from "./src/tools/paquete.ts"

const directory = import.meta.dir
const ctx = { directory, sessionId: "demo" }

type Json = { ok: boolean; error?: string; data?: Record<string, any>; [k: string]: any }

async function llamar(nombre: string, args: Record<string, unknown>): Promise<Json> {
  return JSON.parse(await ejecutarHerramienta(nombre, args, ctx)) as Json
}

const linea = (t = "") => console.log(t)
const codigos = (xs: { codigo: string }[]) => xs.map((x) => x.codigo).join(",") || "—"

/** Resultado esperado por caso (PRD §3.1): lo que debe producir la demo. */
const ESPERADO: Record<string, { apta: boolean; bloqueos: string[]; confirmaciones: string[]; retroactiva: boolean; crea: boolean }> = {
  "sol-001": { apta: true, bloqueos: [], confirmaciones: [], retroactiva: false, crea: true },
  "sol-002": { apta: false, bloqueos: ["RC1"], confirmaciones: [], retroactiva: false, crea: false },
  "sol-003": { apta: false, bloqueos: ["RC2", "RC3"], confirmaciones: [], retroactiva: false, crea: false },
  "sol-004": { apta: true, bloqueos: [], confirmaciones: ["RC5"], retroactiva: false, crea: true },
  "sol-005": { apta: true, bloqueos: [], confirmaciones: ["RC8"], retroactiva: true, crea: true },
  "sol-006": { apta: true, bloqueos: [], confirmaciones: ["RC6"], retroactiva: false, crea: true },
}

const fallos: string[] = []
const verificar = (condicion: boolean, mensaje: string) => {
  if (!condicion) fallos.push(mensaje)
}

// `out/` se limpia al inicio para que la demo sea determinista.
await rm(join(directory, "out"), { recursive: true, force: true })

linea("=== Demo de herramientas (sin modelo) · Reto 03 · Órdenes de compra SAP ===")
const casos = await listarCasos(ctx)
const resumen: string[][] = []

for (const caso of casos) {
  linea(`\n──────── ${caso} ────────`)
  const esperado = ESPERADO[caso]

  const paquete = await llamar("oc_leer_paquete", { caso })
  if (!paquete.ok || !paquete.data) {
    linea(`  ✖ oc_leer_paquete: ${paquete.error}`)
    fallos.push(`${caso}: no se pudo leer`)
    continue
  }
  const sol = paquete.data.solicitud
  linea(`  Solicitud ${sol.solicitud_id} · ${sol.proveedor_nombre} · ${sol.moneda} ${sol.valor_total.toLocaleString("en-US")} · ${sol.centro_costo}/${sol.subarea}`)

  const val = await llamar("oc_validar", { caso, paquete: paquete.data })
  const v = val.data!
  linea(`  oc_validar → apta=${v.apta} · bloqueos=[${codigos(v.bloqueos)}] · confirmaciones=[${codigos(v.confirmaciones)}] · retroactiva=${v.retroactiva}`)
  for (const b of v.bloqueos) linea(`     ⛔ ${b.codigo}: ${b.detalle}\n        → ${b.accion_sugerida}`)
  for (const c of v.confirmaciones) linea(`     ❓ ${c.codigo}: ${c.detalle}`)
  for (const [k, d] of Object.entries<{ valor: string; detalle?: string }>(v.derivados)) linea(`     ⚙ derivado ${k} = ${d.valor} (${d.detalle ?? ""})`)

  if (esperado) {
    verificar(v.apta === esperado.apta, `${caso}: apta esperada ${esperado.apta}`)
    verificar(codigos(v.bloqueos) === (esperado.bloqueos.join(",") || "—"), `${caso}: bloqueos esperados [${esperado.bloqueos}]`)
    verificar(codigos(v.confirmaciones) === (esperado.confirmaciones.join(",") || "—"), `${caso}: confirmaciones esperadas [${esperado.confirmaciones}]`)
    verificar(v.retroactiva === esperado.retroactiva, `${caso}: retroactiva esperada ${esperado.retroactiva}`)
  }

  let estado = ""
  if (!v.apta) {
    const r = await llamar("oc_construir_payload", { caso })
    linea(`  oc_construir_payload → ${r.ok ? "payload" : "rechazado"}: ${r.error ?? ""}`)
    verificar(!r.ok, `${caso}: un caso bloqueado no debe producir payload`)
    const c = await llamar("oc_crear", { caso })
    linea(`  oc_crear → ${c.ok ? "CREADA" : "no creada"} (${c.bloqueada ? "bloqueada" : c.error})`)
    verificar(!c.ok && c.bloqueada === true, `${caso}: oc_crear debe quedar bloqueada`)
    estado = `BLOQUEADA (${codigos(v.bloqueos)})`
  } else {
    const p = await llamar("oc_construir_payload", { caso, paquete: paquete.data, derivados: v.derivados })
    verificar(p.ok, `${caso}: el payload debe construirse`)
    const orden = p.data!.orden
    const pos = orden.posiciones[0]
    linea(`  oc_construir_payload → proveedor ${orden.proveedor.codigo_sap} · ${pos.cantidad} ${pos.unidad} × ${pos.precio_unitario} · IVA ${pos.indicador_iva} · pago ${orden.condiciones_pago}`)
    const e = await llamar("oc_generar_evidencia", { caso })
    linea(`  oc_generar_evidencia → ${e.data?.ruta} · sha256 ${String(e.data?.sha256).slice(0, 16)}…`)

    let crear: Json
    if (v.confirmaciones.length > 0) {
      const primero = await llamar("oc_crear", { caso, payload: orden })
      linea(`  oc_crear (sin confirmar) → ${primero.ok ? "CREADA" : "pide confirmación"}: ${primero.error?.slice(0, 110)}…`)
      verificar(!primero.ok && primero.requiere_confirmacion === true, `${caso}: debe pedir confirmación antes de crear`)
      linea(`  ► El analista confirma explícitamente: oc_crear({ confirmado: true })`)
      crear = await llamar("oc_crear", { caso, payload: orden, confirmado: true, confirmado_por: "analista-demo" })
    } else {
      crear = await llamar("oc_crear", { caso, payload: orden })
    }
    linea(`  oc_crear → ${crear.ok ? `OC ${crear.data!.numero_oc} (${crear.data!.fecha})` : `ERROR ${crear.error}`}`)
    verificar(crear.ok === esperado?.crea, `${caso}: creación esperada ${esperado?.crea}`)
    estado = crear.ok ? `OC ${crear.data!.numero_oc}${v.retroactiva ? " · retroactiva" : ""}` : "ERROR"

    if (caso === "sol-001") {
      const otra = await llamar("oc_crear", { caso })
      linea(`  ♻ Idempotencia: oc_crear otra vez → OC ${otra.data?.numero_oc} idempotente=${otra.data?.idempotente}`)
      verificar(otra.data?.idempotente === true && otra.data?.numero_oc === crear.data?.numero_oc, "sol-001: la segunda creación debe devolver la misma OC")
    }
  }
  resumen.push([caso, sol.solicitud_id, v.apta ? "sí" : "no", codigos(v.bloqueos), codigos(v.confirmaciones), String(v.retroactiva), estado])
}

linea("\n=== Resumen ===")
const cab = ["caso", "solicitud", "apta", "bloqueos", "confirmaciones", "retroactiva", "resultado"]
const filas = [cab, ...resumen]
const anchos = cab.map((_, i) => Math.max(...filas.map((f) => (f[i] ?? "").length)))
for (const f of filas) linea("  " + f.map((c, i) => c.padEnd(anchos[i] ?? 0)).join("  "))
linea("\nArchivos generados en out/: control.csv · log.jsonl · sap/ordenes.jsonl · <caso>/{payload,trazabilidad}.json · <caso>/aprobacion.{txt,pdf}")

if (fallos.length) {
  linea(`\n✖ ${fallos.length} verificación(es) fallida(s):`)
  for (const f of fallos) linea(`  - ${f}`)
  process.exit(1)
}
linea("\n✔ Todas las verificaciones pasaron: resultados deterministas y conformes al PRD.")
