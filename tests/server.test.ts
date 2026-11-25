import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MockLlm } from "../src/llm/mock.ts"
import { crearServidor } from "../src/server.ts"

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
    const sap = await (await fetch(`${base}/api/sap`)).json()
    expect(sap.ordenes).toHaveLength(1)
    expect(sap.ordenes[0].numero_oc).toBe("4500000001")
    const control = await (await fetch(`${base}/api/control`)).json()
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
