import type { DefinicionHerramienta, LlamadaHerramienta, LlmAdapter, Mensaje, RespuestaLlm } from "./adapter.ts"

type Json = { ok?: boolean; error?: string; data?: Record<string, any>; [k: string]: any }

const parsear = (t: string): Json => {
  try {
    return JSON.parse(t) as Json
  } catch {
    return {}
  }
}

const CONFIRMA = /\b(confirmo|confirmado|adelante|procede|proceda|hazlo|s[ií])\b/i

/**
 * Modelo guionado y determinista, sin red ni clave (LLM_PROVIDER=mock).
 * Sirve para probar el ciclo del agente, la guardia de confirmación y el front sin gastar tokens.
 * NO es un modelo: solo encadena las herramientas en el orden esperado y resume sus resultados.
 */
export class MockLlm implements LlmAdapter {
  readonly proveedor = "mock"
  readonly modelo = "guion-determinista"
  readonly configurado = true

  async enviar(mensajes: Mensaje[], _herramientas: DefinicionHerramienta[]): Promise<RespuestaLlm> {
    const idxUsuario = mensajes.map((m) => m.rol).lastIndexOf("usuario")
    const usuario = mensajes[idxUsuario]
    const texto = usuario?.rol === "usuario" ? usuario.texto : ""
    const delTurno = mensajes.slice(idxUsuario + 1)
    const hechas = delTurno.filter((m): m is Extract<Mensaje, { rol: "herramienta" }> => m.rol === "herramienta")
    const resultado = (nombre: string): Json | undefined => {
      const m = hechas.find((h) => h.nombre === nombre)
      return m ? parsear(m.resultado) : undefined
    }

    const caso = /sol-\d{3}/i.exec(texto)?.[0]?.toLowerCase() ?? this.ultimoCaso(mensajes.slice(0, idxUsuario))
    const llamar = (nombre: string, args: Record<string, unknown>): RespuestaLlm => {
      const llamada: LlamadaHerramienta = { id: `mock-${mensajes.length}`, nombre, args }
      return { texto: "", llamadas: [llamada], uso: { entrada: 400, salida: 40 } }
    }
    const responder = (t: string): RespuestaLlm => ({ texto: t, llamadas: [], uso: { entrada: 400, salida: Math.ceil(t.length / 4) } })

    if (!caso) {
      return responder("Indícame qué solicitud procesar, por ejemplo: **Procesa la solicitud sol-001**.")
    }

    // Segundo turno: el usuario confirma lo que quedó pendiente.
    const confirma = CONFIRMA.test(texto) && !/sol-\d{3}/i.test(texto)
    if (confirma) {
      const r = resultado("oc_crear")
      if (!r) return llamar("oc_crear", { caso, confirmado: true })
      return responder(r.ok ? this.textoCreada(caso, r.data ?? {}) : `No se creó la OC: ${r.error}`)
    }

    if (!resultado("oc_leer_paquete")) return llamar("oc_leer_paquete", { caso })
    const validar = resultado("oc_validar")
    if (!validar) return llamar("oc_validar", { caso })
    if (!validar.ok) return responder(`No pude validar ${caso}: ${validar.error}`)
    const v = validar.data ?? {}

    if (!v.apta) {
      const lineas = (v.bloqueos as Array<{ codigo: string; detalle: string; accion_sugerida?: string }>).map(
        (b) => `- **${b.codigo}**: ${b.detalle}\n  Acción sugerida: ${b.accion_sugerida ?? "—"}`,
      )
      return responder(`⛔ **${caso} no puede crearse.** Bloqueos:\n${lineas.join("\n")}\n\nNo se creó ninguna OC.`)
    }

    const payload = resultado("oc_construir_payload")
    if (!payload) return llamar("oc_construir_payload", { caso })
    if (!payload.ok) return responder(`No pude construir el payload: ${payload.error}`)
    const orden = payload.data?.orden ?? {}
    const pos = orden.posiciones?.[0] ?? {}
    const tabla = [
      "| Campo | Valor |",
      "|---|---|",
      `| Proveedor | ${orden.proveedor?.nombre} (${orden.proveedor?.codigo_sap}) |`,
      `| Posición | ${pos.cantidad} ${pos.unidad} × ${pos.precio_unitario} ${orden.moneda} |`,
      `| Centro de costo | ${pos.centro_costo} / ${pos.subarea} |`,
      `| IVA / Pago | ${pos.indicador_iva} / ${orden.condiciones_pago} |`,
      `| Aprobador | ${orden.aprobador?.email} |`,
    ].join("\n")

    const confirmaciones = (v.confirmaciones ?? []) as Array<{ codigo: string; detalle: string }>
    if (confirmaciones.length > 0) {
      const lista = confirmaciones.map((c) => `- **${c.codigo}**: ${c.detalle}`).join("\n")
      return responder(`Así quedaría la OC de ${caso}:\n\n${tabla}\n\nRequiere tu confirmación:\n${lista}\n\n¿Confirmas que cree la OC con estas excepciones?`)
    }

    if (!resultado("oc_generar_evidencia")) return llamar("oc_generar_evidencia", { caso })
    const creada = resultado("oc_crear")
    if (!creada) return llamar("oc_crear", { caso })
    return responder(creada.ok ? `${this.textoCreada(caso, creada.data ?? {})}\n\n${tabla}` : `No se creó la OC: ${creada.error}`)
  }

  private textoCreada(caso: string, d: Record<string, any>): string {
    return `✅ OC **${d.numero_oc}** ${d.idempotente ? "(ya existía)" : "creada"} para ${caso}. Evidencia: ${d.evidencia ?? "out/" + caso + "/aprobacion.txt"}.`
  }

  private ultimoCaso(previos: Mensaje[]): string | undefined {
    for (const m of [...previos].reverse()) {
      if (m.rol === "asistente") {
        const c = m.llamadas.at(-1)?.args.caso
        if (typeof c === "string") return c
      }
    }
    return undefined
  }
}
