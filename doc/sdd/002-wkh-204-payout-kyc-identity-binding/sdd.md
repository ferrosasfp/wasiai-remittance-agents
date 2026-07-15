# SDD — [WKH-204] Atar el KYC re-verificado a la identidad de quien pide el payout (G4)

> F2 (NexusAgil QUALITY) · Repo: `wasiai-remittance-agents` · SDD_MODE: **full**
> Input: `work-item.md` (HU_APPROVED 2026-07-15) + `project-context.md` + `doc/sdd/001-.../sdd.md` §9 (R-2)
> Baseline verificado por ejecución: `37728c0` · **79/79 verde** · `tsc --noEmit` limpio.
> Branch sugerido: `feat/002-wkh-204-payout-kyc-identity-binding`

---

## 1. Context Map — qué leí y qué extraje

Todo verificado con `find`/`grep`/`Read` **antes** de citarlo (precedente: el F2.5 de WKH-203 encontró
una evidencia de `chaski-v2` que había migrado de archivo por un refactor en paralelo).

| Archivo | Por qué lo leí | Qué extraje (hecho verificado) |
|---|---|---|
| `src/agents/cashout-payout.ts` (183 L) | El gate vive acá; WKH-203 lo reescribió hace minutos | `CashoutPayoutInputSchema` (L18-33) **no tiene ningún campo de identidad del sender**. `isKycGatePassed(verificationId)` (L90-118) = 10 ramas B1-B10. Orden deliberado (L128-134): `assertPayoutProviderSafe()` → `getPayoutProvider()` → gate KYC. |
| `src/providers/kyc.ts` (183 L) | Dueño de `status()`, `verify()`, allowlist | `verify()` L33: `vendor_data: input.legalId` → **vendor_data = DNI**. `DiditKycProvider.status()` L58-97 **ya fetchea el JSON completo de la decisión Didit** — el `vendor_data` ya está a su alcance, sin request extra. `REAL_KYC_PROVENANCES` L13. `assertValidKycStatus()` L152-157. |
| `src/providers/types.ts` (106 L) | Contrato `KycStatusResult` (CD-7) | `KycStatusResult` L37-42 = `{approved, verificationId, provenance, reasons}` — angosto **a propósito**. `KycProvider.status(verificationId)` L48. |
| `src/agents/kyc-validator.ts` (96 L) | Blast radius cross-agente (CD-7) | **`KycInputSchema` L19 ya exige `legalId` en claro** al mismo caller por el mismo gateway. `KycAgentOutput` L34-43 expone `verificationId` pero **NO** `legalId` (BLQ-MED-1). **No llama a `status()`** → ver §2.3. |
| `src/app/api/agents/remit-cashout-payout/invoke/route.ts` (31 L) | Superficie HTTP / CD-4 | 400 = `parsed.error.flatten()` (L15) → **vector de eco de PII, ver DT-3**. 502 opaco + `err.name`. |
| `src/agents/cashout-payout.test.ts`, `src/providers/kyc.test.ts`, `.../route.test.ts` | Patrón de test + baseline | `vi.spyOn(FallbackPayoutProvider.prototype,"execute")` + `stubDiditDecision()` + `afterEach` con `unstubAllEnvs`+`unstubAllGlobals`. Conteo por `grep -c "it("`: **15 / 17 / 11**. |
| `chaski-v2/src/infrastructure/payout/authority.ts` (92 L, read-only) | El ownership check "que funciona" allá | L83: `if (d.vendorData !== "" && d.vendorData.toLowerCase() !== address.toLowerCase())` → **si `vendor_data` viene vacío el check se OMITE = fail-OPEN**. El AR de WKH-202 lo probó ejecutando. **NO se replica** (ver C5). MNR-B (L74-82): el binding solo tiene fuerza real con caller autenticado. |
| `chaski-v2/src/infrastructure/kyc-auth.ts` (18 L, read-only) | Evaluar DT-1(c) | `issueSessionToken` firma **solo `sessionId`**: sin TTL, sin expiry, sin nonce. Ver DT-1 rechazo (c). |
| `chaski-v2/app/api/a2a/payout/submit/route.ts` (115 L, read-only) | **El consumidor real** | **L102: `body: JSON.stringify(body)` → forwardea el body del caller VERBATIM al agente.** L60-63: exige `address` no-vacío (400 si falta) → **`address` YA llega al agente hoy y Zod lo strippea en silencio**. Ver DT-2. |
| `wasiai-a2a/src/services/compose.ts` L765-800 (read-only) | ¿El gateway pasa identidad autenticada? | **NO.** Solo `Content-Type` + auth del registry + (condicional) el `x-a2a-key` del caller a registries system-trusted. **No existe un principal autenticado que el agente pueda verificar** → mata la opción "anclar a identidad del gateway" y responde "¿quién emite el token?" de DT-1(c). |
| `doc/sdd/001-.../auto-blindaje.md` | Aprendizaje histórico (obligatorio) | Ver §11. Única HU DONE del repo. |

**Comandos de verificación ejecutados** (no conté a mano — lección auto-blindaje WKH-203):
- `npm run typecheck && npm run test` → **79/79, 9 files, tsc limpio**.
- `grep -rn "\.status(" src` → **un solo call site de producción**: `cashout-payout.ts:97`.
- 2 scripts Node contra el Zod real instalado (**zod 3.25.76**) → §3 y DT-3.

---

## 2. Decisiones técnicas

### DT-1 — CENTRAL: cómo probar la identidad sin violar CD-7

**ELEGIDA: opción (a) — comparación INTERNA al provider, que expone solo un booleano.**

`DiditKycProvider.status()` (`kyc.ts:76-80`) **ya fetchea el JSON completo** de
`GET /v3/session/{id}/decision/`, que es donde vive `vendor_data`. La comparación ocurre **dentro
del provider**; lo único que cruza el borde es `identityMatches: boolean`. `vendor_data` **nunca**
entra a `KycStatusResult`, ni al agente, ni a un response, ni a un log → **CD-7 intacta, sin request
extra a Didit**.

#### Por qué (a) es la correcta — el argumento decisivo (asimetría de canales)

No es "la menos mala": es la única que aprovecha una asimetría **real y ya existente** en el repo.

| Dato | ¿Viaja en el `{result}` que el gateway persiste en telemetría? | Evidencia |
|---|---|---|
| `kycVerificationId` | **SÍ** | `kyc-validator.ts:39` (`KycAgentOutput.verificationId`) |
| `legalId` / DNI (= `vendor_data` en este repo) | **NO — removido a propósito** | `kyc-validator.ts:30-32`, BLQ-MED-1 |

Es decir: **el `verificationId` y el DNI NO co-viajan por el canal persistido.** El atacante que
saca un `verificationId` de la telemetría (precedente WKH-155: `a2a_events` anon-readable) obtiene
el id **pero no el DNI**. Exigir el DNI como claim lo obliga a conseguir un segundo dato de un
**canal distinto**. Eso es exactamente "deja de ser un ataque de un solo dato" (§"Qué cierra").

Cualquier mecanismo que **co-viaje** con el `verificationId` por el canal persistido (un token en el
`{result}` del kyc-validator — opción (c)) **no** crea esa asimetría: quien lee la telemetría se
lleva los dos. Ese es el criterio que ordena las 4 opciones.

#### ¿Y el DNI en el input? No es una clase nueva de exposición (verificado)

`KycInputSchema` (`kyc-validator.ts:19`) **ya exige `legalId` en claro** del mismo caller, por el
mismo gateway, en la misma remesa. CD-6/CD-4 (`project-context.md`, `route.ts:5`) prohíben PII en el
**response** (`{result}` persistido) — no en el input, que ya transporta
`beneficiary.name`/`beneficiary.destination` (PII) en este mismo agente (`cashout-payout.ts:26-31`).
El diseño elegido **no agrega una categoría nueva** de PII inbound; agrega un dato que el caller ya
manda al agente hermano. **No se relaja CD-6/CD-7**: el claim jamás se ecoa, loguea ni persiste
(§4, C-branches + DT-3).

#### Opciones descartadas — con evidencia

**(c) Token HMAC estilo `chaski-v2/kyc-auth.ts` (WKH-179) — RECHAZADA.** Era la favorita tentativa
del Analyst; la rechazo con 4 razones independientes, cada una suficiente:

1. **Sin TTL = autorización de desembolso PERMANENTE.** Verificado leyendo el archivo:
   `issueSessionToken(sessionId) = createHmac("sha256", secret).update(sessionId)`. Firma **solo el
   `sessionId`**: sin expiry, sin nonce, sin binding a monto/beneficiario/tiempo. Emitido una vez,
   sirve para siempre. En un money-path eso es un bearer eterno.
2. **Co-viaja con lo que pretende proteger (fatal).** Para que el payout lo exija, `remit-kyc-validator`
   tendría que devolverlo en su `{result}` — **el mismo envelope persistido donde ya vive el
   `verificationId`**. Destruye la asimetría de canales que es la razón de ser del binding: un leak
   de telemetría entrega id + token juntos. Estrictamente **peor que (a)**.
3. **No hay emisor natural — la opción se cae sola.** Verificado en `wasiai-a2a/src/services/compose.ts`
   L772-791: el gateway **no** pasa ninguna identidad autenticada al agente. Este repo es un agente
   A2A **stateless invocado por terceros**, no una DApp con sesión de browser (que es el contexto
   donde `kyc-auth.ts` sí tiene sentido: allí el emisor es la propia app que corrió el KYC). Acá el
   emisor sería otro agente sin sesión ni vínculo con el caller del payout.
4. **No ata identidad.** Prueba posesión de un secreto, no "sos el dueño de esa verificación". El
   AC-1 pide binding contra "la identidad ligada según la fuente autoritativa".

   Además: exige un `KYC_SESSION_SECRET` compartido entre 2 agentes publicados (DT-3) y cambiar el
   contrato de salida de `remit-kyc-validator` (blast radius CD-7). **Coincide con el veredicto del
   Architect de WKH-202** (SDD §4.3), que ya lo descartó para este mismo money-path.

**(b) Comparación de hashes — RECHAZADA.** El DNI peruano son **8 dígitos** → 10⁸ preimágenes:
un `SHA-256(DNI)` se revierte en segundos. No protege PII (seguridad-teatro) y agrega superficie de
mismatch por normalización/encoding. La variante con secreto (`HMAC(secret, DNI)`) **no es
computable por el caller** (no tiene el secreto) → degenera en (a) con un hash interno, sin ganancia.

**(d) Cambiar `vendor_data` en `verify()` a un valor no-PII — RECHAZADA.** Toca `verify()`
(Scope OUT/CD-10 de WKH-203) y a `remit-kyc-validator`, agente publicado y facturable
(CD-7 exige justificar por qué las otras no alcanzan → **(a) alcanza**, con blast radius menor).
Peor aún: **empeoraría la seguridad**. Si `vendor_data` deja de ser el DNI y pasa a ser un
identificador público (como el address de `chaski-v2`), el claim se vuelve un dato **público** →
el binding degenera en el teatro de MNR-B (§6). El DNI es un mal identificador *público* y por eso
mismo es un **buen** secreto compartido de bajo grado. Y no re-ataría las sesiones ya creadas.

**(e) Anclar a la identidad autenticada del gateway — DESCARTADA por inexistente.** Sería lo
correcto, pero verifiqué que `compose.ts` no forwardea ningún principal verificable (L772-791).
No hay nada a qué anclar. Es, en el fondo, la HU de seguimiento (§6).

### DT-2 — qué identidad presenta el caller, y las 2 convenciones incompatibles

**Campo elegido: `senderIdentity: z.string().min(1).optional()` — string OPACO.**

**Semántica**: "el valor que quedó ligado (`vendor_data`) a esa verificación en su creación".
No es "el DNI" ni "el address": es **lo que la fuente autoritativa tiene atado a ese id**.

#### Por qué opaco y no un discriminado `{type, value}`

Descarté `{type: z.enum([...]), value}` por **dos** motivos, uno de ellos verificado por ejecución:

1. **`z.enum` ecoa el valor recibido en el body 400 → fuga de PII NUEVA (CD-4/AC-3).** Ejecutado
   contra zod 3.25.76 (§3, caso A): un `type` inválido produce
   `"Invalid enum value. Expected 'wallet_address' | 'legal_id', received 'DNI-12345678'"` **dentro
   de `parsed.error.flatten()`**, que `route.ts:15` devuelve tal cual en el 400 (y que el gateway
   persiste). Un cliente que swapee `type`/`value` publicaría el DNI. WKH-203 no tiene este
   problema porque **todos** sus campos son `z.string`/`z.number`, cuyos mensajes son value-free
   (§3, casos B/C/D). **Regla que dejo asentada: PROHIBIDO `z.enum`/`z.literal` en cualquier campo
   de input que pueda contener PII, mientras el 400 devuelva `flatten()`.**
2. **El `type` no hacía falta.** Una única normalización sirve para **ambas** convenciones:
   `trim()` + `toLowerCase()` deja el DNI (dígitos) intacto y vuelve el address EVM
   case-insensitive (que es exactamente lo que hace `authority.ts:83`). El discriminador era
   decorativo y solo compraba un footgun.

#### Cómo convive con las 2 convenciones (el agente NO sabe cuál creó la sesión)

**No necesita saberlo, y no lo adivina** (adivinar violaría "fail-closed ante ambigüedad"). La
comparación es contra el `vendor_data` **real** que devuelve Didit, que es la fuente autoritativa y
es un valor fijo. El caller manda el valor correcto o no pasa:

| Origen de la sesión | `vendor_data` real | Claim que el caller debe mandar | Resultado |
|---|---|---|---|
| `remit-kyc-validator` (este repo, `kyc.ts:33`) | DNI | el DNI | match → pasa |
| `chaski-v2` (`/api/kyc/session`) | wallet address | el address | match → pasa |
| cualquiera | — | valor equivocado / de otra convención | **mismatch → BLOCK** (C6) |
| cualquiera | ausente/vacío | — | **BLOCK** (C5) — `chaski-v2` acá **fail-OPENea**; nosotros no |

El "no sé qué convención es" **nunca produce un allow**: no hay rama que dependa de conocerla.

#### Compat con `chaski-v2` — transición explícita, sin romperlo (hallazgo clave)

**`chaski-v2` no se toca (Scope OUT) y NO se rompe** — porque ya manda el dato, verificado:

- `chaski-v2/app/api/a2a/payout/submit/route.ts:60-63` **exige `address` no-vacío** (400 si falta).
- **L102 forwardea el body del caller VERBATIM** al agente: `body: JSON.stringify(body)`.
- Hoy `CashoutPayoutInputSchema` **strippea `address` en silencio** (`z.object` sin `.strict()`,
  verificado §3 caso 3).

⇒ **El claim de `chaski-v2` ya está llegando al agente; solo está siendo descartado.**

**Diseño de la transición — puente legado explícito (no accidental):**

```
claim = input.senderIdentity ?? input.address        // ambos z.string().min(1).optional()
if (claim === undefined)            → BLOCK C3  reason "kyc_identity_claim_missing"
if (normalize(claim) === "")        → BLOCK C4  reason "kyc_identity_claim_missing"
```

- `senderIdentity` (nuevo, explícito) **gana** sobre `address` (legado) si vienen los dos —
  precedencia determinística, documentada, sin rama "ambos y discrepan → ???".
- `address` se declara **legado/deprecado** en el schema y el README, con el comentario de por qué
  existe y cuándo se saca (cuando `chaski-v2` mande `senderIdentity` — follow-up cross-repo).
- **El puente NO es un fail-open**: `address` es un claim real que se compara contra el
  `vendor_data` real con las mismas ramas fail-closed. No debilita el gate; solo evita romper un
  consumidor vivo por un nombre de campo.
- **Ambos opcionales, nunca requeridos.** Verificado (§3, casos 1/2/5): un campo **requerido**
  faltante hace **fallar el parse → 400 `invalid_input`**. Eso sería peor: (i) 400 es
  indistinguible de un error de schema real (mala diagnosticabilidad en un money-path), y (ii)
  semánticamente miente — el input no está malformado, **falta autorización**. Con opcional +
  rama de gate obtenemos `200 {executed:false, status:"blocked", reason:"kyc_identity_claim_missing"}`:
  **igual de fail-closed, pero auditable**. Es la misma filosofía que WKH-203/DT-4 (compat por
  stripping + decisión server-side).

**Resolución de DT-2 del work-item (fail-closed día 1 vs período de gracia): fail-closed día 1, sin
gracia.** Ratifico la recomendación del Analyst y ahora con evidencia de que **no cuesta nada**: el
único consumidor real ya manda el dato (`address`), así que el puente legado **es** el período de
gracia — sin ventana de fail-open y sin flag temporal que alguien olvide apagar.

### DT-3 — granularidad del `reason`: no-oracle (colapso deliberado)

Tensión: AC-1 pide un `reason` auditable; un `reason` que distinga "no aprobado" de "aprobado pero
no es tuyo" convierte al endpoint en **oráculo** (y permite confirmar DNIs de a uno).

**Decisión — colapsar, siguiendo el precedente CD-12 de WKH-202** (`submit/route.ts:83-87`: mapea
`kyc_not_approved` y `kyc_ownership_mismatch` al **mismo** `payout_not_authorized`):

| Situación | `reason` en el response | ¿Oráculo? |
|---|---|---|
| KYC no aprobado (B2-B9) **o** identidad no coincide (C6/C5) | `kyc_gate_not_passed` (**el de hoy, sin cambio**) | No — indistinguibles |
| Claim ausente/vacío (C3/C4) | `kyc_identity_claim_missing` | **No** — habla del request del propio caller, no revela nada de la verificación ajena |

La discriminación fina para ops vive en `console.warn` **server-side**, value-free (nunca el claim,
nunca `vendor_data`): `{ branch: "C6", identityClaimPresent: true }`. Satisface AC-1 ("auditable y
libre de PII") sin regalar el oráculo. **Beneficio colateral**: `chaski-v2` no necesita cambios —
ya colapsa ambos a `payout_not_authorized` (403).

> **Nota para el orquestador**: `chaski-v2` `/api/payout/validate` **ya es** un oráculo público
> (ecoa `reason` verbatim, sin auth ni rate-limit) → follow-up WKH-205, **otro repo**. No lo
> agravamos: este diseño no agrega ningún oráculo nuevo del lado del agente.

### DT-4 — firma de `status()`: segundo parámetro REQUERIDO

`KycProvider.status(verificationId: string, identityClaim: string): Promise<KycStatusResult>`.

**Requerido, no opcional** — mismo principio estructural que WKH-203/DT-4 ("la confianza en el
caller es estructuralmente imposible"): un param opcional se puede **olvidar** en un call site nuevo
y degradaría en silencio; uno requerido **no compila**. El `tsc --noEmit` del repo cubre los tests
→ el compilador es el guard.

**Blast radius verificado — cero cross-agente**: `grep -rn "\.status(" src` da **un solo call site
de producción** (`cashout-payout.ts:97`). **`kyc-validator.ts` NO llama a `status()`** (usa
`verify()`), y `verify()`/`KycInput`/`KycResult` **no se tocan** ⇒ **no se activa la escalación de
CD-7**, no se toca `remit-kyc-validator`, `vendor_data` sigue igual en la creación de sesión (§5).
Coste: 6 call sites en `kyc.test.ts` (L46/67/87/102/109/119) piden un argumento más — **arrange
only, asserts intactos** (AC-4).

### DT-5 — `identityMatches` en `KycStatusResult` (booleano, no PII)

`KycStatusResult` gana `identityMatches: boolean`. Es un booleano derivado: **no es PII y no puede
serlo**. CD-7 dice "no exponer `vendor_data` ni campos derivados del legalId" — `identityMatches` no
permite reconstruir el DNI salvo por fuerza bruta **a $0.03 USDC por intento** (`PRICE_USDC`,
`cashout-payout.ts:16`) → 10⁸ × $0.03 = **~$3M** y 10⁸ llamadas a Didit. Económicamente inviable;
se documenta como residual (§6) y el rate-limit es del gateway.

`assertValidKycStatus()` (`kyc.ts:152`) gana `if (typeof s.identityMatches !== "boolean") throw
new Error("invalid_kyc_status_identity")` — espejo exacto del guard anti-WKH-198 de `approved`.

### DT-6 — `FallbackKycProvider.status()` → `identityMatches: true`

No tiene store y **no debe fingir que lo tiene** (mismo razonamiento que su `approved: true` actual,
`kyc.ts:125-136`): es **inocuo por construcción** porque `REAL_KYC_PROVENANCES` lo bloquea en prod
**siempre** (rama B3), y en dev/CI exige `ALLOW_FALLBACK_KYC=true`. La seguridad vive en la
allowlist, no acá.

> **Considerada y descartada**: recomputar `fallback-${hashLite(claim)} === verificationId`
> (`kyc.ts:120` deriva el id del `legalId`, así que sería un check real sin store). Es elegante y
> haría más fiel al fallback, **pero** rompería los tests existentes que llaman `status("x")` con
> ids arbitrarios (→ AC-4) y `hashLite` es no-cripto con colisiones. El valor no paga el riesgo de
> regresión en un gate money-path. Anotado como posible mejora futura, fuera de scope.

---

## 3. Comportamiento de Zod — VERIFICADO POR EJECUCIÓN (no asumido)

Script ejecutado contra el **zod realmente instalado (3.25.76)**, resolviendo desde
`node_modules` del repo. El orquestador pidió explícitamente no asumirlo (precedente WKH-203).

| # | Caso | Resultado real | Consecuencia de diseño |
|---|---|---|---|
| 1 | campo **requerido** ausente | `success:false`, `fieldErrors:{a:["Required"]}` | **Un campo requerido rompe `chaski-v2` con 400** → por eso ambos son opcionales (DT-2) |
| 2 | campo **opcional** ausente | `success:true`, `data:{}` | El gate puede bloquear con reason auditable (C3) |
| 3 | key **desconocida** (`kycPayoutAllowed`, `junk`) | **strippeada** → `{a:"x"}` | Confirma la compat de WKH-203/DT-4 **y** que hoy `address` de `chaski-v2` se descarta en silencio |
| 4 | opcional + `""` | `success:false` (min(1)) | Claim vacío → **400**, no "blocked" (rama documentada) |
| 5 | opcional + `null` explícito | `success:false` | 400 (`chaski-v2` nunca manda null: exige no-vacío) |
| 6 | opcional + `"   "` (whitespace) | **`success:true`** ⚠️ | **`min(1)` NO trimea** → un claim whitespace-only **atraviesa Zod** → obliga a la rama **C4** (`normalize(claim)===""` → BLOCK). Sin C4, si `vendor_data` también viniera vacío, `"" === ""` **matchearía** → fail-open clase WKH-198 |
| 7 | opcional + `123` (number) | `success:false` | 400, sin coerción |

**Caso A (probe de PII, ver DT-2)**: `z.enum` **ecoa el valor recibido** en `flatten()`
(`received 'DNI-12345678'`) → llegaría al body 400 de `route.ts:15`. Casos B/C/D (`z.string` min /
tipo / objeto) son **value-free**. → **`z.enum` prohibido en campos con PII potencial.**

> Los hallazgos **6** y **A** son fail-opens/fugas que **no** habría detectado leyendo la doc de Zod.
> Ambos nacieron de ejecutar. Están cubiertos por C4 y por la elección de string opaco.

---

## 4. Ramas del binding — enumeración fail-closed exhaustiva (AC-2, CD-5)

Nomenclatura **C1-C12** para no colisionar con las B1-B10 de WKH-203 (que **no se tocan**, AC-4).
**Ninguna rama tiene un default "else → allow"**.

### Resolución del claim — en `runCashoutPayout()`, antes del gate

| # | Condición | Resultado | Nota |
|---|---|---|---|
| **C1** | `senderIdentity` presente | claim = `senderIdentity` | camino explícito (preferente) |
| **C2** | `senderIdentity` ausente **y** `address` presente | claim = `address` | puente legado `chaski-v2` (DT-2) |
| **C3** | ninguno de los dos | **BLOCK** `kyc_identity_claim_missing` | **no se llama al provider** (no se gasta Didit ni se da señal) |
| **C4** | claim presente pero `normalize(claim) === ""` (ej. `"   "`) | **BLOCK** `kyc_identity_claim_missing` | ⚠️ **alcanzable**: §3 caso 6 probó que `min(1)` no trimea |

### Comparación — dentro de `DiditKycProvider.status()`

| # | Condición | Resultado | Nota |
|---|---|---|---|
| **C5** | `vendor_data` ausente / `""` / no-string | `identityMatches:false` → **BLOCK** | **⚠️ Divergencia deliberada de `chaski-v2`**: `authority.ts:83` **omite** el check si `vendorData===""` → **fail-OPEN probado por el AR de WKH-202**. Acá "no hay contra qué comparar" = **BLOQUEAR**. **PROHIBIDO "alinear" con `chaski-v2`: la divergencia es el fix** (mismo espíritu que CD-8/anti-WKH-198). |
| **C6** | `normalize(vendor_data) !== normalize(claim)` | `identityMatches:false` → **BLOCK** | reason colapsado `kyc_gate_not_passed` (DT-3) |
| **C7** | `normalize(vendor_data) === normalize(claim)` (ambos no-vacíos) | `identityMatches:true` | **única rama que abre** |
| **C8** | `vendor_data` no-string (number/object/null) | `String()`-guard → `""` → cae en **C5** → **BLOCK** | tipado `Record<string, unknown>` + narrowing, **cero `any`** (auto-blindaje WKH-203) |

`normalize(s) = s.trim().toLowerCase()` — única función, sirve a las 2 convenciones (DT-2).

### Guard, fallback y gate

| # | Condición | Resultado | Nota |
|---|---|---|---|
| **C9** | `FallbackKycProvider.status()` | `identityMatches:true` | inocuo por construcción — B3 lo bloquea en prod siempre (DT-6) |
| **C10** | `typeof s.identityMatches !== "boolean"` | `throw invalid_kyc_status_identity` | espejo del guard `approved` (anti-WKH-198) |
| **C11** | `s.identityMatches !== true` en `isKycGatePassed()` | **BLOCK** | **estricto `!== true`**, NUNCA truthiness (CD-8) |
| **C12** | el provider lanza al resolver identidad (timeout/DNS/JSON) | `kyc_gate_unavailable` → **502** | **rama B6 existente, sin cambios** — "no sé" ≠ "es tuyo" |

**Ubicación de C11 en el gate** (`cashout-payout.ts:90-118`) — inserción quirúrgica, B1-B10 intactas:

```
  s = await kycProvider.status(verificationId, claim)   // B6/C12 en el catch (sin cambios)
  if (s.approved !== true) return false                 // B2+B9  ← INTACTA
+ if (s.identityMatches !== true) return false          // C11    ← NUEVA (AND, nunca OR)
  if (REAL_KYC_PROVENANCES.has(s.provenance)) return true  // B1   ← INTACTA
  ...                                                   // B3/B4/B5/B8 ← INTACTAS
```

C11 es un **AND** que solo puede **restar** allows: va **después** de `approved` y **antes** de la
allowlist, así ninguna rama que hoy bloquea pasa a abrir. **Ningún camino que hoy devuelve `false`
puede devolver `true` tras este cambio** (invariante que el AR debe verificar).

**Orden en `runCashoutPayout()`**: la resolución del claim (C1-C4) va **después** de
`assertPayoutProviderSafe()` y `getPayoutProvider()`, preservando el orden deliberado de WKH-203
(`cashout-payout.ts:128-134`, CD-1: cuando hay dos problemas, gana el error de payout) → los tests
existentes no cambian de expectativa.

---

## 5. `verify()` y blast radius — NO se toca (CD-10 de WKH-203 preservada)

| Símbolo | ¿Se toca? | Evidencia |
|---|---|---|
| `verify()` / `vendor_data` en creación de sesión (`kyc.ts:19-56`) | **NO** | (a) resuelve sin tocarlo (DT-1) |
| `KycInput` / `KycResult` (`types.ts:9-30`) | **NO** | compat de `remit-kyc-validator` intacta |
| `src/agents/kyc-validator.ts` | **NO** | no llama a `status()` (DT-4, verificado por grep) |
| `REAL_KYC_PROVENANCES` (`kyc.ts:13`) | **NO** | allowlist única, 2 consumidores (CD-3) |
| `assertPayoutProviderSafe()` (`cashout-payout.ts:52-76`) | **NO** | CD-1 |
| B1-B10 de `isKycGatePassed()` | **NO** | solo se **inserta** C11 (§4) |
| `approved !== true` estricto | **NO** | CD-8 / anti-WKH-198 |

⇒ **La escalación cross-agente de CD-7 NO se activa.** El work-item la marcaba "condicional, solo si
DT-1 concluye que hace falta": **no hace falta**. `remit-kyc-validator` queda byte-idéntico.

---

## 6. Qué cierra / Qué NO cierra (obligatorio — CD-6, sin eufemismos)

### Cierra
- **Deja de ser un ataque de un solo dato.** Hoy basta conocer un `kycVerificationId` Approved
  ajeno. Post-WKH-204 hace falta **además** el valor atado a esa verificación, y —para las sesiones
  de este repo— ese valor (el DNI) **no viaja por el canal persistido** donde vive el id
  (`kyc-validator.ts:30-32`, BLQ-MED-1). Son dos canales distintos.
- Cierra la confianza implícita "cualquiera que sepa el id de una verificación Approved es su dueño"
  = el riesgo residual **R-2** que WKH-203 dejó documentado.
- **Cierra el fail-open de `vendor_data` vacío** que `chaski-v2` tiene vivo (`authority.ts:83`,
  probado por el AR de WKH-202): acá esa rama **bloquea** (C5).

### NO cierra — límites honestos, verificados

- **NO es prueba criptográfica de posesión. No hay firma ni SIWE.** `senderIdentity` es
  **caller-controlado**, igual que `kycVerificationId`. Si el atacante consigue **ambos** datos,
  pasa. Sube la barra; **no cierra el vector**. Misma limitación que
  `chaski-v2/src/infrastructure/kyc-auth.ts:6-7` ("NO prueba posesión de wallet… SIWE queda
  deferred") y que MNR-B (`authority.ts:74-82`).
- **La fuerza del binding depende de la convención, y el agente no la elige** (hallazgo propio,
  no estaba en el work-item):

  | Origen | `vendor_data` | ¿Es público? | Fuerza real del binding |
  |---|---|---|---|
  | `remit-kyc-validator` (este repo) | DNI | **No** | **Real** — el atacante necesita un dato de otro canal |
  | `chaski-v2` | wallet address | **Sí, on-chain** | **≈Nula** — el atacante conoce el address de la víctima; es exactamente MNR-B |

  ⇒ **Para el flujo de `chaski-v2` esto es, en lo sustantivo, teatro.** Lo implementamos igual
  (defensa en profundidad, coste ~0, cierra el fail-open C5), pero **PROHIBIDO** documentarlo como
  protección de ese flujo. Cerrar esa pata **requiere** la prueba de posesión (abajo).
- **Oráculo residual**: `identityMatches` permite confirmar un claim de a uno. Inviable
  económicamente ($0.03/intento, ~$3M para un DNI de 8 dígitos) y el rate-limit es del gateway.
  Se documenta, no se mitiga acá.
- **NO habilita la Fase A por sí sola.** Estado del gate:

  | Hueco | HU | Estado |
  |---|---|---|
  | **G1** | WKH-202 | ✅ (`3bae588`) |
  | **G2** | WKH-203 | ✅ (`37728c0`) |
  | **G3** | **WKH-168** | ⛔ **PENDIENTE / diferida** — nadie verifica que el sender pagó el principal |
  | **G4** | **WKH-204 (esta HU)** | ⏳ en curso |

  **Cerrar WKH-204 NO habilita la Fase A.** Sin G3, un atacante con **su propio** KYC Approved y
  **su propia** identity claim (que matchea perfecto) sigue pudiendo pedir un payout con monto y
  beneficiario arbitrarios **sin haber pagado el principal**. **NO setear `TRANSFI_ADAPTER_READY=true`
  hasta que G3 también esté DONE.**
- **Sigue inerte por `assertPayoutProviderSafe()`**: el path real no es explotable hoy (nadie setea
  `TRANSFI_API_KEY`+`TRANSFI_ADAPTER_READY`). Precondición de Fase A, no incidente activo.

### Recomendación del Analyst sobre la HU de seguimiento: **RATIFICADA, con evidencia adicional**

La prueba de posesión (SIWE/firma) queda **fuera de scope**. No solo por tamaño: **verifiqué que hoy
no hay dónde anclarla**. `wasiai-a2a/src/services/compose.ts:772-791` muestra que el gateway **no
forwardea ninguna identidad autenticada** al agente — solo `Content-Type`, auth del registry y
(condicional a registries system-trusted) el `x-a2a-key` del caller. Un agente A2A stateless no
tiene sesión, ni nonce store (CD-8: cero persistencia), ni challenge-response. Implementar posesión
real exige decidir **quién autentica al sender** y **dónde vive el nonce anti-replay** — cambio de
arquitectura que atraviesa gateway + agente y merece su propio F1/F2. **HU de seguimiento
recomendada** (candidata a agruparse con el hardening de MNR-B de `chaski-v2`).

---

## 7. Waves de implementación

**W0 es serial y obligatorio** (contratos/tipos): rompe el typecheck a propósito y las demás waves
lo reparan. W1/W2 son paralelizables entre sí; W3 cierra.

| Wave | Archivos | Contenido | Paralelo |
|---|---|---|---|
| **W0** — contrato (serial) | `src/providers/types.ts` | `KycStatusResult.identityMatches: boolean` (DT-5) + `KycProvider.status(verificationId, identityClaim)` **requerido** (DT-4). **Rompe el typecheck a propósito** → el compilador enumera todos los call sites. | ❌ serial |
| **W1** — provider | `src/providers/kyc.ts` | `DiditKycProvider.status()`: leer `vendor_data`, `normalize()`, comparar → C5-C8 (**cero `any`**: `Record<string,unknown>` + narrowing). `FallbackKycProvider.status()` → `identityMatches:true` + comentario "inocuo por construcción" (C9/DT-6). `assertValidKycStatus()` → C10. **`verify()` NO se toca** (§5). | ✅ con W2 |
| **W2** — agente + HTTP | `src/agents/cashout-payout.ts` | Schema: `senderIdentity` + `address` legado, **ambos `z.string().min(1).optional()`**, **sin `z.enum`** (DT-2). `resolveIdentityClaim()` → C1-C4. `isKycGatePassed(verificationId, claim)` + C11 (AND, post-`approved`, pre-allowlist). `warn` value-free (DT-3). `route.ts` **sin cambios** (wrapper fino; el 400/502 ya funciona). | ✅ con W1 |
| **W3** — tests + docs | `kyc.test.ts`, `cashout-payout.test.ts`, `route.test.ts`, `README.md`, `project-context.md` | Tests nuevos (§8) + **arrange-only** en los 6 call sites de `status()` de `kyc.test.ts` (asserts intactos, AC-4). README: contrato del endpoint (L122) + `senderIdentity` + `address` deprecado + **frase CD-6 obligatoria**. `project-context.md`: convención `senderIdentity`, regla anti-`z.enum`, Auto-Blindaje. | ❌ tras W1+W2 |

**Gate de cada wave**: `npm run typecheck && npm run test`. **PROHIBIDO validar solo con
`npm run build`** (excluye tests — precedente WKH-196).

---

## 8. Plan de tests (≥1 por AC) — baseline 79/79 a preservar

| AC | Test | Archivo |
|---|---|---|
| **AC-1** | claim que **no** matchea `vendor_data` → `{executed:false,status:"blocked"}` + `executeSpy` **nunca** invocado (C6) | `cashout-payout.test.ts` |
| **AC-1** | claim que **sí** matchea + `provenance:"didit"` → ejecuta (C7/B1) — prueba que el gate no bloquea de más | `cashout-payout.test.ts` |
| **AC-2** | claim **ausente** → blocked, **sin llamar a `fetch`** (C3) | `cashout-payout.test.ts` |
| **AC-2** | claim `"   "` whitespace → blocked (**C4** — el caso que §3/6 destapó) | `cashout-payout.test.ts` |
| **AC-2** | Didit responde **sin** `vendor_data` → blocked (**C5**, la divergencia anti-`chaski-v2`) | `kyc.test.ts` + `cashout-payout.test.ts` |
| **AC-2** | `vendor_data` no-string (number/null/object) → blocked (C8) | `kyc.test.ts` |
| **AC-2** | `status()` lanza (timeout/JSON malformado) → `kyc_gate_unavailable` → **502**, no allow (C12/B6) | `cashout-payout.test.ts` |
| **AC-2** | `identityMatches` no-booleano → `assertValidKycStatus` lanza (C10) | `kyc.test.ts` |
| **AC-3** | `JSON.stringify(body)` de **200-blocked / 400 / 502** no contiene el claim, `vendor_data`, `legalId`, `travelRuleData`, `beneficiary.name`, `beneficiary.destination`. **Incluir el caso `senderIdentity` con un DNI real** (el probe A) | `route.test.ts` |
| **AC-4** | **regresión**: 79/79 verdes; `git diff -U0` sobre los test files → **solo arranges**, `expect(...)` byte-idénticos | suite completa |
| **AC-4** | B1-B10 intactas: los tests WKH-203 pasan; C11 no convierte ningún `false` en `true` (invariante §4) | `cashout-payout.test.ts` |
| **AC-5** | **caller legado `chaski-v2`**: body con `address` y **sin** `senderIdentity` → **usa `address`** (C2) y NO 400 (compat DT-2) | `cashout-payout.test.ts` |
| **AC-5** | `senderIdentity` **y** `address` presentes y distintos → **gana `senderIdentity`** (precedencia determinística) | `cashout-payout.test.ts` |
| **AC-6** | grep del SDD/README por la frase de calificación ("no prueba criptográfica de posesión") | checklist F4 (QA) |

**Mocking (auto-blindaje WKH-203)**: usar `vi.spyOn(Prototype, "method")` + `stubDiditDecision()`
(`cashout-payout.test.ts:17-22`), **NO `vi.mock`** (hoisted a todo el archivo → riesgo de falso
verde). Todo `describe` que use `vi.stubGlobal` **debe** limpiar con `vi.unstubAllEnvs()` **y**
`vi.unstubAllGlobals()` en `afterEach`.

**Sugerencia para el AR**: repetir el **mutation testing** sobre C5/C6/C11 — WKH-203 mató 8/9 en el
gate. Mutaciones candidatas: `!== true` → truthiness; C5 → `vendorData !== "" &&` (**la forma exacta
del fail-open de `chaski-v2`** — *este mutante DEBE morir*); C11 → borrar; `normalize` → identidad.
**El diseño no puede bajar de 8/9.**

---

## 9. Constraint Directives

### Heredadas del work-item (las 10, vigentes sin cambios)
CD-1 money-path intocable · CD-2 aislamiento de repos · CD-3 no romper WKH-203 (B1-B10 /
`REAL_KYC_PROVENANCES` / `approved !== true`) · CD-4 PII fuera de todo response · CD-5 fail-closed
sin `else→allow` · CD-6 no sobre-prometer · CD-7 impacto cross-agente (**no se activa**, §5) ·
CD-8 cero persistencia consciente (**se respeta: cero estado nuevo, cero secretos nuevos, cero
env vars nuevas**) · CD-9 cero `any` nuevo · CD-10 nunca 500.

### Nuevas de este SDD
- **CD-11 — PROHIBIDO `z.enum`/`z.literal`** en cualquier campo de input que pueda contener PII
  mientras el 400 devuelva `parsed.error.flatten()`: **ecoa el valor recibido** (verificado, §3/A).
  Usar `z.string()` + allowlist fail-closed en el gate.
- **CD-12 — PROHIBIDO replicar el fail-open de `chaski-v2`**: `vendor_data` ausente/vacío/no-string
  **BLOQUEA** (C5). **PROHIBIDO "alinear" con `authority.ts:83`** (`d.vendorData !== "" && …`) — la
  divergencia es el fix, igual que CD-8/anti-WKH-198.
- **CD-13 — el claim NUNCA se ecoa, loguea ni persiste.** `console.warn` solo con datos value-free
  (`branch`, `identityClaimPresent: boolean`) — **nunca** el claim ni `vendor_data`.
- **CD-14 — `identityMatches` es un AND que solo resta allows.** PROHIBIDO que C11 convierta en
  `true` cualquier camino que hoy devuelve `false`. PROHIBIDO OR / early-return que saltee B1-B10.
- **CD-15 — precedencia determinística**: `senderIdentity` > `address`. PROHIBIDA cualquier rama
  "ambos presentes y discrepan → ambiguo": gana el explícito, siempre.
- **CD-16 — `address` es legado y deprecado**: existe solo para no romper `chaski-v2`. PROHIBIDO
  construir features nuevas sobre él; se elimina cuando `chaski-v2` mande `senderIdentity`.

---

## 10. Impacto cross-repo (compat)

| Repo | Impacto | Acción |
|---|---|---|
| **`chaski-v2`** | **Ninguno — no se rompe.** Ya manda `address` no-vacío (`submit/route.ts:60-63`) y forwardea el body verbatim (L102). Hoy Zod lo strippea; a partir de acá **se usa** (C2). Colapsa `kyc_not_approved`/`kyc_ownership_mismatch` a `payout_not_authorized` → el reason colapsado (DT-3) tampoco lo afecta. | **No se toca** (Scope OUT/CD-2). Follow-up cross-repo: migrar a `senderIdentity`. ⚠️ **Con la advertencia de §6: para `chaski-v2` el binding es ≈teatro** (vendor_data = address público). |
| **`wasiai-a2a`** (gateway) | Ninguno. El body es passthrough; no valida el schema del agente. | No se toca. |
| **`remit-kyc-validator`** (mismo repo) | **Ninguno — byte-idéntico.** No llama a `status()` (§5). | No se toca. |
| **`remit-corridor-fx`** | Ninguno. | No se toca. |
| **WKH-205** (`chaski-v2`) | Confirmado con el orquestador: **tarea de backlog, no carpeta SDD** — por eso el Analyst no la encontró. Agrupa follow-ups de WKH-202; el más relevante: `/api/payout/validate` es **público, sin auth ni rate-limit, y ecoa `reason` verbatim** (oráculo de estado KYC ya vivo en prod). **No bloquea esta HU** y este diseño **no asume que nada de `chaski-v2` sea privado**. | Sin dependencia de archivos. |

---

## 11. Auto-Blindaje histórico aplicado

Única HU DONE del repo (`_INDEX.md`): WKH-203 → `auto-blindaje.md` leído entero. Aplicado:

| Lección (WKH-203) | Cómo se aplica acá |
|---|---|
| Code blocks con `as any` chocan con la Done Definition → **gana la Done Definition** | §7/W1 exige `Record<string,unknown>` + narrowing explícito (C8). Este SDD **no** prescribe code blocks con `as any`. |
| `vi.stubGlobal` sin `unstubAllGlobals` → falso verde latente | §8 lo exige en todo `describe` nuevo. |
| **Números en artefactos: verificar ejecutando, nunca contando a mano** (5 artefactos contaron mal) | 79/79, 15/17/11 tests, "un solo call site de `status()`", zod 3.25.76 → **todos por comando**, §1. |
| Un gate nuevo tiene **gemelos a nivel route**, no solo unit (el SDD de WKH-203 se saltó el route → 3 rojos) | §8 incluye `route.test.ts` explícitamente (AC-3) y §7/W3 cuenta con arrange-growth en los 3 niveles. |
| Mutation testing probó las teeth mejor que leer la suite | §8 se lo deja preparado al AR, con el mutante `vendorData !== "" &&` como caso estrella. |
| **No usar `git stash`** en HU sin commits; `git diff` de untracked retorna vacío (≠ "intacto") | §8/AC-4 usa `git diff -U0` **con `HEAD --`**, no stash. |

**Patrón recurrente detectado (≥2 HUs) → convertido en CD**: WKH-198 (`NaN` fail-open) + WKH-203
(`approved` no-booleano) + WKH-202 (`vendorData===""` omite el check) = **"un valor ausente o de
tipo inesperado se lee como señal positiva"**. Es el mismo bug tres veces. → **CD-12** + **C5/C8/C10/C11**
lo atacan de frente en las 4 superficies nuevas.

---

## 12. Readiness Check

| # | Ítem | Estado |
|---|---|---|
| 1 | Todos los paths verificados con `find`/`grep` antes de citarlos | ✅ §1 |
| 2 | Baseline reproducido (no asumido de la foto del orquestador) | ✅ 79/79 + tsc limpio, ejecutado |
| 3 | `cashout-payout.ts` leído **entero, post-WKH-203** (`37728c0`) | ✅ 183 L |
| 4 | **DT-1 resuelta** con opciones descartadas + evidencia | ✅ (a); (b)(c)(d)(e) rechazadas |
| 5 | **Veredicto del token HMAC con evidencia de TTL** | ✅ RECHAZADO, 4 razones independientes (DT-1) |
| 6 | Campo de identidad definido + convivencia de las 2 convenciones + fail-closed ante ambigüedad | ✅ DT-2 |
| 7 | **Compat `chaski-v2` diseñada explícitamente y Zod verificado ejecutando** | ✅ §3 (7 casos + probe PII) |
| 8 | `verify()` no se toca / blast radius acotado | ✅ §5, por grep |
| 9 | WKH-203 no se debilita (B1-B10, allowlist, `!== true`) | ✅ §4 + CD-3/CD-14 |
| 10 | Ramas nuevas enumeradas una por una con resultado | ✅ C1-C12, §4 |
| 11 | Waves con W0 serial | ✅ §7 |
| 12 | CDs heredadas (10) + nuevas (6) | ✅ §9 |
| 13 | "Qué cierra / Qué NO cierra" con G1-G4 y sin eufemismos | ✅ §6 |
| 14 | ≥1 test por AC (AC-1..AC-6) | ✅ §8, 14 tests |
| 15 | Cero persistencia / cero env vars / cero secretos nuevos | ✅ CD-8 respetada |
| 16 | Cero `any` nuevo previsto | ✅ §7/W1 |
| 17 | `[NEEDS CLARIFICATION]` sin resolver | ✅ **Ninguno** — los 3 Missing Inputs del work-item resueltos (DT-1, DT-2, y DT-3 **disuelta**: la opción elegida no necesita secret compartido) |

### Riesgos que el orquestador debe ver ANTES de `SPEC_APPROVED`

| # | Riesgo | Severidad | Mitigación |
|---|---|---|---|
| **R-1** | **Para `chaski-v2` el binding es ≈teatro** (vendor_data = wallet address, dato público on-chain). El AC-1 se cumple mecánicamente, pero la protección real de **ese** flujo es ~nula. | **Alta (honestidad)** | Documentado §6 sin eufemismos; CD-6 prohíbe venderlo como cerrado. **Decisión de producto**: si se exige protección real del flujo `chaski-v2`, hace falta la HU de posesión (o migrar su `vendor_data`, hoy Scope OUT). |
| **R-2** | **G3/WKH-168 sigue abierta** → cerrar G4 **no** habilita Fase A. | Alta | §6: **no setear `TRANSFI_ADAPTER_READY=true`**. |
| **R-3** | El puente legado `address` acopla este repo a un nombre de campo interno de `chaski-v2`. Si `chaski-v2` lo renombra, el claim desaparece. | Baja | **Falla cerrado** (C3 → blocked, nunca allow). CD-16 lo marca deprecado con condición de salida. |
| **R-4** | `identityMatches` como oráculo de confirmación de DNI. | Baja | Inviable económicamente ($0.03/intento ≈ $3M); rate-limit del gateway. Documentado §6. |
| **R-5** | **R-1 de WKH-203 sigue bloqueante y sin tocar**: compat Didit v2↔v3 + forma de `aml.hits` (`kyc.ts:59-73`). Esta HU **suma** una dependencia del sandbox: **hay que confirmar que `/v3/session/{id}/decision/` realmente ecoa `vendor_data`**. `chaski-v2` lo asume (`decision.ts:19` "Didit lo eco-a") y WKH-180 lo dio por bueno, pero **este repo nunca lo verificó contra el sandbox**. | Media | **Fail-safe**: si no lo ecoa → C5 → **blocked** (nunca fail-open). Se agrega al checklist de `DIDIT_ADAPTER_READY`, que ya está bloqueado por R-1. No bloquea esta HU. |

---

*Generado por nexus-architect — F2. Próximo paso: gate `SPEC_APPROVED`. El Story File (F2.5) se
genera DESPUÉS del gate, nunca antes.*
