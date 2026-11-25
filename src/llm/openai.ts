import { ErrorLlm, timeoutMs, type DefinicionHerramienta, type LlmAdapter, type Mensaje, type RespuestaLlm } from "./adapter.ts"

type MensajeApi =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }
  | { role: "tool"; tool_call_id: string; content: string }

export function aFormatoOpenAi(mensajes: Mensaje[]): MensajeApi[] {
  return mensajes.map((m): MensajeApi => {
    switch (m.rol) {
      case "sistema":
        return { role: "system", content: m.texto }
      case "usuario":
        return { role: "user", content: m.texto }
      case "herramienta":
        return { role: "tool", tool_call_id: m.id, content: m.resultado }
      case "asistente":
        return {
          role: "assistant",
          content: m.texto || null,
          ...(m.llamadas.length
            ? { tool_calls: m.llamadas.map((l) => ({ id: l.id, type: "function" as const, function: { name: l.nombre, arguments: JSON.stringify(l.args) } })) }
            : {}),
        }
    }
  })
}

/** Cualquier API compatible con Chat Completions (OpenAI, Gemini compat., Groq, OpenRouter, Ollama...). */
export class OpenAiLlm implements LlmAdapter {
  readonly proveedor = "openai"
  readonly modelo: string
  readonly configurado: boolean
  private readonly clave: string
  private readonly base: string

  constructor(env: Record<string, string | undefined> = process.env) {
    this.clave = env.OPENAI_API_KEY ?? ""
    this.modelo = env.OPENAI_MODEL ?? "gpt-4.1-mini"
    this.base = (env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "")
    this.configurado = this.clave.length > 0
  }

  async enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[]): Promise<RespuestaLlm> {
    if (!this.configurado) throw new ErrorLlm("Falta OPENAI_API_KEY en el servidor: el modelo no está configurado.")
    const cuerpo = {
      model: this.modelo,
      messages: aFormatoOpenAi(mensajes),
      ...(herramientas.length
        ? { tools: herramientas.map((h) => ({ type: "function", function: { name: h.nombre, description: h.descripcion, parameters: h.esquema } })) }
        : {}),
    }
    const resp = await fetch(`${this.base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.clave}` },
      body: JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(timeoutMs()),
    })
    if (!resp.ok) {
      const detalle = await resp.text().catch(() => "")
      const motivo = /"message"\s*:\s*"([^"]{1,200})"/.exec(detalle)?.[1] ?? ""
      throw new ErrorLlm(`El proveedor de IA respondió con error ${resp.status}${motivo ? `: ${motivo}` : ""}.`)
    }
    const json = (await resp.json()) as {
      choices: Array<{ message: { content: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    const msg = json.choices[0]?.message
    const llamadas = (msg?.tool_calls ?? []).map((c) => {
      let args: Record<string, unknown> = {}
      try {
        args = JSON.parse(c.function.arguments || "{}")
      } catch {
        // Argumentos malformados: llegan vacíos y la validación zod le devolverá el error al modelo.
      }
      return { id: c.id, nombre: c.function.name, args }
    })
    return {
      texto: (msg?.content ?? "").trim(),
      llamadas,
      uso: { entrada: json.usage?.prompt_tokens ?? 0, salida: json.usage?.completion_tokens ?? 0 },
    }
  }
}
