# Report — HU [WKH-204] Atar el KYC re-verificado a la identidad de quien pide el payout (G4)

## Resumen ejecutivo

**WKH-204** cierra el vector de **IDOR-análogo en identity binding (G4, gate Fase A)**: WKH-203 confirmó que la verificación estaba APROBADA; esta HU confirma que sea **de quien la pide**. El mecanismo: comparación interna al provider (`DiditKycProvider.status()`) que recibe el claim del caller (opaco string `senderIdentity`, con puente legado `address` para compat `chaski-v2`), lo contrasta contra el `vendor_data` real que Didit ecoa, y devuelve solo un booleano `identityMatches` — **nunca expone PII** (CD-7 intacta). El binding sube la barra (atacante necesita 2 datos) sin prueba criptográfica (declarado explícitamente: R-1). **Veredicto final**: F0–F1–HU_APPROVED–F2–SPEC_APPROVED–F2.5–F3(123/123 verde)–AR(0 BLQ, 27 mutantes)–CR(0 BLQ, 4 MNR)–fix-pack(4 items)–re-AR(0 BLQ, 21 mutantes)–fix-pack #2(2 canarios)–F4(123/123 ACs APROBADO)–**LISTO PARA DONE**. Código sin commitear, índice y reporte listos.

---

## Pipeline ejecutado

| Fase | Artefacto | Veredicto | Fecha |
|------|-----------|-----------|-------|
| F0 | project-context | cargado (`wasiai-remittance-agents`) | 2026-07-15 |
| F1 | `work-item.md` (WKH-204) | HU_APPROVED (6 Missing Inputs BLOQUEANTES: DT-1/DT-2/DT-3/CD-7, todos resueltos en F2 con evidencia) | 2026-07-15 |
| F2 | `sdd.md` | SPEC_APPROVED (resoluciones: DT-1 = opción (a) comparación interna al provider; DT-2 = campo `senderIdentity` opaco + puente legado `address`; DT-3 = no-oracle, colapsado en `kyc_identity_claim_missing`/`identity_mismatch`/`identity_no_binding`; 4 opciones descartadas con evidencia; CD-7 verify() intacta; 10 constraint directives preventivas CD-1 a CD-10) | 2026-07-15 |
| F2.5 | `story-WKH-204.md` | contrato listo para F3 (waves W0-W3 definidas, gates, exemplars verificados, 2 correcciones C1/C2 de artefacto aplicadas) | 2026-07-15 |
| F3 | Implementación | COMPLETA: W0 (interfaz `KycStatusResult` con `identityMatches`) + W1 (métodos `status()` con binding) + W2 (aplicación en gate + schema) + W3 (route test + docs). 8 archivos modificados. **Baseline 79 → +44 tests nuevos = 123/123 verde.** Wave 0 rompe tsc a propósito; W1-W3 lo reparan. | 2026-07-15 |
| AR | `ar-report.md` | **0 BLOQUEANTES, 27 mutantes ejecutados**: encontró 1 falso negativo (el `typeof`-narrowing vs `String()` fail-open), 1 igualdad no-defendida (`===` vs `.includes`/`.startsWith`), 1 log tautológico (`identityClaimPresent`). Mutation testing exhaustivo. | 2026-07-15 |
| CR | `cr-report.md` | APPROVED (0 BLOQUEANTES, 4 MNRs: test arrangement sub-enumado, dups de `stubDiditDecision()`, fuga potencial de PII en Zod `z.enum`, líneas stale). | 2026-07-15 |
| fix-pack | 4 items | (1) `typeof`-narrowing en C8 (`String()` → `typeof ... === "string"`) (2) igualdad defensible (prefijo + substring fixtures en C6) (3) log discriminador value-free (C5 `identity_no_binding` vs C6 `identity_mismatch`) (4) refs stale en comentarios. **123/123 sigue verde.** | 2026-07-15 |
| re-AR | `ar-report.md` (2ª ronda) | **0 BLOQUEANTES, 21 mutantes ejecutados** (menor drift debido a fix-pack). Mutation testing confirmó que los 3 principales hallazgos están defensa por construcción. | 2026-07-15 |
| fix-pack #2 | 2 canarios | (1) canario faltante de rama C5 (CD-7: `vendor_data` ausente); (2) assert faltante en test de C11 (no verificaba `verificationId`). **Cero lógica de producción.** **Ejecutado re-mutation**: ambos mutantes **mueren**. | 2026-07-15 |
| F4 | `validation.md` (QA) | **APROBADO PARA DONE** (123/123 tests ejecutados por QA, `npm run typecheck` limpio, CD-1/CD-8/CD-9 verificados, R-1 declarado explícitamente sin suavizar, AC-6 confirmado sin eufemismos, WKH-206 NO VERIFICABLE marcado con cuidado) | 2026-07-15 |

---

## Acceptance Criteria — resultado final (6/6 PASS, 123/123 tests)

| AC | Descripción | Status | Evidencia (archivo:línea) | Validación |
|----|---|---|---|---|
| **AC-1** | Identity mismatch → `{ executed: false, status: "blocked", reason: "kyc_identity_claim_missing"/"identity_mismatch" }`, **y** `provider.execute()` NUNCA invocado | **PASS** | `src/agents/cashout-payout.test.ts:161` (claim ajeno) + `:176` (prefijo adversarial) + `:187` (positivo C7, ejecuta) con spy de provider; impl `cashout-payout.ts:153` estricto (`!== true`); `kyc.ts:123-124` (`===` no `.includes`) | vitest 123/123 + tsc clean |
| **AC-2** | Fail-closed: claim ausente/mismatch/provider error → bloqueado (NO rama "else → allow") | **PASS** | `cashout-payout.test.ts:196` (C3 ausente) + `:215` (C4 whitespace trim necesario) + `:231` (C5 sin `vendor_data`) + `:242` (C12 status() lanza → 502) + `:259` (truthy no-bool `identityMatches: 1`); `kyc.test.ts:417,423` (`assertValidKycStatus` throws) | vitest PASS, 10/10 ramas cubiertas |
| **AC-3** | Response bloqueado / error → NO expone `beneficiary.name`/`destination`, `legalId`/DNI, `vendor_data` crudo, `travelRuleData`, `verificationId` en logs | **PASS** | `route.test.ts:182` (200 blocked con DNI real `"12345678"` → `not.toContain`) + `:197` (400 CD-11 con `senderIdentity:"DNI-12345678"` → `not.toContain("12345678")`) + `:215` (502 body fijo opaco); `cashout-payout.test.ts` warn dumped en C11 (`not.toContain("v1")` verificationId) | vitest PASS + grep logs limpio |
| **AC-4** | Regresión: los 79 tests de WKH-203 siguen verdes, asserts intactos (solo arranges crecen) | **PASS** | `git diff -U0 HEAD -- src/agents/kyc-validator.test.ts` → 0 líneas diff (byte-idéntico); `cashout-payout.test.ts` baseline 15→56 con solo nuevos tests + asserts WKH-203 intactos; `kyc.test.ts` aserciones de WKH-203 preservadas en 40+ tests existentes | vitest 79/79 preexistentes + 44 nuevos = 123/123 |
| **AC-5** | Caller legado sin `senderIdentity` (solo `address`) → comportamiento determinístico (fallback a `address`, ejecuta si matchea) | **PASS** | `cashout-payout.test.ts:382` (usa `address` legado, ejecuta OK); precedencia: `:392`/`:404` (gana `senderIdentity` si viene junto) | vitest PASS |
| **AC-6** | SDD/README/project-context declara explícitamente que NO es prueba criptográfica, sube la barra (atacante necesita 2 datos) | **PASS** | `README.md:154-161` ("alcance real de esta protección... NO constituye prueba criptográfica... protección de **ese** flujo es **≈nula**...") + `project-context.md:208-211` (mismo texto, sin suavizar) + `kyc.ts:69-89` checklist pre-`DIDIT_ADAPTER_READY` item #3 citando explícitamente "R-5 / WKH-204" | QA F4 confirmado: sin eufemismos |

---

## Hallazgos finales

### BLOQUEANTEs
Ninguno. AR 0 BLQ, CR 0 BLQ post-fix-pack. Re-AR 0 BLQ post-fix-pack #2. Las 15 ramas del gate de identidad (C1-C12 + B1-B10 heredadas de WKH-203) implementadas, fail-closed por construcción.

### MENOREs (4 encontrados + resueltos)

1. **AR/MNR-1**: `String()` en C8 fail-OPENea (devuelve `"123"` no `""`). **Ejecutado**: `vendor_data:123 + claim "123"` → `String()` matchea (ALLOW), `typeof`-narrowing bloquea (correcto). **Fix**: `typeof vendorRaw === "string" ? vendorRaw : ""` (`kyc.ts`). **Aplicar en**: todo guard que sani­ce a `""`. Tercera clase de "un tipo inesperado se lee como permiso" en el ecosistema (WKH-198/WKH-203/aquí).

2. **CR/MNR-2**: Igualdad no-defendida. **Ejecutado**: `===`→`.includes`/`.startsWith` → **108/108 verde**. Causa: fixture C6 usaba `vendor:"12345678"` vs claim `"99999999"` (sin relación prefijo/substring) → cualquier comparación razonable fallaba igual. **Fix**: claims **prefijo** + **substring** del mismo `vendor_data` (C6 provider + C6 agente). Verificado ejecutando: `===`→`.includes` mata 3 tests. **Aplicar en**: fixtures de "no matchea" deben ser adversarialmente relacionados (prefijo, substring, case-variant) del positivo.

3. **CR/MNR-3**: Log tautológico. **Ejecutado**: `identityClaimPresent:true` en **ambas** ramas (C5 "Didit no ecoó" vs C6 "claim no matchea") — nunca `false`, cero información, **el canario de PII no lo ejercitaba**. **Fix**: discriminador value-free en `reasons[]`: `identity_no_binding` (masivo = integración rota) vs `identity_mismatch` (puntual = ataque); `claimSource:"senderIdentity"|"address"` (dinámico, reemplaza tautología). Testeado: `identity_no_binding` **no** llega al response (DT-3, correcto). **Aplicar en**: un campo de log constante es peor que nada — si no varía, borralo o renombralo value-free.

4. **CR/MNR-4**: Referencias de línea stale. **Ejecutado**: `verify()` L33 ← real L43 post-inserción. README/project-context referenciaban firma vieja pre-WKH-204. **Fix**: citar símbolo no número (`DiditKycProvider.verify()`) + actualizar firmas en docs. **Aplicar en**: números en comentarios de código están malditos (quedan stale en el 1er diff). Citar el símbolo en el código; números solo en reports point-in-time.

### Riesgos residuales resueltos por el pipeline

- **R-1 (teatro para chaski-v2)**: Documentado explícitamente en README/project-context sin eufemismos — **"el alcance real de esta protección… es ≈nula"** para chaski-v2 (vendor_data = address público). Tiene valor real en flujo directo-al-agente (vendor_data = DNI), donde la asimetría de canales crea una defensa no-trivial.
- **R-5 (Didit no ecoa vendor_data)**: Risk más alto de la HU. El repo **nunca verificó contra sandbox**. Si Didit no lo ecoa, el binding bloquea TODO en prod. Ahora **discriminado en logs** (`identity_no_binding` masivo = integración rota, distinto de `identity_mismatch` puntual). Checklist pre-`DIDIT_ADAPTER_READY` item #3.
- **Falsedad en justificación (2ª vez)**: El dev declaró que renombrar a `identity_no_vendor_data` "rompía el canario CD-7", re-AR lo probó (122/122 seguían verdes sin el cambio), la afirmación era falsa. Registrado textualmente en auto-blindaje: **"SEGUNDA VEZ del mismo error, en dos HUs consecutivas."** Canario faltante agregado en fix-pack #2 (rama C5 sin `vendor_data`), ahora es verdadera.

---

## Riesgo residual — qué cierra WKH-204 y qué NO

> **CRÍTICO: Cerrar WKH-204 NO habilita por sí solo la Fase A.** El gate de Fase A son **4 huecos independientes**; esta HU cierra **G4**.

### Cierra (G4 — esta HU)
- El campo `senderIdentity` (nuevo) **ata el KYC a la identidad del que pide el payout**: fuente autoritativa (Didit) decide si matchea. Input desconocido o mismatch → bloqueado, nunca ejecuta.
- Sube la barra material: atacante necesita **2 datos** (el `verificationId` aprobado **Y** el `senderIdentity` que lo ata) en vez de 1. El `verificationId` viaja en la telemetría (`a2a_events`); el claim no.
- **Pero**: atacante que conoce/roba AMBOS datos sigue pasando. **No es prueba criptográfica.**

### NO cierra (queda vivo tras el merge) — obligatorio en checklist operativo

| # | Hueco | Dueño | Qué significa | Regla operativa |
|---|-------|-------|---------------|-----------------|
| **G1 / WKH-202** | `/api/a2a/payout/submit` proxy sin auth | `chaski-v2` (merge `3bae588` pendiente) | Cualquiera puede llegar al agente del payout. | No habilitar payout real hasta WKH-202 confirmada en prod. |
| **G3 / WKH-168** | Nadie verifica que el sender pagó principal USDC | **WKH-168** (diferida) | Atacante con KYC Approved pide payout con monto/beneficiario arbitrarios sin pagar. | **NO setear `TRANSFI_ADAPTER_READY=true` hasta G3 DONE.** |
| **G5 / WKH-206** | Prueba criptográfica de posesión (SIWE/firma) | **WKH-206** (no verificable en disco) | El binding de esta HU NO prueba wallet-ownership — solo que ambos datos co-existieron. | **Registrada** (no verificable en este repo), diferida. |
| **R-1 (teatro chaski-v2)** | Para flujo chaski-v2, `vendor_data=address` es público → binding es protección ≈nula | **Documentado aquí, sin suavizar** | El binding real **solo agrega fuerza** en flujo directo-al-agente (vendor_data=DNI). | No sobre-prometer en publicidad. Compat chaski-v2 es puente, no garantía de seguridad. |
| **R-5 (sandbox Didit)** | ¿Didit ecoa `vendor_data` en `/v3/session/{id}/decision/`? **Nunca verificado.** | **Checklist pre-`DIDIT_ADAPTER_READY` item #3** | Si no lo ecoa: binding bloqueador TODO en prod (fail-safe, no fail-open). | Antes de `DIDIT_ADAPTER_READY=true`: confirmar en sandbox que session_id v2 es consultable por v3 decision endpoint **y que ecoa `vendor_data`**. |

---

## Checklist OBLIGATORIO antes de `DIDIT_ADAPTER_READY=true` en prod

Este checklist **debe estar explícito en la operación**. WKH-203+WKH-204 están DONE, pero habilitar el adapter real requiere validación sandbox posterior. **Ahora 3 items** (WKH-203 tenía 3, WKH-204 agrega el 3º).

1. **R-1 compat v2↔v3** (heredado WKH-203): confirmar que un `session_id` creado con `POST /v2/session/` (esto repo, `verify()`) es consultable por `GET /v3/session/{id}/decision/` (status endpoint). Test: crear sesión con `remit-kyc-validator`, consultar decision endpoint, verificar `session_id` eco-ado correcto. **Es fail-SAFE** (si falla → B6 → 502).

2. **Forma exacta de `aml.hits`** (heredado WKH-203): código prescrito por Story File hace `Array.isArray(amlHitsRaw) ? amlHitsRaw.length : 0`. Test: llamar a Didit con KYC que tenga AML hits, verificar que payload contiene `aml.hits` (no `aml.total_hits`, no `aml: null`), y longitud se cuenta correctamente. **Es fail-OPEN si falla** (si no se cuenta, da `approved: true` con hits reales) → item crítico.

3. **¿Didit ecoa `vendor_data` en `/v3/session/{id}/decision/`?** (NUEVO, WKH-204 R-5): el binding entero depende de que el `vendor_data` creado en `verify()` esté presente en la decision response. Repo **nunca lo verificó contra sandbox**. Test: crear sesión con `vendor_data="123-45"`, consultar decision endpoint, verificar que response contiene `vendor_data:"123-45"`. **Es fail-SAFE** (si Didit no lo ecoa → `vendor_data` queda null → C5 bloquea TODO — correcto, pero masivo). **Item bloqueante para G4 en prod.**

**Sin pasar este checklist, NO setear `DIDIT_ADAPTER_READY=true`.**

---

## Auto-Blindaje consolidado

### Lecciones nuevas (sesión WKH-204)

#### 1. Trampa del `String()` vs `typeof`-narrowing
- **Falso negativo**: `String(v ?? "")` es `"123"` si `v=123`, **no** `""`. Solo colapsa si `null`/falsy. Tercera clase del mismo bug (WKH-198/203/aquí): *un tipo inesperado se lee como permiso.*
- **Regla**: `typeof x === "string" ? x : ""` en cualquier guard que sanitice a `""` para bloquear.

#### 2. Igualdad no-defendida en fixtures
- **Falso verde**: un fixture de "no matchea" con valores sin relación (misma longitud, sin prefijo/substring) deja los mutantes `startsWith`/`includes` vivos.
- **Regla**: fixtures de mismatch deben ser adversarialmente relacionados al positivo (prefijo, substring, case-variant). Corre la mutación **antes** de cantar victoria.

#### 3. Log tautológico en surfaces de PII
- **Riesgo**: un campo de log "constante" se lee como señal dinámica. En el warn de C11 (donde vive el claim), `identityClaimPresent:true` siempre fue true → cero información, pero **se leía como si describiera un estado variable**.
- **Defensa**: (a) si el campo no varía, borralo; (b) si **dos ramas con causas operativas opuestas** (integración rota vs ataque) emiten el mismo log, el log **no sirve** → discriminador value-free (`identity_no_binding` vs `identity_mismatch`).

#### 4. Referencias numéricas stale en comentarios de código
- **Precedente rechazado de WKH-203, REPETIDO acá**: `kyc.ts:33` era la línea correcta, pero tras insertar `normalizeIdentity()` 10 líneas atrás, se convirtió en stale → README citaba la vieja. Regla de WKH-203 **estaba escrita y no la aplicó**.
- **Regla (re-asentada)**: **nunca** números en comentarios de **código**. Citar símbolos (`DiditKycProvider.verify()`). Números solo en **reports point-in-time** (review, release notes).

#### 5. Falsedad en justificación de fix + canario faltante = falsedad invisible
- **Segunda vez del error de WKH-203**: dev declaró que la renombramiento "rompía el canario CD-7". Re-AR lo probó (122/122 verde sin cambio) → **la afirmación era falsa.** Pero **la decisión de renombrar seguía siendo correcta** (higiene de literales). La diferencia: en WKH-203 la lección era "reproducir antes de escribir 'esto arreglaba'"; acá hubo **además un canario sin cobertura** (rama C5 sin vendor_data) que habría puesto rojo SI existiera.
- **Corolario**: cuando citás un canario "esto no se rompe porque X lo verifica", **corre el mutante del canario ANTES de escribir.** Si el canario que creés no cubre la rama que declarás → **ese es el bug**, no un detalle de redacción. Fix-pack #2 agregó el canario real, ahora la afirmación es verdadera.

#### 6. Nombre de test vs asserts presentes (promesa > realidad)
- **Falso negativo menor**: test se llamaba *"el warn NUNCA contiene… ni el `verificationId`"*, pero no asserteaba el `verificationId`. Mutante (`verificationId: s.verificationId` en el warn) sobrevivía. El nombre es un **contrato**, no una intención.
- **Regla**: si enumerás N cosas ("nunca A, B **ni C**"), tiene que haber **N asserts**. Un canario que promete de más es peor que no tenerlo.

### Hallazgos históricos — defectos reales del artefacto (corregidos en Story File, aplicados en F3)

**C1 — Omisión en fixtures del test arrange**: el Story File §10 solamente mencionaba los 6 call sites de `status()` en `kyc.test.ts`, pero omitía los fixtures `validInput` en `cashout-payout.test.ts` + `route.test.ts` (que tampoco referenciaban `senderIdentity`/`address`). Tsc se ponía rojo hasta que el dev completara el arrange en los 3 niveles (unit provider, unit agente, route HTTP). **Precedente idéntico WKH-203 §C2.** 

**C2 — Contrato incompleto en types.ts**: el SDD agregaba `identityMatches: boolean` a `KycStatusResult`, pero no agregaba el 2º param requerido a `status(senderIdentity)` en el trait `KycProvider`. El dev tuvo que inferir la firma completa del SDD §2. Mejor aún si hubiera sido prescrita explícitamente en el SDD §5 (Scope IN, interfaces).

---

## Archivos modificados

| Archivo | Wave | Cambio | LOC |
|---------|------|--------|-----|
| `src/providers/types.ts` | W0 | ADD `identityMatches: boolean` to `KycStatusResult`; ADD 2nd param `senderIdentity` to `KycProvider.status()` | +5 |
| `src/providers/kyc.ts` | W1 | ADD `normalizeIdentity()` helper + `DiditKycProvider.status()` with binding logic + `FallbackKycProvider.status()` + enhanced `assertValidKycStatus()`; ADD `reasons` to status result | +150 |
| `src/agents/cashout-payout.ts` | W2 | ADD `senderIdentity` + `address` (legado) to schema; ADD binding gate call in `isKycGatePassed()`; MOD wiring orden | +25 |
| `src/providers/kyc.test.ts` | W1 | ADD tests for `normalizeIdentity()` + 6 `status()` test cases (C1-C7) covering mismatch/absence/whitespace/type errors/fallback/compat | +190 |
| `src/agents/cashout-payout.test.ts` | W2 | ADD 12 binding tests (identity mismatch, whitespace, absence, provider error, truthy-no-bool, prefijo/substring adversarial) + compat chaski-v2 `address` | +250 |
| `src/app/api/agents/remit-cashout-payout/invoke/route.test.ts` | W3 | ADD route-level tests for binding (200 blocked, 400 no-PII, 502); MOD CD-11 probe `senderIdentity` payload | +80 |
| `README.md` | W3 | ADD/MOD `senderIdentity` field documentation + schema example; ADD note that `address` is legacy; ADD honestidad sobre alcance real (R-1) | +20 |
| `project-context.md` | W3 | ADD notes on `senderIdentity` / legacy `address` + checklist item #3 (Didit vendor_data echo) + R-1 transparencia | +12 |

**Total**: 8 archivos, +732 LOC, **44 tests nuevos** (baseline 79 + 44 = **123/123**), 0 eliminaciones netas.

---

## Decisiones diferidas a backlog

- **WKH-205**: consumidor `chaski-v2` — mandar `senderIdentity` en vez de `address` hardcodeado. Cross-repo, diseño pendiente.
- **WKH-206**: prueba criptográfica de posesión (SIWE/firma). **NO VERIFICABLE en disco** — registrada aparte, diferida.
- **WKH-168**: value-delivery real (principal-in USDC). Diferida, intacta.
- **Cosmético**: `chaski-v2:gateways.ts:127` sigue mandando `kycPayoutAllowed: true` hardcodeado (inerte post-WKH-203).

---

## Lecciones para próximas HUs

1. **Defensa en profundidad de comparaciones**: `typeof`-narrowing + igualdad estricta + fixtures adversariales **+ mutation testing ANTES de DONE**. El dev de WKH-204 corrió mutation testing y descubrió un falso negativo (igualdad no-defendida); el re-AR confirmó con 21 mutantes más. Patrón transferible: en money-path, siempre correr mutación antes de cantar victoria.

2. **Lecciones que se repiten sin aplicarse**: WKH-203 dejó asentado "reproducir antes de 'esto arreglaba'"; WKH-204 lo repitió (falsedad + canario faltante). **Regla operativa**: el auto-blindaje que se escribe de una HU se **revisa manualmente** al iniciar la siguiente. No es automático; requiere disciplina.

3. **Asimetría de canales como defensa**: el binding elegido (opción a) aprovecha que `verificationId` viaja persistido, pero `vendor_data` (DNI) no → obliga al atacante a conseguir dos datos de canales distintos. Esto es **transferible a cualquier KYC**: si un componente de la defensa está en telemetría y otro no, tienes una defensa por combinatoria de canales.

4. **Nombres de tests son contratos**: si dices "nunca A, B, C", tiene que haber 3 asserts. Un canario que promete de más es la forma perfecta de esconder un mutante superviviente. Aplicar ahora: revisar todos los nombres de tests que enumeran N cosas y verificar que haya N asserts.

5. **Checklist pre-activación**: habilitar un adapter nuevo (Didit, Transfi, cualquiera) requiere **3 validaciones sandbox** mínimo (compat, campos, flujo). Hacerlas **explícitas en el checklist y en el comentario de env var** — no son "detalles después". WKH-203+WKH-204 tienen el precedente; aplicar a futuros adapters.

---

## Merge & Deploy

- **Código listo**: 8 archivos modificados, **123/123 verde**, `npm run typecheck` limpio, CD-1/CD-8/CD-9 verificados.
- **Status**: Unstaged en `main` (HEAD = `37728c0`, WKH-203 merge). El orquestador maneja el commit.
- **Next**: Merge a `main` + push a `feat/002-wkh-204-payout-kyc-identity-binding`. Deploy a staging → validación manual de los 3 endpoints `remit-*`. 
- **CRÍTICO**: 
  - No setear `DIDIT_ADAPTER_READY=true` hasta **pasar el checklist §Checklist pre-`DIDIT_ADAPTER_READY` (items 1-3, 2 nuevos en WKH-204).**
  - No setear `TRANSFI_ADAPTER_READY=true` hasta **WKH-168 DONE** (G3).
  - WKH-205 (consumidor chaski-v2) es follow-up, no bloquea DONE de esta HU.

---

*Generado por nexus-docs — NexusAgil DONE. Próximo paso: orquestador presenta el reporte al humano y cierra la HU.*
