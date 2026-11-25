# Conocimiento del proceso · Órdenes de compra (OC)

Este documento es el **conocimiento** del agente: qué se controla y por qué. El **comportamiento** vive en
`agent/prompt.md` y la **ejecución** en `src/tools/`. Un cambio de reglas de negocio se refleja aquí y en
`src/tools/controles.ts`, sin tocar el servidor.

## Flujo del proceso

1. El solicitante envía por correo: solicitud (Excel), cotización del proveedor y el correo de aprobación de su líder.
2. La analista administrativa digitaba todo en SAP. El agente lee el paquete, lo valida contra los maestros y construye la OC.
3. Las excepciones no se resuelven a la fuerza: se clasifican y se devuelven a la analista con una recomendación.
4. La OC se crea en SAP (simulado) y queda un registro en el log de control para Contabilidad y Auditoría.

## Bloqueos (impiden crear la OC)

- **RC1 · Proveedor**: debe existir en el maestro (por NIT; si la solicitud no trae NIT, por nombre normalizado) y estar activo.
- **RC2 · Aprobación**: debe existir, contener la palabra "Aprobado" y venir de un correo listado como aprobador del centro de costo.
- **RC3 · Tope**: el valor total no puede superar el tope del aprobador en ese centro de costo.
- **RC4 · Subárea**: debe pertenecer al centro de costo de la solicitud.
- **RC10 · Aritmética**: cantidad × valor unitario debe igualar el valor total (tolerancia de 1 unidad monetaria).

## Confirmaciones (se crea solo si el usuario confirma)

- **RC5 · Cotización vs solicitud**: si difieren más de 2 %, o no hay cotización, se pide confirmación mostrando ambos valores.
- **RC6 · Indicador de IVA ausente**: se propone el predeterminado del proveedor y se pide confirmar.
- **RC8 · Retroactiva**: existe una factura con fecha anterior a la solicitud. Se crea solo con confirmación y se marca `retroactiva = true`.
- **RC9 · Fecha de aprobación**: anterior a la fecha de la solicitud.

## Derivados (solo se informan)

- **RC7 · Condiciones de pago ausentes**: se toman de `condiciones_pago_default` del proveedor.
- La descripción se recorta a 40 caracteres (límite SAP de texto breve) y la unidad de medida se infiere del ítem de la cotización (Hora → H, Mes → MES, otro → UN).

## Glosario

- **OC retroactiva**: orden creada después de recibir la factura; se salta la cotización y el control previo. La dirección quiere medir su frecuencia.
- **Tope**: monto máximo que un aprobador puede autorizar en un centro de costo.
- **Indicador de IVA**: código SAP (C0 excluido, C1 19 %, C2 5 %).
- **Condición de pago**: código SAP (Z000 inmediato, Z015, Z030, Z060 días fecha factura).

## Reglas de seguridad del agente

- Todo valor que el agente afirme debe provenir de una herramienta; nunca se inventa ni se "arregla" un monto para que cuadre.
- Nada se crea con excepciones pendientes sin una confirmación explícita del usuario en el mensaje siguiente a la petición.
- Crear dos veces la misma solicitud devuelve la OC existente (idempotencia).
