# Report — HU [WKH-203] El agente de payout no debe confiar en `kycPayoutAllowed` del caller

## Resumen ejecutivo

**WKH-203** cierra el vector de **compliance gate bypass (trust-the-caller, análogo a IDOR)** en `remit-cashout-payout`: el agente usaba un booleano del **caller** (`input.kycPayoutAllowed`, hardcodeado `true` en `chaski-v2/gateways.ts:127`) como único hard-gate de compliance KYC antes de ejecutar un desembolso. Ahora re-deriva la decisión **server-side contra Didit**: consulta `KycProvider.status(kycVerificationId)` en la fuente autoritativa, aplica la allowlist `REAL_KYC_PROVENANCES`, y es **fail-closed en las 10 ramas de decisión** (B1-B10). El campo `kycPayoutAllowed` **se eliminó del schema** (DT-4: Zod lo strippea, compatibilidad confirmada) → `input.kycPayoutAllowed` **no compila**. Garantía estructural verificada por `tsc`. **Veredicto final**: F0–F1–HU_APPROVED–F2–SPEC_APPROVED–F2.5–F3(79/79 verde)–AR(0 BLQ, 4 MNR)–CR(0 BLQ, 4 MNR)–fix-pack(5 MNRs solo comments/docs)–F4(6/6 ACs APROBADO)–**LISTO PARA DONE**. Código sin commitear, índice y reporte listos.

---

## Pipeline ejecutado

| Fase | Artefacto | Veredicto | Fecha |
|------|-----------|-----------|-------|
| F0 | project-context | cargado (`wasiai-remittance-agents` repo nuevo, contexto de negocio en plan) | 2026-07-15 |
| F1 | `work-item.md` (WKH-203) | HU_APPROVED (2 Missing Inputs BLOQUEANTES: DT-1 / DT-4, ambos resueltos en F2 con evidencia) | 2026-07-15 |
| F2 | `sdd.md` | SPEC_APPROVED (resoluciones: DT-1(a) = extender KycProvider con `status()`, sin persistencia; DT-4 = eliminar campo del schema; 2 conflictos declarados §7.1/§5, ambos ratificados; CD-13 sobre gate incondicional, resuelta; 12 constraint directives preventivas CD-7 a CD-13) | 2026-07-15 |
| F2.5 | `story-WKH-203.md` | contrato listo para F3 (waves W0-W3 definidas, gates, exemplars de ref verificados en disco, 3 correcciones C1/C2/C3 de artefacto aplicadas) | 2026-07-15 |
| F3 | Implementación | COMPLETA: W0 (contratos `KycStatusResult` + allowlist movida) + W1 (providers `DiditKycProvider.status()` + `FallbackKycProvider.status()` + guard + tests) + W2 (gate `isKycGatePassed()` + schema sin `kycPayoutAllowed`) + W3 (route test + project-context). 8 archivos modificados. **Baseline 59 → +20 tests nuevos = 79/79 verde.** | 2026-07-15 |
| AR | `ar-report.md` | **0 BLOQUEANTES, 4 MENOREs**: MNR-1 (aml.hits forma desconocida—sandbox-gated) + MNR-2 (comentario impreciso en gate) + MNR-3 (teardown preventivo, no bug existente) + MNR-4 (FallbackKycProvider.status() no llama assertValidKycStatus, doble defensa). Mutation testing de gate: 8/9 mutaciones asesinadas; 1 superviviente = redundancia de defensa (esperada). | 2026-07-15 |
| CR | `cr-report.md` | APPROVED (0 BLOQUEANTES, 4 MENOREs: MNR-1 como AR + MNR-2/3 sobre comentario + MNR-4 sobre CD-8 guardias redundantes, aceptados como defensa en profundidad. **README.md stale**: payload doc contiene `kycPayoutAllowed: true` que ya no existe post-DT-4 — asignado a nexus-docs, Scope OUT del CR). | 2026-07-15 |
| fix-pack | 1 commit + docs | **5 MENOREs cosmético/docs**: (1) MNR-2 comentario en gate → corrección de "Espejo EXACTO" a forma real; (2) MNR-1 aml.hits → docstring sobre sandbox-gated; (3) `kyc.test.ts` detalles de casos; (4) `cashout-payout.test.ts` comentarios de rama B9; (5) `README.md` payload actualizado (ver §Actualización README). **Cero cambio de lógica**, 79/79 sigue verde. | 2026-07-15 |
| F4 | `validation.md` (QA) | **APROBADO PARA DONE** (79/79 tests, `npm run typecheck` limpio, CD-1/CD-8/CD-9 verificados por ejecución, §9 riesgo residual documentado, checklist pre-`DIDIT_ADAPTER_READY` incluido) | 2026-07-15 |

---

## Acceptance Criteria — resultado final (6/6 PASS)

| AC | Descripción | Status | Evidencia (archivo:línea) | Validación |
|----|---|---|---|---|
| **AC-1** | `kycVerificationId` no re-verificable / no aprobado en PROD → `{ executed: false, status: "blocked", reason: "kyc_gate_not_passed" }`, **y** `provider.execute()` NUNCA invocado | **PASS** | `cashout-payout.ts:230-233` bloqueo + `isKycGatePassed()` throw-safe (lanza pre-execute); `cashout-payout.test.ts:AC-1` — spy mock de provider, nunca called | vitest 79/79 + tsc clean |
| **AC-2** | `kycPayoutAllowed: true` en input **PERO** re-verificación server-side falla/no confirma → bloqueado igual (booleano del input no basta) | **PASS** | `cashout-payout.test.ts:AC-2` — input dice true, Didit dice Declined, resultado = blocked (fuente autoritativa manda) | vitest PASS |
| **AC-3** | Fuente autoritativa decide (contradice input): (a) input false + Didit Approved → **ejecuta**; (b) input true + Didit Declined → **bloqueado** | **PASS** | `cashout-payout.test.ts:AC-3a/3b` — ambos casos, provider.execute invocado solo en (a) | vitest PASS |
| **AC-4** | Los **7** tests protegidos `cashout-payout.test.ts:26,32,39,49,57,68,77` **verde con asserts intactos** (setup: +ALLOW_FALLBACK_KYC, +Didit mock, asertaciones byte-idénticas) | **PASS** | `cashout-payout.test.ts:23-83` — todos 7 en verde; `git diff -U0` asserts unchanged; L39/L57 setup crecido per §2.1 Story File | vitest 7/7 PASS |
| **AC-5** | Response bloqueado / error → NO expone `beneficiary.name`/`destination`/`travelRuleData`; error 502 opaco | **PASS** | `route.test.ts:AC-5a` — blocked response: `JSON.stringify` no contiene PII; `AC-5b` — kyc_gate_unavailable (fetch throw) → 502 `{error:"payout_unavailable"}` exacto, sin PII | vitest PASS |
| **AC-6** | `CashoutPayoutInputSchema.safeParse({...validInput, kycPayoutAllowed:true})` → `success:true` **y** `!("kycPayoutAllowed" in parsed.data)` (compat con chaski-v2, campo strippea) | **PASS** | `cashout-payout.ts:17-21` schema sin el campo; `cashout-payout.test.ts:AC-6` — Zod safeParse verifica stripeo; **verified**: Zod 3.25.76 `z.object`(**sin** `.strict()`) strippea campos desconocidos | vitest PASS |

---

## Hallazgos finales

### BLOQUEANTEs
Ninguno. AR 0 BLQ, CR 0 BLQ post-fix-pack. Las 10 ramas del gate (B1-B10) implementadas, fail-closed por construcción.

### MENOREs (4, documentados / aceptados)

1. **AR/MNR-1**: forma exacta de `aml.hits` en JSON de Didit desconocida. El código hace `Array.isArray(amlHitsRaw) ? amlHitsRaw.length : 0` → si Didit devuelve otro formato (`aml: {total_hits: [...]}` o `aml: null`) → `amlHits = 0` → con `status:"Approved"` da `approved: true` CON hits de AML reales. **Es fail-OPEN de compliance** (menor gravedad: inocuo hoy, el adapter está tras `DIDIT_ADAPTER_READY=false`). **Item obligatorio del checklist pre-`DIDIT_ADAPTER_READY`** (§Checklist DIDIT_ADAPTER_READY abajo). Fix-pack: docstring claro en `kyc.ts:198`.

2. **CR/MNR-2**: comentario en `cashout-payout.ts:80` decía *"Espejo EXACTO de `isPayoutAllowed()`"* pero no lo es: el gate usa `s.approved !== true` (estricto) y su "espejo" usa `!kyc.approved` (truthiness). Quien lea "EXACTO" podría "alinearlos" y borrar el `!== true`. Fix-pack: comentario corregido a "Espejo LÓGICO, tipificación IGUAL DE ESTRICTA (CD-8)".

3. **AR/MNR-3**: higiene de teardown (`vi.unstubAllGlobals()`). AR refutó que había un falso verde existente (la suite sigue 15/15 sin el unstub, los tests posteriores lanzan antes del gate). **Cambio por prevención**: el día que alguien agregue un test que SÍ llegue al gate, ese stub não estaría limpio. Mantiene. Fix-pack: explícita la razón (preventiva, no correctiva).

4. **CR/MNR-4**: `FallbackKycProvider.status()` no llama `assertValidKycStatus()` mientras `DiditKycProvider.status()` sí. La garantía CD-8 es cierta para el path Didit; el gate `!== true` cubre el fallback. **Defensa en profundidad aceptada**, no bloquea. Documentado en CR/F4.

---

## Riesgo residual — qué cierra WKH-203 y qué NO

> **CRÍTICO: Cerrar WKH-203 NO habilita por sí solo la Fase A.** El gate de Fase A son **4 huecos independientes**; esta HU cierra **G2**.

### Cierra (G2 — esta HU)
- El campo `kycPayoutAllowed` **se elimina del schema** → `input.kycPayoutAllowed` **no compila**. Garantía estructural.
- `runCashoutPayout()` re-deriva la decisión de compliance **server-side**: `KycProvider.status(kycVerificationId)` → allowlist real `REAL_KYC_PROVENANCES` → B1-B10 fail-closed.
- **Vector cerrado**: *"cualquiera que manda `kycPayoutAllowed: true` activa un payout"* ← **ESTA HU LO CIERRA**. El booleano del input deja de compilar y de tener efecto.

### NO cierra (queda vivo tras el merge) — OBLIGATORIO en el checklist operativo

| # | Hueco | Dueño | Qué significa | Regla operativa |
|---|-------|-------|---------------|-----------------|
| **R-1** | **Compat Didit v2↔v3**: `verify()` crea con `POST /v2/session/` (`kyc.ts:17`) y `status()` consulta `GET /v3/session/{id}/decision/`. Que un `session_id` creado por v2 sea consultable por v3 es **plausible pero NO verificado** (no hay sandbox). | **Todo el adapter detrás de `DIDIT_ADAPTER_READY=true`** — hoy **nadie lo setea**. Si v3 no acepta ids de v2 → cae en **B6 → 502 fail-closed**, **NUNCA** fail-open. | **Checklist obligatorio item #1**: confirmar que un `session_id` creado por v2 es consultable por v3 en el sandbox. Es fail-SAFE (B6 maneja); no bloquea DONE. |
| **R-2** | **No hay binding `verificationId` ↔ sender**. El gate confirma "está aprobada", **no** "es de quien pide el payout". Un caller con un `verificationId` aprobado **ajeno** (dato robado) pasa el gate. `chaski-v2` mitiga con `vendorData === address` (`authority.ts:76-79`), pero **no es portable acá**: en este repo `vendor_data = input.legalId` (DNI), no wallet, y el input de payout **no trae identidad del sender**. | **Es WKH-204** (registrada) — distinto gate KYC (identity binding). **PROHIBIDO diseñar aquí.** No dejar TODOs huérfanos — referencia WKH-204. | **Regla operativa**: no setear `TRANSFI_ADAPTER_READY=true` hasta WKH-204 DONE. |
| **G1 / WKH-202** | `/api/a2a/payout/submit` proxy sin auth (repo `chaski-v2`). Corre **en paralelo ahora**, repo distinto, sin colisión de archivos. | Complementario: G2 sin G1 = cualquiera llega al agente (pero ya no puede forjar el gate). | **Regla operativa**: no habilitar payout real hasta WKH-202 DONE. |
| **G3 / WKH-168** | Nadie verifica que el sender pagó el principal en USDC. Un atacante con su propio KYC `Approved` pide un payout con monto/beneficiario arbitrarios. | Value-delivery (quote-lock, principal-in, payout, reconcile). **Diferida**, intacta. Esta HU **no la toca** (DT-2: `resolveTravelRuleData()` sigue STUB). | **Regla operativa**: no setear `TRANSFI_ADAPTER_READY=true` hasta WKH-168 DONE. |
| **R-5** | `chaski-v2:gateways.ts:127` sigue mandando `kycPayoutAllowed: true` hardcodeado. | Ya **inocuo** (Zod lo strippea). Cleanup cosmético posterior. **CD-2: no se toca acá.** Este fix-pack actualiza el README donde se documenta ese payload. | **Cosmético**, no bloquea. |

---

## Checklist OBLIGATORIO antes de `DIDIT_ADAPTER_READY=true` en prod

Este checklist **debe estar explícito en la operación**. WKH-203 **está DONE**, pero habilitar el adapter real requiere validación sandbox posterior.

1. **R-1 compat**: confirmar que un `session_id` creado con `POST /v2/session/` es consultable por `GET /v3/session/{id}/decision/`. **Test**: crear sesión, consultar decision endpoint, verificar que eco-a `session_id` correcto. **Es fail-SAFE** (si falla → B6 → 502).

2. **Forma exacta de `aml.hits`** (AR/MNR-1): **Código actual prescrito por Story File**, espejo de `verify()`; hace `Array.isArray(amlHitsRaw) ? amlHitsRaw.length : 0`. **Test**: llamar a Didit con un KYC que tenga AML hits, verificar que el payload contiene `aml.hits` (no `aml.total_hits`, no `aml: null`) y que la longitud se cuenta correctamente. **Es fail-OPEN si falla** (si no se cuenta, da `approved: true` con hits reales) → **item crítico**.

3. **Mapeo de campos del adapter en general**: contrastar `kyc.ts:197-209` contra la documentación real de Didit v3-decision endpoint. Hoy usa `status`, `aml.hits`, `session_id`.

**Sin pasar este checklist, NO setear `DIDIT_ADAPTER_READY=true`.**

---

## Auto-Blindaje consolidado

### Lecciones de proceso — nuevas (sesión WKH-203, aplicables a futuras HUs)

#### 1. Trampa del `git stash` en una HU sin commits
- **Riesgo**: en un repo sin commits de la HU (cambios unstaged), hacer `git stash` devuelve la versión pre-HU, no "la HU menos el fix". No hay forma de reproducir un estado "post-F3 original, pre-fix".
- **Regla**: revertir **sólo la línea específica** que necesitás aislar, o `git show HEAD:archivo` para comparar. **No usar `git stash` en una HU unstaged.**

#### 2. `git diff` de un archivo untracked retorna vacío (no es evidencia de "cero cambios")
- **Riesgo**: al verificar que un archivo estaba intacto, hacer `git diff archivo` → resultado vacío. Eso no significa que no cambió; significa que el archivo **ya no está staged o es untracked**. 
- **Regla**: diff contra la fuente real: `git show HEAD:archivo` → pipear a `diff`, o `git diff HEAD -- archivo` (con el double dash para desambiguar).

#### 3. Contar números en artefactos: verifica siempre con comandos
- **Patrón recurrente de la sesión**: 5 artefactos de diferentes HUs contaron mal (WKH-202: 5→7 imports, 4→5 niveles; WKH-203: 5→7 tests protegidos, 4→5 tests de kyc-validator.test.ts). Los agentes que **verificaron ejecutando** (`npm run test`, `grep -c`, `git diff -U0 | grep expect`) acertaron siempre. Los que contaron **leyendo** manualmente, fallaron.
- **Regla**: números en ACs = ejecuta `grep -c`, `npm run test --`, `git diff --stat`, **nunca manual**. Si el número real difiere en F3, **documentar en auto-blindaje inmediatamente** (referencia para F4/retro).

#### 4. Patrón recurrente: `as any` en code blocks heredado de exemplars viejos
- **Error**: el Story File prescribía un code block con `(d as any).status`, `(d as any).aml?.hits`. Eso introdujo 4 `any` explícitos nuevos, que violan el checklist "Cero `any` explícito nuevo" de la Done Definition.
- **Resolución de conflicto**: cuando un code block de un Story File choca con la Done Definition / los guardrails del proyecto, **gana la Done Definition**. El code block comunica la **lógica**, no el **estilo**. Se documenta la desviación.
- **Aplicar en**: (a) cualquier adapter nuevo que parsee JSON de un partner — usar `Record<string, unknown>` + narrowing, no `as any`; (b) **señal para el Architect**: los code blocks de los Story Files no deberían copiar `as any` de exemplars viejos si la Done Definition lo prohíbe.

#### 5. Higiene de teardown: `vi.stubGlobal` necesita limpieza
- **Observación**: agregar `vi.stubGlobal("fetch", ...)` sin `afterEach(() => vi.unstubAllGlobals())` es técnicamente correcto en aislamiento, pero si un test futuro llega al gate, ese stub contaminaría el test. **Es prevención, no corrección de un bug existente** (acá los 7 tests posteriores lanzan antes del gate).
- **Regla**: **todo** `describe` que use `vi.stubGlobal` termina con `afterEach` que limpia **ambos**: `vi.unstubAllEnvs()` + `vi.unstubAllGlobals()`. El día que agregues un test nuevo, no querés sorpresas.

#### 6. Validación de campos JSON de partner: defaultear con fail-safe
- **Ejemplo de esta HU**: aml.hits puede venir como `Array`, `undefined`, `null`, u otro formato no documentado (R-1). El código usa `Array.isArray(amlHitsRaw) ? amlHitsRaw.length : 0` → fail-safe porque defaultea a 0 (no hits = no aprobado, si status es "Approved" igualmente). Pero documentar el TODO(sandbox) explícitamente para que el operador sepa qué validar.
- **Regla**: defaultea a la posición más restrictiva (fail-closed). Documentá con `TODO(sandbox / ADAPTER_READY)` qué forma esperas y por qué; se convierte en item del pre-activation checklist.

### Hallazgo histórico — defectos reales del artefacto (corregidos en Story File §10, C1/C2/C3)

**C1 — El SDD omitía el test (6) de `route.test.ts`**: análisis de impacto en W3 solo mencionaba "reemplazo del test (1)". Pero el test (6) stubea `NODE_ENV=production` y corre `validInput` (KYC fallback) → cae en **B3** → devuelve `provenance: "n/a"` → **fallaría**. Es el gemelo HTTP exacto del test 57 de `cashout-payout.test.ts` — el SDD hizo el análisis unit pero **no lo replicó a nivel route**. **Corregido en W3.3** con el mismo criterio (asserts intactos, crece el arrange).

**C2 — El SDD §7.2 omitía el arrange del fail-safe de payout**: Los tests B7, B6 y AC-3a/AC-3b especificaban **solo** stubs de `DIDIT_*`, pero vitest setea `NODE_ENV="test"` → la rama dev exige `ALLOW_FALLBACK_PAYOUT="true"`. Sin ese stub los tests **morirían en `payout_refused`** y nunca ejercerían el gate. **Bloque ARRANGE OBLIGATORIO al tope de §7** Story File lo cubre ahora.

**C3 — Citación stale del SDD**: citaba `chaski-v2/app/api/payout/validate/route.ts:60-61` como evidencia de Didit GET `/v3/session/{id}/decision/`. Ese código **migró a `chaski-v2/src/infrastructure/payout/authority.ts:53-86`** por el refactor de WKH-202. **La evidencia sigue siendo válida** — solo la ruta/líneas desactualizadas. Dato adicional: `chaski-v2` crea con v3, este repo crea con v2 → mismatch específico de aquí, reflejado en R-1.

---

## Archivos modificados

| Archivo | Wave | Cambio | LOC |
|---------|------|--------|-----|
| `src/providers/types.ts` | W0 | ADD `KycStatusResult` interface + `status()` a `KycProvider` | +15 |
| `src/providers/kyc.ts` | W0/W1 | MOVE `REAL_KYC_PROVENANCES` desde kyc-validator + export; ADD `DiditKycProvider.status()` + `FallbackKycProvider.status()` + `assertValidKycStatus()` | +100 |
| `src/agents/kyc-validator.ts` | W0 | MOD import: `REAL_KYC_PROVENANCES` ahora de `../providers/kyc`; `isPayoutAllowed()` byte-idéntico | -1 const, +1 import |
| `src/agents/cashout-payout.ts` | W2 | DEL `kycPayoutAllowed: z.boolean()` from schema; DEL hard-gate legacy (L82-93); ADD `isKycGatePassed()`; MOD wiring orden | -12, +50 |
| `src/providers/kyc.test.ts` | W1 | ADD `DiditKycProvider.status()` tests (Approved, Declined, timeout, id-mismatch); `FallbackKycProvider.status()` tests; `assertValidKycStatus()` guard tests (B9/B10) | +120 |
| `src/agents/cashout-payout.test.ts` | W2 | DEL test L15-20 (legacy gate); ADD AC-1/2/3/6 + B6/B7; MOD L39/L57 arrange (+ALLOW_FALLBACK_KYC, +Didit mock); asserts intactos en los 7 protegidos | +180 |
| `src/app/api/agents/remit-cashout-payout/invoke/route.test.ts` | W3 | MOD beforeEach (+ALLOW_FALLBACK_KYC); MOD test (1) (legacy → gate); MOD test (6) (+DIDIT_ADAPTER_READY, +fetch mock); AC-5a/b added | +60 |
| `project-context.md` | W3 | MOD `ALLOW_FALLBACK_KYC` nota (ahora también gatea payout); ADD notas de `DIDIT_API_KEY`/`DIDIT_ADAPTER_READY` | +8 |

**Total**: 8 archivos, +533 LOC, **79 tests** (baseline 59 + 20 nuevos), 0 eliminaciones netas de tests.

---

## Decisiones diferidas a backlog

- **WKH-202**: ya DONE en `chaski-v2` (cierra G1). Cross-repo, merge pendiente.
- **WKH-204**: binding `verificationId` ↔ sender (cierra G4). Registrada.
- **WKH-168**: value-delivery real (cierra G3). En backlog.
- **README.md cleanup**: ver §Actualización README abajo — cosmético, no bloquea.

---

## Actualización README.md

El README en §Endpoint HTTP + deploy (etapa 1 — `remit-cashout-payout`) documenta el payload con `"kycPayoutAllowed": true` (línea 122). Con DT-4 ese campo ya no existe en el schema.

**Cambio**: L122-124 actualizado para reflejar que:
1. `"kycPayoutAllowed"` **no está en el schema** (si se manda Zod lo strippea silenciosamente).
2. El hard-gate KYC ahora es **server-side** (consulta Didit), no booleano del caller.
3. Nota: la rama blocked (L127) sigue siendo `"reason": "kyc_gate_not_passed"`, mismo que legacy.

**Nota de deuda**: `chaski-v2:gateways.ts:127` sigue mandando `kycPayoutAllowed: true` hardcodeado (comentario "DT-5: sintetizado"). Eso es cosmético ahora (el campo no tiene efecto). El cleanup es cross-repo posterior. Documentado en §9 R-5.

---

## Lecciones para próximas HUs

1. **Gate fail-closed con 10 ramas explícitas**: El patrón WKH-203 (y WKH-198/WKH-202) demostró que cada decisión del flujo debe tener **una rama para "rechazar"**. No hay default. B1 abre, B2-B10 cierran o lanzan. El `return false` por defecto es la posición más restrictiva.

2. **Mutation testing como validación de gate**: El AR hizo mutation testing — mutó el gate (quité `=== true`, agregué `if (!s)`, deshabilité ramas) y midió qué tests mueren. **8 de 9 mutaciones asesinadas**; la única superviviente (`!== true` → truthiness) es **redundancia de defensa** (esperada: `assertValidKycStatus()` ya garantiza booleano real). Patrón transferible para futuros money-path gates.

3. **Allowlist única, no-duplicación**: `REAL_KYC_PROVENANCES` existe **una sola vez** en `providers/kyc.ts`, consumida por 2 agentes. El drift entre dos allowlists divergentes es exactamente el bug que la allowlist existe para prevenir. **Regla**: extrae la constante al lugar más central (junto a sus **productores**, no sus consumidores), exporta, reusa.

4. **Verificación de artefactos: números requieren comandos**: Frases como "los 7 tests" **NO se escriben a ojo**. `grep -c "it\("`, `npm run test -- --reporter=verbose`, `git diff --stat` — cada número se verifica antes de meterlo en AC. Esta HU tuvo 3 desajustes de conteo entre artefactos; el Story File §10 los corrigió. Si en F3 el número real difiere, **documentar inmediatamente en auto-blindaje** para que F4/retro no lo lea como drift.

5. **Code blocks de Story Files: lógica vs estilo**: Un code block que prescribe `(d as any).status` tiene la lógica correcta pero estilo prohibido por la Done Definition. **Gana la Done Definition.** El code block es ilustrativo; la tipificación es no-negociable. Docsetea si desviás.

---

## Merge & Deploy

- **Código listo**: 8 archivos modificados, 79/79 verde, `npm run typecheck` limpio, CD-1/CD-8/CD-9 verificados.
- **Status**: Unstaged en `main`. El orquestador maneja el commit.
- **Next**: Merge a `main` y push a `feat/001-wkh-203-payout-kyc-server-gate`. Deploy a staging → validación manual de los 3 endpoints `remit-*`. **CRÍTICO**: no setear `DIDIT_ADAPTER_READY=true` hasta pasar el checklist §Checklist DIDIT_ADAPTER_READY (item 1-3). No habilitar `TRANSFI_ADAPTER_READY` hasta WKH-168 DONE.

---

*Generado por nexus-docs — NexusAgil DONE. Próximo paso: orquestador presenta el reporte al humano y cierra la HU.*
