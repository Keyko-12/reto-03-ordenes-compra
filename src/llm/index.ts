import type { LlmAdapter } from "./adapter.ts"
import { AnthropicLlm } from "./anthropic.ts"
import { MockLlm } from "./mock.ts"
import { OpenAiLlm } from "./openai.ts"

/** Fábrica según LLM_PROVIDER. Cambiar de proveedor es cambiar una variable de entorno. */
export function crearLlm(env: Record<string, string | undefined> = process.env): LlmAdapter {
  switch ((env.LLM_PROVIDER ?? "anthropic").toLowerCase()) {
    case "openai":
      return new OpenAiLlm(env)
    case "mock":
      return new MockLlm()
    case "anthropic":
      return new AnthropicLlm(env)
    default:
      throw new Error(`LLM_PROVIDER desconocido: "${env.LLM_PROVIDER}". Usa anthropic, openai o mock.`)
  }
}

export type { LlmAdapter } from "./adapter.ts"
