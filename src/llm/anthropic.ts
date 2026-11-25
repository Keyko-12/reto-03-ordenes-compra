import { ErrorLlm, timeoutMs, type DefinicionHerramienta, type LlmAdapter, type Mensaje, type RespuestaLlm } from "./adapter.ts"

type Bloque =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string }

type MensajeApi = { role: "user" | "assistant"; content: Bloque[] }

/** Convierte nuestros mensajes al formato de Anthropic (los tool_result viajan en un mensaje "user"). */
export function aFormatoAnthropic(mensajes: Mensaje[]): { system: string; messages: MensajeApi[] } {
  const system = mensajes.filter((m) => m.rol === "sistema").map((m) => m.texto).join("\n\n")
  const messages: MensajeApi[] = []
  const agregar = (role: "user" | "assistant", bloques: Bloque[]) => {
    const ultimo = messages.at(-1)
    if (ultimo && ultimo.role === role) ultimo.content.push(...bloques)
    else messages.push({ role, content: bloques })
  }
  for (const m of mensajes) {
    if (m.rol === "usuario") agregar("user", [{ type: "text", text: m.texto }])
    else if (m.rol === "herramienta") agregar("user", [{ type: "tool_result", tool_use_id: m.id, content: m.resultado }])
    else if (m.rol === "asistente") {
      const bloques: Bloque[] = []
      if (m.texto) bloques.push({ type: "text", text: m.texto })
      for (const l of m.llamadas) bloques.push({ type: "tool_use", id: l.id, name: l.nombre, input: l.args })
      if (bloques.length) agregar("assistant", bloques)
    }
  }
  // Los tool_result deben ir antes que cualquier texto dentro del mismo mensaje de usuario.
  for (const msg of messages) {
    if (msg.role === "user") msg.content.sort((a, b) => Number(b.type === "tool_result") - Number(a.type === "tool_result"))
  }
  return { system, messages }
}

export class AnthropicLlm implements LlmAdapter {
  readonly proveedor = "anthropic"
  readonly modelo: string
  readonly configurado: boolean
  private readonly clave: string
  private readonly url: string

  constructor(env: Record<string, string | undefined> = process.env) {
    this.clave = env.ANTHROPIC_API_KEY ?? ""
    this.modelo = env.ANTHROPIC_MODEL ?? "claude-haiku-5-5"
    this.url = env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com"
    this.configurado = this.clave.length > 0
  }

  async enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[]): Promise<RespuestaLlm> {
    if (!this.configurado) throw new ErrorLlm("Falta ANTHROPIC_API_KEY en el servidor: el modelo no está configurado.")
    const { system, messages } = aFormatoAnthropic(mensajes)
    const cuerpo = {
      model: this.modelo,
      max_tokens: 2048,
      system,
      messages,
      ...(herramientas.length
        ? { tools: herramientas.map((h) => ({ name: h.nombre, description: h.descripcion, input_schema: h.esquema })) }
        : {}),
    }
    const resp = await fetch(`${this.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": this.clave, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(timeoutMs()),
    })
    if (!resp.ok) {
      // El cuerpo del error no incluye la clave, pero igual no se reenvía completo al usuario.
      const detalle = await resp.text().catch(() => "")
      const motivo = /"message"\s*:\s*"([^"]{1,200})"/.exec(detalle)?.[1] ?? ""
      throw new ErrorLlm(`El proveedor de IA respondió con error ${resp.status}${motivo ? `: ${motivo}` : ""}.`)
    }
    const json = (await resp.json()) as {
      content: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>
      usage?: { input_tokens?: number; output_tokens?: number }
    }
    const texto = json.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n").trim()
    const llamadas = json.content
      .filter((b) => b.type === "tool_use")
      .map((b) => ({ id: b.id ?? "", nombre: b.name ?? "", args: b.input ?? {} }))
    return { texto, llamadas, uso: { entrada: json.usage?.input_tokens ?? 0, salida: json.usage?.output_tokens ?? 0 } }
  }
}
