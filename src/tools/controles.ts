import type { SapAdapter } from "../sap/adapter.ts"
import type { Hallazgo, Maestros, Paquete, Proveedor, Validacion } from "./tipos.ts"
import { formatoMonto, normalizarNit, normalizarNombre, soloFecha } from "./util.ts"

/** Tolerancia entre cotización y solicitud (RC5). */
export const TOLERANCIA_COTIZACION = 0.02

const pct = (x: number): string => (x * 100).toFixed(2).replace(".", ",")

/** Localiza al proveedor: por NIT si viene; si no, por nombre normalizado en el maestro. */
function resolverProveedor(paquete: Paquete, maestros: Maestros): { proveedor: Proveedor | null; porNombre: boolean; ambiguo: boolean } {
  const { proveedor_nit, proveedor_nombre } = paquete.solicitud
  if (proveedor_nit) {
    const nit = normalizarNit(proveedor_nit)
    return { proveedor: maestros.proveedores.find((p) => normalizarNit(p.nit) === nit) ?? null, porNombre: false, ambiguo: false }
  }
  const nombre = normalizarNombre(proveedor_nombre)
  const coincidencias = maestros.proveedores.filter((p) => normalizarNombre(p.nombre) === nombre)
  return { proveedor: coincidencias.length === 1 ? (coincidencias[0] ?? null) : null, porNombre: true, ambiguo: coincidencias.length > 1 }
}

/**
 * Aplica las reglas RC1–RC10 (PRD §7.3). No tiene efectos secundarios.
 *  - bloqueos: impiden crear la OC.
 *  - confirmaciones: permiten crearla solo con confirmación humana explícita.
 *  - derivados: valores que se completaron desde maestros y deben informarse.
 */
export async function validarPaquete(paquete: Paquete, maestros: Maestros, sap: SapAdapter): Promise<Validacion> {
  const { solicitud: sol, cotizacion, aprobacion, factura } = paquete
  const bloqueos: Hallazgo[] = []
  const confirmaciones: Hallazgo[] = []
  const derivados: Validacion["derivados"] = {}

  /* RC1 · proveedor existente y activo ----------------------------------- */
  const { proveedor, porNombre, ambiguo } = resolverProveedor(paquete, maestros)
  const nitBuscado = proveedor?.nit ?? sol.proveedor_nit
  const enSap = nitBuscado ? await sap.consultarProveedor(nitBuscado) : null
  let proveedorOk: Validacion["proveedor"] = null

  if (ambiguo) {
    bloqueos.push({
      codigo: "RC1",
      detalle: `El nombre "${sol.proveedor_nombre}" coincide con más de un proveedor del maestro.`,
      accion_sugerida: "Pedir al solicitante el NIT del proveedor.",
    })
  } else if (!proveedor || !enSap) {
    const ref = sol.proveedor_nit ? `NIT ${sol.proveedor_nit}` : `nombre "${sol.proveedor_nombre}"`
    bloqueos.push({
      codigo: "RC1",
      detalle: `El proveedor (${ref}) no existe en el maestro de proveedores.`,
      accion_sugerida: "Solicitar la creación del proveedor (alta en el maestro) antes de generar la OC.",
    })
  } else if (!proveedor.activo || !enSap.activo) {
    bloqueos.push({
      codigo: "RC1",
      detalle: `El proveedor ${proveedor.nombre} (NIT ${proveedor.nit}) está inactivo en el maestro.`,
      accion_sugerida: "Reactivar al proveedor o escoger otro proveedor activo.",
    })
  } else {
    proveedorOk = { codigo_sap: enSap.codigo_sap, nit: proveedor.nit, nombre: proveedor.nombre }
    if (porNombre) {
      derivados.proveedor_nit = {
        valor: proveedor.nit,
        fuente: "maestro.proveedores",
        detalle: "La solicitud no trae NIT; el proveedor se identificó por nombre normalizado.",
      }
    }
    if (cotizacion?.nit && normalizarNit(cotizacion.nit) !== normalizarNit(proveedor.nit)) {
      confirmaciones.push({
        codigo: "RC1",
        detalle: `El NIT de la cotización (${cotizacion.nit}) no coincide con el del proveedor del maestro (${proveedor.nit}).`,
        accion_sugerida: "Confirmar con el solicitante que la cotización corresponde a este proveedor.",
      })
    }
  }

  /* Centro de costo (insumo de RC2, RC3 y RC4) -------------------------- */
  const centro = maestros.centros.find((c) => c.centro_costo === sol.centro_costo)

  /* RC4 · subárea pertenece al centro de costo --------------------------- */
  if (!centro) {
    bloqueos.push({
      codigo: "RC4",
      detalle: `El centro de costo ${sol.centro_costo} no existe en el maestro.`,
      accion_sugerida: "Corregir el centro de costo con el solicitante.",
    })
  } else if (!centro.subareas.includes(sol.subarea)) {
    bloqueos.push({
      codigo: "RC4",
      detalle: `La subárea "${sol.subarea}" no pertenece al centro ${centro.centro_costo} (${centro.nombre}). Subáreas válidas: ${centro.subareas.join(", ")}.`,
      accion_sugerida: "Corregir la subárea o el centro de costo en la solicitud.",
    })
  }

  /* RC2 · aprobación existe, dice "Aprobado" y viene de un aprobador del centro */
  if (!aprobacion) {
    bloqueos.push({
      codigo: "RC2",
      detalle: "No hay correo de aprobación en el paquete.",
      accion_sugerida: "Pedir al solicitante la aprobación de su líder.",
    })
  } else if (!aprobacion.aprobado) {
    bloqueos.push({
      codigo: "RC2",
      detalle: 'El correo de aprobación no contiene la palabra "Aprobado".',
      accion_sugerida: "Pedir al líder una aprobación explícita.",
    })
  }

  /* RC3 · monto dentro del tope del aprobador -------------------------- */
  if (aprobacion && centro) {
    const aprobador = centro.aprobadores.find((a) => a.email.toLowerCase() === aprobacion.de)
    const topeMaximo = Math.max(0, ...centro.aprobadores.map((a) => a.tope))
    if (!aprobador) {
      const otrosCentros = maestros.centros
        .filter((c) => c.aprobadores.some((a) => a.email.toLowerCase() === aprobacion.de))
        .map((c) => c.centro_costo)
      const nota = otrosCentros.length ? ` Esa persona es aprobadora de ${otrosCentros.join(", ")}, no de ${centro.centro_costo}.` : ""
      bloqueos.push({
        codigo: "RC2",
        detalle: `${aprobacion.de} no está registrado como aprobador del centro ${centro.centro_costo} (${centro.nombre}).${nota}`,
        accion_sugerida: `Obtener la aprobación de un aprobador del centro: ${centro.aprobadores.map((a) => a.email).join(", ")}.`,
      })
      if (sol.valor_total > topeMaximo) {
        bloqueos.push({
          codigo: "RC3",
          detalle: `El valor ${formatoMonto(sol.valor_total)} ${sol.moneda} supera el tope máximo de cualquier aprobador de ${centro.centro_costo} (${formatoMonto(topeMaximo)}).`,
          accion_sugerida: "Escalar a un nivel de aprobación superior: ningún aprobador del centro cubre este monto.",
        })
      }
    } else if (sol.valor_total > aprobador.tope) {
      bloqueos.push({
        codigo: "RC3",
        detalle: `El valor ${formatoMonto(sol.valor_total)} ${sol.moneda} supera el tope de ${aprobador.nombre} en ${centro.centro_costo} (${formatoMonto(aprobador.tope)}).`,
        accion_sugerida: "Escalar a un aprobador con tope suficiente.",
      })
    }
  }

  /* RC10 · cantidad × valor_unitario = valor_total (±1) ---------------- */
  if (!(sol.valor_total > 0)) {
    bloqueos.push({
      codigo: "RC10",
      detalle: `El valor total (${sol.valor_total}) debe ser mayor que cero.`,
      accion_sugerida: "Corregir el valor en la solicitud.",
    })
  } else if (Math.abs(sol.cantidad * sol.valor_unitario - sol.valor_total) > 1) {
    bloqueos.push({
      codigo: "RC10",
      detalle: `cantidad × valor unitario (${sol.cantidad} × ${formatoMonto(sol.valor_unitario)} = ${formatoMonto(sol.cantidad * sol.valor_unitario)}) no coincide con el valor total (${formatoMonto(sol.valor_total)}).`,
      accion_sugerida: "Corregir las cifras de la solicitud.",
    })
  }

  /* RC5 · cotización vs solicitud (±2 %) ------------------------------- */
  if (!cotizacion) {
    confirmaciones.push({
      codigo: "RC5",
      detalle: "No hay cotización en el paquete: no se puede contrastar el valor solicitado.",
      accion_sugerida: "Pedir la cotización o confirmar que se crea la OC sin ella.",
    })
  } else if (cotizacion.moneda !== sol.moneda) {
    confirmaciones.push({
      codigo: "RC5",
      detalle: `La cotización está en ${cotizacion.moneda} y la solicitud en ${sol.moneda}.`,
      accion_sugerida: "Confirmar la moneda correcta con el solicitante.",
    })
  } else if (sol.valor_total > 0) {
    const diff = Math.abs(cotizacion.total - sol.valor_total) / sol.valor_total
    if (diff > TOLERANCIA_COTIZACION) {
      confirmaciones.push({
        codigo: "RC5",
        detalle: `La cotización (${sol.moneda} ${formatoMonto(cotizacion.total)}) difiere de la solicitud (${sol.moneda} ${formatoMonto(sol.valor_total)}) en ${pct(diff)} % (tolerancia ${pct(TOLERANCIA_COTIZACION)} %).`,
        accion_sugerida: "Confirmar con el solicitante cuál valor es el correcto antes de crear la OC.",
      })
    }
  }

  /* RC6 · indicador de IVA (derivado + confirmación) ------------------ */
  if (!sol.indicador_iva) {
    if (proveedorOk && proveedor) {
      const ind = maestros.indicadoresIva.find((i) => i.codigo === proveedor.indicador_iva_default)
      derivados.indicador_iva = {
        valor: proveedor.indicador_iva_default,
        fuente: "maestro.proveedores",
        detalle: `indicador_iva_default de ${proveedor.nombre}${ind ? ` (${ind.descripcion})` : ""}.`,
      }
      const coherencia =
        cotizacion?.iva_tasa != null && ind
          ? cotizacion.iva_tasa === ind.tasa
            ? ` La cotización muestra IVA ${pct(cotizacion.iva_tasa)} %, coherente con ese indicador.`
            : ` Atención: la cotización muestra IVA ${pct(cotizacion.iva_tasa)} % y el indicador equivale a ${pct(ind.tasa)} %.`
          : ""
      confirmaciones.push({
        codigo: "RC6",
        detalle: `La solicitud no informa el indicador de IVA. Se propone ${proveedor.indicador_iva_default}${ind ? ` (${ind.descripcion})` : ""}, el predeterminado del proveedor.${coherencia}`,
        accion_sugerida: "Confirmar el indicador de IVA propuesto.",
      })
    } else {
      confirmaciones.push({
        codigo: "RC6",
        detalle: "La solicitud no informa el indicador de IVA y no se pudo derivar (proveedor no resuelto).",
        accion_sugerida: "Pedir el indicador de IVA al solicitante.",
      })
    }
  } else if (!maestros.indicadoresIva.some((i) => i.codigo === sol.indicador_iva)) {
    bloqueos.push({
      codigo: "RC6",
      detalle: `El indicador de IVA "${sol.indicador_iva}" no existe en el maestro (válidos: ${maestros.indicadoresIva.map((i) => i.codigo).join(", ")}).`,
      accion_sugerida: "Corregir el indicador de IVA en la solicitud.",
    })
  }

  /* RC7 · condiciones de pago (derivado, solo se informa) ------------- */
  if (!sol.condiciones_pago) {
    if (proveedorOk && proveedor) {
      const cond = maestros.condicionesPago.find((c) => c.codigo === proveedor.condiciones_pago_default)
      derivados.condiciones_pago = {
        valor: proveedor.condiciones_pago_default,
        fuente: "maestro.proveedores",
        detalle: `condiciones_pago_default de ${proveedor.nombre}${cond ? ` (${cond.descripcion})` : ""}.`,
      }
    }
  } else if (!maestros.condicionesPago.some((c) => c.codigo === sol.condiciones_pago)) {
    bloqueos.push({
      codigo: "RC7",
      detalle: `La condición de pago "${sol.condiciones_pago}" no existe en el maestro (válidas: ${maestros.condicionesPago.map((c) => c.codigo).join(", ")}).`,
      accion_sugerida: "Corregir la condición de pago en la solicitud.",
    })
  }

  /* RC8 · factura anterior a la solicitud → retroactiva ----------------- */
  const retroactiva = factura !== null && factura.fecha < sol.fecha_solicitud
  if (retroactiva && factura) {
    confirmaciones.push({
      codigo: "RC8",
      detalle: `OC retroactiva: la factura ${factura.numero} (${factura.fecha}) es anterior a la solicitud (${sol.fecha_solicitud}). La compra se hizo antes de tener OC.`,
      accion_sugerida: "Crear la OC solo con confirmación y registrar el desvío en el control para medirlo.",
    })
  }

  /* RC9 · fecha de aprobación ≥ fecha de solicitud ---------------------- */
  if (aprobacion && soloFecha(aprobacion.fecha) < sol.fecha_solicitud) {
    confirmaciones.push({
      codigo: "RC9",
      detalle: `La aprobación (${soloFecha(aprobacion.fecha)}) es anterior a la fecha de la solicitud (${sol.fecha_solicitud}).`,
      accion_sugerida: "Confirmar que la aprobación corresponde a esta solicitud.",
    })
  }

  return { apta: bloqueos.length === 0, bloqueos, confirmaciones, derivados, retroactiva, proveedor: proveedorOk }
}
