# Validation Report — HU WKH-204 (identity binding G4) (COMPACT)

**Veredicto**: APROBADO PARA DONE
**Fecha**: 2026-07-15
**QA**: F4, sobre working tree SIN COMMITEAR (baseline correcto = `git show HEAD:<path>`, HEAD=`37728c0`/WKH-203)

## Runtime checks
- `npm run typecheck` → limpio, 0 errores (ejecutado, no leído).
- `npm run test` → **Test Files 9 passed (9) / Tests 123 passed (123)** (ejecutado, no leído).
- Env parity: cero `.env*` en el repo (correcto by-design) · cero env vars nuevas · `TRANSFI_API_KEY`/`TRANSFI_ADAPTER_READY` NO están seteadas fuera de stubs de test (`grep` limpio de hardcodes) → payout real sigue inerte.
- `any` explícito: **8**, todos preexistentes (`kyc.ts:53,54,55,63` dentro de `verify()`, `payout.ts:33,51`, `fx.ts:32,84`) — cero `any` nuevo. `@ts-ignore`: 0.
- DB/migraciones: N/A (CD-8, repo cero-persistencia, sin cambios).
- Higiene del working tree: `git status` → exactamente los 8 archivos de Scope IN + `doc/sdd/_INDEX.md` (stub de F1, normal — lo actualiza `nexus-docs` en DONE) + carpeta `002-wkh-204-.../`. **Sin** `src/adv.test.ts`/`src/adv2.test.ts` ni ningún archivo fuera de Scope IN.

## ACs (work-item.md)
| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 (mismatch → block, no execute) | ✅ PASS | `src/agents/cashout-payout.test.ts:161` ("AC-1/C6/C11: verificación aprobada AJENA → blocked, NUNCA ejecuta") + `:176` (claim prefijo adversarial) + `:187` (positivo C7/B1 ejecuta, prueba que no bloquea de más). Impl: `src/agents/cashout-payout.ts:153` (`if (s.identityMatches !== true) return false;`) + `src/providers/kyc.ts:123-124` (comparación estricta `===`, no `startsWith`/`includes`) |
| AC-2 (fail-closed: ausente/mismatch/error) | ✅ PASS | `cashout-payout.test.ts:196` (C3 ausente, fetch nunca llamado), `:215` (C4 whitespace `"   "`), `:231` (C5 sin `vendor_data`), `:242` (C12 `status()` lanza → 502), `:259` (identityMatches truthy-no-boolean → blocked, estricto). `src/providers/kyc.test.ts:417,423` (C10 `assertValidKycStatus` throws) |
| AC-3 (no PII en 200/400/502) | ✅ PASS | `src/app/api/agents/remit-cashout-payout/invoke/route.test.ts:182` (200 blocked, DNI real `"12345678"` no aparece), `:197` (400, probe CD-11 con `senderIdentity:"DNI-12345678"`, `not.toContain("12345678")`), `:215` (502, body fijo opaco) |
| AC-4 (B1-B10/allowlist/`approved!==true` intactos + regresión) | ✅ PASS | `git diff -U0 HEAD -- src/agents/cashout-payout.ts` → B1/B2/B3/B5/B7/B9 y `assertPayoutProviderSafe()` sin tocar, única inserción es el bloque C11 (líneas nuevas, no reemplazo). `git diff -U0 HEAD -- <3 test files>` → único patrón de `-`/`+` sobre `expect(...)` son 2 call-sites de `kyc.test.ts` donde solo crece el arg (arrange), el assert `.rejects.toThrow(...)` es byte-idéntico; todo el resto de `+expect(...)` son tests nuevos, cero `expect` existente borrado. `src/agents/kyc-validator.ts` + `.test.ts`: **0 líneas de diff** (`git diff HEAD --` vacío) — byte-idénticos, 5 tests intactos |
| AC-5 (caller legado sin `senderIdentity`) | ✅ PASS | Legado con `address` (compat chaski-v2, sin `senderIdentity`): `cashout-payout.test.ts:382` (usa `address`, ejecuta, NO 400). Caller sin ningún claim: `cashout-payout.test.ts:196` (C3, blocked determinístico, `kyc_identity_claim_missing`). Precedencia: `:392`/`:404` (gana `senderIdentity`) |
| AC-6 (documentar límite, sin sobre-prometer) | ✅ PASS | `README.md:154-161` ("Alcance real de esta protección (sin eufemismos)... NO constituye prueba criptográfica de posesión... protección de **ese** flujo es **≈nula**...") + `project-context.md:208-211` (mismo texto, sin suavizar) |

## Drift
- **Sin drift de scope/wave/spec**: los 8 archivos de Scope IN son exactamente los tocados; W0 (types.ts) rompe tsc a propósito y las waves siguientes lo reparan (confirmado leyendo diffs); `verify()`/`KycInput`/`KycResult`/`kyc-validator.ts` byte-idénticos (CD-7 no se activa, confirmado).
- **R-1 (teatro para chaski-v2) documentado sin eufemismos** — confirmado (ver AC-6). No suavizado.
- **`DIDIT_ADAPTER_READY` checklist**: confirmado en `src/providers/kyc.ts:69-89` con **3 items bloqueantes**, el 3º citando explícitamente `R-5 / WKH-204`.
- **`auto-blindaje.md` — honestidad del registro confirmada**: la entrada "Fix-pack #2 — ⚠️ CORRECCIÓN..." (líneas 131-164) registra explícitamente que la justificación original era falsa, que el re-AR la refutó **ejecutando** (122/122 pasaban sin el cambio), y la marca **textualmente** como "SEGUNDA VEZ del mismo error" citando la lección no aplicada de WKH-203. No está suavizado.
- **Hallazgo menor (no bloqueante, informativo)**: mi brief de tarea pedía confirmar que el §9 residual nombra "G5/WKH-206 (prueba de posesión, registrada)". No encontré ningún ticket `WKH-206` en este repo ni en ningún otro repo del workspace (`grep`/`find` recursivo, negativo). Lo que sí existe (`sdd.md` §6, `story-WKH-204.md` §2.6/§9 R-1) es la recomendación de una "HU de seguimiento… ya registrada aparte", **sin número de ticket asignado en ningún artefacto verificable**. No es una violación de AC-6/CD-6 (el texto no sobre-promete), pero no puedo confirmar la existencia de "WKH-206" como tal — lo marco NO VERIFICABLE en vez de darlo por bueno.

## Gates
- `npm run typecheck` + `npm run test`: **corridos por mí** (no solo leídos de CR) — limpio / 123-123. `npm run build` NO usado como sustituto (precedente WKH-196 respetado).

## AR/CR follow-up
- AR (0 BLQ, 2 MNR, 27 mutantes) + CR (0 BLQ, 4 MNR) + fix-pack (4 items, ver `auto-blindaje.md`) + re-AR (0 BLQ, 2 MNR, 21 mutantes) + fix-pack #2 (2 canarios, cero lógica) — todo consistente con lo verificado en disco; sin BLQ pendiente.

**Listo para DONE.**
