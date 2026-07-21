# SDD — [WKH-209] HU-SOL-3 · remit-agents: off-ramp TransFi USDCSOL (Solana)

- **SDD_MODE**: mini (config + tests + docs; el branch `network=solana` del provider YA está completo).
- **Input**: `work-item.md` (aprobado, HU_APPROVED). 5 ACs EARS, DT-1..3, CD-1..4.
- **Baseline (verificado 2026-07-21)**: `npm run test` → **9 files / 149 tests passed**; `npm run typecheck` (`tsc --noEmit`) → **limpio**. Verde antes de tocar nada.
- **Veredicto de grounding**: `src/providers/payout.ts` **NO necesita cambio** — el mapeo `solana → "USDCSOL"` ya existe (L29) y la selección de red por env ya opera (L83-85). Ningún gap detectado. Trabajo = 2 tests nuevos + 2 ediciones de doc.

---

## 1. Context Map (archivos leídos + patrón extraído)

| Archivo | Líneas foco | Qué confirmé / extraje |
|---|---|---|
| `src/providers/payout.ts` | L23-35 (dict), L41-45 (`resolveSourceCurrency`), L83-85 (`execute` resuelve red por env), L68-74 (`readString`), L139-149 (`depositAddress` pass-through) | `TRANSFI_USDC_CURRENCY` ya tiene `solana: "USDCSOL"` (L29). `execute()` resuelve `process.env.TRANSFI_USDC_NETWORK ?? "base"` **antes** del `fetch`. `depositAddress = readString(d, ["depositAddress","walletAddress"])` — narrowing por `typeof`, **sin** validación de formato (no discrimina `0x…` vs base58). **Cero código nuevo requerido.** |
| `src/providers/payout.test.ts` | L28-32 (`stubFetch`), L80-84 (`afterEach` unstub), L127-135 (AC-3 pass-through `0xdeposit`), L143-150 (AC-6 red no soportada, sin `fetch`), L152-170 (patrón `polygon`/`base` con `vi.stubEnv`) | **Patrón exacto a replicar**: `stubFetch(fixture)` → `vi.stubEnv("TRANSFI_USDC_NETWORK", "<red>")` → `execute` → `JSON.parse(fetchMock.mock.calls[0]![1]?.body)`. Nota `mock.calls[0]!` (non-null, ver CD-5). Los tests de otras redes y el fail-loud ya viven acá sin tocar. |
| `README.md` | §Env vars (L46-51) — genérica y de otra etapa; **la tabla real de payout vive en `project-context.md`** | El README NO tiene hoy una tabla de env vars de payout; §Env vars (L46-51) es un stub de "Fase A". Se agrega una mención de `TRANSFI_USDC_NETWORK=solana` en la sección de deploy/env de payout (AC-4). |
| `project-context.md` | Tabla env vars TransFi payout (L152-166), fila `TRANSFI_USDC_NETWORK` (L158) | Fila existente: *"red del USDC del `source`; default `base` → `USDCBASE`. Fail-loud si fuera del allowlist."* Se agrega `solana → USDCSOL` como valor soportado explícito. |
| `package.json` | scripts L11-13 | `typecheck` = `tsc --noEmit`, `test` = `vitest run`, `test:watch` = `vitest`. |
| `doc/sdd/00{2,3,4}/auto-blindaje.md` | — | Patrones recurrentes → CD-5 y CD-6 (ver §3). |

---

## 2. Decisiones técnicas (heredadas del work-item)

- **DT-1**: Tests nuevos siguen el patrón ya establecido en `payout.test.ts` (`stubFetch` + `vi.stubEnv("TRANSFI_USDC_NETWORK", "solana")` + `afterEach(vi.unstubAllGlobals/unstubAllEnvs)`, L80-84). **Sin** helper ni archivo de test nuevo.
- **DT-2**: `depositAddress` es **pass-through opaco** (`readString`, sin narrowing de formato). El test de AC-2 valida que un fixture base58 llega **intacto** al `PayoutResult`, **NO** que el código reconozca/valide el formato Solana (no existe hoy, no lo pide la HU).
- **DT-3**: Sin `.env.example`/`vercel.json` en el repo (confirmado F0). La doc de `TRANSFI_USDC_NETWORK=solana` vive en `README.md` + `project-context.md`, consistente con WKH-208/WKH-203.

---

## 3. Constraint Directives

**Heredados del work-item (vigentes, verbatim):**
- **CD-1**: PROHIBIDO modificar `resolveSourceCurrency()` / el diccionario `TRANSFI_USDC_CURRENCY` — ya soporta `solana → "USDCSOL"` (payout.ts:29). Cero cambio de firma ni de comportamiento del mapeo.
- **CD-2**: OBLIGATORIO que los tests existentes de las demás redes (`base`, `polygon`, `avalanche` fail-loud, etc.) sigan pasando **sin modificación** — cero regresión (AC-3). Al cierre: `149 + N nuevos` verdes, con los 149 previos **byte-idénticos**.
- **CD-3**: PROHIBIDO ejecutar/apuntar a un sandbox TransFi real (Solana u otra red). Todo test usa `stubFetch`/fixtures mockeados. Cero red real, cero plata real.
- **CD-4**: PROHIBIDO tocar `getPayoutProvider()` ni fail-safes money-path (`TRANSFI_ADAPTER_READY`, `assertPayoutProviderSafe`, `PAYOUT_ALLOW_MOCK`).

**Agregados por el SDD (Auto-Blindaje histórico — previenen errores recurrentes):**
- **CD-5** *(anti-recurrente, ref: WKH-208 auto-blindaje#2 + WKH-196)*: PROHIBIDO destructurar `fetchMock.mock.calls[0]` sin aserción non-null. Bajo `noUncheckedIndexedAccess` el índice es `T | undefined` → los **tests pasan pero `tsc` falla**. Usar `fetchMock.mock.calls[0]![1]?.body` (patrón ya vigente en L114/L156/L166). El gate de cierre es `npm run typecheck` **completo** (incluye `*.test.ts`), NO alcanza `npm run test`.
- **CD-6** *(anti-recurrente, ref: WKH-212 auto-blindaje "STORY-GAP")*: antes de dar la wave por cerrada, `grep` por aserciones de contrato de wire (`Object.keys(...).toEqual([...])` / snapshots) en `src/**/route.test.ts`. Esta HU **NO** cambia el schema de salida (solo el **valor** de `depositAddress`, ya expuesto por WKH-212) → **no se espera romper** ningún `Object.keys`. Si aparece un rojo de contrato, es señal de scope mal medido → escalar, no editar a ciegas.

---

## 4. Waves de implementación (mini — 2 waves, serial)

### W0 — Cobertura de test del branch `solana` (AC-1, AC-2; verificar AC-3, AC-5)
Archivo único: **`src/providers/payout.test.ts`** (solo se **agregan** `it(...)`, cero edición de tests existentes → CD-2).

1. **T-1 (AC-1)** — `it("AC-6 feliz: solana → source.currency USDCSOL", …)` copiando el patrón `polygon` (L152-160): `stubFetch({ orderId:"ord-1", walletAddress:"0xdep" })` → `vi.stubEnv("TRANSFI_USDC_NETWORK","solana")` → `execute(input)` → `JSON.parse(fetchMock.mock.calls[0]![1]?.body)` → `expect(body.source.currency).toBe("USDCSOL")`.
2. **T-2 (AC-2)** — `it("AC-2: solana → depositAddress base58 pass-through intacto", …)`: `stubFetch({ orderId:"ord-1", depositAddress:"7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" })` → `vi.stubEnv("TRANSFI_USDC_NETWORK","solana")` → `const r = await execute(input)` → `expect(r.depositAddress).toBe("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU")`. Valida pass-through **byte-idéntico** (sin `0x`, sin transformar ni truncar). NO valida formato (DT-2).
3. **AC-3 / AC-5 (verificación, cero edición)**: correr la suite completa y confirmar que los tests de `polygon`/`base` (L152-170) y el fail-loud `avalanche` (L143-150) siguen verdes **sin tocarse**.

**Gate W0**: `npm run test` verde (`149 + 2`) **y** `npm run typecheck` limpio (CD-5).

### W1 — Documentación de `TRANSFI_USDC_NETWORK=solana` (AC-4)
1. **`project-context.md`** — fila `TRANSFI_USDC_NETWORK` (L158): agregar `solana → USDCSOL` a los valores soportados citados (ej. *"…default `base` → `USDCBASE`; `solana` → `USDCSOL`. Fail-loud si fuera del allowlist."*).
2. **`README.md`** — en la sección de env/deploy de payout, mencionar `TRANSFI_USDC_NETWORK=solana` (→ `USDCSOL`) como valor válido junto a los existentes. (El README no tiene tabla de payout; basta una línea clara consistente con project-context.)

**Gate W1**: sin gate de tooling (docs). Verificar coherencia texto vs `TRANSFI_USDC_CURRENCY` (payout.ts:29).

---

## 5. Exemplars verificados (paths confirmados)

| Uso | Exemplar (path:línea real) |
|---|---|
| Test happy-path por red (`vi.stubEnv` + assert `source.currency`) | `src/providers/payout.test.ts:152-160` (polygon), `:162-170` (base) |
| Test pass-through de `depositAddress` | `src/providers/payout.test.ts:127-135` (AC-3, `0xdeposit`) |
| Test fail-loud red no soportada (sin `fetch`) | `src/providers/payout.test.ts:143-150` (avalanche) |
| `stubFetch` + inspección de `mock.calls[0]!` | `src/providers/payout.test.ts:28-32`, `:114`, `:156` |
| Fila env var a extender | `project-context.md:158` |

---

## 6. Plan de tests (≥1 por AC)

| AC | Test | Archivo | Qué prueba |
|---|---|---|---|
| AC-1 | T-1 (nuevo) | `payout.test.ts` | `TRANSFI_USDC_NETWORK=solana` → `body.source.currency === "USDCSOL"`. |
| AC-2 | T-2 (nuevo) | `payout.test.ts` | Fixture base58 (`7xKX…AsU`) → `PayoutResult.depositAddress` idéntico, sin transformar/truncar (DT-2, pass-through). |
| AC-3 | existentes (sin cambio) | `payout.test.ts:152-170` | `polygon`→`USDCPOLYGON`, `base`→`USDCBASE` siguen verdes byte-idénticos → cero regresión (CD-2). |
| AC-4 | N/A (docs) | `project-context.md`, `README.md` | Verificación manual: `solana → USDCSOL` documentado en ambos. |
| AC-5 | existente (sin cambio) | `payout.test.ts:143-150` | `avalanche` → `transfi_unsupported_network_avalanche` **sin** `fetch` — fail-loud no se debilita al sumar Solana. |

> Nota adversarial (Auto-Blindaje WKH-204): AC-2 es un **pass-through**, no un gate de comparación, por lo que no aplica el requisito de "negativos adversariales prefijo/substring". El único riesgo real cubierto es que el valor base58 **no** contenga `0x` y **no** coincida con los fixtures `0xdeposit`/`0xdep` existentes — el ejemplo `7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU` cumple ambas.

---

## 7. Readiness Check

- [x] Baseline verde verificado (9 files / 149 tests; `tsc --noEmit` limpio).
- [x] `payout.ts` confirmado sin necesidad de cambio (mapeo L29 + selección de red L83-85 ya operan). Ningún `[NEEDS CLARIFICATION]` de código.
- [x] Exemplars verificados con Read (paths y líneas reales de `payout.test.ts` + `project-context.md`).
- [x] CD-1..4 heredados; CD-5/CD-6 agregados desde Auto-Blindaje (typecheck completo + chequeo de wire-contract).
- [x] Plan de tests ≥1 por AC; AC-3/AC-5 cubiertos por tests existentes sin modificación.
- [x] Fixture base58 definido (`7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU`).
- [x] Waves con archivo exacto por wave; gates definidos.

**Blockers: ninguno.** El `[NEEDS CLARIFICATION]` founder-only (creds/IDs reales del sandbox TransFi para Solana: `TRANSFI_USER_ID`, `TRANSFI_SOURCE_WALLET_ADDRESS` Solana, `depositAddress` real de prueba) **NO bloquea** esta HU — el scope es config+tests con mocks (CD-3). Queda documentado como follow-up (mismo estado que el AC-4 smoke sandbox de WKH-208, pendiente). No es gate de SPEC_APPROVED.

**SDD listo para SPEC_APPROVED.**
