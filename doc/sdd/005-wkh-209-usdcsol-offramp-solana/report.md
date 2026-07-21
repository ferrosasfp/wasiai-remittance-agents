# Report — HU-SOL-3 / WKH-209: Off-ramp TransFi USDCSOL (Solana)

**Status: DONE (2026-07-21)** · Branch `feat/wkh-209-usdcsol-offramp-config` · commit `48f836e` (impl) / cierre DOCS

## Resumen
Cobertura de tests + documentación del branch `network=solana` del payout provider de TransFi. El mapeo `solana → USDCSOL` ya existía (`payout.ts:29`, WKH-208) y la selección de red por env ya operaba (`payout.ts:83-85`), así que **`payout.ts` no se tocó**. La HU agregó 2 tests + documentó la env var. Devnet/sandbox, cero plata real.

**Entrega:** 5/5 ACs PASS · **151 tests** (149 intactos + 2 nuevos) · typecheck limpio · AR+CR APROBADO (0 hallazgos) · F4 APROBADO (drift NONE).

## Acceptance Criteria (F4, evidencia archivo:línea)

| AC | Veredicto | Evidencia |
|----|-----------|-----------|
| AC-1 · `network=solana` → `USDCSOL` | PASS | `payout.test.ts:172` |
| AC-2 · depositAddress base58 pass-through intacto | PASS | `payout.test.ts:182` (fixture `7xKX…AsU` byte-idéntico) |
| AC-3 · cero regresión (otras redes) | PASS | `git diff` = +20/-0; polygon/base verdes sin tocar |
| AC-4 · doc `solana → USDCSOL` | PASS | `project-context.md:158` + `README.md:50`, coherente con `payout.ts:29` |
| AC-5 · fail-loud red no soportada intacto | PASS | `payout.test.ts:143` (avalanche) verde sin edición |

## Cadena de gates
HU_APPROVED → SPEC_APPROVED (mini SDD) → F2.5 Story File → F3 (2 tests + 2 docs, payout.ts sin cambio) → AR+CR combinado APROBADO → F4 QA APROBADO → DONE.

## Archivos modificados (Scope IN)
`src/providers/payout.test.ts` (+2 tests), `project-context.md:158`, `README.md:50`. `payout.ts` intacto (CD-1/CD-4).

## Follow-up (no bloqueante)
**WKH-209a**: smoke test contra el sandbox TransFi Solana real (requiere creds founder-only: `TRANSFI_USER_ID`, `TRANSFI_SOURCE_WALLET_ADDRESS` Solana, deposit address real). No bloquea; el scope de esta HU es config+tests mockeados. Mismo estado que el AC-4 smoke de WKH-208.

## Pendiente (orquestador)
Merge de la branch a `main` — diferido a la decisión de integración de cierre de Sprint 1.
