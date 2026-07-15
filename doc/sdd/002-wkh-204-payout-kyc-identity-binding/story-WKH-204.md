# Story File — HU WKH-204: Atar el KYC re-verificado a la identidad de quien pide el payout (G4)

> Contrato autocontenido para el Dev (F3). **El Dev SOLO lee este archivo** (no el SDD, no el work-item).
> Fuente: `sdd.md` (SPEC_APPROVED 2026-07-15) + `work-item.md` en `doc/sdd/002-wkh-204-payout-kyc-identity-binding/`.
> Tipo: security fix (money-path / IDOR-análogo / compliance gate) · Branch: `feat/002-wkh-204-payout-kyc-identity-binding`
> Repo: **wasiai-remittance-agents** (`/home/ferdev/.openclaw/workspace/wasiai-remittance-agents`) — CD-2: SOLO este repo.
> **Baseline verificado corriendo la suite (2026-07-15)**: `npm run typecheck` limpio + **79 tests / 9 archivos, todos en verde**.
> Desglose real (por ejecución, no por conteo a mano): `kyc.test.ts` **17** · `cashout-payout.test.ts` **15** ·
> `remit-cashout-payout/invoke/route.test.ts` **11** · `kyc-validator.test.ts` **5** · `payout` 7 · `fx` 8 ·
> `corridor-fx` 2 · `remit-corridor-fx/route` 6 · `remit-kyc-validator/route` 8.

---

## 1. Contexto compacto (qué se construye y por qué)

WKH-203 (merge `37728c0`) cerró que el agente confíe en un booleano del **caller**: hoy `isKycGatePassed()`
(`cashout-payout.ts:90-118`) re-deriva la decisión de compliance consultando a Didit por `kycVerificationId`.

Pero ese gate confirma **que la verificación está aprobada**, no **que sea de quien pide el payout**. Un caller
que invoque `remit-cashout-payout` directo (salteando `chaski-v2`) puede pasar el `kycVerificationId` aprobado
de **otra persona** y recibir el payout en **su propio** `beneficiary`. Es un **IDOR-análogo**, y hoy basta con
conocer **un solo dato**.

**El fix**: el caller debe presentar además una **identity claim** (`senderIdentity`), y el sistema la compara
contra el `vendor_data` **real** que Didit tiene atado a esa verificación. Si no matchea → **BLOCK**.

**La comparación vive DENTRO del provider** (`DiditKycProvider.status()`), que **ya fetchea el JSON completo**
de la decisión (`kyc.ts:76-97`) — o sea, `vendor_data` ya está a su alcance **sin request extra**. Lo único que
cruza el borde hacia el agente es `identityMatches: boolean`. Ver §2.1: **esto es un guardrail, no un detalle de estilo.**

**Cero estado nuevo, cero env vars nuevas, cero secretos nuevos, cero DB/KV** (CD-8). El repo sigue cero-persistencia.

**Qué NO hace esta HU**: no habilita el payout real (CD-1/CD-5), no toca `verify()`, no toca `kyc-validator.ts`,
no toca `chaski-v2`, no implementa SIWE ni WKH-168.

### Dónde encaja (no re-litigar)

Gate de Fase A = **G1** (WKH-202 ✅ `3bae588`) + **G2** (WKH-203 ✅ `37728c0`) + **G3** (WKH-168 ⛔ **diferida**) +
**G4 = ESTA HU**. **Cerrar WKH-204 NO habilita la Fase A** (§9 R-2). **NO setear `TRANSFI_ADAPTER_READY=true`.**

---

## 2. Decisiones CERRADAS en el gate SPEC_APPROVED (2026-07-15) — **NO re-litigar**

> Levantadas, discutidas y resueltas. Están acá para que ni el Dev ni el AR las reabran ni las lean como desviación.

### 2.1 🔴 La comparación vive DENTRO del provider — **RATIFICADA. Es un GUARDRAIL.**

**PROHIBIDO "simplificar" exponiendo `vendorData` en `KycStatusResult`.** El motivo es CD-7 y es concreto:

| Repo | Qué es `vendor_data` | ¿Se puede exponer? |
|---|---|---|
| **Este repo** (`kyc.ts:33`, `verify()`: `vendor_data: input.legalId`) | **el DNI** = **PII** | **NO — exponerlo crudo es una fuga de PII nueva** |
| `chaski-v2` | wallet address (público) | por eso allá su check funciona sin filtrar nada |

Si algún día alguien piensa "sería más simple devolver `vendorData` y comparar en el agente": **eso filtra el DNI**
al agente, a los logs y potencialmente a un response. `KycStatusResult` es **deliberadamente angosto** y sale del
provider **solo con un booleano derivado**. `identityMatches` no es PII y no puede serlo.

**Blast radius verificado por grep** (`grep -rn "\.status(" src --include=*.ts | grep -v test`): **UN SOLO call site
de producción** → `cashout-payout.ts:97`. `verify()` **intacto**; `kyc-validator.ts` **no llama a `status()`** →
`remit-kyc-validator` queda **byte-idéntico** y la escalación cross-agente de CD-7 **no se activa**.

### 2.2 Token HMAC estilo `chaski-v2/kyc-auth.ts` — **RECHAZADO DEFINITIVAMENTE. No lo reabras.**

Razón decisiva (no es el TTL): **co-viajaría con el `verificationId` por el mismo envelope persistido**. Para que
el payout lo exija, `remit-kyc-validator` tendría que devolverlo en su `{result}` — el mismo envelope donde ya vive
el `verificationId` (`kyc-validator.ts:39`). Un leak de telemetría (precedente WKH-155: `a2a_events` anon-readable)
entregaría **id + token juntos** → **destruye la asimetría de canales que es la razón de ser del binding** →
estrictamente **peor** que la opción elegida.

**La asimetría que sí existe hoy y que este diseño explota:**

| Dato | ¿Viaja en el `{result}` que el gateway persiste? | Evidencia |
|---|---|---|
| `kycVerificationId` | **SÍ** | `kyc-validator.ts:39` |
| `legalId` / DNI (= `vendor_data` acá) | **NO — removido a propósito** | `kyc-validator.ts:30-32` (BLQ-MED-1) |

⇒ el atacante que saca un `verificationId` de la telemetría **no obtiene el DNI**: necesita un segundo dato de
**otro canal**. Eso es "deja de ser un ataque de un solo dato".

### 2.3 `senderIdentity` es un **string opaco** — **RATIFICADO** (`z.string().min(1).optional()`)

**PROHIBIDO** un discriminado `{type: z.enum([...]), value}`. Ver **CD-11** (§6): `z.enum` **ecoa el valor recibido**
y `route.ts:15` lo devuelve en el 400 → **fuga de PII**. Además el `type` no hace falta: una sola normalización
(`trim()` + `toLowerCase()`) sirve a **las 2 convenciones** (deja el DNI intacto y vuelve el address EVM
case-insensitive). El discriminador era decorativo y solo compraba un footgun.

**El agente NO sabe ni adivina qué convención creó la sesión** — y no lo necesita: compara contra el `vendor_data`
**real** de la fuente autoritativa. "No sé qué convención es" **nunca produce un allow**.

### 2.4 Puente legado `address` (deprecado, CD-16) — **RATIFICADO. `chaski-v2` NO se toca.**

Verificado en disco (2026-07-15) por el orquestador **y por mí**:
- `chaski-v2/app/api/a2a/payout/submit/route.ts:59-62` **ya exige `address` no-vacío** (400 si falta/whitespace).
- `:102` → `body: JSON.stringify(body)` **forwardea el body del caller VERBATIM** al agente.
- Hoy `CashoutPayoutInputSchema` (`z.object` **sin `.strict()`**) lo **strippea en silencio** — verificado
  ejecutando zod 3.25.76: `safeParse({a:"x", address:"0xAbC", junk:1})` → `{"success":true,"data":{"a":"x"}}`.

⇒ **El claim de `chaski-v2` YA está llegando al agente; solo está siendo descartado.** Por eso:
**fail-closed día 1, sin ventana de gracia y sin flag temporal que alguien olvide apagar.** El puente legado
**es** el período de gracia. **`chaski-v2` sigue andando sin tocarlo** (CD-2 / Scope OUT).

### 2.5 🔴 R-1 — para el flujo `chaski-v2` el binding es **≈teatro**. ACEPTADO, documentado, NO bloquea.

**Sin eufemismos** (CD-6): el `vendor_data` de las sesiones de `chaski-v2` **es la wallet address = dato público
on-chain**. El atacante que quiere suplantar a una víctima de ese flujo **ya conoce su address**. Para **ese** flujo
la protección real es **~nula**: el AC-1 se cumple mecánicamente, la seguridad no.

| Origen de la sesión | `vendor_data` | ¿Público? | Fuerza real del binding |
|---|---|---|---|
| `remit-kyc-validator` (este repo) | DNI | **No** | **Real** — exige un dato de otro canal |
| `chaski-v2` | wallet address | **Sí, on-chain** | **≈Nula** — es exactamente MNR-B |

Se implementa igual: defensa en profundidad, coste ~0, y **cierra el fail-open C5** que `chaski-v2` tiene vivo.
**Es decisión de producto, ya reportada al humano.** **PROHIBIDO** documentarlo como protección de ese flujo.
**Esto debe viajar al done-report tal cual.** Cerrar esa pata requiere la HU de prueba de posesión (§2.6).

### 2.6 SIWE / prueba de posesión — **FUERA DE SCOPE**, ratificado con evidencia

No hay **dónde anclarla**: `wasiai-a2a/src/services/compose.ts:772-791` **no forwardea ningún principal
autenticado** al agente (solo `Content-Type`, auth del registry y, condicional a registries system-trusted, el
`x-a2a-key`). Sin principal autenticado y sin nonce store (CD-8: cero persistencia), no hay challenge-response.
**PROHIBIDO diseñarlo o implementarlo acá.** Es HU de seguimiento, ya registrada aparte.

---

## 3. Scope IN (lista exhaustiva de archivos a tocar)

| # | Archivo | Acción | Wave |
|---|---------|--------|------|
| 1 | `src/providers/types.ts` | `KycStatusResult.identityMatches: boolean` + `KycProvider.status(verificationId, identityClaim)` **requerido**. `verify()`/`KycInput`/`KycResult` **INTACTOS**. | **W0** |
| 2 | `src/providers/kyc.ts` | `export function normalizeIdentity()` + `DiditKycProvider.status()` (C5-C8) + `FallbackKycProvider.status()` (C9) + `assertValidKycStatus()` (C10). **`verify()` NO se toca.** | W1 |
| 3 | `src/agents/cashout-payout.ts` | Schema: `senderIdentity` + `address` legado + `resolveIdentityClaim()` (C1-C4) + `isKycGatePassed(verificationId, claim)` + C11 + wiring. | W2 |
| 4 | `src/providers/kyc.test.ts` | Tests C5/C6/C7/C8/C9/C10 + **arrange** en los 6 call sites de `status()` **y en el fixture `valid`** (§10/C2). | W3 |
| 5 | `src/agents/cashout-payout.test.ts` | Tests C1-C4/C11/AC-5 + **arrange** del fixture `validInput` y de los 3 `stubDiditDecision` (§10/C2). | W3 |
| 6 | `src/app/api/agents/remit-cashout-payout/invoke/route.test.ts` | AC-3 (no-PII del claim) + **arrange** del fixture `validInput` y del fetch stub del test (6) (§10/C2). | W3 |
| 7 | `README.md` | Contrato del endpoint: `senderIdentity` + `address` **deprecado** + `kyc_identity_claim_missing` + **frase obligatoria CD-6**. | W3 |
| 8 | `project-context.md` (raíz) | Convención `senderIdentity`, **regla anti-`z.enum` (CD-11)**, entrada de Auto-Blindaje. | W3 |

**PROHIBIDO tocar cualquier otro archivo.** En particular (Scope OUT):
`src/app/api/agents/remit-cashout-payout/invoke/route.ts` (**el `.ts` de producción NO se toca**: es un wrapper
fino y el 400/502 ya funciona tal cual — solo se toca su `.test.ts`), `src/agents/kyc-validator.ts` **y**
`kyc-validator.test.ts` (**byte-idénticos**, sus **5** tests deben pasar sin modificación),
`src/providers/kyc.ts::verify()`, `src/providers/payout.ts`, `src/providers/fx.ts`, `src/agents/corridor-fx.ts`.
**`.env.example` NO se crea** (esta HU **no agrega ninguna env var**). **Nada fuera de este repo** (CD-2):
`chaski-v2` y `wasiai-a2a` son **read-only**.

---

## 4. Waves de implementación

> **W0 es SERIAL y bloquea todo** (rompe el typecheck a propósito). **W1 y W2 son paralelizables entre sí.**
> **W3 cierra** (necesita W1+W2). Comando autoritativo por wave: **`npm run typecheck` + `npm run test`**
> (§8 — **PROHIBIDO cerrar una wave validando solo con `npm run build`**).

### W0 — SERIAL · contrato · `src/providers/types.ts`

`verify()`, `KycInput` y `KycResult` **no se tocan** (CD-10 de WKH-203, preservada).

```ts
export interface KycStatusResult {
  approved: boolean;
  verificationId: string;   // eco del id consultado (canónico = el pedido)
  provenance: Provenance;   // "didit" | "local-fallback"
  reasons: string[];        // auditable y VALUE-FREE; nunca PII
  /**
   * WKH-204: ¿la identity claim del caller coincide con el `vendor_data` que la fuente autoritativa
   * tiene atado a esta verificación? Booleano DERIVADO: la comparación ocurre DENTRO del provider.
   * CD-7: `vendor_data` en este repo es el DNI (kyc.ts:33) → PROHIBIDO exponerlo crudo acá.
   */
  identityMatches: boolean;
}

export interface KycProvider {
  verify(input: KycInput): Promise<KycResult>;   // ← INTACTO
  // WKH-204: `identityClaim` es REQUERIDO a propósito (no opcional): un param opcional se puede
  // OLVIDAR en un call site nuevo y degradaría en silencio; uno requerido NO COMPILA.
  status(verificationId: string, identityClaim: string): Promise<KycStatusResult>;
}
```

> **⚠️ `identityMatches` es un booleano, NUNCA `vendorData`.** Ver §2.1. **PROHIBIDO** agregarle a
> `KycStatusResult` un `vendorData`, `legalId`, `identity`, `travelRuleData` ni nada derivado del DNI.

**Cierre W0 (verificable)**: `npm run typecheck` **FALLA A PROPÓSITO** — las 2 impls de `KycProvider`
(`DiditKycProvider` `kyc.ts:16`, `FallbackKycProvider` `kyc.ts:106`; **no hay otras**, verificado con
`grep -rn "implements KycProvider" src`) no satisfacen la interface nueva, y el fixture `valid` de
`kyc.test.ts:127-132` queda sin `identityMatches`. **Eso es la señal de que el contrato quedó bien atado.**
**NO lo "arregles"** con `any`, `@ts-ignore`, `identityMatches?` opcional ni `identityClaim?` opcional
(CD-9/CD-14): lo cierran W1/W2/W3.

---

### W1 — `src/providers/kyc.ts` (impl) — ∥ con W2

**W1.1 — la normalización, UNA SOLA, exportada.** Vive en `kyc.ts` y la consumen **2** archivos
(`kyc.ts` y `cashout-payout.ts`). **PROHIBIDO duplicarla** — mismo criterio ya auditado que
`REAL_KYC_PROVENANCES` (`kyc.ts:13`, CD-9 de WKH-203): el drift es exactamente lo que la fuente única previene.

```ts
/**
 * WKH-204: normalización ÚNICA de identity claims. Sirve a las DOS convenciones de vendor_data:
 * deja el DNI (dígitos) intacto y vuelve el wallet address EVM case-insensitive.
 * ÚNICA fuente (CD-9): la consumen kyc.ts (DiditKycProvider.status) y cashout-payout.ts (C4).
 */
export function normalizeIdentity(s: string): string {
  return s.trim().toLowerCase();
}
```

**W1.2 — `DiditKycProvider.status()`**: agregar el 2º param y la comparación. **El resto del método
(fetch, timeout, `!res.ok`, `aml.hits`, B10 id-mismatch) NO cambia.**

```ts
async status(verificationId: string, identityClaim: string): Promise<KycStatusResult> {
  // ... el fetch, el !res.ok, decision, amlHits, approved y el guard B10 quedan IGUAL que hoy ...

  // WKH-204 / C5-C8 — el binding de identidad. La comparación vive ACÁ a propósito (CD-7):
  // `vendor_data` en este repo es el DNI; exponerlo crudo filtraría PII. Solo sale un booleano.
  //
  // 🔴 C8 — narrowing por `typeof`, NUNCA `String(...)`: ver §10 corrección C1. `String(123)` es
  // "123" (NO ""), así que un vendor_data no-string ALCANZARÍA la comparación y un claim "123"
  // MATCHEARÍA = fail-open. Un tipo inesperado DEBE colapsar a "" y bloquear por C5.
  const vendorRaw: unknown = d.vendor_data;
  const vendorData = typeof vendorRaw === "string" ? vendorRaw : "";   // C8 → "" → cae en C5
  const normalizedVendor = normalizeIdentity(vendorData);

  // C5: sin vendor_data no hay CONTRA QUÉ comparar → BLOQUEAR. C6: distinto → false. C7: igual → true.
  // ⚠️ El `normalizedVendor !== ""` va PRIMERO y es un AND: PROHIBIDO la forma de chaski-v2
  // (`vendorData !== "" && vendorData !== claim`), que OMITE el check si viene vacío → fail-OPEN (CD-12).
  const identityMatches =
    normalizedVendor !== "" && normalizedVendor === normalizeIdentity(identityClaim);

  return assertValidKycStatus({
    approved,
    verificationId,
    provenance: "didit",
    identityMatches,
    reasons: approved ? [] : [`didit_status_${decision}`, `aml_hits_${amlHits}`],
  });
}
```

> **CD-7/CD-13 acá**: del JSON de Didit se leen **solo** `status`, `aml.hits`, `session_id` y `vendor_data`.
> `vendor_data` **se usa para comparar y se descarta**: **PROHIBIDO** meterlo en `reasons`, en el return, en un
> `console.warn` o en un mensaje de error. `reasons[]` sigue **value-free** (no cambia por esta HU).
> **PROHIBIDO** leer `id_verifications[]`, `first_name`, `last_name`, `document_number`, `date_of_birth`.

**W1.3 — `FallbackKycProvider.status()`** → agregar el 2º param (aunque no lo use) y `identityMatches: true`:

```ts
async status(verificationId: string, _identityClaim: string): Promise<KycStatusResult> {
  // ... el comentario existente y los campos actuales quedan IGUAL ...
  // WKH-204: NO tiene store y NO debe fingir que lo tiene (mismo razonamiento que su `approved: true`).
  // Es INOCUO por construcción: REAL_KYC_PROVENANCES lo bloquea en prod SIEMPRE (rama B3), y en
  // dev/CI exige ALLOW_FALLBACK_KYC=true (B5). La seguridad vive en la allowlist, no acá.
  return { approved: true, verificationId, provenance: "local-fallback",
           identityMatches: true, reasons: ["fallback_no_real_verification"] };
}
```

> **Considerado y DESCARTADO en el SDD, no lo "mejores"**: recomputar `fallback-${hashLite(claim)} === verificationId`.
> Rompería los tests existentes que llaman `status("x")` con ids arbitrarios (→ AC-4) y `hashLite` es no-cripto
> con colisiones. **Fuera de scope.**

**W1.4 — `assertValidKycStatus()`** (`kyc.ts:152-157`) → agregar **C10**, espejo exacto del guard de `approved`:

```ts
if (typeof s.identityMatches !== "boolean") throw new Error("invalid_kyc_status_identity"); // C10
```

**Cierre W1 (verificable)**: `npm run typecheck` — `kyc.ts` ya no aporta errores (los que queden son de W2/W3).

---

### W2 — `src/agents/cashout-payout.ts` — ∥ con W1

**W2.1 — schema.** Agregar los 2 campos. **Ambos `z.string().min(1).optional()`, sin `z.enum`** (CD-11):

```ts
  // WKH-204: identity claim del sender. String OPACO a propósito (CD-11): PROHIBIDO z.enum/z.literal
  // ni un discriminado {type,value} — z.enum ECOA el valor recibido en parsed.error.flatten(), que
  // route.ts:15 devuelve en el 400 → fuga de PII. Semántica: "el valor que quedó ligado (vendor_data)
  // a esa verificación en su creación" (el DNI si la creó remit-kyc-validator; el address si chaski-v2).
  senderIdentity: z.string().min(1).optional(),
  // WKH-204/CD-16 — LEGADO/DEPRECADO: puente de compat con chaski-v2, que ya manda `address` no-vacío
  // (submit/route.ts:59-62) y forwardea el body verbatim (:102) — hoy Zod lo strippea en silencio.
  // NO es un fail-open: es un claim real que se compara con las MISMAS ramas fail-closed.
  // PROHIBIDO construir features nuevas sobre él. Se elimina cuando chaski-v2 mande `senderIdentity`.
  address: z.string().min(1).optional(),
```

> **⚠️ `optional()`, NUNCA requeridos — decisión CERRADA, verificada ejecutando zod 3.25.76.**
> Un campo **requerido** ausente hace **fallar el parse → 400 `invalid_input`**. Eso sería **peor**: (i) el 400 es
> indistinguible de un error de schema real (mala diagnosticabilidad en un money-path), y (ii) miente semánticamente
> — el input no está malformado, **falta autorización**. Con `optional()` + rama de gate obtenemos
> `200 {executed:false, status:"blocked", reason:"kyc_identity_claim_missing"}`: **igual de fail-closed, pero auditable**.

**W2.2 — resolución del claim (C1-C4)**. Fn a nivel módulo:

```ts
/**
 * WKH-204 / C1-C4: resuelve la identity claim del caller. Devuelve null = BLOQUEAR (fail-closed).
 * CD-15 — precedencia determinística: `senderIdentity` (explícito) GANA sobre `address` (legado).
 * PROHIBIDA cualquier rama "ambos presentes y discrepan → ambiguo": gana el explícito, siempre.
 */
function resolveIdentityClaim(input: CashoutPayoutInput): string | null {
  const claim = input.senderIdentity ?? input.address;        // C1 / C2
  if (claim === undefined) return null;                       // C3
  if (normalizeIdentity(claim) === "") return null;           // C4 — ver el aviso 🔴 de abajo
  return claim;
}
```

> ### 🔴 C4 — NO la borres "porque `min(1)` ya lo cubre". **NO lo cubre. Verificado ejecutando.**
> `z.string().min(1)` **NO trimea**. Probado contra el zod **3.25.76** realmente instalado en este repo:
> ```
> min(1).optional() con "   "  ->  OK  data={"senderIdentity":"   "}     ⚠️ ATRAVIESA ZOD
> min(1).optional() con ""     ->  FAIL (400)
> ```
> Un claim `"   "` **atraviesa Zod**. **Sin C4, si `vendor_data` también viniera vacío, `"" === ""` matchearía
> = fail-open clase WKH-198.** (Hoy C5 también lo ataja, pero las dos ramas son defensa en profundidad y **cada
> una debe existir por separado**: C4 evita además gastar una llamada a Didit y dar señal.)
> **Es exactamente el tipo de cosa que un dev "limpia" sin entender. No la limpies.**

**W2.3 — el gate: insertar C11**. `isKycGatePassed()` (`cashout-payout.ts:90-118`) gana un 2º param y **una sola
línea nueva**. **B1-B10 quedan INTACTAS** — no toques ninguna otra línea de esta función:

```
  const kycProvider = getKycProvider();                    // B7: FUERA del try  ← INTACTA
  s = await kycProvider.status(verificationId, claim);     // B6/C12 en el catch ← solo el arg nuevo
  if (s.approved !== true) return false;                   // B2+B9             ← INTACTA
+ if (s.identityMatches !== true) return false;            // C11               ← NUEVA (AND, nunca OR)
  if (REAL_KYC_PROVENANCES.has(s.provenance)) return true; // B1                ← INTACTA
  ...                                                      // B3/B4/B5/B8       ← INTACTAS
```

> **🔴 C11 va DESPUÉS de `approved` y ANTES de la allowlist. Es un AND que SOLO PUEDE RESTAR allows.**
> **Invariante que el AR va a verificar: ningún camino que hoy devuelve `false` puede devolver `true` tras este
> cambio.** **PROHIBIDO** un `||`, un early-return que saltee B1-B10, o mover C11 fuera de esta posición.
> **PROHIBIDO** `!s.identityMatches` (truthiness) — es **`!== true` estricto**, igual que `approved` (CD-8).

El `console.warn` de discriminación fina para ops es **value-free** (CD-13) — **nunca el claim, nunca `vendor_data`**:

```ts
console.warn("[remit-payout] kyc identity binding mismatch:", { branch: "C11", identityClaimPresent: true });
```

**W2.4 — wiring. El ORDEN es load-bearing** (no lo cambies):

```ts
export async function runCashoutPayout(raw: unknown): Promise<CashoutPayoutOutput> {
  const input = CashoutPayoutInputSchema.parse(raw);   // 1.

  assertPayoutProviderSafe();                          // 2. INTACTO (CD-1) — throws primero, como hoy
  const provider = getPayoutProvider();                // 3. INTACTO — throws adapter_not_ready, como hoy

  // 4. WKH-204 / C1-C4 — DESPUÉS de 2 y 3 (CD-1: cuando hay dos problemas, gana el error de payout).
  //    C3/C4 bloquean SIN llamar al provider: no se gasta Didit ni se da señal al caller.
  const identityClaim = resolveIdentityClaim(input);
  if (identityClaim === null) {
    return { slug: SLUG, executed: false, status: "blocked", payoutId: null, deliveredLocal: null,
             txRef: null, reason: "kyc_identity_claim_missing", provenance: "n/a" };
  }

  // 5. Gate KYC (WKH-203) + binding de identidad (WKH-204, C11 adentro).
  if (!(await isKycGatePassed(input.kycVerificationId, identityClaim))) {
    return { /* ...los MISMOS 8 campos, reason: "kyc_gate_not_passed" — SIN CAMBIOS... */ };
  }
  // ... resolveTravelRuleData() y provider.execute() quedan IGUAL ...
}
```

> **El output sigue teniendo EXACTAMENTE 8 campos** (`route.test.ts:97-106` lo assertea). La rama nueva usa el
> mismo shape con `reason: "kyc_identity_claim_missing"`. **`assertPayoutProviderSafe()` (L52-76) byte-idéntica y
> primera** (CD-1). El STUB `resolveTravelRuleData()` (L174-182) **no se toca** (es WKH-168).

**Cierre W1+W2 (verificable)**: `npm run typecheck` **verde**. `npm run test` **todavía en rojo** — es esperado:
las suites aún no tienen el arrange de W3. **No cierres W2 "arreglando" código de producción para que los tests
viejos pasen**: lo que falta es el arrange (§10/C2).

---

### W3 — tests + docs (tras W1+W2)

> **🔴 Sin este arrange, W3 cierra con `tsc` en rojo y 13 tests en rojo.** Lo enumeró mal el SDD → **§10 corrección C2**.
> **Criterio (precedente ratificado en WKH-203/§2.1): los asserts son el contrato, el setup no.**
> **Todos los `expect(...)` existentes quedan BYTE-IDÉNTICOS. Solo crecen los bloques *arrange*.**

**W3.1 — `src/providers/kyc.test.ts` (17 tests, 7 puntos de arrange)**
- Los **6 call sites de `status()`** (**L46, L67, L87, L102, L109, L119**, verificados con grep) piden un 2º arg:
  `status("x")` → `status("x", "12345678")`. **Asserts intactos.**
- **L127-132, el fixture `valid: KycStatusResult`**: agregar `identityMatches: true`. **Sin esto el `tsc` de W3
  queda ROJO** (falta una propiedad requerida). *(Esto el SDD no lo menciona — §10/C2.)*

**W3.2 — `src/agents/cashout-payout.test.ts` (15 tests)**
- **Fixture `validInput` (L7-14)**: agregar `senderIdentity: "12345678"`. Sin esto, **C3 bloquea todo** y mueren
  **8** tests (L41, L56, L70, L82, L108, L124, L160, L184) y **1 queda hueco** (L96: pasa por C3, ya no prueba B4).
- **Los 3 `stubDiditDecision(...)`** (**L75, L87, L192**, verificados con grep): los que deben **APROBAR**
  (**L75** y **L192**) necesitan `vendor_data: "12345678"` para matchear el claim del fixture (C7). El de **L87**
  es `Declined` → bloquea en `approved !== true` antes de C11: no necesita `vendor_data` (y verificar que sigue
  dando `reason: "kyc_gate_not_passed"` es **el test de que C11 no cambió la semántica de B2**).

**W3.3 — `route.test.ts` (11 tests) — el gemelo HTTP. NO lo saltees.**
- **Fixture `validInput` (L18-25)**: agregar `senderIdentity: "12345678"`. Sin esto mueren **5** tests
  (L50, L72, L91, L122, L140) y **2 quedan huecos** (L62, L113).
- **Test (6), fetch stub (L148-154)**: agregar `vendor_data: "12345678"` al body `{ status:"Approved", session_id:"v1" }`.
- **Test (2) (L91-110)**: sus asserts (los 8 keys + `provenance:"local-fallback"`) **NO se tocan** — solo hereda el
  fixture. **El shape de salida no cambia en esta HU.**

**W3.4 — tests nuevos**: ver la tabla del §7.

**W3.5 — `README.md`**: actualizar el bloque del contrato del endpoint (`POST /api/agents/remit-cashout-payout/invoke`,
~L118-128): agregar `senderIdentity` al body de ejemplo, marcar `address` como **deprecado (compat `chaski-v2`)**,
agregar la línea de respuesta `→ 200 { "result": { "executed": false, "status": "blocked", "reason": "kyc_identity_claim_missing" } }`,
y **la frase obligatoria CD-6** — sin eufemismos:

> El binding `kycVerificationId` ↔ `senderIdentity` **sube la barra** (deja de ser un ataque de un solo dato) pero
> **NO constituye prueba criptográfica de posesión**: no hay firma ni SIWE, y `senderIdentity` es caller-controlado
> igual que `kycVerificationId`. Un atacante que consiga **ambos** datos pasa. Además, cuando la sesión KYC fue
> creada con un `vendor_data` **público** (ej. una wallet address, como hace `chaski-v2`), la protección de **ese**
> flujo es **≈nula**. La prueba de posesión real es una HU de seguimiento.

**W3.6 — `project-context.md`**: en `## Variables de Entorno` **NO agregar nada** (esta HU no agrega env vars).
Agregar: (a) la convención `senderIdentity` (string opaco + precedencia sobre `address` + `address` deprecado);
(b) en `### PROHIBIDO`, la regla **CD-11**: *"NUNCA `z.enum`/`z.literal` en un campo de input que pueda contener PII
mientras el 400 devuelva `parsed.error.flatten()`: Zod **ecoa el valor recibido** en el mensaje del enum"*;
(c) la entrada de Auto-Blindaje.

**Cierre W3 (verificable)**: `npm run typecheck` verde **+** `npm run test` verde — **suite COMPLETA, ≥79 tests,
0 rojos**, con `kyc-validator.test.ts` (**5** tests) **sin modificar**.

---

## 5. Las 12 ramas del binding (C1-C12) — una por una. **TODAS fail-closed.**

> Numeradas **C** para no colisionar con las **B1-B10** de WKH-203, que **no se tocan**.
> **Ninguna rama tiene un default "else → allow".**

### Resolución del claim — `runCashoutPayout()`, antes del gate

| # | Condición | Resultado esperado |
|---|-----------|--------------------|
| **C1** | `senderIdentity` presente | `claim = senderIdentity` — camino explícito (preferente, CD-15) |
| **C2** | `senderIdentity` ausente **y** `address` presente | `claim = address` — puente legado `chaski-v2` (CD-16) |
| **C3** | ninguno de los dos | **BLOCK** `200 { executed:false, status:"blocked", reason:"kyc_identity_claim_missing", provenance:"n/a" }`. **NO se llama al provider** (no se gasta Didit ni se da señal) |
| **C4** | claim presente pero `normalizeIdentity(claim) === ""` (ej. `"   "`) | **BLOCK** `kyc_identity_claim_missing`. ⚠️ **ALCANZABLE**: `min(1)` **no trimea** (verificado ejecutando — ver el aviso 🔴 de W2.2) |

### Comparación — DENTRO de `DiditKycProvider.status()`

| # | Condición | Resultado esperado |
|---|-----------|--------------------|
| **C5** | `vendor_data` ausente / `""` | `identityMatches:false` → **BLOCK**. ⚠️ **Divergencia DELIBERADA de `chaski-v2`**: `authority.ts:83` (`d.vendorData !== "" && d.vendorData.toLowerCase() !== address.toLowerCase()`) **OMITE el check si viene vacío → fail-OPEN, probado ejecutando por el AR de WKH-202**. Acá "no hay contra qué comparar" = **BLOQUEAR**. **PROHIBIDO "alinear" con `chaski-v2`: la divergencia ES el fix** (CD-12) |
| **C6** | `normalizeIdentity(vendor_data) !== normalizeIdentity(claim)` | `identityMatches:false` → **BLOCK**, `reason` colapsado `kyc_gate_not_passed` (ver §6 DT-3) |
| **C7** | ambos no-vacíos y normalizados iguales | `identityMatches:true` — **única rama que abre** |
| **C8** | `vendor_data` no-string (number / object / array / null) | `typeof`-narrowing → `""` → cae en **C5** → **BLOCK**. 🔴 **NUNCA `String(...)`** — ver §10/C1 |

### Guard, fallback y gate

| # | Condición | Resultado esperado |
|---|-----------|--------------------|
| **C9** | `FallbackKycProvider.status()` | `identityMatches:true` — **inocuo por construcción**: B3 lo bloquea en prod SIEMPRE; en dev/CI exige `ALLOW_FALLBACK_KYC=true` (B5) |
| **C10** | `typeof s.identityMatches !== "boolean"` | **THROW** `invalid_kyc_status_identity` en `assertValidKycStatus` → 502. Espejo del guard de `approved` (anti-WKH-198) |
| **C11** | `s.identityMatches !== true` en `isKycGatePassed()` | **BLOCK**. **Estricto `!== true`, NUNCA truthiness** (CD-8). AND, jamás OR |
| **C12** | el provider lanza al resolver (timeout / DNS / `!res.ok` / JSON inválido) | `kyc_gate_unavailable` → **502**. **Rama B6 existente, SIN CAMBIOS** — "no sé" ≠ "es tuyo" |

**Invariante que el AR va a verificar**: `provider.execute()` **NO se invoca** en ninguna rama C salvo C7 (+ C9 en
dev/CI con opt-in). Y **C11 solo puede restar allows** (§4 W2.3).

### 🔴 El patrón recurrente que estas ramas atacan (≥2 HUs — por eso son CDs)

**WKH-198** (`NaN` fail-open) + **WKH-203** (`approved` no-booleano) + **WKH-202** (`vendorData === ""` omite el
check) = **"un valor ausente o de tipo inesperado se lee como señal positiva"**. Es **el mismo bug tres veces**.
**C4 / C5 / C8 / C10 / C11 lo atacan de frente en las 4 superficies nuevas.** No las relajes.

---

## 6. Las 3 reglas nuevas que más fácil se rompen

### 🔴 CD-11 — PROHIBIDO `z.enum` / `z.literal` en `senderIdentity` (fuga de PII)

**Verificado ejecutando** contra el zod 3.25.76 del repo. Con un discriminado `{type: z.enum([...]), value}`, un
caller que swapee `type`/`value` produce esto **dentro de `parsed.error.flatten()`**:

```json
{"formErrors":[],"fieldErrors":{"type":["Invalid enum value. Expected 'wallet_address' | 'legal_id', received 'DNI-12345678'"]}}
```

...y **`route.ts:15` devuelve `parsed.error.flatten()` tal cual en el body del 400** (y el gateway lo persiste).
**Eso publica el DNI.** Contraste verificado — `z.string()` es **value-free**:
`{"fieldErrors":{"senderIdentity":["Expected string, received number"]}}`.

⇒ **`senderIdentity` es `z.string()` opaco.** Regla general asentada en `project-context.md` (W3.6).

### 🔴 CD-16 — el puente legado `address`

**Cómo funciona**: `claim = input.senderIdentity ?? input.address`. **Por qué existe**: `chaski-v2` ya manda
`address` no-vacío y forwardea el body verbatim → **el claim ya llega hoy**, solo se strippea. **Por qué está
deprecado**: acopla este repo a un nombre de campo interno de otro repo. **`chaski-v2` NO se toca** (CD-2).
**NO es un fail-open**: `address` es un claim real que se compara con las mismas ramas fail-closed.
Se elimina cuando `chaski-v2` mande `senderIdentity` (follow-up cross-repo).

### DT-3 — el `reason` colapsa a propósito (no-oracle)

| Situación | `reason` en el response |
|---|---|
| KYC no aprobado (B2-B9) **o** identidad no coincide (C5/C6) | **`kyc_gate_not_passed`** — el de hoy, **sin cambio** |
| Claim ausente / vacío (C3/C4) | `kyc_identity_claim_missing` |

**PROHIBIDO** un `reason` que distinga "no aprobado" de "aprobado pero no es tuyo": convertiría al endpoint en un
**oráculo** (permitiría confirmar DNIs de a uno). Sigue el precedente CD-12 de WKH-202 (`submit/route.ts:83-87`
mapea `kyc_not_approved` y `kyc_ownership_mismatch` al mismo `payout_not_authorized`). `kyc_identity_claim_missing`
**sí** es seguro: habla del **request del propio caller**, no revela nada de la verificación ajena.
La discriminación fina vive en `console.warn` **server-side y value-free** (CD-13).

---

## 7. Tests requeridos (≥1 por AC)

> **🔴 ARRANGE**: todo test nuevo que llegue al gate necesita, además del claim, el setup del fail-safe de payout
> (el gate va **después** de `assertPayoutProviderSafe()`, y vitest setea **`NODE_ENV="test"`**):
> - **dev**: `vi.stubEnv("TRANSFI_API_KEY",""); vi.stubEnv("ALLOW_FALLBACK_PAYOUT","true");`
> - **prod**: `vi.stubEnv("NODE_ENV","production"); vi.stubEnv("TRANSFI_API_KEY",""); vi.stubEnv("PAYOUT_ALLOW_MOCK","true");`
>
> Y para **KYC real aprobado**: `vi.stubEnv("DIDIT_API_KEY","k"); vi.stubEnv("DIDIT_ADAPTER_READY","true");`
> + `stubDiditDecision({ status:"Approved", session_id:"v1", vendor_data:"12345678" })`.

| AC / rama | Archivo | Caso | Aserción |
|---|---|---|---|
| **AC-1** | `cashout-payout.test.ts` | `senderIdentity:"99999999"` + Didit `Approved` con `vendor_data:"12345678"` (**C6**) | `{executed:false, status:"blocked", reason:"kyc_gate_not_passed"}` **y** `executeSpy` **NUNCA invocado** |
| **AC-1** | `cashout-payout.test.ts` | claim que **SÍ** matchea + `provenance:"didit"` (**C7/B1**) | `executed:true` — prueba que el gate **no bloquea de más** |
| **AC-2** | `cashout-payout.test.ts` | **sin** `senderIdentity` ni `address` (**C3**) | blocked + `reason:"kyc_identity_claim_missing"` **y** `fetch` **NUNCA llamado** (no se gasta Didit) |
| **AC-2** | `cashout-payout.test.ts` | `senderIdentity:"   "` (**C4** — el caso que `min(1)` deja pasar) | blocked + `reason:"kyc_identity_claim_missing"` |
| **AC-2** | `kyc.test.ts` | Didit `Approved` **sin** `vendor_data` (**C5** — la divergencia anti-`chaski-v2`) | `identityMatches:false` (y `approved:true` → prueba que **son ejes independientes**) |
| **AC-2** | `cashout-payout.test.ts` | idem a nivel agente (**C5**) | blocked, `executeSpy` no invocado |
| **AC-2** | `kyc.test.ts` | `vendor_data` **no-string**: `123`, `null`, `{}` (**C8**) | `identityMatches:false` en los 3. 🔴 **El caso `123` con claim `"123"` es el que mata al `String()`-guard** (§10/C1) |
| **AC-2** | `kyc.test.ts` | `vendor_data:"  12345678  "` vs claim `"12345678"` (normalización) | `identityMatches:true` |
| **AC-2** | `kyc.test.ts` | `vendor_data:"0xAbCd"` vs claim `"0xabcd"` (address case-insensitive) | `identityMatches:true` — sirve a las 2 convenciones |
| **AC-2** | `cashout-payout.test.ts` | `status()` lanza (**C12/B6**) | `rejects.toThrow(/kyc_gate_unavailable/)` — no allow |
| **AC-2** | `kyc.test.ts` | `assertValidKycStatus({...valid, identityMatches: undefined as unknown as boolean })` (**C10**) | `toThrow(/invalid_kyc_status_identity/)` — anti-WKH-198 |
| **AC-2** | `kyc.test.ts` | `FallbackKycProvider.status("x","lo-que-sea")` (**C9**) | `identityMatches:true` + `provenance:"local-fallback"` |
| **AC-3** | `route.test.ts` | `senderIdentity:"12345678"` (**un DNI real**) en 200-blocked / **400** / 502 | `JSON.stringify(body)` **no contiene** `"12345678"`, `"vendor_data"`, `"legalId"`, `"travelRuleData"`, `"Bob"`, `"999888777"`. **El caso 400 es el probe de CD-11** |
| **AC-4** | suite completa | regresión | **≥79 verdes**; `git diff -U0 HEAD -- <test files>` → **solo arranges**, `expect(...)` byte-idénticos |
| **AC-4** | `cashout-payout.test.ts` | B1-B10 intactas (L41/56/70/82/96/108/124/160/184) | verdes con asserts intactos; **C11 no convierte ningún `false` en `true`** |
| **AC-4** | `kyc-validator.test.ts` | **SIN TOCAR** | sus **5** tests verdes |
| **AC-5** | `cashout-payout.test.ts` | **caller legado**: `address:"12345678"` **sin** `senderIdentity` (**C2**) | **usa `address`** → ejecuta (con Didit `vendor_data:"12345678"`); **NO 400** — compat `chaski-v2` |
| **AC-5** | `cashout-payout.test.ts` | `senderIdentity:"12345678"` **y** `address:"99999999"` (distintos) (**CD-15**) | **gana `senderIdentity`** → ejecuta con `vendor_data:"12345678"` |
| **AC-5** | `cashout-payout.test.ts` | `address` en el raw → `safeParse` | `success:true` **y** el campo **no rompe** el schema (compat) |
| **AC-6** | — | grep del README/SDD por la frase de calificación | checklist F4 (QA), no test de código |

> **🔴 Mocking (auto-blindaje WKH-203)**: usar **`vi.spyOn(FallbackPayoutProvider.prototype, "execute")`**
> (`cashout-payout.test.ts:32`) y `stubDiditDecision()` (`cashout-payout.test.ts:17-22`).
> **NO uses `vi.mock`**: es **hoisted a todo el archivo** → riesgo de falso verde. El Dev de WKH-203 evitó
> exactamente ese falso verde cambiando a `vi.spyOn(prototype)`. **No lo revuelvas.**
> Todo `describe` que use `vi.stubGlobal` **debe** limpiar con `vi.unstubAllEnvs()` **y** `vi.unstubAllGlobals()`
> en `afterEach` (patrón real en `cashout-payout.test.ts:34-38`).

> **Sugerencia para el AR — mutation testing.** El AR de WKH-203 verificó que **8/9 mutaciones del gate mueren**.
> **El Dev no puede bajar ese número.** Mutantes candidatos, que **DEBEN morir**: `!== true` → truthiness;
> C5 → `vendorData !== "" &&` (**la forma exacta del fail-open de `chaski-v2` — este mutante es el caso estrella**);
> C11 → borrarla; `normalizeIdentity` → identidad; `typeof`-narrowing → `String(...)` (§10/C1).

**Gotcha verificado (WKH-203)**: `DIDIT_BASE` (`kyc.ts:7`) se evalúa a **import time** → `vi.stubEnv("DIDIT_BASE_URL")`
**NO** lo afecta. No hace falta: los tests mockean `fetch`, no la URL.

---

## 8. Comandos y gate de verificación por wave

```bash
cd /home/ferdev/.openclaw/workspace/wasiai-remittance-agents
npm run typecheck   # tsc --noEmit  ← AUTORITATIVO
npm run test        # vitest run — suite COMPLETA
```

> **🔴 PROHIBIDO cerrar una wave validando solo con `npm run build` (lección WKH-196).** `npm run build` es
> `next build` y **NO typechequea los tests**; en WKH-196 eso dejó pasar un error de tipos en un test.
> **Verificado en ESTE repo**: `tsconfig.json` tiene `"include": [..., "**/*.ts", ...]` → **`npm run typecheck`
> SÍ cubre `*.test.ts`**. Ese es el comando de esta HU.

| Wave | Gate de cierre (verificable) |
|------|------------------------------|
| **W0** | `npm run typecheck` **FALLA a propósito** (2 impls sin el 2º param + `identityMatches` faltante + fixture `valid`). Sin `any` / `@ts-ignore` / params u opcionales de conveniencia. |
| **W1** | `npm run typecheck`: `kyc.ts` sin errores propios. (La suite sigue roja hasta W3 — esperado.) |
| **W2** | `npm run typecheck` **verde**. (La suite sigue roja hasta W3 — **esperado**: falta el arrange. **NO toques producción para verdearla.**) |
| **W3** | `npm run typecheck` verde **+** `npm run test` **suite COMPLETA, ≥79 tests, 0 rojos**, `kyc-validator.test.ts` (5) **sin tocar**. |

**Imports**: estilo existente — **relativos** dentro de `src/` (`../providers/kyc`, como `cashout-payout.ts:12`).
El alias `@/` se usa **solo** desde `app/api/**`. `cashout-payout.ts` ya importa de `"../providers/kyc"` (L12):
**agregá `normalizeIdentity` a ese import existente**, no crees uno nuevo.

---

## 9. Riesgo residual — leelo, **no lo "arregles"**

| # | Riesgo | Qué hacer |
|---|--------|-----------|
| **R-1** 🔴 | **Para el flujo `chaski-v2` el binding es ≈teatro**: su `vendor_data` es la **wallet address = dato público on-chain**. El AC-1 se cumple mecánicamente; la protección real de **ese** flujo es **~nula**. | **ACEPTADO como riesgo documentado por el humano (decisión de producto). NO bloquea.** Se implementa igual (defensa en profundidad, coste ~0, cierra el fail-open C5). **PROHIBIDO** (CD-6) documentarlo como protección de ese flujo. **Debe viajar al done-report sin eufemismos.** La HU de prueba de posesión está registrada aparte. |
| **R-2** 🔴 | **G3 / WKH-168 sigue abierta** → **cerrar G4 NO habilita la Fase A**. Un atacante con **su propio** KYC Approved y **su propia** claim (que matchea perfecto) sigue pudiendo pedir un payout con monto y beneficiario arbitrarios **sin haber pagado el principal**. | **NO setear `TRANSFI_ADAPTER_READY=true`** hasta que G3 esté DONE. |
| **R-3** | El puente legado `address` acopla este repo a un nombre de campo interno de `chaski-v2`. Si `chaski-v2` lo renombra, el claim desaparece. | **Falla cerrado** (C3 → blocked, nunca allow). CD-16 lo marca deprecado con condición de salida. |
| **R-4** | `identityMatches` como **oráculo** de confirmación de DNI (de a uno). | Inviable económicamente: `PRICE_USDC = 0.03` (`cashout-payout.ts:16`) × 10⁸ preimágenes de un DNI de 8 dígitos ≈ **$3M** + 10⁸ llamadas a Didit. El rate-limit es del gateway. **Documentado, no se mitiga acá.** |
| **R-5** 🔴 | **El diseño depende de que Didit realmente ECOE `vendor_data`** en `GET /v3/session/{id}/decision/`. `chaski-v2` lo asume (`decision.ts:19`) y WKH-180 lo dio por bueno, pero **este repo NUNCA lo verificó contra el sandbox**. | **Es fail-SAFE**: si no lo ecoa → **C5 → blocked**, nunca fail-open. **NO bloquea esta HU.** **Sumalo como 3er item del checklist de `DIDIT_ADAPTER_READY`** (§9b). Dejá el TODO referenciando `R-5 / WKH-204`. **PROHIBIDO** "arreglarlo" tocando `verify()` (Scope OUT). |
| **R-6** | El `assertPayoutProviderSafe()` mantiene el path real **inerte**: nadie setea `TRANSFI_API_KEY`+`TRANSFI_ADAPTER_READY`. | Precondición de Fase A, **no incidente activo**. No lo uses como excusa para diseñar flojo: el diseño debe ser correcto **ahora**. |

### 9b. Checklist de `DIDIT_ADAPTER_READY` — ahora **3** items bloqueantes

El TODO de `kyc.ts:59-75` ya lista 2. **Esta HU agrega el 3º.** Actualizá ese bloque de comentario:

1. **Compat v2↔v3** (R-1 de WKH-203): que un `session_id` creado con `POST /v2/session/` (`verify()`, `kyc.ts:23`)
   sea consultable por `GET /v3/session/{id}/decision/`. **Fail-safe** (→ B6 → 502).
2. **Forma de `aml.hits`** (AR/MNR-1): **fail-OPEN latente** — si no es un array, `amlHits` cae a 0 en silencio.
3. **🆕 (WKH-204 / R-5): que `/v3/session/{id}/decision/` realmente ECOE `vendor_data`**, y con qué nombre/forma
   exacta. **Fail-safe** (→ C5 → blocked). **Sin esto confirmado, el binding entero bloquea todo en prod.**

> **⛔ Cerrar WKH-204 NO habilita la Fase A.** El gate se declara cerrado solo con **G1 + G2 + G3 (WKH-168) + G4**,
> más el checklist de `DIDIT_ADAPTER_READY` (3 items).

---

## 10. Corrección al SDD (defectos reales hallados al traducir — **avisados al orquestador**)

> El SDD es la fuente de verdad, pero al traducirlo a instrucciones ejecutables verifiqué cada claim contra el
> disco y la suite. **Dos defectos reales, ambos de impacto alto.** El Story File (arriba) **ya los corrige**;
> se listan acá para que el AR no los lea como desviación del Dev.

### C1 — 🔴 (fail-open real) El `String()`-guard de C8 **NO bloquea** los no-strings. Contradice al propio SDD.

El SDD §4, fila **C8**, especifica: *"`vendor_data` no-string (number/object/null) → **`String()`-guard → `""`** →
cae en **C5** → **BLOCK**"*. **Es falso, y verificado ejecutando:**

```
vendor_data=123   | String(v??"") = "123"              | narrow = "" | ¿bloquea por C5? NO  <-- ALCANZA LA COMPARACIÓN
vendor_data={}    | String(v??"") = "[object object]"  | narrow = "" | ¿bloquea por C5? NO  <-- ALCANZA LA COMPARACIÓN
vendor_data=null  | String(v??"") = ""                 | narrow = "" | ¿bloquea por C5? YES
```

`String(123)` es `"123"`, **no `""`**. Con el guard literal del SDD, un `vendor_data: 123` **alcanza la
comparación** y un atacante que reclame `"123"` **matchea → ALLOW**. Ídem `{}` con el claim `"[object Object]"`.
**Es un fail-open** — y de la **misma clase exacta** que el patrón recurrente que el propio SDD §11 identifica
(*"un valor ausente o de tipo inesperado se lee como señal positiva"*, WKH-198 + WKH-203 + WKH-202).

El SDD **se contradice a sí mismo** en esa fila: la columna "Nota" dice *"tipado `Record<string, unknown>` +
**narrowing**"*, que es lo correcto. **Gana el narrowing** (y gana la Done Definition — precedente del auto-blindaje
de WKH-203). **Corregido en W1.2**: `typeof vendorRaw === "string" ? vendorRaw : ""`.
*Sin esto, C8 nacía fail-open y el mutante `String(...)` sobrevivía al mutation testing.*

### C2 — 🔴 (impacto real) El SDD enumera el arrange de W3 **solo para `kyc.test.ts`** → W3 cerraba con `tsc` rojo y **13 tests rojos**.

El SDD §7/W3 dice: *"Tests nuevos (§8) + **arrange-only** en los 6 call sites de `status()` de `kyc.test.ts`"*.
Los 6 call sites son correctos (L46/67/87/102/109/119, verificados con grep). **Pero es el único arrange que nombra.**
Verificado test por test contra el disco, faltan:

| Archivo | Qué falta en el SDD | Consecuencia si no se hace |
|---|---|---|
| `kyc.test.ts` | el fixture **`valid: KycStatusResult` (L127-132)** necesita `identityMatches: true` | **`tsc` ROJO** (propiedad requerida faltante) |
| `cashout-payout.test.ts` | el fixture **`validInput` (L7-14)** necesita el claim; los `stubDiditDecision` de **L75** y **L192** necesitan `vendor_data` | **8 tests ROJOS** (L41, L56, L70, L82, L108, L124, L160, L184) + **1 hueco** (L96 pasa por C3 y deja de probar B4) |
| `route.test.ts` | el fixture **`validInput` (L18-25)** necesita el claim; el fetch stub del **test (6) (L148-154)** necesita `vendor_data` | **5 tests ROJOS** (L50, L72, L91, L122, L140) + **2 huecos** (L62, L113) |

**Total: `tsc` rojo + 13 tests rojos + 3 huecos.** Es **exactamente** la lección que el SDD §11 dice haber aplicado
(*"un gate nuevo tiene gemelos a nivel route, no solo unit — el SDD de WKH-203 se saltó el route → 3 rojos"*): el
SDD §11 **afirma** que *"§7/W3 cuenta con arrange-growth en los 3 niveles"*, pero el texto de §7/W3 **solo nombra
`kyc.test.ts`**. La intención estaba; la especificación no. **Corregido en W3.1/W3.2/W3.3**, con los archivos, las
líneas y el efecto de cada uno. **El objetivo del SDD (AC-4: 79/79 con asserts byte-idénticos) SÍ es alcanzable** —
verifiqué que **todo** lo que se rompe se restaura con arrange, sin tocar un solo `expect(...)`.
*Sin esto, W3 cerraba en rojo y el Dev habría tenido que improvisar el criterio.*

### Nota menor (sin impacto, resuelta, no es defecto)
El SDD dice *"`normalize(s)` — única función"* pero **no dice dónde vive**. La puse **exportada en `kyc.ts`**
(W1.1), consumida por `kyc.ts` y `cashout-payout.ts`, replicando el precedente ya auditado de
`REAL_KYC_PROVENANCES` (CD-9 de WKH-203: fuente única, dos consumidores, prohibido duplicar).

---

## 11. Anti-Hallucination Checklist (verificá ANTES de codear)

- [ ] **Baseline**: `npm run typecheck` limpio + `npm run test` = **79 tests / 9 archivos en verde** ANTES de tocar
      nada. **Contalo ejecutando, no leyendo.** Si no da 79, **parás**.
- [ ] **`status()` tiene UN SOLO call site de producción**: `cashout-payout.ts:97` (verificado con
      `grep -rn "\.status(" src --include=*.ts | grep -v test`). `kyc-validator.ts` **NO** llama a `status()`.
- [ ] **`KycProvider` tiene exactamente 2 impls**: `DiditKycProvider` (`kyc.ts:16`) y `FallbackKycProvider`
      (`kyc.ts:106`). Verificado con `grep -rn "implements KycProvider" src`. Ambas deben ganar el 2º param.
- [ ] **`vendor_data` en ESTE repo es el DNI** (`kyc.ts:33`, `verify()`: `vendor_data: input.legalId`) → **PII**.
      La comparación vive **dentro** del provider (§2.1). **Nunca** lo expongas en `KycStatusResult`.
- [ ] **`verify()` (`kyc.ts:19-56`) NO se toca.** Sus 4 `as any` (`kyc.ts:43/44/45/53`) son **preexistentes** y
      **Scope OUT**: no los toques ni los uses como excusa. **El `status()` de hoy (`kyc.ts:58-97`) tiene CERO `any`
      — dejalo así.** Repo en **cero `any` nuevo**: los 8 existentes están en `fx.ts`(2)/`payout.ts`(2)/`kyc.ts::verify()`(4).
- [ ] **`assertPayoutProviderSafe()` está en `cashout-payout.ts:52-76` y NO se toca** (CD-1). Es **distinta** de
      `isKycGatePassed()` (L90-118), donde va la **única línea nueva** (C11).
- [ ] **`getKycProvider()` va FUERA del `try`** de `isKycGatePassed()` (`cashout-payout.ts:94`) — rama **B7**,
      fail-loud. Si lo metés adentro, su throw se vuelve `kyc_gate_unavailable` y rompés B7 y su test.
- [ ] La comparación del gate es **`!== true`** (`approved` **y** `identityMatches`). **PROHIBIDO** truthiness.
      **PROHIBIDO "alinear" con la truthiness `!kyc.approved` de `kyc-validator.ts:55` — la divergencia es
      intencional** (CD-8 / anti-WKH-198).
- [ ] **`REAL_KYC_PROVENANCES` (`kyc.ts:13`) NO se toca**: allowlist **única**, **2 consumidores**
      (`kyc-validator.ts` y `cashout-payout.ts`). **PROHIBIDO duplicarla.** Allowlist, **nunca** denylist.
- [ ] **`z.object` sin `.strict()`** → Zod **strippea** las keys desconocidas (verificado ejecutando, zod 3.25.76).
      Por eso `address` **ya llega hoy** de `chaski-v2` y solo se descarta.
- [ ] **`z.string().min(1)` NO trimea** (verificado ejecutando: `"   "` → `success:true`). **C4 es alcanzable.**
- [ ] **`z.enum` ecoa el valor recibido** en `flatten()` y `route.ts:15` lo devuelve en el 400 → **CD-11**.
- [ ] El output sigue teniendo **exactamente 8 campos** (`route.test.ts:97-106` lo assertea).
- [ ] **Mocking**: `vi.spyOn(FallbackPayoutProvider.prototype,"execute")` + `stubDiditDecision()`. **NO `vi.mock`**
      (hoisted → falso verde). `afterEach` con `vi.unstubAllEnvs()` **y** `vi.unstubAllGlobals()`.
- [ ] **NO** crear `.env.example`, **NO** agregar env vars, **NO** agregar DB/KV ni secretos (CD-8).
- [ ] **NO** tocar `route.ts` de producción, `kyc-validator.ts`, `kyc-validator.test.ts`, ni nada fuera de este
      repo (CD-2). **NO** implementar SIWE ni WKH-168.
- [ ] **NO usar `git stash`** (HU sin commits: el `git diff` de untracked retorna vacío ≠ "intacto").
      Para AC-4 usá `git diff -U0 HEAD -- <archivo>`.

---

## 12. Constraint Directives — chequealas UNA POR UNA

| CD | Regla | Cómo la cumplís |
|----|-------|-----------------|
| **CD-1** 🔴 | **Money-path intocable.** PROHIBIDO debilitar/saltear/volver condicional `assertPayoutProviderSafe()` (`cashout-payout.ts:52-76`): `TRANSFI_API_KEY`+`TRANSFI_ADAPTER_READY`, `PAYOUT_ALLOW_MOCK`, `ALLOW_FALLBACK_PAYOUT`. Esta HU **AGREGA** un gate, **no relaja ninguno**. | Queda **byte-idéntica y primera** (§4 W2.4) |
| **CD-2** 🔴 | **Aislamiento de repos.** PROHIBIDO modificar `chaski-v2` / `wasiai-a2a` / el demo live (`agentshop-*`, `wasiai-agentshop.vercel.app`, `chaski-ai.vercel.app`). **Leerlos: SÍ.** | Solo tocás los **8** archivos del §3 |
| **CD-3** 🔴 | **No romper WKH-203**: B1-B10 de `isKycGatePassed()`, `REAL_KYC_PROVENANCES` (`kyc.ts:13`), y `approved !== true`. **El AR de WKH-203 probó por mutation testing que 8/9 mutaciones del gate mueren: no podés bajar ese número.** | C11 es **una sola línea insertada** (§4 W2.3); §7 lo verifica |
| **CD-4** 🔴 | **PII fuera de TODO response** (200/400/502): `beneficiary.name`/`destination`, `travelRuleData`, `legalId`, el **`vendor_data` crudo** y **el `senderIdentity` recibido**. | blocked = 8 campos; 502 = body fijo opaco; 400 = `flatten()` **value-free gracias a CD-11**; §7/AC-3 lo testea |
| **CD-5** 🔴 | **Fail-closed sin `else → allow`.** Cada ambigüedad tiene su rama explícita de bloqueo. **PROHIBIDO habilitar el payout real.** Ninguna wave toca `TRANSFI_*`. | §5 (C1-C12), default = BLOQUEAR |
| **CD-6** 🔴 | **No sobre-prometer.** Ningún artefacto puede afirmar que el IDOR queda "cerrado". Frase obligatoria en README (W3.5). **R-1 (teatro para `chaski-v2`) se dice sin eufemismos.** | §2.5 + §9 R-1 + W3.5 |
| **CD-7** | **Impacto cross-agente: NO se activa.** `verify()`, `KycInput`, `KycResult` y `kyc-validator.ts` **byte-idénticos** → `remit-kyc-validator` intacto. | §2.1 (blast radius por grep) |
| **CD-8** | **Cero persistencia consciente**: cero estado nuevo, cero secretos, cero env vars, cero DB/KV. | El diseño (a) no necesita nada de eso |
| **CD-9** | **Cero `any` explícito nuevo**, cero `@ts-ignore`, cero opcionales de conveniencia. | `Record<string, unknown>` + `typeof`-narrowing (W1.2) |
| **CD-10** | **Nunca 500**: todo error nuevo → 502 opaco vía `route.ts` (sin tocarlo). | C10/C12 propagan → el `catch` de `route.ts:23-30` ya mapea a `502 { error:"payout_unavailable" }` con warn de solo `err.name` |
| **CD-11** 🔴 | **PROHIBIDO `z.enum`/`z.literal`** en campos de input con PII potencial mientras el 400 devuelva `flatten()` (**ecoa el valor recibido**). | `senderIdentity`/`address` = `z.string()` opaco (§6) |
| **CD-12** 🔴 | **PROHIBIDO replicar el fail-open de `chaski-v2`**: `vendor_data` ausente/vacío/no-string **BLOQUEA** (C5/C8). **PROHIBIDO "alinear" con `authority.ts:83`** — **la divergencia ES el fix**. | §5 C5/C8 + el mutante estrella del AR |
| **CD-13** 🔴 | **El claim NUNCA se ecoa, loguea ni persiste.** `console.warn` solo value-free (`branch`, `identityClaimPresent`). Nunca el claim ni `vendor_data`. | §4 W2.3 |
| **CD-14** 🔴 | **`identityMatches` es un AND que SOLO resta allows.** PROHIBIDO que C11 vuelva `true` un camino que hoy da `false`. PROHIBIDO OR / early-return que saltee B1-B10. | §4 W2.3 (posición fija) |
| **CD-15** | **Precedencia determinística**: `senderIdentity` > `address`. PROHIBIDA una rama "ambos y discrepan → ambiguo". | §4 W2.2 (`??`) |
| **CD-16** | **`address` es legado y deprecado**: existe solo para no romper `chaski-v2`. PROHIBIDO construir features nuevas sobre él. | §6 + comentario en el schema |

---

## 13. Done Definition

- [ ] Los **8 archivos** del Scope IN (§3) modificados; **ningún otro** tocado; **nada fuera de este repo**.
- [ ] `KycStatusResult.identityMatches: boolean` + `KycProvider.status(verificationId, identityClaim)` con el 2º
      param **REQUERIDO** (no opcional). `verify()`/`KycInput`/`KycResult` **byte-idénticos**.
- [ ] **`vendorData` NUNCA sale del provider.** `KycStatusResult` sin `vendorData`/`legalId`/`identity`/`travelRuleData`.
- [ ] Las **12 ramas C1-C12** implementadas; **default = BLOQUEAR**; sin ninguna rama "else → allow".
- [ ] **C8 usa `typeof`-narrowing, NO `String(...)`** (§10/C1) — y hay un test con `vendor_data: 123` + claim `"123"`.
- [ ] **C4 existe** y hay un test con `senderIdentity: "   "` (`min(1)` no trimea).
- [ ] **C11 es `!== true`**, va **después de `approved` y antes de la allowlist**, y **ninguna** rama que hoy da
      `false` pasa a dar `true`.
- [ ] `assertPayoutProviderSafe()` **byte-idéntica y primera**; `resolveTravelRuleData()` **STUB intacto**;
      B1-B10 y `REAL_KYC_PROVENANCES` **intactas**; `approved !== true` **intacto**.
- [ ] `normalizeIdentity()` exportada **una sola vez** de `providers/kyc.ts`, consumida por los 2 archivos.
- [ ] `senderIdentity` y `address` son **`z.string().min(1).optional()`** — **sin `z.enum`/`z.literal`** (CD-11).
- [ ] `kyc-validator.ts` **byte-idéntico**; `kyc-validator.test.ts` (**5** tests) verde **SIN modificación**.
- [ ] Los tests preexistentes verdes con **asserts byte-idénticos** — solo crecieron los **arrange** (§10/C2);
      confirmado con `git diff -U0 HEAD -- <test files>` (**no `git stash`**).
- [ ] ≥1 test por AC (§7), incluido el **AC-3 con un DNI real** en el body del 400 (probe de CD-11).
- [ ] `README.md` con `senderIdentity`, `address` **deprecado**, `kyc_identity_claim_missing` y **la frase CD-6**
      (incluida la calificación de R-1 sobre `chaski-v2`, **sin eufemismos**).
- [ ] `project-context.md`: convención `senderIdentity` + **regla anti-`z.enum`** + Auto-Blindaje. **Sin env vars nuevas.**
- [ ] El checklist de `DIDIT_ADAPTER_READY` (`kyc.ts:59-75`) actualizado a **3 items** (R-5, §9b).
- [ ] **Cero `any` explícito nuevo** (los 8 preexistentes intactos), cero `@ts-ignore`, cero opcionales de conveniencia.
- [ ] **`npm run typecheck` verde** (AUTORITATIVO — **no** `npm run build`, lección WKH-196).
- [ ] **`npm run test` verde: suite COMPLETA, ≥79 tests, 0 rojos.**
- [ ] Ningún TODO huérfano: R-5 → `DIDIT_ADAPTER_READY` checklist; posesión/SIWE → HU de seguimiento; G3 → WKH-168.
- [ ] **`TRANSFI_ADAPTER_READY` sigue SIN setear** (R-2): cerrar G4 **no** habilita la Fase A.
