# Validation Report — WKH-232 / HU-SOL-15 (COMPACT)

**Veredicto**: APROBADO PARA DONE
**Fecha**: 2026-07-22
**Branch/commit**: `feat/wkh-232-devnet-beneficiary-escape-hatch` @ `b22a2cf`

## Runtime checks (ejecutados por QA)
- `npm test` → **9 test files / 160 tests PASS** (esperado 160, confirmado exacto).
- `npx tsc --noEmit` → **0 errores** ("TypeScript compilation completed").
- No hay DB/env-deploy/migration involucrados (HU es código puro, sin schema ni infra) → N/A.

## ACs (work-item.md L57-79)
| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 (doble-gate → devnet-stub, sin fetch) | PASS | `src/providers/payout.ts:57-72` (`resolveDevnetStubAddress`); test `src/providers/payout.test.ts:267-273` "T-1 (AC-1)" |
| AC-2 (el real SIEMPRE precede, stub ignorado) | PASS | `src/providers/payout.ts:275-286` (`getPayoutProvider`, precedencia estructural — DT-1); test `payout.test.ts:284-292` "T-3 (AC-2/CD-1)" |
| AC-3 (sin env → byte-idéntico al mock actual) | PASS | `payout.ts:58-59` (`if (!raw) return null`); test `payout.test.ts:294-299` "T-4 (AC-3/CD-4)" |
| AC-4 (fail-closed: malformada O red≠solana) | PASS | `payout.ts:60-69`; tests `payout.test.ts:301-307` "T-5 (AC-4a)" (malformada) y `:309-315` "T-6 (AC-4b)" (red≠solana) |
| AC-5 (nunca en prod salvo `PAYOUT_ALLOW_MOCK`/gate heredado) | PASS | gate en `src/agents/cashout-payout.ts:66-93` (`assertPayoutProviderSafe`, se ejecuta ANTES de instanciar el provider — código sin diff en esta HU, confirmado `git diff main...HEAD` vacío en ese archivo); test `payout.test.ts:317-334` "T-7 (AC-5/CD-6)" — prod sin `PAYOUT_ALLOW_MOCK` con stub-env seteada → `rejects.toThrow(/payout_refused/)` |
| AC-6 (`provenance:"devnet-stub"` distinguible) | PASS | `payout.ts:221,233` (`provenance: stub ? "devnet-stub" : "local-fallback"`); test `payout.test.ts:275-282` "T-2 (AC-6/CD-3)" — asserts explícitos `!== "transfi"` y `!== "local-fallback"` |

## Verificaciones críticas de seguridad
- **Nunca dispara en prod**: 3 capas confirmadas por lectura de código + test T-7: (1) precedencia estructural de `getPayoutProvider()` (`payout.ts:275-286`, el stub vive dentro de `FallbackPayoutProvider`, que ni se instancia si hay creds reales); (2) `assertPayoutProviderSafe()`/`PAYOUT_ALLOW_MOCK` (`cashout-payout.ts:66-93`, se ejecuta antes de tocar el provider); (3) doble-gate + base58 propio del hatch (`payout.ts:57-72`). `depositAddress` no mueve dinero — es solo un campo de retorno pasado opaco en `cashout-payout.ts:260` (`depositAddress: result.depositAddress`), sin ningún `fetch`/side-effect asociado.
- **Precedencia del real**: test T-3 (`payout.test.ts:284-292`) — con las 3 creds + `TRANSFI_ADAPTER_READY=true` seteadas junto con el stub-env activo, `getPayoutProvider()` devuelve `TransFiPayoutProvider` (el `FallbackPayoutProvider` con el stub ni se instancia).
- **base58 fail-closed**: regex anclada `^[...]{32,44}$` (`payout.ts:50`) rechaza `0x…` (test T-5), boundaries 31/45 chars (test T-8, `payout.test.ts:336-346`) y chars ambiguos `0/O/I/l` (test T-9, `:348-354`); nunca lanza excepción — retorna `null` (DT-2 fail-closed, no fail-open).
- **provenance honesto**: nunca `"transfi"` cuando no hubo off-ramp real — confirmado por assertion explícita en T-2.
- **Byte-idéntico sin la env**: T-4 confirma `depositAddress: null` + `provenance: "local-fallback"` idéntico al comportamiento pre-existente; los tests originales del mock (anteriores a esta HU, en el mismo archivo) no fueron modificados — `git diff` solo agrega líneas nuevas (+99/-0 en `payout.test.ts`, sin `-` en ninguna assertion existente, confirmado por `git diff --stat`).

## Drift
- `git diff main...HEAD --name-only`: `README.md`, `doc/sdd/006-devnet-beneficiary-escape-hatch/{sdd.md,story-HU-SOL-15.md,work-item.md}`, `doc/sdd/_INDEX.md`, `project-context.md`, `src/providers/payout.test.ts`, `src/providers/payout.ts`. Exactamente el Scope IN declarado (work-item.md L82-90). `src/agents/cashout-payout.ts`, `route.ts`, `types.ts`, `TransFiPayoutProvider`, `getPayoutProvider()` — sin diff, confirmado.
- Wave/spec drift: none.

## Gates (confirmado por orquestador — F3/AR/CR ya verdes; QA re-ejecutó runtime igual, ver arriba)
- F3: 151→160 tests, tsc 0 — **re-confirmado por QA: 160 tests, tsc 0.**
- AR: APROBADO — 0 findings.
- CR: APROBADO — 0 BLQ, 1 MENOR diferido a backlog.

## MNR-1 diferido (CR)
Falta test de `status()` con la env activa (path secundario, no usado en el smoke M5 que consume `execute()`). No es un AC fallido — los 6 ACs del work-item se validan sobre `execute()`/comportamiento general del helper `resolveDevnetStubAddress()`, ambos cubiertos. Queda diferido a backlog por decisión del orquestador con el respaldo del AR de que `depositAddress` no mueve dinero en ningún path.

**Listo para DONE.**
