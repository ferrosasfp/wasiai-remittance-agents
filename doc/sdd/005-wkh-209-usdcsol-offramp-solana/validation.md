# Validation Report — WKH-209 / HU-SOL-3 (off-ramp USDCSOL Solana) (COMPACT)

**Veredicto**: APROBADO PARA DONE
**Fecha**: 2026-07-21
**Branch/HEAD**: `feat/wkh-209-usdcsol-offramp-config` @ `48f836e`

## Runtime checks
- `npm run test` → `Test Files 9 passed (9)` / `Tests 151 passed (151)`, exit 0.
- `npx vitest run src/providers/payout.test.ts -t "solana"` → `PASS (2) FAIL (0)` (los 2 tests nuevos AC-1/AC-2, aislados por filtro).
- `npx vitest run src/providers/payout.test.ts -t "polygon|base (default)|avalanche"` → `PASS (3) FAIL (0)` (regresión + fail-loud, sin tocar).
- `npm run typecheck` (`tsc --noEmit`, gate completo incl. `.test.ts`) → exit 0, limpio.
- No DB / no env-var deployment nuevo (config-only, ya soportada por `payout.ts:29`) → N/A runtime DB/env-parity.

## ACs
| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 (currency USDCSOL) | PASS | `src/providers/payout.test.ts:172` `it("AC-6 feliz: solana → source.currency USDCSOL")` — filtro `-t solana` PASS (2/2) |
| AC-2 (depositAddress base58 pass-through) | PASS | `src/providers/payout.test.ts:182` `it("AC-2: solana → depositAddress base58 pass-through intacto")` — fixture `7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU` propagado byte-idéntico |
| AC-3 (cero regresión otras redes) | PASS | `git diff main...HEAD -- src/providers/payout.test.ts` = 20 insertions/0 deletions (solo additions); `payout.test.ts:152` (polygon) y `:162` (base) siguen PASS en filtro dirigido |
| AC-4 (doc `solana → USDCSOL`) | PASS | `project-context.md:158` + `README.md:50` documentan `TRANSFI_USDC_NETWORK` con `solana → USDCSOL`; consistente con `src/providers/payout.ts:29` (`solana: "USDCSOL"`) |
| AC-5 (fail-loud red no soportada intacto) | PASS | `payout.test.ts:143` (avalanche, `transfi_unsupported_network_avalanche`, sin `fetch`) verde en filtro dirigido, sin edición |

## Drift
- Scope: `git diff --name-only main...HEAD` = `README.md`, `project-context.md`, `src/providers/payout.test.ts` + artefactos SDD (`sdd.md`, `story-HU-SOL-3.md`, `work-item.md`, `_INDEX.md`). Todo dentro de Scope IN del Story File. `src/providers/payout.ts` sin cambios (`git diff --stat -- src/providers/payout.ts` vacío) — CD-1/CD-4 respetados.
- Wave order: N/A (mini, sin waves formales en commits separados — un solo commit atómico, consistente con Story File W0+W1).
- Tests existentes: `payout.test.ts` diff = pure additions (0 deletions) — CD-2 cumplido.

## Gates
- test/typecheck: PASS (ejecutados directamente por QA, ver Runtime checks arriba — no hay cr-report.md/ar-report.md como archivo separado en este repo para HUs mini; la aprobación AR+CR consta en el mensaje del commit `48f836e`: "AR + CR APROBADOS, 0 hallazgos").
- lint/build: no cubiertos explícitamente por el Story File de esta HU (mini, config+tests+docs); no hay script `lint` bloqueante distinto documentado — sin hallazgos relevantes al ser cambio de tests+docs puros.

## Nota de proceso (no bloqueante)
- `doc/sdd/_INDEX.md:9` (fila 005) todavía dice "in progress (F1)" — desactualizado, corresponde a `nexus-docs` actualizarlo a DONE en el cierre del pipeline.

**Listo para DONE.**
