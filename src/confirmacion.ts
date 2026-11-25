/**
 * Clasificación determinista de la respuesta del usuario a una petición de confirmación (CA3).
 *
 * El ciclo del agente solo deja pasar `oc_crear(confirmado: true)` si el mensaje del usuario es
 * una confirmación afirmativa explícita. Es deliberadamente conservadora: ante la duda, no confirma.
 * Una respuesta negativa o ambigua nunca permite crear la OC.
 */
export type Veredicto = "afirmativa" | "negativa" | "ambigua"

/** Una confirmación es corta; un mensaje largo mezcla otras cosas y se trata como ambiguo. */
const MAX_LARGO = 200

const AFIRMA = new Set([
  "confirmo", "confirmado", "confirmamos", "adelante", "procede", "proceda",
  "hazlo", "dale", "ok", "okay", "vale", "crea", "creala", "crealo", "acepto", "autorizo", "autorizado",
])

/** Negaciones y cancelaciones. */
const NIEGA = new Set([
  "no", "nunca", "jamas", "tampoco", "ni", "cancela", "cancelar", "cancelalo",
  "rechazo", "rechaza", "rechazar", "detente", "deten", "espera", "esperar", "olvida", "olvidalo",
])

/** Condiciones o reservas: «confirmo, pero…» no es una confirmación limpia. */
const RESERVA = new Set([
  "pero", "salvo", "excepto", "aunque", "antes", "despues", "primero", "solo", "unicamente",
  "cambia", "cambiar", "modifica", "corrige", "corregir", "duda", "dudo",
])

const sinTildes = (t: string): string => t.normalize("NFD").replace(/[̀-ͯ]/g, "")

export function clasificarConfirmacion(mensaje: string): Veredicto {
  const original = mensaje.normalize("NFC").toLowerCase().trim()
  if (!original || original.length > MAX_LARGO) return "ambigua"
  // Una pregunta no es una confirmación.
  if (/[?¿]/.test(original)) return "ambigua"

  let afirma = false
  let niega = false
  let reserva = false

  // Se analiza frase por frase (separadas por coma, punto, etc.): una negación anula las
  // afirmaciones que la siguen en la MISMA frase («no la confirmo»), pero no las de otra frase
  // («no sé, confirmo» queda ambigua porque mezcla ambas).
  original.split(/[,;.!:]+/).forEach((frase, nFrase) => {
    const tokens = frase.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
    let negadoDesde = Number.POSITIVE_INFINITY
    tokens.forEach((token, i) => {
      const base = sinTildes(token)
      if (NIEGA.has(base)) {
        niega = true
        negadoDesde = Math.min(negadoDesde, i)
      }
      if (RESERVA.has(base)) reserva = true
      // «sí» con tilde afirma. «si» sin tilde solo afirma si es el mensaje o la primera frase completa
      // («si, créala»); en cualquier otro lugar es condicional («si el valor cambia…») y es una reserva.
      const esSiAfirmativo = token === "sí" || (token === "si" && nFrase === 0 && tokens.length === 1)
      if (token === "si" && !esSiAfirmativo) reserva = true
      if ((AFIRMA.has(base) || esSiAfirmativo) && i < negadoDesde) afirma = true
    })
    if (/\bde acuerdo\b/.test(sinTildes(frase)) && negadoDesde === Number.POSITIVE_INFINITY) afirma = true
  })

  if (niega) return afirma ? "ambigua" : "negativa"
  if (reserva) return "ambigua"
  return afirma ? "afirmativa" : "ambigua"
}
