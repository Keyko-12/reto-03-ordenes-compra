// Front de chat sin dependencias. Muestra cada llamada a herramienta y resalta las confirmaciones.

const $ = (id) => document.getElementById(id)
const el = {
  mensajes: $("mensajes"), form: $("form"), texto: $("texto"), enviar: $("enviar"), pensando: $("pensando"),
  confirmacion: $("confirmacion"), estado: $("estado"), rapidos: $("rapidos"), salida: $("salida"),
}

function nuevoId() {
  return globalThis.crypto?.randomUUID ? crypto.randomUUID() : `s-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}
function leerSesion() {
  try { return localStorage.getItem("oc_session") || null } catch { return null }
}
let sessionId = leerSesion() || nuevoId()
try { localStorage.setItem("oc_session", sessionId) } catch { /* modo privado: la sesión vive solo en memoria */ }

/* ---------- Markdown mínimo (se escapa todo el HTML antes de formatear) ---------- */
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
const inline = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")

function markdown(texto) {
  const lineas = texto.split("\n")
  const html = []
  let i = 0
  while (i < lineas.length) {
    const l = lineas[i]
    if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|[\s:|-]+\|\s*$/.test(lineas[i + 1] || "")) {
      const celdas = (x) => x.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()))
      const cab = celdas(l)
      i += 2
      const filas = []
      while (i < lineas.length && /^\s*\|.*\|\s*$/.test(lineas[i])) filas.push(celdas(lineas[i++]))
      html.push(`<table><thead><tr>${cab.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${filas.map((f) => `<tr>${f.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`)
    } else if (/^\s*[-*]\s+/.test(l)) {
      const items = []
      while (i < lineas.length && /^\s*[-*]\s+/.test(lineas[i])) items.push(`<li>${inline(lineas[i++].replace(/^\s*[-*]\s+/, ""))}</li>`)
      html.push(`<ul>${items.join("")}</ul>`)
    } else if (!l.trim()) {
      i++
    } else {
      const parrafo = []
      while (i < lineas.length && lineas[i].trim() && !/^\s*[-*]\s+/.test(lineas[i]) && !/^\s*\|.*\|\s*$/.test(lineas[i])) parrafo.push(inline(lineas[i++]))
      html.push(`<p>${parrafo.join("<br>")}</p>`)
    }
  }
  return html.join("")
}

/* ---------- Render ---------- */
function bajar() { el.mensajes.scrollTop = el.mensajes.scrollHeight }

function burbuja(clase, contenido, esHtml = false) {
  const d = document.createElement("div")
  d.className = `burbuja ${clase}`
  if (esHtml) d.innerHTML = contenido
  else d.textContent = contenido
  el.mensajes.appendChild(d)
  bajar()
  return d
}

function tarjetaHerramienta(t) {
  const d = document.createElement("details")
  d.className = "tool"
  const s = document.createElement("summary")
  const nombre = document.createElement("span"); nombre.className = "nombre"; nombre.textContent = t.nombre
  const estado = document.createElement("span"); estado.className = `estado ${t.ok ? "ok" : "error"}`; estado.textContent = t.ok ? "ok" : "error"
  const resumen = document.createElement("span"); resumen.className = "resumen"; resumen.textContent = t.resumen
  s.append(nombre, estado, resumen)
  const pre = document.createElement("pre")
  const args = JSON.stringify(t.args, null, 2)
  const res = typeof t.resultado === "string" ? t.resultado : JSON.stringify(t.resultado, null, 2)
  pre.textContent = `argumentos:\n${args.length > 1500 ? args.slice(0, 1500) + "…" : args}\n\nresultado:\n${res}`
  d.append(s, pre)
  return d
}

function pintarRespuesta(r) {
  if (r.toolCalls?.length) {
    const cont = document.createElement("div")
    cont.className = "herramientas"
    for (const t of r.toolCalls) cont.appendChild(tarjetaHerramienta(t))
    el.mensajes.appendChild(cont)
  }
  burbuja(r.needsConfirmation ? "agente pide" : "agente", markdown(r.reply || ""), true)
  el.confirmacion.hidden = !r.needsConfirmation
  bajar()
}

/* ---------- Envío ---------- */
let enCurso = false
async function enviarMensaje(mensaje) {
  const texto = mensaje.trim()
  if (!texto || enCurso) return
  enCurso = true
  el.enviar.disabled = true
  el.confirmacion.hidden = true
  burbuja("usuario", texto)
  el.texto.value = ""
  el.pensando.hidden = false
  try {
    const resp = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, message: texto }),
    })
    const datos = await resp.json().catch(() => ({}))
    if (!resp.ok) burbuja("sistema", `⚠ ${datos.error || "No se pudo procesar el mensaje."}`)
    else pintarRespuesta(datos)
  } catch {
    burbuja("sistema", "⚠ No hay conexión con el servidor. Intenta de nuevo.")
  } finally {
    el.pensando.hidden = true
    enCurso = false
    el.enviar.disabled = false
    el.texto.focus()
  }
}

el.form.addEventListener("submit", (e) => { e.preventDefault(); enviarMensaje(el.texto.value) })
el.texto.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); enviarMensaje(el.texto.value) } })
$("confirmo").addEventListener("click", () => enviarMensaje("Confirmo, crea la OC con las excepciones indicadas."))
$("espera").addEventListener("click", () => enviarMensaje("No la crees todavía."))
$("nueva").addEventListener("click", () => {
  sessionId = nuevoId()
  try { localStorage.setItem("oc_session", sessionId) } catch { /* sin persistencia */ }
  el.mensajes.replaceChildren()
  el.confirmacion.hidden = true
  burbuja("sistema", "Sesión nueva.")
})

async function mostrar(ruta, formato) {
  try {
    const r = await (await fetch(ruta)).json()
    el.salida.textContent = formato(r) || "(vacío: aún no hay registros)"
  } catch {
    el.salida.textContent = "No se pudo leer la salida."
  }
}
$("verControl").addEventListener("click", () => mostrar("/api/control", (r) => r.csv))
$("verSap").addEventListener("click", () =>
  mostrar("/api/sap", (r) => r.ordenes.map((o) => `${o.numero_oc} · ${o.fecha} · ${o.orden.referencia.solicitud_id} · ${o.orden.proveedor.nombre} · excepciones: ${o.orden.excepciones.map((e) => e.codigo).join(",") || "—"}`).join("\n")),
)

/* ---------- Arranque ---------- */
async function iniciar() {
  try {
    const h = await (await fetch("/api/health")).json()
    el.estado.textContent = `${h.provider} · ${h.model}${h.configured ? "" : " · sin clave"}`
    el.estado.className = `chip ${h.configured ? "ok" : "error"}`
  } catch {
    el.estado.textContent = "sin conexión"
    el.estado.className = "chip error"
  }
  try {
    const { casos } = await (await fetch("/api/casos")).json()
    for (const c of casos) {
      const b = document.createElement("button")
      b.type = "button"; b.className = "sec"; b.textContent = `Procesar ${c}`
      b.addEventListener("click", () => enviarMensaje(`Procesa la solicitud ${c}. Muéstrame la OC como quedaría, qué validaciones pasó y cuáles no. Si requiere confirmación, no la crees hasta que yo lo confirme.`))
      el.rapidos.appendChild(b)
    }
  } catch { /* los atajos son opcionales */ }
  burbuja("sistema", "Escribe qué solicitud procesar (sol-001 … sol-006) o usa un atajo.")
}
iniciar()
