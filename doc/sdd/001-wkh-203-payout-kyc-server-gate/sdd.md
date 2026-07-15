# SDD — [WKH-203] El agente de payout no debe confiar en `kycPayoutAllowed` del caller

> Fase F2 (NexusAgil QUALITY) · Input: `work-item.md` (HU_APPROVED 2026-07-15) + `project-context.md`
> Repo: `wasiai-remittance-agents` · Branch sugerido: `feat/001-wkh-203-payout-kyc-server-gate`
> **Sizing revisado: L → M** (la L venía de la incertidumbre de DT-1, ahora resuelta con evidencia en disco)

---

## 0. Resumen ejecutivo del diseño

`runCashoutPayout()` deja de leer el booleano del caller y pasa a **re-derivar** la decisión de compliance
server-side: `getKycProvider().status(kycVerificationId)` → allowlist de provenance (`REAL_KYC_PROVENANCES`,
la misma que ya usa `kyc-validator`) → allow/block. El campo `kycPayoutAllowed` **se elimina del schema**
(DT-4) — verificado que Zod lo strippea, así que **no rompe compat** con `chaski-v2`.

Decisiones cerradas: **DT-1 = opción (a)** (extender `KycProvider` con `status()`, sin persistencia nueva)
y **DT-4 = eliminar el campo del schema**. Ambas con evidencia verificada en este documento (§2, §4).

---

## 1. Context Map (archivos leídos — todos verificados en disco)

| Archivo | Por qué lo leí | Patrón / hecho extraído |
|---|---|---|
| `src/agents/cashout-payout.ts` (1-133, entero) | Es el archivo central de la HU | `assertPayoutProviderSafe()` (48-72); hard-gate legacy (82-93); orden `parse → assert → getProvider → resolveTravelRule → execute` (79-107); `resolveTravelRuleData()` es STUB (125-133) |
| `src/providers/types.ts` (1-90) | Contrato a extender | `KycProvider.verify()` (32-34); **`PayoutProvider.status(payoutId)` (84-90) = exemplar de forma para el método nuevo** |
| `src/providers/payout.ts` (1-118) | Exemplar del par adapter/fallback + `status()` + guard de salida | `TransFiPayoutProvider.status()` (44-60): fetch GET + `encodeURIComponent` + `AbortSignal.timeout(8000)` + `if (!res.ok) throw` + **echo del id pedido** (53); `assertValidPayout()` (99-105) = guard de salida fail-loud; `getPayoutProvider()` (108-118) = factory con readiness gate |
| `src/providers/kyc.ts` (1-113) | Donde vive el método nuevo | `DiditKycProvider.verify()` usa **`POST /v2/session/`** (17) y saca el id de `session_id ?? id` (47); `FallbackKycProvider` → `verificationId: "fallback-<hash>"` + `provenance: "local-fallback"` (73-74); `getKycProvider()` (103-113) = **gate `DIDIT_ADAPTER_READY`, fail-loud, sin downgrade silencioso** |
| `src/agents/kyc-validator.ts` (1-98) | Fuente del patrón fail-closed a espejar | `REAL_KYC_PROVENANCES` (54) = allowlist explícita, hoy **const privada**; `isPayoutAllowed()` (56-69) = `!approved → false` / real → true / `!isProd && ALLOW_FALLBACK_KYC` → true+warn / **default false** |
| `src/agents/cashout-payout.test.ts` (1-83) | CD-3 / AC-4 — contrato de no-regresión | `validInput` (4-11) con `kycVerificationId: "v1"`; `vi.stubEnv` + `afterEach(vi.unstubAllEnvs)`; **7 `it` en el rango 23-83** (ver §7.1 — el work-item dice "5") |
| `src/app/api/agents/remit-cashout-payout/invoke/route.ts` (1-31) | AC-5 / CD-4 | wrapper fino; 400 solo con `parsed.error.flatten()`; catch → `console.warn` con `err.name` + `{ error: "payout_unavailable" }` 502; nunca 500 |
| `src/app/api/agents/remit-cashout-payout/invoke/route.test.ts` (1-148) | Impacto colateral del gate | `beforeEach` stubea `TRANSFI_API_KEY=""` + `ALLOW_FALLBACK_PAYOUT=true` (34-37); **test (2) asserta EXACTAMENTE 8 keys del output (60-69)** → el shape de salida no se toca; patrón `vi.hoisted` + `vi.mock` (6-11) |
| `src/providers/kyc.test.ts` (1-57) | Exemplar de tests de provider | `FallbackKycProvider` directo + `getKycProvider` factory con `vi.stubEnv`; **hoy no hay ningún mock de `fetch` en el repo** |
| `src/agents/kyc-validator.test.ts` (1-57) | Verificar que mover la allowlist no rompe nada | testea solo `runKycValidator()`; **no referencia `REAL_KYC_PROVENANCES` directamente** → mover la const es seguro |
| `package.json`, `tsconfig.json`, `vitest.config.ts` | Comandos + typecheck real + alias | ver §8 (gotcha del typecheck) |
| `chaski-v2/app/api/payout/validate/route.ts` + `chaski-v2/src/infrastructure/didit/decision.ts` | **Referencia read-only** (CD-2: no se toca) | Evidencia de DT-1 (§2) |

**Auto-Blindaje histórico**: `doc/sdd/_INDEX.md` tiene 1 sola fila (esta HU) y `find doc/sdd -name auto-blindaje.md` → 0 resultados. No hay HUs DONE previas en este repo → paso salteado, no bloqueante. Sí se aplica la entrada de Auto-Blindaje ya cargada en `project-context.md` (el stub de `resolveTravelRuleData`) → ver DT-2.

---

## 2. DT-1 — RESUELTO: opción (a), extender `KycProvider` con `status()`. Sin persistencia.

### Evidencia (verificada por mí, no asumida)

Didit **sí** expone consulta de decisión por id de sesión, y ya está **en producción hoy** en el repo hermano
`chaski-v2` (leído read-only, CD-2 respetada):

- `chaski-v2/app/api/payout/validate/route.ts:60-61` → `GET ${BASE}/v3/session/${encodeURIComponent(verificationId)}/decision/`
  con `headers: { "x-api-key": apiKey }` y `signal: AbortSignal.timeout(10_000)`.
- Mapeo: `chaski-v2/src/infrastructure/didit/decision.ts:34-58` → `approved = status === "Approved"`,
  `verificationId = s(raw?.session_id)`, `provenance = "didit"`.
- Ramas fail-closed ya probadas ahí: `!res.ok → kyc_reauth_failed` (502, línea 65), `status !== Approved →
  kyc_not_approved` (75), `catch → kyc_reauth_failed` (502, 99).

**Conclusión vinculante**: la opción (a) alcanza. **DT-1(b) (store de verificaciones) queda DESCARTADA** —
CD-6 del work-item exigía justificar por qué (a) no alcanzaba y la respuesta es que **sí alcanza**.
Este repo sigue con **CERO persistencia** (ver CD-11).

### Diseño concreto

**(1) `src/providers/types.ts` — tipo nuevo + extensión de la interface** (no se toca `verify()`):

```ts
/**
 * Resultado de una CONSULTA de estado de una verificación existente (no crea verificación).
 * Deliberadamente MÁS ANGOSTO que KycResult: NO incluye travelRuleData ni ningún campo derivado
 * del legalId/DNI (CD-7). El Travel Rule sigue viajando solo por el canal seguro del provider.
 */
export interface KycStatusResult {
  approved: boolean;
  verificationId: string;   // eco del id consultado (canónico = el pedido)
  provenance: Provenance;   // "didit" | "local-fallback"
  reasons: string[];        // auditable y VALUE-FREE (ej. "didit_status_declined"); nunca PII
}

export interface KycProvider {
  verify(input: KycInput): Promise<KycResult>;   // ← INTACTO (Scope OUT: extender sí, modificar no)
  // Consulta de estado de una verificación ya existente, por su verificationId.
  // Espejo de PayoutProvider.status(payoutId) (líneas 84-90 de este archivo).
  status(verificationId: string): Promise<KycStatusResult>;
}
```

**(2) `src/providers/kyc.ts` — `DiditKycProvider.status()`** (forma copiada de `payout.ts:44-60`):

```ts
async status(verificationId: string): Promise<KycStatusResult> {
  // TODO(sandbox / DIDIT_ADAPTER_READY): confirmar que un session_id creado con POST /v2/session/
  // es consultable por GET /v3/session/{id}/decision/ (ver §9 riesgo R-1).
  const res = await fetch(`${DIDIT_BASE}/v3/session/${encodeURIComponent(verificationId)}/decision/`, {
    method: "GET",
    signal: AbortSignal.timeout(8000),          // igual que payout.ts:47 — no colgar el money-path
    headers: { "x-api-key": this.apiKey },
  });
  if (!res.ok) throw new Error(`didit_status_error_${res.status}`);   // fail-closed (rama B6)
  const d = (await res.json()) as Record<string, unknown>;
  const decision = String((d as any).status ?? "").toLowerCase();     // chaski-v2: "Approved"
  const amlHits = Array.isArray((d as any).aml?.hits) ? (d as any).aml.hits.length : 0;
  const approved = decision === "approved" && amlHits === 0;          // mismo criterio que verify() (41)
  const echoed = String((d as any).session_id ?? "");
  if (echoed !== "" && echoed !== verificationId) {
    throw new Error("didit_status_id_mismatch");                      // rama B10, fail-closed
  }
  return assertValidKycStatus({
    approved,
    verificationId,                             // canónico = el pedido (igual que payout.ts:53)
    provenance: "didit",
    reasons: approved ? [] : [`didit_status_${decision}`, `aml_hits_${amlHits}`],
  });
}
```

**(3) `FallbackKycProvider.status()`** — no tiene memoria y no debe fingir que la tiene:

```ts
async status(verificationId: string): Promise<KycStatusResult> {
  // NO es verificación real y NO hay store: devuelve determinístico y SIEMPRE tageado local-fallback.
  // Es INOCUO por construcción: la allowlist REAL_KYC_PROVENANCES lo bloquea en prod SIEMPRE (rama B3).
  return {
    approved: true,
    verificationId,
    provenance: "local-fallback",
    reasons: ["fallback_no_real_verification"],   // mismo reason que verify() (kyc.ts:61)
  };
}
```

**(4) Guard de salida** (espejo de `assertValidPayout()`, `payout.ts:99-105`) en `src/providers/kyc.ts`:

```ts
export function assertValidKycStatus(s: KycStatusResult): KycStatusResult {
  if (typeof s.approved !== "boolean") throw new Error("invalid_kyc_status_approved"); // anti-WKH-198
  if (!s.verificationId) throw new Error("invalid_kyc_status_id");
  if (!s.provenance) throw new Error("invalid_kyc_status_provenance");
  return s;
}
```

**(5) Consumo en `runCashoutPayout()`** — ver §5 (gate + orden) y §3 (tabla de ramas).

### Por qué NO se toca `verify()`
Scope OUT del work-item es explícito. Además `verify()` **crea** una sesión (POST) y devuelve
`travelRuleData` (PII); el gate necesita **consultar** una existente y no debe tocar PII. Son operaciones
distintas → método distinto. Reusar `verify()` para el gate habría creado una sesión nueva en cada payout.

---

## 3. Ramas del gate — enumeración fail-closed exhaustiva (DT-3)

> Precedente obligatorio: **WKH-198 fue un fail-OPEN por un `NaN` que se coló**. Cada rama abajo es
> explícita y el default es BLOQUEAR. No hay rama "else → allow".

| # | Condición | Resultado | Dónde |
|---|---|---|---|
| **B1** | `status()` → `approved === true` **y** `provenance ∈ REAL_KYC_PROVENANCES` | **ALLOW** → sigue a `execute()` | única rama que abre |
| **B2** | `status()` → `approved !== true`, provenance real | **BLOCK** 200 `kyc_gate_not_passed` | KYC real rechazado |
| **B3** | provenance ∉ allowlist (ej. `local-fallback`) **y** `NODE_ENV === "production"` | **BLOCK** 200 | el fallback JAMÁS abre en prod (espejo de `kyc-validator.ts:60-68`) |
| **B4** | provenance ∉ allowlist, no-prod, `ALLOW_FALLBACK_KYC !== "true"` | **BLOCK** 200 | sin opt-in explícito no abre |
| **B5** | provenance ∉ allowlist, no-prod, `ALLOW_FALLBACK_KYC === "true"` | **ALLOW** + `console.warn` ruidoso | solo dev/CI |
| **B6** | `status()` lanza (timeout `AbortSignal`, DNS, `!res.ok`, JSON inválido, id mismatch) | **THROW `kyc_gate_unavailable`** → route 502 `payout_unavailable` | partner caído ≠ "KYC rechazado" (espejo de `kyc_reauth_failed` de chaski-v2) |
| **B7** | `getKycProvider()` lanza (`DIDIT_API_KEY` sin `DIDIT_ADAPTER_READY=true`) | **THROW propaga** `didit_adapter_not_ready` → 502 | fail-loud, **NO downgrade silencioso al fallback** (`kyc.ts:106-110`) |
| **B8** | provenance desconocido / typo (ej. `"didit-v2"`, `""`) | **BLOCK** (cae en B3/B4) | allowlist, no denylist |
| **B9** | `status()` devuelve `approved` no-booleano / `undefined` / `NaN`-ish | **THROW** en `assertValidKycStatus` → 502 | comparación `=== true`, nunca truthy (CD-8) |
| **B10** | el partner eco-a un `session_id` distinto al pedido | **THROW** → 502 | integridad de la respuesta |

**Invariante**: en TODAS las ramas salvo B1 y B5, `provider.execute()` **no se invoca**. B1/B5 son las únicas
dos rutas de ejecución y ambas exigen una señal server-side (no el input).

**Por qué B6/B7/B9/B10 son 502 y no 200-blocked**: "no sé" ≠ "está rechazado". Devolver
`{ status:"blocked", reason:"kyc_gate_not_passed" }` ante un timeout le mentiría al orquestador
(le diría "este KYC no sirve" cuando el KYC puede estar perfecto). El 502 opaco ya es el contrato de error
del repo (`route.ts:29`) y es igual de fail-closed (no ejecuta). AC-1 admite explícitamente "o un `reason`
equivalente explícito". Mismo criterio que la autoridad live de `chaski-v2` (502 `kyc_reauth_failed` vs
`kyc_not_approved`).

---

## 4. DT-4 — RESUELTO: **eliminar `kycPayoutAllowed` del schema**. La premisa del work-item era falsa.

### Evidencia verificada por mí

- `src/agents/cashout-payout.ts:17` → `z.object({...})` **sin `.strict()`**.
- `grep -rn "strict()\|passthrough()\|catchall" src/` → **0 resultados** en todo el repo.
- Zod instalado: **3.25.76** (`node_modules/zod/package.json`), rango `^3.23.8`.
- Ejecutado contra el Zod real de este repo:
  ```
  z.object({ a: z.string() }).safeParse({ a:"x", kycPayoutAllowed:true })
    → success: true | data: {"a":"x"}          ← STRIPPEA, no lanza
  z.object({ a: z.string() }).strict().safeParse({...})
    → success: false
  ```

→ El work-item decía que eliminar el campo "rompe compat inmediata con `chaski-v2`". **Es falso**:
`chaski-v2/src/infrastructure/a2a/gateways.ts:127` puede seguir mandando `kycPayoutAllowed: true` y Zod
lo strippea silenciosamente. **AC-6 se cumple sola, sin escribir código** (y se testea igual, §7.2 AC-6).

### Decisión: eliminar el campo (`cashout-payout.ts:21`)

**Justificación**:
1. **No rompe compat** (evidencia arriba). El trade-off que planteaba el work-item no existe.
2. **Es la forma más fuerte de AC-2/AC-3**: el campo desaparece del tipo `CashoutPayoutInput`, así que
   `input.kycPayoutAllowed` deja de compilar. La garantía "el booleano del caller no puede habilitar el
   payout" pasa de ser *una convención testeada* a ser *estructuralmente imposible*, verificada por `tsc`.
   Un dev futuro no puede reintroducir la confianza en el input por accidente.
3. **Honestidad del contrato público**: mantener un campo que el server ignora deja un campo mentiroso en
   el contrato a2a e invita al mismo bug (alguien lo vuelve a leer "porque está ahí").
4. Cross-repo: el cleanup del `// DT-5: sintetizado` en `chaski-v2` sigue siendo trabajo posterior
   (Scope OUT, CD-2) — pero ahora es **cosmético**, no un fix de seguridad, porque el campo ya no tiene efecto.

**Consecuencia aceptada**: el hard-gate legacy (`cashout-payout.ts:82-93`) se elimina y lo reemplaza el gate
nuevo, que devuelve el **mismo** `reason: "kyc_gate_not_passed"` y el mismo shape. El work-item lo autoriza
explícitamente (CD-3: "el hard-gate legacy puede cambiar de semántica/implementación"). El test
`cashout-payout.test.ts:15-20` (fuera del rango protegido 23-83) se reemplaza por los tests de gate (§7.2).

---

## 5. Diseño en `src/agents/cashout-payout.ts`

### Orden de operaciones (elegido para preservar CD-1/CD-3 al pie de la letra)

```ts
export async function runCashoutPayout(raw: unknown): Promise<CashoutPayoutOutput> {
  const input = CashoutPayoutInputSchema.parse(raw);   // 1. (sin kycPayoutAllowed — DT-4)

  assertPayoutProviderSafe();                          // 2. INTACTO (CD-1) — throws primero, como hoy
  const provider = getPayoutProvider();                // 3. INTACTO — throws adapter_not_ready, como hoy

  // 4. GATE NUEVO (WKH-203): la decisión de compliance se re-deriva server-side.
  if (!(await isKycGatePassed(input.kycVerificationId))) {
    return { slug: SLUG, executed: false, status: "blocked", payoutId: null,
             deliveredLocal: null, txRef: null, reason: "kyc_gate_not_passed", provenance: "n/a" };
  }

  const travelRuleData = await resolveTravelRuleData(input.kycVerificationId);  // 5. STUB (DT-2)
  const result = await provider.execute({ ... });                               // 6. inalcanzable sin B1/B5
  return { ...same 8 fields... };
}
```

**Por qué el gate va DESPUÉS de `assertPayoutProviderSafe()` y de `getPayoutProvider()`** (y no antes):
- Es lo que hace que **5 de los 7 tests del rango protegido 23-83 queden literalmente intactos** (§7.1):
  esos 5 lanzan en el paso 2 o 3 y nunca alcanzan el gate.
- Es **inerte y seguro**: `getPayoutProvider()` solo hace `new TransFiPayoutProvider(key)` /
  `new FallbackPayoutProvider()` (`payout.ts:108-118`) — cero I/O, cero side-effects, cero movimiento de plata.
  Entre el paso 3 y el gate no ocurre nada observable.
- Todas las ramas siguen fail-closed en cualquier orden; el orden solo decide **qué error gana** cuando hay
  dos problemas a la vez, y preservar el error de payout (CD-1) es lo que pide el work-item.

### El gate

```ts
// WKH-203: el input NO decide compliance. Se consulta la fuente autoritativa por verificationId.
// Espejo EXACTO de isPayoutAllowed() (kyc-validator.ts:56-69) — misma allowlist, mismo default false.
async function isKycGatePassed(verificationId: string): Promise<boolean> {
  const kycProvider = getKycProvider();               // B7: throws fail-loud si key sin readiness
  let s: KycStatusResult;
  try {
    s = await kycProvider.status(verificationId);
  } catch (err) {
    // B6: partner caído/timeout ≠ aprobado. Nunca "asumir true".
    console.warn("[remit-payout] kyc gate unavailable:", {
      errorName: err instanceof Error ? err.name : "unknown",   // nunca err.message/input (CD-4)
    });
    throw new Error("kyc_gate_unavailable");
  }
  if (s.approved !== true) return false;              // B2 + B9: estricto, nunca truthy (CD-8)
  if (REAL_KYC_PROVENANCES.has(s.provenance)) return true;   // B1
  const isProd = process.env.NODE_ENV === "production";
  if (!isProd && process.env.ALLOW_FALLBACK_KYC === "true") { // B5
    console.warn("[remit-payout] gate KYC pasado con provenance FALLBACK (no verificación real) — solo dev/CI");
    return true;
  }
  return false;                                       // B3/B4/B8: default = BLOQUEAR
}
```

### Allowlist compartida (evitar la duplicación que la allowlist existe para prevenir)

`REAL_KYC_PROVENANCES` hoy es **const privada** en `kyc-validator.ts:54`. Duplicarla en `cashout-payout.ts`
crearía dos allowlists divergentes — exactamente el bug que MNR-3 quería evitar.

**Decisión**: mover la const a `src/providers/kyc.ts` (donde viven los providers que *producen* esos
valores de provenance) y exportarla; `kyc-validator.ts` la importa en vez de declararla.

- `kyc-validator.ts` **cambia de forma, no de comportamiento**: `isPayoutAllowed()` queda byte-idéntico salvo
  el origen del símbolo. Los 4 tests de `kyc-validator.test.ts` quedan **sin tocar** y en verde (verificado:
  no referencian la const, solo `runKycValidator()`).
- **Nota de scope**: el work-item no lista `kyc-validator.ts` en Scope IN (dice: su *comportamiento* no se
  modifica — y no se modifica). Es una **extensión de scope deliberada de F2** que el humano ratifica en
  SPEC_APPROVED. Alternativa rechazada: duplicar la Set (drift). Ver CD-9.
- Va en `providers/kyc.ts` y no en `types.ts` porque `types.ts` es puro tipos (cero valores runtime hoy).

---

## 6. Waves de implementación

| Wave | Serial/Par | Archivos | Contenido |
|---|---|---|---|
| **W0** | **SERIAL — bloquea todo** | `src/providers/types.ts` · `src/providers/kyc.ts` · `src/agents/kyc-validator.ts` | Contratos: `KycStatusResult`; `KycProvider.status()` en la interface; `export const REAL_KYC_PROVENANCES` movida a `providers/kyc.ts`; `kyc-validator.ts` la importa (behavior-identical). **Al final de W0 `npm run typecheck` FALLA a propósito** (los 2 providers aún no implementan `status()`) → eso es la señal de que el contrato quedó bien atado. |
| **W1** | tras W0 | `src/providers/kyc.ts` · `src/providers/kyc.test.ts` | `DiditKycProvider.status()`, `FallbackKycProvider.status()`, `assertValidKycStatus()`. Tests de provider (primer mock de `fetch` del repo). Al final de W1: typecheck verde + suite verde (el agente todavía no usa el gate). |
| **W2** | tras W1 | `src/agents/cashout-payout.ts` · `src/agents/cashout-payout.test.ts` | Quitar `kycPayoutAllowed` del schema (DT-4) + borrar el hard-gate legacy (82-93) + `isKycGatePassed()` + wiring en el orden de §5. Tests AC-1/2/3 + ajuste de setup de los 2 tests de §7.1. |
| **W3** | tras W2 (∥ con el doc) | `src/app/api/agents/remit-cashout-payout/invoke/route.test.ts` · `project-context.md` | `beforeEach` + `ALLOW_FALLBACK_KYC`; reemplazo del test (1); AC-5 no-PII sobre blocked y 502. Doc: `ALLOW_FALLBACK_KYC` ahora también afecta al agente de payout + nota del gate. |

`.env.example` **no se crea**: esta HU **no agrega ninguna env var** (reusa `ALLOW_FALLBACK_KYC`, `DIDIT_API_KEY`,
`DIDIT_ADAPTER_READY`, todas preexistentes). El Scope IN lo condicionaba a "si F2 agrega env vars nuevas" → no aplica.

---

## 7. Plan de tests

### 7.1 AC-4 / CD-3 — el rango protegido `cashout-payout.test.ts:23-83`

**Corrección de hecho (el work-item se equivoca en el conteo)**: el rango 23-83 contiene **7 `it`**, no 5:
líneas 26, 32, 39, 49, 57, 68, 77.

| Test (línea) | Con el diseño de §5 | Acción |
|---|---|---|
| 26 — PROD sin provider real → `payout_refused` | lanza en el paso 2, no llega al gate | ✅ **intacto** |
| 32 — dev sin opt-in → `payout_refused` | lanza en el paso 2 | ✅ **intacto** |
| 49 — input inválido → throws | lanza en Zod (paso 1) | ✅ **intacto** |
| 68 — PROD+MOCK+KEY sin READY → `transfi_adapter_not_ready` | lanza en el paso 3 | ✅ **intacto** |
| 77 — PROD sin `PAYOUT_ALLOW_MOCK` → `payout_refused` | lanza en el paso 2 | ✅ **intacto** |
| **39** — dev + opt-in → ejecuta fallback MOCK | llega al gate → fallback KYC sin `ALLOW_FALLBACK_KYC` → **B4 block** → `executed:false` | ⚠️ **+1 línea de setup**: `vi.stubEnv("ALLOW_FALLBACK_KYC", "true")` junto al `ALLOW_FALLBACK_PAYOUT` que ya está (línea 42). **Asserts intactos.** |
| **57** — PROD + `PAYOUT_ALLOW_MOCK` → ejecuta mock | llega al gate → prod + fallback KYC → **B3 block** (ninguna env puede abrirlo en prod, by design) | ⚠️ **setup nuevo**: `DIDIT_API_KEY="k"` + `DIDIT_ADAPTER_READY="true"` + `vi.stubGlobal("fetch", ...)` → `{ status: "Approved" }`. **Los 4 asserts intactos.** |

> **⚠️ CONFLICTO DECLARADO — CD-3 (literal) vs AC-1. Requiere ratificación en SPEC_APPROVED.**
> CD-3 dice "preservar los tests **tal cual están escritos hoy**". Para los tests 39 y 57 eso es
> **matemáticamente incompatible** con AC-1/AC-2/AC-3: ambos ejecutan `validInput`
> (`kycVerificationId:"v1"`, sin KYC real) y esperan `executed:true` — y el test 57 lo hace **en
> `NODE_ENV=production`**, que es exactamente el caso que AC-1 ordena bloquear. Cualquier diseño que los deje
> literalmente intactos es, por definición, un fail-open en el eje compliance (o vuelve el gate condicional a
> otro flag, que es el anti-patrón que la HU viene a matar).
> **Resolución propuesta**: se honra el **intent** de CD-3 — `assertPayoutProviderSafe()` no se toca, su
> comportamiento es idéntico, y **los asserts de los 7 tests quedan intactos**; solo crecen 2 bloques *arrange*
> para reflejar la precondición nueva (ejecutar un payout ahora exige un KYC aprobado server-side).
> Es la lectura que coincide con la instrucción del orquestador ("quedan en verde **sin tocar sus asserts**").
> **Alternativa rechazada**: gate activo solo cuando el payout provider es real → dejaría el gate **inerte en
> prod** (hoy el deploy es etapa-1 mock) y ataría una garantía de compliance a un flag de payout. Rechazada
> por violar AC-1 y por ser un gate condicional.

### 7.2 Tests nuevos (≥1 por AC)

| AC / rama | Archivo | Test |
|---|---|---|
| **AC-1** | `cashout-payout.test.ts` | PROD + `PAYOUT_ALLOW_MOCK=true` + `verificationId` no confirmable (fallback KYC) → `{ executed:false, status:"blocked", reason:"kyc_gate_not_passed" }` **y** `provider.execute` (spy vía `vi.mock("../providers/payout")`) **NUNCA invocado** |
| **AC-2** | `cashout-payout.test.ts` | mismo body **con `kycPayoutAllowed: true` presente en el raw** (post-strip) + gate que no confirma → **bloqueado igual**. Es la prueba directa de "el booleano del input no basta" |
| **AC-3** | `cashout-payout.test.ts` | ×2, la fuente autoritativa manda: (a) input `kycPayoutAllowed:false` + Didit mockeado `Approved` → **ejecuta** (b) input `kycPayoutAllowed:true` + Didit mockeado `Declined` → **blocked** |
| **AC-4** | `cashout-payout.test.ts:23-83` | los 7 tests en verde con asserts intactos (§7.1) |
| **AC-5** | `route.test.ts` | (a) response `blocked` → `JSON.stringify(body)` NO contiene `"Bob"` / `"999888777"` / `"travelRuleData"`; (b) `kyc_gate_unavailable` (fetch mockeado que lanza) → **502** `{ error:"payout_unavailable" }` exacto, sin `kyc_gate_unavailable` ni PII en el body. Patrón `kyc-validator.test.ts:16-22` |
| **AC-6** | `cashout-payout.test.ts` | `CashoutPayoutInputSchema.safeParse({...validInput, kycPayoutAllowed:true})` → `success === true` **y** `!("kycPayoutAllowed" in parsed.data)` → prueba compat (no-400) **y** que el campo no llega al core |
| **B6** | `cashout-payout.test.ts` | `status()` lanza (timeout/`!res.ok`) → `rejects.toThrow(/kyc_gate_unavailable/)` y `execute` no invocado — **el anti-fail-open explícito** |
| **B7** | `cashout-payout.test.ts` | `DIDIT_API_KEY="k"` + `DIDIT_ADAPTER_READY=""` → `rejects.toThrow(/didit_adapter_not_ready/)` (sin downgrade silencioso al fallback) |
| **B9** | `kyc.test.ts` | `assertValidKycStatus({ approved: undefined as unknown as boolean, ... })` → throws (anti-WKH-198) |
| **B10** | `kyc.test.ts` | fetch mockeado que eco-a `session_id: "otro"` → `didit_status_id_mismatch` |
| **provider** | `kyc.test.ts` | `DiditKycProvider.status()`: `Approved` → `approved:true`, `provenance:"didit"`; `Declined` → `approved:false` + reason value-free; `!res.ok` → `didit_status_error_<n>`. `FallbackKycProvider.status()` → `provenance:"local-fallback"` |
| **no-regresión** | `kyc-validator.test.ts` | **sin tocar** — verde tras mover la allowlist |
| **contrato** | `route.test.ts:60-69` | **sin tocar** — el output sigue teniendo exactamente los 8 campos |

**Mock de `fetch`**: `vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: "Approved", session_id: "v1" }), { status: 200 })))` + `afterEach(vi.unstubAllGlobals)`. Es el **primer mock de fetch del repo** (hoy no existe ninguno).

**Gotcha para el Dev**: `DIDIT_BASE` (`kyc.ts:7`) se evalúa **a nivel de módulo** (import time) → `vi.stubEnv("DIDIT_BASE_URL")` **no** lo afecta. No hace falta: los tests mockean `fetch`, no la URL.

---

## 8. Comandos de verificación

```bash
npm run typecheck   # tsc --noEmit  ← AUTORITATIVO
npm run test        # vitest run
```

**Gotcha verificado (precedente WKH-196)**: `npm run build` es `next build` y **NO** typechequea los tests.
En este repo `tsconfig.json` tiene `"include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"]`
→ `npm run typecheck` **sí** cubre `*.test.ts`. **El comando de verificación de esta HU es `npm run typecheck`,
nunca `npm run build`.**

**Imports**: seguir el estilo existente — relativos dentro de `src/` (`../providers/kyc`, como
`kyc-validator.ts:10` y `cashout-payout.ts:11`); el alias `@/` se usa solo desde `app/api/**` y está resuelto
en `vitest.config.ts` (`resolve.alias`) — verificado, no asumido.

---

## 9. Riesgo residual — qué cierra WKH-203 y qué NO

**Cierra**: G2. El booleano del caller deja de existir en el contrato y la decisión de compliance se
re-deriva server-side contra Didit, fail-closed en las 10 ramas de §3.

**NO cierra (explícito)**:

| # | Riesgo | Estado |
|---|---|---|
| **R-1** | **Compat Didit v2↔v3**: `verify()` crea con `POST /v2/session/` (`kyc.ts:17`) y `status()` consulta `GET /v3/session/{id}/decision/`. Que un `session_id` creado por v2 sea consultable por v3 es **plausible pero NO verificado** (no hay sandbox). | **Sandbox-gated**: el adapter entero está detrás de `DIDIT_ADAPTER_READY=true` (`kyc.ts:106-110`), que hoy **nadie setea**. Confirmar esta compat es **item obligatorio del checklist de `DIDIT_ADAPTER_READY`**, junto al mapeo de campos ya pendiente. Si v3 no acepta ids de v2, el gate cae en **B6 → 502** (fail-closed, no fail-open). Key sin readiness = fail-loud. |
| **R-2** | **No hay binding verificationId ↔ sender**. El gate confirma "esta verificación está aprobada", NO "esta verificación es de quien pide el payout". Un caller con un `verificationId` aprobado **ajeno** (dato conocido/robado) pasa el gate — análogo a un IDOR. `chaski-v2` mitiga esto con `vendorData === address` (`validate/route.ts:88`), **pero acá no es portable**: en este repo `vendor_data = input.legalId` (DNI, `kyc.ts:26`), no una wallet, y el input de payout **no trae identidad del sender**. | **Fuera de alcance, requiere HU nueva** (cambia el contrato de input y depende de la auth del gateway). Candidato **G4**. Documentado, no silenciado. |
| **R-3** | **G1 / WKH-202** (`chaski-v2`, `/api/a2a/payout/submit` proxy sin auth) corre **en paralelo AHORA**, repo distinto, sin colisión de archivos. | Complementario: G2 sin G1 = cualquiera llega al agente (pero ya no puede forjar el gate). |
| **R-4** | **G3 / WKH-168** (value-delivery / principal-in) + el TODO de Travel Rule real (`resolveTravelRuleData()` sigue STUB — DT-2, entrada de Auto-Blindaje de `project-context.md`). | **Diferida**, intacta. Esta HU **no** la toca. |
| **R-5** | **Cross-repo drift**: `chaski-v2:gateways.ts:127` sigue mandando `kycPayoutAllowed: true` hardcodeado. | Ya **inocuo** (Zod lo strippea, §4). Cleanup cosmético posterior (CD-2: no se toca acá). |

> **⛔ Cerrar WKH-203 NO habilita la Fase A por sí sola.** El gate de "payout real" se declara cerrado solo
> con **G1 (WKH-202) + G2 (esta HU) + G3 (WKH-168)** DONE, **más** la confirmación sandbox de R-1.
> **CD-5 sigue vigente**: esta HU **no** enciende `TRANSFI_API_KEY`+`TRANSFI_ADAPTER_READY`.

---

## 10. Constraint Directives

### Heredadas del work-item (vigentes, sin cambios)
- **CD-1** *(invariante de seguridad)*: PROHIBIDO debilitar/saltear/volver condicionales los fail-safes de
  `assertPayoutProviderSafe()` (`cashout-payout.ts:48-72`). El diseño de §5 la deja **byte-idéntica** y
  **primera en el orden**. Esta HU **agrega** un gate, no relaja ninguno.
- **CD-2** *(cross-repo)*: PROHIBIDO modificar `chaski-v2` / `wasiai-a2a` / el demo live (`agentshop-*`,
  `wasiai-agentshop.vercel.app`, PWA `chaski-ai.vercel.app`). Leer `chaski-v2` como referencia: **SÍ** (§2).
- **CD-3**: los tests de `cashout-payout.test.ts:23-83` quedan en verde **con sus asserts intactos**
  → ver el conflicto declarado y la resolución en §7.1 (ratificar en SPEC_APPROVED).
- **CD-4** *(no-PII)*: PROHIBIDO exponer `beneficiary.name` / `beneficiary.destination` / `travelRuleData` en
  cualquier response (200/400/502). El blocked usa el shape de 8 campos ya existente; el 502 es el body fijo
  opaco de `route.ts:29`.
- **CD-5**: PROHIBIDO habilitar el payout real. Ninguna wave toca `TRANSFI_API_KEY`/`TRANSFI_ADAPTER_READY`.
- **CD-6** *(persistencia)*: satisfecha y **cerrada** — DT-1(a) alcanza (§2), **no se agrega DB/KV**.

### Nuevas de este SDD
- **CD-7** *(no-PII en el contrato nuevo)*: `KycStatusResult` **NUNCA** incluye `travelRuleData`, `legalId`,
  `vendor_data` ni ningún dato de identidad. El endpoint de decisión de Didit **sí** devuelve PII
  (`chaski-v2/decision.ts:39-47` mapea nombre/DNI/nacimiento) → **el mapper de este repo la descarta y no la
  lee**. `reasons[]` es value-free (`didit_status_<x>`), nunca interpola valores del partner.
- **CD-8** *(anti WKH-198)*: la decisión del gate se evalúa con **comparación estricta** (`s.approved !== true`
  → bloquear). PROHIBIDO usar truthiness, `!!`, `Number()` o coerción sobre la señal de compliance.
  `assertValidKycStatus()` rechaza cualquier `approved` no-booleano.
- **CD-9** *(single source of truth)*: PROHIBIDO duplicar `REAL_KYC_PROVENANCES`. Existe **una sola**
  (`src/providers/kyc.ts`), consumida por `kyc-validator.ts` y `cashout-payout.ts`. Es allowlist, nunca denylist.
- **CD-10** *(extender ≠ modificar)*: `KycProvider.verify()` y `FallbackKycProvider.verify()` /
  `DiditKycProvider.verify()` **no se tocan**. `isPayoutAllowed()` de `kyc-validator.ts` no cambia de
  comportamiento (solo el origen del símbolo de la allowlist).
- **CD-11**: PROHIBIDO agregar persistencia (DB/KV) en esta HU. DT-1(b) **descartada con evidencia** (§2).
- **CD-12** *(fail-loud)*: PROHIBIDO capturar el throw de `getKycProvider()` para caer al fallback.
  Key sin readiness = **error**, nunca downgrade silencioso (rama B7).
- **CD-13** *(gate incondicional)*: PROHIBIDO condicionar el gate KYC a otro flag (`PAYOUT_ALLOW_MOCK`,
  realness del payout provider, `NODE_ENV`, etc.) para "no romper tests". La única excepción es B5, que
  espeja exactamente la excepción ya existente y auditada de `isPayoutAllowed()` (no-prod + opt-in explícito).

---

## 11. Exemplars verificados (paths confirmados con `find`/`Read`)

| Para... | Exemplar | Qué copiar |
|---|---|---|
| `KycProvider.status()` (forma del método) | `src/providers/types.ts:84-90` | firma `status(id) → Promise<Result>` al lado de la operación principal |
| `DiditKycProvider.status()` (impl) | `src/providers/payout.ts:44-60` | GET + `encodeURIComponent` + `AbortSignal.timeout(8000)` + `if (!res.ok) throw` + eco del id pedido |
| Guard de salida | `src/providers/payout.ts:99-105` (`assertValidPayout`) | validación fail-loud del objeto devuelto |
| Lógica del gate | `src/agents/kyc-validator.ts:54-69` (`REAL_KYC_PROVENANCES` + `isPayoutAllowed`) | allowlist + `!isProd && ALLOW_FALLBACK_KYC` + warn + **default false** |
| Factory fail-loud | `src/providers/kyc.ts:103-113` | `DIDIT_ADAPTER_READY` gate |
| Tests env-driven | `src/agents/cashout-payout.test.ts:23-52` | `vi.stubEnv` + `afterEach(vi.unstubAllEnvs)` |
| Tests de no-PII | `src/agents/kyc-validator.test.ts:16-22` | `expect(JSON.stringify(out)).not.toContain(...)` |
| Mock del core en route | `src/app/api/agents/remit-cashout-payout/invoke/route.test.ts:6-11` | `vi.hoisted` + `vi.mock` con `importActual` |

---

## 12. Readiness Check

| # | Ítem | Estado |
|---|---|---|
| 1 | DT-1 resuelto con evidencia (no opinión) | ✅ opción (a); evidencia `chaski-v2` live citada archivo:línea |
| 2 | DT-4 resuelto con el comportamiento **real** de Zod, no la suposición del work-item | ✅ strip verificado ejecutando Zod 3.25.76 del repo |
| 3 | Ningún `[NEEDS CLARIFICATION]` abierto | ✅ los 2 del work-item cerrados |
| 4 | Todos los exemplars verificados en disco | ✅ §11 |
| 5 | Ramas fail-closed enumeradas una por una | ✅ §3 (B1-B10) |
| 6 | CD-1 / CD-5 intactos | ✅ `assertPayoutProviderSafe()` sin cambios, primera en el orden; ninguna wave toca TransFi |
| 7 | Sin persistencia nueva | ✅ CD-11 |
| 8 | Sin env vars nuevas | ✅ reusa `ALLOW_FALLBACK_KYC` / `DIDIT_*` |
| 9 | ≥1 test por AC | ✅ §7.2 |
| 10 | Comando de verificación = el que **realmente** typechequea los tests | ✅ `npm run typecheck` (§8, `include: **/*.ts` verificado) |
| 11 | Riesgo residual explícito (G1/G3/R-1/R-2) | ✅ §9 |
| 12 | Waves con W0 serial | ✅ §6 |
| 13 | **Conflicto CD-3-literal vs AC-1 declarado, no tapado** | ⚠️ §7.1 — **requiere ratificación humana en SPEC_APPROVED** |
| 14 | **Extensión de scope declarada** (`kyc-validator.ts` cambia de forma, no de comportamiento) | ⚠️ §5 — **requiere ratificación humana en SPEC_APPROVED** |

**Veredicto**: **LISTO PARA SPEC_APPROVED**, con dos puntos (13 y 14) que el humano debe ratificar
explícitamente en el gate. Ninguno es una incógnita técnica: ambos son decisiones de alcance ya tomadas y
justificadas, que se documentan para que la ratificación sea consciente.
