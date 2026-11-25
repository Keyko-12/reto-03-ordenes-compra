import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MockLlm } from "../src/llm/mock.ts"
import { crearServidor, ipCliente, opcionesDesdeEnv } from "../src/server.ts"

const raiz = join(import.meta.dir, "..")
const directory = mkdtempSync(join(tmpdir(), "reto03-srv-"))
for (const d of ["fixtures", "agent", "web"]) cpSync(join(raiz, d), join(directory, d), { recursive: true })
mkdirSync(join(directory, "src", "knowledge"), { recursive: true })
cpSync(join(raiz, "src", "knowledge"), join(directory, "src", "knowledge"), { recursive: true })

let base = ""
const servidor = crearServidor({
  directory,
  llm: new MockLlm(),
  maxIteraciones: 25,
  maxTokensSesion: 1_000_000,
  maxTokensDia: 1_000_000,
  limitePorMinuto: 1000,
})

beforeAll(async () => {
  await new Promise<void>((ok) => servidor.listen(0, ok))
  base = `http://localhost:${(servidor.address() as AddressInfo).port}`
})
afterAll(() => {
  servidor.close()
  rmSync(directory, { recursive: true, force: true })
})

const post = (cuerpo: unknown) => fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(cuerpo) })

describe("API HTTP", () => {
  test("/api/health no expone claves y dice el proveedor", async () => {
    const r = await (await fetch(`${base}/api/health`)).json()
    expect(r).toEqual({ ok: true, provider: "mock", model: "guion-determinista", configured: true })
  })

  test("chat en dos turnos: pide confirmación y luego crea", async () => {
    const id = "sesion-prueba-1"
    const a = await (await post({ sessionId: id, message: "Procesa sol-004" })).json()
    expect(a.needsConfirmation).toBe(true)
    expect(a.toolCalls.length).toBeGreaterThan(0)
    const b = await (await post({ sessionId: id, message: "Confirmo" })).json()
    expect(b.needsConfirmation).toBe(false)
    expect(b.reply).toContain("4500000001")
    const sap = await (await fetch(`${base}/api/sap?sessionId=${id}`)).json()
    expect(sap.ordenes).toHaveLength(1)
    expect(sap.ordenes[0].numero_oc).toBe("4500000001")
    const control = await (await fetch(`${base}/api/control?sessionId=${id}`)).json()
    expect(control.csv).toContain("SOL-2026-004,creada,4500000001")
    const hist = await (await fetch(`${base}/api/sessions/${id}`)).json()
    expect(hist.turno).toBe(2)
    expect(JSON.stringify(hist)).not.toContain("Agente de Órdenes de Compra") // el system prompt no se expone
  })

  test("validación de entrada", async () => {
    expect((await post({ sessionId: "corto", message: "hola" })).status).toBe(400)
    expect((await post({ sessionId: "sesion-valida-1", message: "   " })).status).toBe(400)
    expect((await post({ sessionId: "sesion-valida-1", message: "x".repeat(2001) })).status).toBe(400)
  })

  test("sesión inexistente → 404; ruta inexistente → 404", async () => {
    expect((await fetch(`${base}/api/sessions/no-existe-123`)).status).toBe(404)
    expect((await fetch(`${base}/api/nada`)).status).toBe(404)
  })

  test("estáticos servidos y sin salida de la carpeta web", async () => {
    expect((await fetch(`${base}/`)).status).toBe(200)
    expect((await fetch(`${base}/app.js`)).status).toBe(200)
    const r = await fetch(`${base}/..%2fpackage.json`)
    expect(r.status).not.toBe(200)
  })
})

describe("aislamiento por sesión (API)", () => {
  test("dos visitantes no comparten órdenes, registros ni idempotencia", async () => {
    const [a, b] = ["visitante-aaa-1", "visitante-bbb-2"]
    const ra = await (await post({ sessionId: a, message: "Procesa sol-001" })).json()
    const rb = await (await post({ sessionId: b, message: "Procesa sol-001" })).json()
    expect(ra.reply).toContain("4500000001")
    expect(rb.reply).toContain("4500000001")
    expect(rb.reply).not.toContain("ya existía")
    const sapA = await (await fetch(`${base}/api/sap?sessionId=${a}`)).json()
    const sapB = await (await fetch(`${base}/api/sap?sessionId=${b}`)).json()
    expect(sapA.ordenes).toHaveLength(1)
    expect(sapB.ordenes).toHaveLength(1)
    // Un tercero que no creó nada ve vacío.
    const vacio = await (await fetch(`${base}/api/sap?sessionId=visitante-ccc-3`)).json()
    expect(vacio.ordenes).toHaveLength(0)
    const ctrlC = await (await fetch(`${base}/api/control?sessionId=visitante-ccc-3`)).json()
    expect(ctrlC.csv).toBe("")
  })

  test("/api/control y /api/sap exigen un sessionId válido", async () => {
    for (const ruta of ["/api/control", "/api/sap"]) {
      expect((await fetch(`${base}${ruta}`)).status).toBe(400)
      expect((await fetch(`${base}${ruta}?sessionId=..%2F..%2Ffixtures`)).status).toBe(400)
      expect((await fetch(`${base}${ruta}?sessionId=corto`)).status).toBe(400)
    }
  })

  test("al arrancar, las carpetas de sesiones anteriores (huérfanas) se limpian", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reto03-limpia-"))
    mkdirSync(join(dir, "out", "sesiones", "vieja-sesion-1"), { recursive: true })
    const s = crearServidor({ directory: dir, llm: new MockLlm(), maxIteraciones: 5, maxTokensSesion: 1000, maxTokensDia: 1000, limitePorMinuto: 5 })
    expect(existsSync(join(dir, "out", "sesiones"))).toBe(false)
    s.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("límite de peticiones por IP", () => {
  test("ipCliente: sin proxies de confianza ignora X-Forwarded-For", () => {
    expect(ipCliente("9.9.9.9", "1.2.3.4", 0)).toBe("9.9.9.9")
    expect(ipCliente(undefined, "1.2.3.4", 0)).toBe("?")
  })

  test("ipCliente: con N proxies toma la N-ésima entrada desde el final", () => {
    expect(ipCliente("10.0.0.1", "falsa, 203.0.113.7", 1)).toBe("203.0.113.7")
    expect(ipCliente("10.0.0.1", "falsa1, falsa2, 203.0.113.7, 10.0.0.2", 2)).toBe("203.0.113.7")
    expect(ipCliente("10.0.0.1", ["falsa", "203.0.113.7"], 1)).toBe("203.0.113.7")
  })

  test("ipCliente: encabezado ausente o más corto que N → IP del socket (nunca un valor falsificable)", () => {
    expect(ipCliente("10.0.0.1", undefined, 1)).toBe("10.0.0.1")
    expect(ipCliente("10.0.0.1", "", 1)).toBe("10.0.0.1")
    expect(ipCliente("10.0.0.1", "203.0.113.7", 2)).toBe("10.0.0.1")
  })

  test("TRUST_PROXY_HOPS: valores inválidos o negativos equivalen a 0", () => {
    const dir = "/tmp/x"
    expect(opcionesDesdeEnv(dir, { LLM_PROVIDER: "mock" }).trustProxyHops).toBe(0)
    expect(opcionesDesdeEnv(dir, { LLM_PROVIDER: "mock", TRUST_PROXY_HOPS: "1" }).trustProxyHops).toBe(1)
    expect(opcionesDesdeEnv(dir, { LLM_PROVIDER: "mock", TRUST_PROXY_HOPS: "-3" }).trustProxyHops).toBe(0)
    expect(opcionesDesdeEnv(dir, { LLM_PROVIDER: "mock", TRUST_PROXY_HOPS: "abc" }).trustProxyHops).toBe(0)
  })

  /** Levanta un servidor con límite 3/min y devuelve una función que cuenta los 429 de N envíos. */
  async function conLimite(trustProxyHops: number) {
    const s = crearServidor({ directory, llm: new MockLlm(), maxIteraciones: 5, maxTokensSesion: 1_000_000, maxTokensDia: 1_000_000, limitePorMinuto: 3, trustProxyHops })
    await new Promise<void>((ok) => s.listen(0, ok))
    const url = `http://localhost:${(s.address() as AddressInfo).port}/api/chat`
    const enviar = async (forwardedFor: string, n: number) => {
      const estados: number[] = []
      for (let i = 0; i < n; i++) {
        const r = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": forwardedFor },
          body: JSON.stringify({ sessionId: `rate-${trustProxyHops}-${forwardedFor.length}-${i}-${Math.random().toString(36).slice(2, 8)}`, message: "hola" }),
        })
        estados.push(r.status)
      }
      return estados
    }
    return { enviar, cerrar: () => s.close() }
  }

  test("sin confiar en proxies, falsificar X-Forwarded-For NO evade el límite", async () => {
    const { enviar, cerrar } = await conLimite(0)
    const estados: number[] = []
    for (let i = 0; i < 8; i++) estados.push(...(await enviar(`10.0.0.${i}`, 1)))
    cerrar()
    expect(estados.filter((e) => e === 429).length).toBe(5) // 3 pasan, 5 se bloquean
  })

  test("con 1 proxy de confianza, el cliente falsifica el comienzo del encabezado y sigue limitado", async () => {
    const { enviar, cerrar } = await conLimite(1)
    const estados: number[] = []
    // Misma IP real (la que añade el proxy: la última); el cliente inventa lo que va antes.
    for (let i = 0; i < 8; i++) estados.push(...(await enviar(`falsa-${i}, 203.0.113.7`, 1)))
    expect(estados.filter((e) => e === 429).length).toBe(5)
    // Otro cliente real distinto tiene su propio cupo.
    expect(await enviar("falsa-0, 198.51.100.9", 1)).toEqual([200])
    cerrar()
  })
})
