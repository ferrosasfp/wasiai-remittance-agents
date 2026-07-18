# Report — [WKH-212] Exponer `depositAddress` en la salida HTTP del agente remit-cashout-payout

**Status**: DONE (2026-07-17) · **NNN**: 004 · **Branch**: `feat/004-wkh-212-expose-deposit-address-http` · **Metodología**: QUALITY mini (S) · Pipeline FAST+AR

## Resumen ejecutivo

Bug de integración descubierto en el F0 de WKH-211: WKH-208 agregó `depositAddress` al tipo interno `PayoutResult`, pero el output HTTP del agente (`CashoutPayoutOutput`) lo descartaba silenciosamente → chaski-v2 no podía leer la dirección de depósito que TransFi asigna por orden. Esta HU lo propaga de forma **aditiva** hasta el contrato HTTP. **Desbloquea WKH-211** (el reorder no-custodial, en chaski-v2).

## Qué cambió (4 edits, 1 archivo de lógica)

`src/agents/cashout-payout.ts`:
- E1 (`:59`) — `depositAddress: string | null` agregado a `CashoutPayoutOutput` (9º campo).
- E2 (`:218`) / E3 (`:236`) — ramas `blocked` (kyc_identity_claim_missing / kyc_gate_not_passed) → `depositAddress: null` explícito.
- E4 (`:260`) — rama `executed` → `depositAddress: result.depositAddress`.
- `route.ts` NO tocado (serializa `{result}` verbatim; el campo viaja solo).
- Mock (`FallbackPayoutProvider`) ya devuelve `null` → output refleja `null` sin romper.

## Pipeline

| Fase | Resultado |
|------|-----------|
| F0+F1 | HU_APPROVED (3 ACs, mini/S, aditivo). |
| F2+F2.5 (mini) | SDD breve + Story; los 3 puntos de retorno + 3 tests; Readiness verde. |
| F3 | 149 tests (145→149), mutante E4→null muerto+restaurado, grep MUTANT=0, byte-identidad de los 8 campos previos. |
| AR | APROBADO 0 BLQ/0 MENOR — aditivo, sin PII (depositAddress = wallet on-chain pública), shape consistente en las 3 ramas, mutación verificada. |
| F4 | Gate re-verificado (typecheck 0 + 149/149) — consolidado en el cierre por ser mini con AR limpio. |

## ACs — 3/3 PASS
AC-1 executed→valor real (spyOn provider, mutante mata) · AC-2 mock default→null + campos existentes byte-idénticos · AC-3 las 2 ramas blocked→null.

## Nota / STORY-GAP resuelto
El test de wire-contract `src/app/api/agents/remit-cashout-payout/invoke/route.test.ts:102` asertaba el key-set EXACTO (8 campos) → agregar el 9º lo rompía. El dev agregó `"depositAddress"` al set esperado (9 campos) + assert null en mock. SOLO el test, `route.ts` intacto. **Lección para futuras HUs**: incluir los tests de wire-contract (`*/route.test.ts` con `toEqual([...keys])`) en el Scope IN cuando el cambio agrega/quita un campo serializado.

## Desbloqueo
Con esto chaski-v2 (WKH-211) puede leer `depositAddress` del HTTP response del agente. Sandbox, flags OFF, cero plata real.
