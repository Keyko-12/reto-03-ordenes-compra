/**
 * Interfaz propia del proveedor de lenguaje. El ciclo del agente solo conoce este archivo:
 * cambiar de proveedor = escribir otra implementación de `LlmAdapter`, sin tocar `agent.ts`.
 */

export type LlamadaHerramienta = { id: string; nombre: string; args: Record<string, unknown> }

export type Mensaje =
  | { rol: "sistema"; texto: string }
  | { rol: "usuario"; texto: string }
  | { rol: "asistente"; texto: string; llamadas: LlamadaHerramienta[] }
  | { rol: "herramienta"; id: string; nombre: string; resultado: string }

export type DefinicionHerramienta = {
  nombre: string
  descripcion: string
  /** JSON Schema de los argumentos (generado desde zod). */
  esquema: Record<string, unknown>
}

export type RespuestaLlm = {
  texto: string
  llamadas: LlamadaHerramienta[]
  uso: { entrada: number; salida: number }
}

export interface LlmAdapter {
  readonly proveedor: string
  readonly modelo: string
  /** false si falta la clave del proveedor: el servidor arranca igual y lo informa en el chat. */
  readonly configurado: boolean
  enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[]): Promise<RespuestaLlm>
}

/** Error del proveedor con mensaje apto para el usuario (nunca incluye claves). */
export class ErrorLlm extends Error {}

/** Mensaje claro para el chat a partir de cualquier fallo al llamar al proveedor (CA5). */
export function mensajeDeError(e: unknown): string {
  if (e instanceof ErrorLlm) return e.message
  if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
    return "El modelo tardó demasiado en responder (timeout). Intenta de nuevo."
  }
  return "No pude comunicarme con el modelo de lenguaje. Intenta de nuevo en un momento."
}

export const timeoutMs = (): number => Number(process.env.LLM_TIMEOUT_MS ?? 60000)
