# SOLUCION.md · Reto 03 · Agente de Órdenes de Compra SAP

## 1. Problema en una frase

La analista administrativa de Periferia digita a mano, por cada factura que entra, proveedor, centro de costos, valor, IVA, aprobador y condiciones de pago en SAP, y verifica de memoria que quien aprobó podía aprobar ese monto; esto cuesta tiempo, genera errores que se corrigen en el cierre contable y deja a Contabilidad sin saber cuántas OC se crean *después* de la factura.

## 2. Arquitectura

```
┌──────────────┐  HTTP    ┌──────────────────────────────────────────────────┐
│  web/ (chat) │ ───────▶ │  src/server.ts   API + estáticos + límites       │
│  - historial │ ◀─────── │  src/agent.ts    ciclo: modelo ⇄ herramientas    │
│  - tool calls│          │  src/llm/*       adaptador (Anthropic/OpenAI/mock)│
│  - confirmar │          │  src/tools/*     herramientas zod (oc_*)         │
└──────────────┘          │  src/sap/*       SapAdapter → mock sobre archivos │
                          └───────┬──────────────────────────┬───────────────┘
                                  │ lee                      │ escribe
                          fixtures/ (solo lectura)      out/ (control.csv, log.jsonl,
                                                             sap/ordenes.jsonl, <caso>/…)
```

La separación que evalúa el PRD:

| Capa | Dónde vive | Qué contiene |
|---|---|---|
| **Comportamiento** | `agent/prompt.md` | Rol, flujo, reglas que no se rompen, protocolo de confirmación |
| **Conocimiento** | `src/knowledge/ordenes-compra.md` | Reglas RC1–RC10, flujo, glosario. El agente lo consulta con `oc_consultar_proceso` |
| **Ejecución** | `src/tools/` | Lectura, controles, payload, evidencia, creación. Importables desde `demo.ts` sin servidor |

Una regla de negocio nueva se agrega en `src/tools/controles.ts` y `src/knowledge/`; el servidor no cambia. `demo.ts` y el servidor pasan por el mismo punto de ejecución (`ejecutarHerramienta`), que valida argumentos con zod, ejecuta, registra en `out/log.jsonl` y **nunca lanza**.

## 3. Ciclo del agente

`ejecutarTurno` (`src/agent.ts`) implementa: mensaje del usuario → (modelo → herramientas)\* → respuesta.

- **Tope de iteraciones (CA1).** `MAX_ITERACIONES` (25 por defecto). Al alcanzarlo se hace una última llamada pidiendo un resumen de lo logrado y lo pendiente; si esa llamada falla, se responde con un mensaje fijo. No hay bucle infinito posible.
- **Tope de tokens.** Por sesión (`MAX_TOKENS_SESION`) y por día para todo el servidor (`MAX_TOKENS_DIA`), más límite de peticiones por IP. Un visitante no puede gastar la clave sin límite. La IP no se toma de `X-Forwarded-For` tal cual (el cliente puede falsificarlo): por defecto se usa la del socket, y detrás de una plataforma `TRUST_PROXY_HOPS=N` toma la entrada N desde el final del encabezado, la que añade el último proxy de confianza (README, «Despliegue»).
- **Salidas aisladas por sesión.** Cada sesión escribe en `out/sesiones/<id>/`: su propio SAP simulado (numeración desde `4500000001`), `control.csv` y `log.jsonl`. Dos evaluadores que prueben `sol-001` a la vez obtienen cada uno una creación real, no una respuesta idempotente por culpa del otro.
- **Confirmación humana (CA3), forzada en código y no solo en el prompt.** Cuando un turno termina con excepciones pendientes (`oc_validar` con confirmaciones, o `oc_crear` que respondió `requiere_confirmacion`), el ciclo anota el caso y el número de turno, y responde `needsConfirmation: true` (el front resalta el estado). `oc_crear` con `confirmado: true` solo procede si se cumplen **dos** condiciones: (a) la petición se hizo **en el turno inmediatamente anterior** y (b) el mensaje del usuario en este turno es una **confirmación afirmativa explícita**, que decide `clasificarConfirmacion` (`src/confirmacion.ts`) sin intervención del modelo. Esa función clasifica en afirmativa («confirmo», «sí, créala», «adelante»), negativa («no la crees todavía», «cancela») o ambigua (preguntas, reservas como «confirmo, pero…», condicionales como «si el valor cambia…», mensajes que mezclan sí y no, mensajes largos); **solo la afirmativa confirma**, y ante la duda no confirma. Un modelo que intente auto-confirmarse en el mismo turno, que confirme tarde después de que el usuario cambió de tema, o que confirme pese a un «no» o a una respuesta ambigua, recibe un error y no se crea nada (hay pruebas para cada caso, y el botón «Confirmo» del front se comprueba contra el clasificador). Límite: es una lista de reglas en español, no comprensión del lenguaje; está sesgada a rechazar, así que una confirmación inusual simplemente se vuelve a pedir.
- **Errores (CA5).** Un fallo o timeout del proveedor se traduce a un mensaje en español dentro del chat (sin detalles internos ni claves); la sesión sigue viva y el turno siguiente funciona. Argumentos inválidos o herramientas inexistentes se devuelven al modelo como `{ ok:false, error }` para que corrija.
- **Trazabilidad (CA4).** Cada llamada queda visible en el chat (nombre, argumentos, resumen y resultado desplegable) y en `out/log.jsonl`.

**Los valores salen de las herramientas (CA2), y el diseño lo hace innecesario de confiar en el modelo.** Cada herramienta vuelve a leer la fuente a partir de `caso`. Los argumentos `paquete`, `derivados` y `payload` existen por contrato, pero no son la fuente: si el modelo reenvía un payload que difiere del recalculado por el sistema, `oc_crear` lo rechaza. Así un modelo no puede "arreglar" un monto para que cuadre con la cotización.

## 4. Elección del modelo

- **Proveedor y modelo por defecto:** Anthropic, `claude-haiku-5-5` (variable `ANTHROPIC_MODEL`).
- **Por qué:** el flujo es corto y está guiado por herramientas deterministas; el modelo decide qué herramienta llamar, redacta el resumen y formula la pregunta de confirmación. No necesita razonamiento profundo, y un modelo pequeño responde más rápido y más barato. Si en pruebas reales falla en casos ambiguos, se sube a un modelo mayor cambiando una variable.
- **Intercambiable:** `LlmAdapter.enviar(mensajes, herramientas)` es la única interfaz que ve el ciclo. Hay implementaciones para Anthropic, para cualquier API compatible con Chat Completions (`LLM_PROVIDER=openai`, con `OPENAI_BASE_URL`) y un modelo guionado (`mock`) para pruebas sin red. Cambiar de proveedor no toca `agent.ts`. Se usa `fetch` directo, sin SDK, para no añadir dependencias.
- **Costo estimado por caso.** Medí el tamaño real de los mensajes, las definiciones de herramientas y los resultados al ejecutar el ciclo con el modelo guionado, convertido a tokens con ~3,5 caracteres por token (aproximación, no un conteo exacto del tokenizador):

  | Flujo | Llamadas al modelo | Tokens de entrada (aprox.) | Tokens de salida (aprox.) |
  |---|---|---|---|
  | Caso limpio (`sol-001`) | 6 | ~18.000 | ~600–900 |
  | Caso bloqueado (`sol-003`) | 3 | ~8.000 | ~400–600 |
  | Con confirmación (`sol-004`, 2 turnos) | 6 | ~18.000 | ~800–1.100 |

  **Precio.** La página de precios de Anthropic (consultada el 25-nov-2026) lista Claude Haiku 5.5 a **USD 0,10 por millón de tokens de entrada y USD 0,50 por millón de salida** para prompts de hasta 100.000 tokens (por encima, USD 0,50 y USD 2,50). Cada llamada de este agente envía ~8.000–30.000 tokens, muy por debajo de ese umbral. Con esos precios un caso cuesta del orden de **USD 0,001–0,003** (caso limpio ≈ 0,0022; bloqueado ≈ 0,0010; con confirmación ≈ 0,0023). Con 8–12 solicitudes al mes (volumen del PRD) el costo mensual es de centavos. El tope diario `MAX_TOKENS_DIA` (1,5 millones de tokens) limita el gasto del servicio a **menos de USD 0,75 al día** aun si todos fueran tokens de salida. **Los precios cambian: reverifica la página el día del despliegue.** Unos 13.000 de los ~18.000 tokens de entrada son el prompt y las herramientas reenviados en cada llamada, así que el *prompt caching* del prefijo es la primera optimización si el volumen crece. El costo operativo real está en el tiempo de revisión humana, no en el modelo.

**Qué no está verificado:** la página de precios no cita el identificador de API del modelo. El valor por defecto (`claude-haiku-5-5`, en el código, `.env.example` y esta sección) es el que Anthropic publica para Haiku 5.5, pero ningún paso de la construcción lo exigió contra la API; se comprobará con la primera llamada real, antes de la defensa.

## 5. Matriz de controles

Implementados en `src/tools/controles.ts`, sin efectos secundarios. Cada hallazgo trae `codigo`, `detalle` y `accion_sugerida`.

| # | Regla | Tipo | Implementación | Caso que la ejercita |
|---|---|---|---|---|
| RC1 | Proveedor existe (por NIT; sin NIT, por nombre normalizado) y está activo | Bloqueo | Resuelve el proveedor en el maestro y consulta `SapAdapter.consultarProveedor`. Nombre normalizado: sin tildes ni sufijos societarios; si hay más de una coincidencia, bloquea | sol-002 (no existe); sol-006 (sin NIT, se resuelve por nombre) |
| RC2 | Aprobación existe, dice "Aprobado" y viene de un aprobador del centro | Bloqueo | "Aprobado" sin negación inmediata; remitente contra `aprobadores` del centro | sol-003 |
| RC3 | `valor_total` ≤ tope del aprobador en ese centro | Bloqueo | Compara con el tope del aprobador; si el aprobador no pertenece al centro, compara con el tope máximo del centro para sugerir escalamiento | sol-003 |
| RC4 | Subárea pertenece al centro | Bloqueo | Lista de subáreas del centro; centro inexistente también bloquea | todos (pasan) |
| RC5 | Cotización vs solicitud ≤ 2 % | Confirmación | `abs(cot − sol)/sol > 2 %` o sin cotización o moneda distinta | sol-004 (6 %) |
| RC6 | IVA ausente → derivar del proveedor | Confirmación + derivado | Usa `indicador_iva_default`; el mensaje contrasta con la tasa de IVA que muestra la cotización | sol-006 |
| RC7 | Condiciones de pago ausentes → derivar | Derivado | Usa `condiciones_pago_default`; solo se informa | sol-006 |
| RC8 | Factura anterior a la solicitud → `retroactiva` | Confirmación | Compara `factura.fecha < fecha_solicitud`; queda `retroactiva=true` en `control.csv` | sol-005 |
| RC9 | Aprobación posterior o igual a la solicitud | Confirmación | Compara solo la parte fecha (YYYY-MM-DD) | ninguno (todos pasan) |
| RC10 | `cantidad × valor_unitario = valor_total` (±1) | Bloqueo | Aritmética; valor total ≤ 0 también bloquea | ninguno (todos pasan) |

También se bloquean valores que no existen en los maestros (indicador de IVA o condición de pago inválidos), porque no se podría construir un payload válido.

**La regla más difícil: RC2/RC3 en `sol-003`.** El aprobador (Felipe Vargas) es un líder legítimo, pero de *otro* centro (CC-3030), y además el monto (COP 74.000.000) supera el tope máximo de cualquier aprobador de CC-2020 (COP 30.000.000). Una implementación ingenua marcaría solo uno de los dos problemas. Se informan ambos: RC2 (no es aprobador de ese centro, y a quién acudir) y RC3 (ningún aprobador del centro cubre el monto: hay que escalar). Son dos acciones distintas para la analista.

## 6. Diseño del adaptador SAP real

> Los nombres de servicios y campos SAP de esta sección son de referencia y deben validarse contra el sistema del cliente (S/4HANA o ECC, versión, APIs liberadas) antes de implementar.

**Opción elegida: por fases, dado que la viabilidad de conexión no está confirmada.**

| Fase | Qué | Condición |
|---|---|---|
| **0 · Plan B (disponible sin integración)** | El agente genera la OC lista para pegar o cargar: el payload ya validado, una hoja de carga masiva (CSV/Excel con el formato que acepte el proceso de carga de la compañía) y la evidencia en PDF. La analista elimina la digitación y la verificación mental aunque SAP no se toque | Ninguna |
| **1 · OData** | `API_PURCHASEORDER_PROCESS_SRV` (API de órdenes de compra de S/4HANA), expuesta a través de SAP Integration Suite o API Management | S/4HANA con la API liberada y acceso desde la nube (o Cloud Connector si es on-premise) |
| **1b · RFC/BAPI** | `BAPI_PO_CREATE1` vía RFC detrás de middleware (nunca directo desde el agente) | ECC, o S/4 sin la API OData |

Se descartan la carga por archivo como solución final (sin respuesta síncrona ni número de OC) y la conexión directa del agente a SAP (acopla el modelo a un sistema crítico).

**Mapeo del payload (7.4) a OData, y lo que falta:**

| Payload | Campo de SAP (referencia) | Nota |
|---|---|---|
| `sociedad`, `organizacion_compras` | `CompanyCode`, `PurchasingOrganization` | Constantes `1000` |
| `proveedor.codigo_sap` | `Supplier` | |
| `moneda` | `DocumentCurrency` | |
| `condiciones_pago` | `PaymentTerms` | Código tipo `Z030` |
| `posiciones[].numero` / `descripcion` | `PurchaseOrderItem` / `PurchaseOrderItemText` | Texto breve de 40 caracteres: ya se recorta en el payload |
| `cantidad`, `unidad` | `OrderQuantity`, `PurchaseOrderQuantityUnit` | `UN/H/MES` es interno del agente: requiere tabla a las unidades de medida de SAP |
| `precio_unitario` | `NetPriceAmount` | **Cuidado:** hoy se transmite el valor de la solicitud (IVA incluido según la cotización). SAP espera precio neto y calcula el IVA con el código de impuesto; hay que enviar la base (`base gravable / cantidad`) |
| `indicador_iva` | `TaxCode` | |
| `centro_costo`, `subarea` | Imputación (`AccountAssignmentCategory = K`, `CostCenter`) | La subárea probablemente es un campo propio o texto; definir con el equipo SAP |
| `referencia.solicitud_id` | Referencia externa del pedido (p. ej. `YourReference`) | Clave de idempotencia |

**Datos que SAP exigiría y el payload actual no tiene:** grupo de compras, centro/planta si aplica, cuenta de mayor, clase de documento, fecha de entrega. Son maestros o defaults por categoría de compra: se resuelven con el equipo funcional.

**Autenticación y credenciales.** Usuario técnico dedicado con permisos mínimos (crear OC, consultar proveedor), autenticado con OAuth 2.0 *client credentials* en Integration Suite (o usuario de comunicación en el sistema). Las credenciales viven en un gestor de secretos del entorno de ejecución (Key Vault, AWS Secrets Manager o equivalente), se inyectan en el adaptador y **no pasan nunca por el agente, el prompt, los logs ni el front**.

**Idempotencia frente a reintentos.** `buscarOrdenPorReferencia(solicitud_id)` consulta SAP por la referencia externa antes de crear, y el `solicitud_id` viaja en la propia OC. Si una creación termina en timeout (resultado desconocido), el adaptador **no reintenta a ciegas**: primero consulta por referencia y solo reintenta si no existe. La idempotencia que hoy hace `SapMock` sigue valiendo como contrato.

**Error parcial.** Una creación OData es atómica por documento: o se crea la OC completa o no se crea. Con BAPI, se revisa la tabla `RETURN`: si hay mensajes de error o aborto, se hace `ROLLBACK` y no se confirma (`BAPI_TRANSACTION_COMMIT` solo sin errores). Un fallo se registra en `control.csv` y se devuelve a la analista con el mensaje de SAP traducido; los errores transitorios (red, bloqueos de SAP) se reintentan con espera creciente y tope, siempre con la consulta previa por referencia.

## 7. Lectura del proceso: OC retroactivas

`sol-005` muestra el problema con claridad: la cotización es del 5 de agosto, la factura del 10 de agosto, la solicitud del 27 y la aprobación del 28; y el correo del líder dice que la factura ya llegó y que se cree la OC *"para poder radicarla"*. Es decir, **la OC dejó de ser un control previo al gasto y se volvió un trámite para registrar una factura**: el compromiso con el proveedor existió antes de que alguien verificara presupuesto, tope o proveedor, y la aprobación llegó después del hecho. En la muestra, 1 de 6 solicitudes es retroactiva (17 %), pero seis casos no permiten concluir una frecuencia real: eso es justo lo que el log de control permitirá medir.

**Qué le diría a la dirección:**
1. El agente no rechaza estos casos (la factura ya existe y el proveedor hay que pagarle): los crea **solo con confirmación explícita** y los marca `retroactiva=true`. Se mide el desvío sin frenar el pago.
2. Medirlo ya: porcentaje mensual de OC retroactivas por centro de costo, aprobador y proveedor, y días entre factura y aprobación (`out/control.csv`).
3. Atacar la causa, no solo el síntoma. Una compra recurrente como "papelería y tóner del trimestre" no debería pasar por una OC por evento: pide un **pedido abierto / contrato marco** con tope y vigencia, y la OC retroactiva desaparece para esa categoría.
4. Política en dos tiempos: un periodo de transición donde se toleran con marca y reporte mensual a los líderes, y después una regla de "sin OC no se radica" con excepciones definidas (emergencias, servicios públicos) y segunda firma del dueño del presupuesto para el resto.
5. Reducir el tiempo de creación de la OC (el agente lo lleva de digitación manual a una conversación) elimina el argumento de que "no hubo tiempo".

La decisión de política (tolerar con marca o rechazar) es de la dirección; el agente la hace medible y la hace cumplir sea cual sea.

## 8. Decisiones y trade-offs

1. **Las herramientas releen la fuente en vez de confiar en lo que reenvía el modelo.** *Alternativa descartada:* aceptar el `paquete`/`payload` que devuelve el modelo y validarlo solo con el esquema. *Por qué:* un esquema válido no garantiza un valor correcto; un modelo podría alterar un monto sin romper el esquema. *Costo:* cada herramienta relee archivos (irrelevante a este volumen; con SAP real sería una consulta y convendría cachear dentro del turno).
2. **La confirmación humana se hace cumplir en código por turno, no solo en el prompt.** *Alternativa descartada:* confiar en que el prompt prohíba confirmar sin permiso; o un token firmado de confirmación. *Por qué:* un prompt no es una garantía y el token añade infraestructura que el reto no necesita. *Costo:* la confirmación debe llegar en el mensaje inmediatamente siguiente; si el usuario se desvía, el agente vuelve a preguntar.
3. **Parseo de la cotización con expresiones regulares.** *Alternativa descartada:* extraer los campos con el modelo. *Por qué:* los valores que van a SAP deben ser deterministas y reproducibles en `demo.ts` sin modelo. *Riesgo:* los PDF reales de proveedores varían mucho; en producción se necesitaría extracción con modelo **más** validación contra la herramienta (ver §12).
4. **El payload transmite el precio de la solicitud (IVA incluido).** *Alternativa descartada:* convertir a precio neto con la base gravable de la cotización. *Por qué:* mantiene cada valor trazable a `solicitud` y evita inventar una conversión sin confirmar la convención de SAP. *Costo:* hay que corregirlo en el adaptador real (§6).
5. **Sesiones y SAP simulado en memoria y archivos.** *Alternativa descartada:* base de datos. *Por qué:* el PRD lo declara no-objetivo. *Costo:* se pierden al reiniciar el contenedor.
6. **`control.csv` registra cada intento de `oc_crear` y también las validaciones.** *Por qué:* auditoría quiere ver los intentos que fallaron, y los casos bloqueados nunca llegan a crear; HU-5 pide una fila por intento. Cada llamada a `oc_crear` agrega su fila aunque repita la anterior; solo `oc_validar`, que es una consulta sin efectos, omite la fila si es idéntica a la última de esa solicitud, para no inflar el log por validar dos veces. *Costo:* un caso bloqueado procesado por el agente deja dos filas (la validación y el intento de creación).
7. **Dos adaptadores LLM reales y un mock.** *Por qué:* la prueba pide poder cambiar de proveedor sin tocar el ciclo; el mock permite probar el ciclo, la guardia de confirmación y el front sin gastar tokens.
8. **Salidas aisladas por sesión en vez de un SAP simulado compartido.** *Alternativa descartada:* un único `out/` para todos, con un endpoint de reinicio. *Por qué:* con un link público y varios evaluadores simultáneos, un estado compartido haría que el segundo vea `sol-001` ya creada y no pueda reproducir los casos del PRD; un reinicio global borraría el trabajo de otro visitante. *Costo:* una carpeta por sesión (se limpia al expulsar la sesión más antigua y al arrancar).
9. **La confirmación se valida por contenido con reglas, no con el modelo.** *Alternativa descartada:* pedirle a otra llamada al modelo que clasifique la respuesta. *Por qué:* esa decisión protege una escritura en SAP; debe ser determinista, probable sin clave y no depender de otro modelo. *Costo:* reglas en español que rechazan de más (se vuelve a pedir la confirmación) y no entienden formulaciones inusuales.

## 9. Supuestos

- Un paquete tiene una sola posición (`numero: 10`); el esquema admite varias, pero los fixtures y el Excel de solicitud describen un ítem.
- RC9 y RC8 comparan solo fechas (sin hora ni zona): una aprobación del mismo día de la solicitud es válida.
- RC5 usa una tolerancia estricta de 2 %: exactamente 2 % pasa, más de 2 % pide confirmación.
- "Aprobado" se busca como palabra completa, ignorando mayúsculas; "no aprobado" y "no está aprobado" no cuentan.
- La unidad de medida se infiere del ítem de la cotización: empieza por "hora" → `H`, "mes/mensualidad" → `MES`, otro → `UN`.
- La descripción se recorta a 40 caracteres (límite SAP citado en el PRD) y el recorte queda registrado en la trazabilidad.
- La fecha de la OC es la del servidor al crearla; `OC_NOW` la fija en pruebas.
- Solo se soportan `COP` y `USD` (los que define el esquema del payload); otra moneda es un error legible.
- El NIT se compara sin puntos ni dígito de verificación.
- Cada sesión del chat tiene su propio SAP simulado (`out/sesiones/<id>/`): la idempotencia vale dentro de una sesión, no entre sesiones. «Nueva sesión» en el front empieza de cero. Todo se pierde al reiniciar el servidor.
- Los fixtures representan la variabilidad real; en producción habrá cotizaciones y aprobaciones peores.

## 10. Cobertura

| Historia | Estado | Qué falta para producción |
|---|---|---|
| HU-1 Leer el paquete | Hecho | Leer `.xlsx`/`.pdf` y `.eml` reales (`oc_leer_excel` P1 no se implementó); los fixtures ya vienen normalizados |
| HU-2 Validar contra maestros | Hecho (RC1–RC10) | Maestros y proveedores consultados en SAP en tiempo real |
| HU-3 Construir el payload | Hecho, con trazabilidad por campo | Precio neto de IVA y los campos que SAP exige (§6) |
| HU-4 Evidencia de aprobación | Hecho: P0 (`.txt` con sha256) y P1 (`.pdf`) | Firma digital si Auditoría la exige |
| HU-5 Crear la OC (idempotente, `control.csv`) | Hecho en el SAP simulado | Adaptador real (§6) |
| HU-6 Manejo de errores | Hecho: `{ ok:false, error }` legible; JSON malformado, adjunto ausente, monto no numérico | Más casos de datos sucios reales |
| Front de chat | Hecho | Autenticación, y revisar accesibilidad con usuarios |
| Bonus `modulo/` | No hecho | — |

## 11. Uso de IA

Estado a la fecha de esta revisión (25-nov-2026). Si algo de lo que aquí se declara como pendiente cambia antes de entregar, esta sección debe actualizarse.

- **Qué usé:**
  - **Claude (Anthropic)**, como asistente principal de construcción: análisis del PRD y de los fixtures, propuesta de la arquitectura, implementación del código (herramientas, controles, ciclo del agente, servidor, front), desarrollo de las pruebas y elaboración de la documentación, incluida esta redacción.
  - **ChatGPT**, como apoyo independiente para revisar decisiones técnicas, identificar riesgos y evaluar las correcciones.
- **Qué se verificó y quién lo hizo:**
  - **Yo** ejecuté en mi equipo `bun test` (81 pruebas aprobadas, 0 fallidas), `bun run typecheck` (sin errores) y `bun run demo.ts` (los seis escenarios dieron el resultado esperado; la demo termina con código 1 si alguno no coincide).
  - **Claude** probó la interfaz en un navegador headless con el modelo guionado (`mock`).
- **Lo que no se verificó:**
  - **No se hicieron llamadas reales a Anthropic ni a otro proveedor de modelo.** El ciclo del agente solo se probó con el modelo guionado; los adaptadores Anthropic y OpenAI-compatible están escritos contra la documentación pública de cada API y deben probarse con una clave real antes de la defensa.
  - **No hay integración efectiva con SAP:** solo el SAP simulado sobre archivos; el adaptador real es el diseño de §6.
  - **No se ha construido la imagen Docker** (no tengo Docker instalado en mi equipo), por lo que el `Dockerfile` no está probado.
  - **No existe todavía un despliegue público.**
- **Alternativas de diseño descartadas** (con su razón): ver §8, decisiones 1 a 3 (el modelo como fuente de valores, la confirmación solo por prompt y la extracción de la cotización por modelo).
- **Responsabilidad:** las decisiones finales y la aceptación de las limitaciones documentadas en este documento (§8, §10 y §12) corresponden al autor del proyecto.

## 12. Riesgos para producción y mitigación

| Riesgo | Mitigación |
|---|---|
| El modelo "completa" o ajusta un valor | Los valores salen de las herramientas, que releen la fuente; un payload alterado se rechaza (§3) |
| Auto-confirmación o confirmación ambigua | Guardia en código por turno; el front ofrece un botón explícito de confirmación y resalta el estado pendiente |
| Cotizaciones y PDF reales que el parser no entiende | Extracción con modelo + validación determinista contra la herramienta; si la confianza es baja, pedir revisión humana; guardar el original |
| Maestros desactualizados | Consultar SAP en tiempo real a través de `SapAdapter`; dueño del dato por maestro |
| Conexión a SAP no viable en el corto plazo | Plan B de la fase 0 (§6): el agente igual elimina la digitación y la verificación mental |
| Gasto descontrolado de la clave del modelo | Topes por turno, por sesión y por día; límite por IP; la clave solo en el backend |
| Prompt injection desde correos o cotizaciones | El contenido de los adjuntos entra como datos de las herramientas; las acciones críticas exigen confirmación humana y pasan por controles deterministas |
| Pérdida de estado al reiniciar | Persistir sesiones y `out/` en almacenamiento externo; SAP real como fuente de verdad |
| Datos personales y de proveedores en logs | Registrar solo lo necesario, retención definida, acceso restringido a `out/` |
| Auditoría exige más que un correo como evidencia | El hash `sha256` ya liga la evidencia a la OC; añadir firma digital sobre el PDF |
