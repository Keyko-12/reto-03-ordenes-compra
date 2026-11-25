import { describe, expect, test } from "bun:test"
import { clasificarConfirmacion, type Veredicto } from "../src/confirmacion.ts"

const casos: Array<[string, Veredicto]> = [
  // Afirmativas explícitas
  ["Confirmo", "afirmativa"],
  ["Sí, confirmo", "afirmativa"],
  ["sí", "afirmativa"],
  ["Si, créala", "afirmativa"],
  ["Adelante", "afirmativa"],
  ["Dale, hazlo", "afirmativa"],
  ["De acuerdo", "afirmativa"],
  ["OK", "afirmativa"],
  ["Confirmo, crea la OC con las excepciones indicadas.", "afirmativa"],
  // Negativas explícitas
  ["No", "negativa"],
  ["No la crees todavía.", "negativa"],
  ["No confirmo", "negativa"],
  ["Cancela", "negativa"],
  ["Espera", "negativa"],
  ["No, no la confirmo", "negativa"],
  // Ambiguas: nunca confirman
  ["", "ambigua"],
  ["Hola", "ambigua"],
  ["Mmm, déjame pensarlo", "ambigua"],
  ["¿Confirmo?", "ambigua"],
  ["¿Puedes crearla?", "ambigua"],
  ["Confirmo pero con otro valor", "ambigua"],
  ["Si el valor cambia, confirmo", "ambigua"],
  ["No sé, confirmo", "ambigua"],
  ["Sí, no hay problema, adelante", "ambigua"],
  ["Procesa sol-001", "ambigua"],
  ["Confirmo " + "x".repeat(200), "ambigua"],
]

describe("clasificarConfirmacion", () => {
  for (const [mensaje, esperado] of casos) {
    test(`«${mensaje.slice(0, 50)}» → ${esperado}`, () => {
      expect(clasificarConfirmacion(mensaje)).toBe(esperado)
    })
  }
})
