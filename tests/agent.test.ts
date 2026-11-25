import { afterAll, describe, expect, test } from "bun:test"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ejecutarTurno, nuevaSesion, type ConfigAgente } from "../src/agent.ts"
import type { LlmAdapter, Mensaje, RespuestaLlm } from "../src/llm/adapter.ts"
import { MockLlm } from "../src/llm/mock.ts"

const raiz = join(import.meta.dir, "..")
const dirs: string[] = []

function proyecto(): string {
  const directory = mkdtempSync(join(tmpdir(), "reto03-agent-"))
  dirs.push(directory)
  cpSync(join(raiz, "fixtures"), join(directory, "fixtures"), { recursive: true })
  mkdirSync(join(directory, "src", "knowledge"), { recursive: true })
  cpSync(join(raiz, "src", "knowledge"), join(directory, "src", "knowledge"), { recursive: true })
  return directory
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

const config = (directory: string, extra: Partial<ConfigAgente> = {}): ConfigAgente => ({
  directory,
  maxIteraciones: 25,
  maxTokensSesion: 1_000_000,
  ...extra,
})

const ordenes = (directory: string, sessionId: string): string[] => {
  const ruta = join(directory, "out", "sesiones", sessionId, "sap", "ordenes.jsonl")
  return existsSync(ruta) ? readFileSync(ruta, "utf8").split("\n").filter(Boolean) : []
}

/** Modelo que ejecuta una lista fija de pasos; permite simular a un modelo "desobediente". */
class Guionado implements LlmAdapter {
  readonly proveedor = "guion"
  readonly modelo = "test"
  readonly configurado = true
  private paso = 0
  constructor(private readonly pasos: Array<RespuestaLlm | Error>) {}
  async enviar(_m: Mensaje[]): Promise<RespuestaLlm> {
    const p = this.pasos[Math.min(this.paso++, this.pasos.length - 1)]!
    if (p instanceof Error) throw p
    return p
  }
}
const llamada = (nombre: string, args: Record<string, unknown>, id: string): RespuestaLlm => ({
  texto: "",
  llamadas: [{ id, nombre, args }],
  uso: { entrada: 10, salida: 5 },
})
const texto = (t: string): RespuestaLlm => ({ texto: t, llamadas: [], uso: { entrada: 10, salida: 5 } })

describe("ciclo del agente (modelo guionado)", () => {
  test("sol-001: flujo limpio → crea la OC sin pedir confirmación", async () => {
    const directory = proyecto()
    const s = nuevaSesion("s1", "prompt")
    const r = await ejecutarTurno(s, "Procesa la solicitud sol-001", new MockLlm(), config(directory))
    expect(r.needsConfirmation).toBe(false)
    expect(r.reply).toContain("4500000001")
    expect(r.toolCalls.map((t) => t.nombre)).toEqual(["oc_leer_paquete", "oc_validar", "oc_construir_payload", "oc_generar_evidencia", "oc_crear"])
    expect(ordenes(directory, s.id)).toHaveLength(1)
  })

  test("sol-004: el turno 1 pide confirmación y NO crea; el turno 2 confirma y crea", async () => {
    const directory = proyecto()
    const s = nuevaSesion("s2", "prompt")
    const t1 = await ejecutarTurno(s, "Procesa sol-004, no la crees hasta que yo confirme", new MockLlm(), config(directory))
    expect(t1.needsConfirmation).toBe(true)
    expect(t1.reply).toContain("RC5")
    expect(ordenes(directory, s.id)).toHaveLength(0)

    const t2 = await ejecutarTurno(s, "Confirmo", new MockLlm(), config(directory))
    expect(t2.needsConfirmation).toBe(false)
    expect(t2.reply).toContain("4500000001")
    expect(ordenes(directory, s.id)).toHaveLength(1)
    expect(ordenes(directory, s.id)[0]).toContain("analista (sesión s2)")
  })

  test("sol-003 y sol-002: bloqueadas, con razón, sin OC ni confirmación posible", async () => {
    const directory = proyecto()
    const s = nuevaSesion("s3", "prompt")
    const r = await ejecutarTurno(s, "Procesa sol-003", new MockLlm(), config(directory))
    expect(r.reply).toContain("RC2")
    expect(r.reply).toContain("RC3")
    expect(r.needsConfirmation).toBe(false)
    expect(ordenes(directory, s.id)).toHaveLength(0)
  })

  test("CA3: un modelo que se auto-confirma en el mismo turno es rechazado por el sistema", async () => {
    const directory = proyecto()
    const s = nuevaSesion("s4", "prompt")
    const modelo = new Guionado([
      llamada("oc_validar", { caso: "sol-004" }, "a"),
      llamada("oc_crear", { caso: "sol-004", confirmado: true }, "b"), // sin esperar al usuario
      texto("Listo."),
    ])
    const r = await ejecutarTurno(s, "Procesa sol-004", modelo, config(directory))
    const crear = r.toolCalls.find((t) => t.nombre === "oc_crear")!
    expect(crear.ok).toBe(false)
    expect(ordenes(directory, s.id)).toHaveLength(0)
    expect(r.needsConfirmation).toBe(true)
  })

  test("CA3: la confirmación solo vale en el turno inmediatamente posterior", async () => {
    const directory = proyecto()
    const s = nuevaSesion("s5", "prompt")
    await ejecutarTurno(s, "Procesa sol-004", new MockLlm(), config(directory))
    // El usuario cambia de tema: la petición de confirmación caduca.
    await ejecutarTurno(s, "¿Qué es una OC retroactiva?", new Guionado([texto("Es una OC creada después de la factura.")]), config(directory))
    const tarde = new Guionado([llamada("oc_crear", { caso: "sol-004", confirmado: true }, "c"), texto("ok")])
    const r = await ejecutarTurno(s, "Sí, confirmo", tarde, config(directory))
    expect(r.toolCalls[0]?.ok).toBe(false)
    expect(ordenes(directory, s.id)).toHaveLength(0)
  })

  test("CA5: si el proveedor LLM falla, se responde con un mensaje claro y la sesión sigue viva", async () => {
    const directory = proyecto()
    const s = nuevaSesion("s6", "prompt")
    const r1 = await ejecutarTurno(s, "hola", new Guionado([new Error("boom")]), config(directory))
    expect(r1.reply).toContain("⚠️")
    expect(r1.reply).not.toContain("boom")
    const r2 = await ejecutarTurno(s, "Procesa sol-001", new MockLlm(), config(directory))
    expect(r2.reply).toContain("4500000001")
  })

  test("CA1: tope de iteraciones → se detiene y resume", async () => {
    const directory = proyecto()
    const s = nuevaSesion("s7", "prompt")
    const infinito = new Guionado([llamada("oc_leer_paquete", { caso: "sol-001" }, "x")])
    const r = await ejecutarTurno(s, "bucle", infinito, config(directory, { maxIteraciones: 3 }))
    expect(r.toolCalls).toHaveLength(3)
    expect(r.reply.length).toBeGreaterThan(0)
  })

  test("tope de tokens por sesión", async () => {
    const directory = proyecto()
    const s = nuevaSesion("s8", "prompt")
    s.tokens = 500
    const r = await ejecutarTurno(s, "hola", new MockLlm(), config(directory, { maxTokensSesion: 500 }))
    expect(r.reply).toContain("tope")
    expect(s.turno).toBe(0)
  })

  test("herramienta desconocida o argumentos inválidos: error claro, el ciclo continúa", async () => {
    const directory = proyecto()
    const s = nuevaSesion("s9", "prompt")
    const modelo = new Guionado([llamada("oc_inexistente", {}, "a"), llamada("oc_validar", {}, "b"), texto("ok")])
    const r = await ejecutarTurno(s, "x", modelo, config(directory))
    expect(r.toolCalls.map((t) => t.ok)).toEqual([false, false])
    expect(r.reply).toBe("ok")
  })
  test("aislamiento: dos sesiones sobre el mismo proyecto no comparten SAP ni control.csv", async () => {
    const directory = proyecto()
    const a = nuevaSesion("sesion-a", "prompt")
    const b = nuevaSesion("sesion-b", "prompt")
    const ra = await ejecutarTurno(a, "Procesa sol-001", new MockLlm(), config(directory))
    const rb = await ejecutarTurno(b, "Procesa sol-001", new MockLlm(), config(directory))
    // Ambas obtienen la primera OC de SU propio SAP: la de b NO es "idempotente" por culpa de a.
    expect(ra.reply).toContain("4500000001")
    expect(rb.reply).toContain("4500000001")
    expect(rb.reply).not.toContain("ya existía")
    expect(ordenes(directory, a.id)).toHaveLength(1)
    expect(ordenes(directory, b.id)).toHaveLength(1)
    expect(existsSync(join(directory, "out", "sap"))).toBe(false)
    expect(existsSync(join(directory, "out", "control.csv"))).toBe(false)
    expect(readFileSync(join(directory, "out", "sesiones", "sesion-a", "control.csv"), "utf8")).toContain("SOL-2026-001,creada")
  })

  test("un id de sesión que intenta salir de out/sesiones/ se rechaza", async () => {
    const directory = proyecto()
    const s = nuevaSesion("../../fuera", "prompt")
    await expect(ejecutarTurno(s, "hola", new MockLlm(), config(directory))).rejects.toThrow("Identificador de sesión inválido")
  })

  /** Deja sol-004 pendiente de confirmación y devuelve la sesión lista para el turno 2. */
  async function conPendiente(id: string) {
    const directory = proyecto()
    const s = nuevaSesion(id, "prompt")
    const t1 = await ejecutarTurno(s, "Procesa sol-004, no la crees hasta que yo confirme", new MockLlm(), config(directory))
    expect(t1.needsConfirmation).toBe(true)
    return { directory, s }
  }
  const autoconfirma = () => new Guionado([llamada("oc_crear", { caso: "sol-004", confirmado: true }, "z"), texto("Listo.")])

  test("CA3: si el usuario responde que NO, un modelo que igual confirma es rechazado y no se crea nada", async () => {
    const { directory, s } = await conPendiente("sesion-no")
    const r = await ejecutarTurno(s, "No, no la crees todavía", autoconfirma(), config(directory))
    expect(r.toolCalls[0]?.ok).toBe(false)
    expect(ordenes(directory, s.id)).toHaveLength(0)
  })

  test("CA3: una respuesta ambigua o una pregunta tampoco confirman", async () => {
    for (const [i, mensaje] of ["Mmm, déjame pensarlo", "¿Confirmo?", "Confirmo pero con otro valor", "Hola"].entries()) {
      const { directory, s } = await conPendiente(`sesion-amb-${i}`)
      const r = await ejecutarTurno(s, mensaje, autoconfirma(), config(directory))
      expect(r.toolCalls[0]?.ok).toBe(false)
      expect(ordenes(directory, s.id)).toHaveLength(0)
    }
  })

  test("CA3: tras un rechazo, el siguiente mensaje afirmativo sí confirma (la petición se renueva)", async () => {
    const { directory, s } = await conPendiente("sesion-renueva")
    // Turno 2: ambiguo, el modelo intenta confirmar; el rechazo vuelve a dejar la confirmación pendiente.
    const t2 = await ejecutarTurno(s, "Mmm", autoconfirma(), config(directory))
    expect(t2.needsConfirmation).toBe(true)
    const t3 = await ejecutarTurno(s, "Sí, confirmo", new MockLlm(), config(directory))
    expect(t3.reply).toContain("4500000001")
    expect(ordenes(directory, s.id)).toHaveLength(1)
  })

  test("el botón «Confirmo» del front confirma y el botón «Espera» no", async () => {
    const front = readFileSync(join(raiz, "web", "app.js"), "utf8")
    const msg = (id: string) => new RegExp(`\\$\\("${id}"\\)\\.addEventListener\\("click", \\(\\) => enviarMensaje\\("([^"]+)"\\)\\)`).exec(front)?.[1] ?? ""
    const confirmo = msg("confirmo")
    const espera = msg("espera")
    expect(confirmo.length).toBeGreaterThan(0)
    expect(espera.length).toBeGreaterThan(0)

    const a = await conPendiente("sesion-boton-si")
    const ra = await ejecutarTurno(a.s, confirmo, new MockLlm(), config(a.directory))
    expect(ra.reply).toContain("4500000001")
    expect(ordenes(a.directory, a.s.id)).toHaveLength(1)

    const b = await conPendiente("sesion-boton-no")
    await ejecutarTurno(b.s, espera, autoconfirma(), config(b.directory))
    expect(ordenes(b.directory, b.s.id)).toHaveLength(0)
  })
})
