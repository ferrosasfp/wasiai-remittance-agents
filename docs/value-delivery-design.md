# Value-delivery layer — diseño de producción

La pieza que **mueve el principal real** de la remesa: `sender USDC → TransFi → PEN a la Yape del beneficiario`.
Es lo único 100% ausente hoy: por ahora sólo se mueven los **fees** de los agentes (el cobro x402 por llamada);
el monto de la remesa no se mueve en ningún lado.

> **Estado:** diseño. El skeleton se construye con las llamadas de partner/on-chain **STUBBED**;
> el money-code real se activa con el sandbox de TransFi (Fase A). **No se escribe money-code a ciegas.**

## Restricción #1 — AISLAMIENTO del gateway compartido (parallel-safety)
El gateway `wasiai-a2a` (discovery, orquestación y settlement x402 de los fees) sirve tráfico en vivo de otros
consumidores. Esta capa **NO puede modificar su orquestación ni su settlement compartido** de forma que cambie
el comportamiento de lo que ya corre ahí.

**Diseño aislado:** el value-delivery vive **fuera** de ese path:
- Opción elegida: un **servicio/endpoint propio de este repo** que orquesta la remesa real, llamando al gateway
  **solo** para lo que ya existe y es idempotente (discovery/quote de los agentes `remit-*`), y ejecutando el
  movimiento del principal + payout **en su propia capa** (nueva tabla, nueva lógica).
- El settlement de FEES de los agentes `remit-*` sí puede reusar el x402 del gateway (es el mismo mecanismo
  probado, y son fees chicos), PERO el **movimiento del PRINCIPAL** (el monto de la remesa) es un path NUEVO,
  no el settlement compartido. Nunca se re-cablea la orquestación del gateway.

## Máquina de estados (una remesa = un `remittance_intent`)
Persistida en una tabla **NUEVA** `remittance_intents` (aislada; NO toca ninguna tabla existente del gateway).
Estados:

```
CREATED
  → KYC_PENDING → KYC_FAILED (terminal)            # hard-gate: remit-kyc-validator.payoutAllowed
                → KYC_PASSED
  → QUOTED (quoteId + rate + expiresAt)            # remit-corridor-fx (tasa fijada)
  → PRINCIPAL_LOCKED                                # el USDC del sender comprometido (autorización/escrow)
  → PRINCIPAL_IN (txSig)                            # el principal on-chain → depósito del partner (NO self-transfer)
  → PAYOUT_SUBMITTED (payoutId)                      # TransFi payout con idempotencyKey
  → PAYOUT_SETTLED (deliveredPEN, txRef)  (terminal OK)
  → PAYOUT_FAILED → REFUND_PENDING → REFUNDED (terminal)   # refund del principal al sender
```

Reglas:
- **Idempotencia:** `idempotencyKey` por intent (derivado de senderId+quoteId+nonce). Toda transición es
  idempotente; re-ejecutar una transición ya aplicada es no-op. El payout a TransFi lleva el `idempotencyKey`
  (evita doble-desembolso).
- **Quote-lock:** el `PAYOUT_SUBMITTED` debe usar el `quoteId` de `QUOTED` y validar `expiresAt` — si venció,
  se re-cotiza (nuevo QUOTED) antes de mover principal. Nunca se mueve principal con quote vencido.
- **Orden estricto:** el KYC-gate y el QUOTE ocurren ANTES de `PRINCIPAL_LOCKED`. Nunca se compromete principal
  sin KYC_PASSED + quote válido.

## El movimiento del principal (on-chain) — lo que falta construir
- Hoy: sólo settlean los **fees** de los agentes. El principal de la remesa no se mueve: el payout corre en mock
  (`provenance:"local-fallback"`, `deliveredLocal:null`) y tiene un fail-safe que lo impide en producción.
- Producción: el **principal real** del sender (ej. 400 USDC) se transfiere on-chain al **depósito real del
  partner** (TransFi), a la address dedicada que TransFi devuelve **por orden**. Este corredor cobra y opera en
  Solana, y `USDCSOL` está en el catálogo publicado de TransFi; el flujo exacto de depósito se confirma en el
  sandbox antes de escribir una línea de money-code.
- **Quién firma:** el **sender** autoriza la transferencia de SU principal; el operador **NO fondea** la remesa.
  El mecanismo exacto de autorización queda stubbeado hasta el sandbox.
- **REFUND:** si el payout de TransFi falla tras `PRINCIPAL_IN`, se devuelve el principal al sender. El gateway
  compartido no tiene cableado un clawback del fee-split, así que el refund es lógica **NUEVA** de esta capa
  (una transferencia de retorno desde el depósito, o un flujo de refund del partner). Debe ser idempotente +
  auditado.

## Reconciliación
Invariante: `principal_in_usdc` (lo que entró) `== delivered_pen / rate + fee_declarado` (lo que salió), dentro de
tolerancia. Cualquier intent en `PAYOUT_SUBMITTED` sin confirmar tras N min → job de reconciliación consulta
`payoutProvider.status(payoutId)` (o webhook de TransFi) → settled/failed. Nada queda colgado.

## Datos (tabla nueva, aislada)
`remittance_intents`: `id, idempotency_key, sender_ref, status, kyc_verification_id, quote_id, rate,
principal_usdc, principal_in_tx, payout_id, delivered_pen, payout_tx, refund_tx, failure_reason,
created_at, updated_at`. NO se toca ninguna tabla existente. Ownership por `sender_ref`: además de la política
de RLS, toda query filtra por `sender_ref` en la capa de aplicación (el cliente de servicio bypassea RLS, así
que la app es la línea de defensa real).

## Qué se stubbea hasta el sandbox
- `PayoutProvider.execute/status` (TransFi) — hoy fallback mock (no mueve plata).
- El mecanismo exacto de `PRINCIPAL_IN` (depende del flujo de depósito por orden de TransFi).
- El flujo de REFUND del partner (depende de si TransFi soporta refund o hay que devolver on-chain).
La máquina de estados, la persistencia, la idempotencia, el orden de gates y la reconciliación **sí** se construyen
ahora (partner-agnósticos, producción); solo las hojas (llamadas TransFi + on-chain) quedan stubbeadas.

## Proceso
Cuando el sandbox llegue, esta capa se construye con el proceso más estricto que usamos, porque mueve plata real:
spec escrita → implementación → **revisión adversarial** → QA con evidencia, antes de mergear. Lo que la revisión
adversarial tiene que atacar acá: débito == entrega, no doble-payout, refund-on-fail, aislamiento del gateway
compartido, quote-lock.
