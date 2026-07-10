# Value-delivery layer — diseño de producción (WKH-168)

La pieza que **mueve el principal real** de la remesa: `sender USDC → TransFi → PEN a la Yape del beneficiario`.
Es lo único 100% ausente hoy (en el demo solo se mueven los fees; el "$400" es display).

> **Estado:** diseño. El skeleton se construye con las llamadas de partner/on-chain **STUBBED**;
> el money-code real se activa con el sandbox de TransFi (Fase A). **No se escribe money-code a ciegas.**

## Restricción #1 — AISLAMIENTO del gateway compartido (parallel-safety)
El gateway `wasiai-a2a` (orquestación + settlement) sirve al **demo live** (jurados Team1). La v2 **NO puede
modificar `orchestrate.ts` ni el settlement compartido** de forma que cambie el comportamiento del demo.

**Diseño aislado:** el value-delivery de v2 vive **fuera** del path del demo:
- Opción elegida: un **servicio/endpoint propio** de v2 (`wasiai-remittance-agents`) que orquesta la remesa real,
  llamando al gateway **solo** para lo que ya existe y es idempotente (discovery/quote de agentes `remit-*`),
  y ejecutando el movimiento del principal + payout **en su propia capa** (nueva tabla, nueva lógica).
- El settlement de FEES de los agentes `remit-*` sí puede reusar el x402 del gateway (es el mismo mecanismo probado,
  y son fees chicos), PERO el **movimiento del PRINCIPAL** (el monto de la remesa) es un path NUEVO de v2, no el
  settlement del demo. Nunca se re-cablea `orchestrate.ts`.

## Máquina de estados (una remesa = un `remittance_intent`)
Persistida en una tabla **NUEVA** `remittance_intents` (aislada; NO toca tablas del demo). Estados:

```
CREATED
  → KYC_PENDING → KYC_FAILED (terminal)            # hard-gate: remit-kyc-validator.payoutAllowed
                → KYC_PASSED
  → QUOTED (quoteId + rate + expiresAt)            # remit-corridor-fx (tasa fijada)
  → PRINCIPAL_LOCKED                                # el USDC del sender comprometido (autorización/escrow)
  → PRINCIPAL_IN (txHash)                           # el principal on-chain → depósito del partner (NO self-transfer)
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

## El movimiento del principal (on-chain) — lo que cambia vs el demo
- Demo: settle de fees, y el único "movimiento" real es un self-transfer operador→operador capeado (0.5 PYUSD).
- v2: el **principal real** del sender (ej. 400 USDC) se transfiere on-chain al **depósito real del partner**
  (TransFi) — dirección que da TransFi, en la chain que TransFi acepta (a confirmar en sandbox: Base? Avalanche?).
  El sender firma la autorización (EIP-3009/allowance) sobre SU principal; el operador NO fondea la remesa.
- **REFUND:** si el payout de TransFi falla tras `PRINCIPAL_IN`, se devuelve el principal al sender. Como el
  clawback del fee-split NO está wired (`fee-split.ts:567-579`), el refund es lógica NUEVA de v2 (una transferencia
  de retorno desde el depósito, o un flujo de refund del partner). Debe ser idempotente + auditado.

## Reconciliación
Invariante: `principal_in_usdc` (lo que entró) `== delivered_pen / rate + fee_declarado` (lo que salió), dentro de
tolerancia. Cualquier intent en `PAYOUT_SUBMITTED` sin confirmar tras N min → job de reconciliación consulta
`payoutProvider.status(payoutId)` (o webhook de TransFi) → settled/failed. Nada queda colgado.

## Datos (tabla nueva, aislada)
`remittance_intents`: `id, idempotency_key, sender_ref, status, kyc_verification_id, quote_id, rate,
principal_usdc, principal_in_tx, payout_id, delivered_pen, payout_tx, refund_tx, failure_reason,
created_at, updated_at`. NO se toca ninguna tabla del demo. RLS/ownership por `sender_ref` (patrón WKH-53).

## Qué se stubbea hasta el sandbox
- `PayoutProvider.execute/status` (TransFi) — hoy fallback mock (no mueve plata).
- El mecanismo exacto de `PRINCIPAL_IN` (depende de la chain + el flujo de depósito de TransFi).
- El flujo de REFUND del partner (depende de si TransFi soporta refund o hay que devolver on-chain).
La máquina de estados, la persistencia, la idempotencia, el orden de gates y la reconciliación **sí** se construyen
ahora (partner-agnósticos, producción); solo las hojas (llamadas TransFi + on-chain) quedan stubbeadas.

## Pipeline
Cuando el sandbox llegue: NexusAgil AUTO **QUALITY** (mueve plata real) — F0→F1→HU→F2(SDD)→F3→AR+CR→F4→DONE.
El AR es crítico acá: débito==entrega, no doble-payout, refund-on-fail, aislamiento del demo, quote-lock.
