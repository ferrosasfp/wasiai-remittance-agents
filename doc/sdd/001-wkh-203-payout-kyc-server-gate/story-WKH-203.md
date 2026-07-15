# Story File — HU WKH-203: El agente de payout no debe confiar en `kycPayoutAllowed` del caller

> Contrato autocontenido para el Dev (F3). **El Dev SOLO lee este archivo** (no el SDD, no el work-item).
> Fuente: `sdd.md` (SPEC_APPROVED 2026-07-15) + `work-item.md` en `doc/sdd/001-wkh-203-payout-kyc-server-gate/`.
> Tipo: security fix (money-path / compliance gate bypass) · Branch: `feat/001-wkh-203-payout-kyc-server-gate`
> Repo: **wasiai-remittance-agents** (`/home/ferdev/.openclaw/workspace/wasiai-remittance-agents`) — CD-2: SOLO este repo.
> Baseline verificado corriendo la suite (2026-07-15): **59 tests / 9 archivos, todos en verde.**

---

## 1. Contexto compacto (qué se construye y por qué)

`runCashoutPayout()` (`src/agents/cashout-payout.ts:82-93`) usa hoy un booleano del **input**
(`input.kycPayoutAllowed`) como único hard-gate de compliance antes de un desembolso. Cualquier caller
que mande `true` desactiva el gate — y el consumidor real ya lo hace **hardcodeado**
(`chaski-v2/src/infrastructure/a2a/gateways.ts:127`, `kycPayoutAllowed: true, // DT-5: sintetizado`).
Es un bypass trust-the-caller, análogo a un IDOR: cero verificación server-side end-to-end.

**El fix**: la decisión de compliance se **re-deriva server-side**. El agente consulta la fuente
autoritativa por `kycVerificationId` vía un método NUEVO `KycProvider.status()`, y aplica la misma
allowlist de provenance que ya usa `kyc-validator` (`REAL_KYC_PROVENANCES`). El campo
`kycPayoutAllowed` **se elimina del schema** (DT-4): así `input.kycPayoutAllowed` deja de compilar y la
garantía pasa de "convención testeada" a **estructuralmente imposible**, verificada por `tsc`.

**No hay persistencia nueva** (DT-1(a): Didit expone consulta de decisión por id de sesión; ya corre
en producción en el repo hermano — ver §6). Este repo sigue con **CERO DB/KV** (CD-11).

**Qué NO hace esta HU**: no habilita el payout real (CD-5), no toca `verify()`, no resuelve el Travel
Rule real (WKH-168), no toca `chaski-v2`.

### Dónde encaja (no re-litigar)

Gate de Fase A ("habilitar payout real") = **G1** (WKH-202, `chaski-v2`, en AR) + **G2 = ESTA HU** +
**G3** (WKH-168, principal-in, diferida) + **G4** (WKH-204, ver §9 R-2). Cerrar WKH-203 **no** habilita
la Fase A por sí sola.

---

## 2. Decisiones CERRADAS en el gate SPEC_APPROVED (2026-07-15) — **NO re-litigar**

> Estas tres ya fueron levantadas, discutidas y resueltas. Están acá para que ni el Dev ni el AR las
> reabran ni las lean como desviación.

### 2.1 Los 7 tests protegidos: **asserts intactos, crecen 2 bloques *arrange*** — RESUELTO

El work-item (CD-3) decía "preservar los 5 tests de `cashout-payout.test.ts:23-83` **tal cual están
escritos hoy**". Dos hechos verificados en disco:

1. **Son 7 tests, no 5** (el work-item contó mal): líneas **26, 32, 39, 49, 57, 68, 77**.
2. Los tests de **L39** (`"dev + opt-in explícito → ejecuta fallback MOCK"`) y **L57**
   (`"PROD + PAYOUT_ALLOW_MOCK → ejecuta mock"`) corren `validInput` (`kycVerificationId:"v1"`, sin KYC
   real) y esperan `executed: true` — y el de **L57 lo hace en `NODE_ENV=production`**, que es
   exactamente el caso que AC-1 ordena bloquear. Es **matemáticamente incompatible** con AC-1/2/3.

**Decisión vinculante**: los 7 tests conservan sus **asserts byte-idénticos**; solo crecen los 2 bloques
***arrange*** necesarios para que el KYC re-verificado dé aprobado.
**Fundamento**: (a) **los asserts son el contrato, el setup no** — mismo criterio ya aplicado y aprobado
en WKH-202 (fixture `validPayload`); (b) el CD-3 se escribió sobre un **error de conteo** y sin ver la
incompatibilidad estructural — un CD basado en un dato falso no ata; (c) dejar esos tests literalmente
intactos significaría que el gate de compliance **nace fail-open**, que es exactamente lo que esta HU
existe para impedir.
**Alternativa RECHAZADA**: hacer el gate condicional a la realness del payout provider → dejaría el gate
**inerte en prod** (hoy el deploy es etapa-1 mock) y ataría una garantía de compliance a un flag de
payout. Prohibido por CD-13.

### 2.2 Mover `REAL_KYC_PROVENANCES` a `providers/kyc.ts` — **RATIFICADO por el humano**

`kyc-validator.ts` es **Scope OUT excepto este move ratificado** (Fernando, 2026-07-15). Autorizado
explícitamente. **Condición**: cambia de **forma**, NO de **comportamiento** — `kyc-validator.ts`
importa la misma Set y **sus 4 tests quedan sin tocar y en verde**.
**Fundamento del humano**: duplicar la Set crearía exactamente el drift que la allowlist existe para
prevenir. **Verificá** que `kyc-validator.test.ts` pasa **sin modificación** (verificado: sus 4 tests
solo llaman `runKycValidator()`, no referencian la const).

### 2.3 G4 / binding `verificationId` ↔ sender — **es WKH-204, NO se implementa acá**

El gate confirma "esta verificación está aprobada", **no** "es de quien pide el payout". Riesgo residual
real y **documentado con dueño y ticket: WKH-204**. **PROHIBIDO diseñarlo o implementarlo en esta HU.**
No dejes un TODO huérfano: si comentás algo, referenciá `WKH-204`.

---

## 3. Scope IN (lista exhaustiva de archivos a tocar)

| # | Archivo | Acción | Wave |
|---|---------|--------|------|
| 1 | `src/providers/types.ts` | `export interface KycStatusResult` + `status()` en `KycProvider`. `verify()` INTACTO. | W0 |
| 2 | `src/providers/kyc.ts` | `export const REAL_KYC_PROVENANCES` (movida acá) + `assertValidKycStatus()` + `DiditKycProvider.status()` + `FallbackKycProvider.status()`. | W0/W1 |
| 3 | `src/agents/kyc-validator.ts` | **SOLO** borrar la const local (L54) e importarla de `../providers/kyc`. Cero cambio de comportamiento (§2.2). | W0 |
| 4 | `src/providers/kyc.test.ts` | Tests de `status()` en ambos providers + `assertValidKycStatus` (B9) + id-mismatch (B10). | W1 |
| 5 | `src/agents/cashout-payout.ts` | Quitar `kycPayoutAllowed` del schema + borrar hard-gate legacy (L82-93) + `isKycGatePassed()` + wiring. | W2 |
| 6 | `src/agents/cashout-payout.test.ts` | Reemplazar el `describe` L13-21 + tests AC-1/2/3/6 + B6/B7 + arrange de L39 y L57. | W2 |
| 7 | `src/app/api/agents/remit-cashout-payout/invoke/route.test.ts` | `beforeEach` + `ALLOW_FALLBACK_KYC`; reemplazar test (1); **arreglar test (6)** (§4 W3 — ver §10 corrección C1); AC-5. | W3 |
| 8 | `project-context.md` (raíz) | Documentar que `ALLOW_FALLBACK_KYC` ahora también afecta al agente de payout + nota del gate. | W3 |

**PROHIBIDO tocar cualquier otro archivo.** En particular (Scope OUT):
`src/app/api/agents/remit-cashout-payout/invoke/route.ts` (**el .ts de producción NO se toca** — el 502
opaco ya existe y sirve tal cual; solo se toca su `.test.ts`), `src/agents/corridor-fx.ts`,
`src/providers/payout.ts`, `src/providers/fx.ts`, `src/agents/kyc-validator.test.ts` (**sin tocar**),
cualquier archivo de los otros 2 agentes. **`.env.example` NO se crea** (esta HU **no agrega ninguna env
var**: reusa `ALLOW_FALLBACK_KYC`, `DIDIT_API_KEY`, `DIDIT_ADAPTER_READY`, todas preexistentes).
**Nada fuera de `wasiai-remittance-agents/`** (CD-2): `chaski-v2` y `wasiai-a2a` son **read-only**.

---

## 4. Waves de implementación

> **W0 es SERIAL y bloquea todo.** W1 → W2 → W3 en orden (comparten `kyc.ts` / dependen del gate).
> Criterio de cierre **verificable** al final de cada wave. Comando autoritativo: **`npm run typecheck`**
> (ver §8 — **PROHIBIDO validar solo con `npm run build`**).

### W0 — SERIAL · contratos · `types.ts` + `kyc.ts` (allowlist) + `kyc-validator.ts`

**W0.1 — `src/providers/types.ts`**: agregar el tipo nuevo y extender la interface. `verify()` **no se
toca** (CD-10). El exemplar de forma es `PayoutProvider.status(payoutId)` en **este mismo archivo, L84-90**.

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
  verify(input: KycInput): Promise<KycResult>;   // ← INTACTO
  // Consulta de estado de una verificación ya existente, por su verificationId.
  // Espejo de PayoutProvider.status(payoutId) (L84-90 de este archivo).
  status(verificationId: string): Promise<KycStatusResult>;
}
```

> **⚠️ Por qué `KycStatusResult` es más angosto que `KycResult` — esto es un GUARDRAIL, no un detalle.**
> El endpoint de decisión de Didit **devuelve PII**: nombre, apellidos, `document_number` (DNI), fecha de
> nacimiento, nacionalidad (verificado en `chaski-v2/src/infrastructure/didit/decision.ts:44-56`, que sí
> los mapea). **Acá esa PII se descarta deliberadamente y NO se lee** (CD-7). El tipo angosto hace que
> agregar PII al gate sea un cambio de contrato visible, no un descuido. **PROHIBIDO** agregarle
> `travelRuleData`, `legalId`, `vendor_data`, `identity` ni nada derivado del DNI.

**W0.2 — `src/providers/kyc.ts`**: mover la allowlist acá y **exportarla** (§2.2, CD-9). Copiar el
comentario `MNR-3` que la acompaña en `kyc-validator.ts:52-54` (no perder el porqué):

```ts
// MNR-3 (re-AR): allowlist explícita de proveniencias REALES (fail-safe en el eje provenance).
// Un typo futuro en un provider NO debe leerse como "real" y abrir el money-path.
// WKH-203/CD-9: vive ACÁ (junto a los providers que PRODUCEN estos valores) y es la ÚNICA;
// la consumen kyc-validator.ts (isPayoutAllowed) y cashout-payout.ts (isKycGatePassed).
export const REAL_KYC_PROVENANCES = new Set<string>(["didit"]);
```

**W0.3 — `src/agents/kyc-validator.ts`**: borrar la const local (L54) y agregar el símbolo al import
existente de L10 (`import { getKycProvider } from "../providers/kyc";` → agregar `REAL_KYC_PROVENANCES`).
**`isPayoutAllowed()` (L56-69) queda byte-idéntico salvo el origen del símbolo.** Cero cambio de
comportamiento (§2.2).

**Cierre W0 (verificable)**: `npm run typecheck` **FALLA A PROPÓSITO** — `DiditKycProvider` y
`FallbackKycProvider` aún no implementan `status()`, así que TS marca que no satisfacen `KycProvider`.
**Eso es la señal de que el contrato quedó bien atado.** No lo "arregles" con `any`, `@ts-ignore` ni
haciendo `status?` opcional (CD-8/CD-10): lo cierra W1.

---

### W1 — `src/providers/kyc.ts` (impl) + `src/providers/kyc.test.ts`

**W1.1 — guard de salida** (espejo exacto de `assertValidPayout()`, `payout.ts:99-105`):

```ts
// guard de salida — fail-loud. WKH-203/CD-8 (anti WKH-198): `approved` DEBE ser booleano real;
// nunca dejar que un undefined/NaN-ish se lea como señal de compliance.
export function assertValidKycStatus(s: KycStatusResult): KycStatusResult {
  if (typeof s.approved !== "boolean") throw new Error("invalid_kyc_status_approved");
  if (!s.verificationId) throw new Error("invalid_kyc_status_id");
  if (!s.provenance) throw new Error("invalid_kyc_status_provenance");
  return s;
}
```

**W1.2 — `DiditKycProvider.status()`** (forma copiada de `payout.ts:44-60`; método NUEVO en la clase,
junto a `verify()`, sin tocar `verify()`):

```ts
async status(verificationId: string): Promise<KycStatusResult> {
  // TODO(sandbox / DIDIT_ADAPTER_READY — R-1): confirmar que un session_id creado con
  // POST /v2/session/ (verify(), L17) es consultable por GET /v3/session/{id}/decision/. Ver §9.
  const res = await fetch(`${DIDIT_BASE}/v3/session/${encodeURIComponent(verificationId)}/decision/`, {
    method: "GET",
    signal: AbortSignal.timeout(8000),        // igual que payout.ts:47 — no colgar el money-path
    headers: { "x-api-key": this.apiKey },
  });
  if (!res.ok) throw new Error(`didit_status_error_${res.status}`);   // fail-closed (rama B6)
  const d = (await res.json()) as Record<string, unknown>;
  const decision = String((d as any).status ?? "").toLowerCase();     // Didit manda "Approved"
  const amlHits = Array.isArray((d as any).aml?.hits) ? (d as any).aml.hits.length : 0;
  const approved = decision === "approved" && amlHits === 0;          // mismo criterio que verify() (L41)
  const echoed = String((d as any).session_id ?? "");
  if (echoed !== "" && echoed !== verificationId) {
    throw new Error("didit_status_id_mismatch");                      // rama B10, fail-closed
  }
  return assertValidKycStatus({
    approved,
    verificationId,                            // canónico = el PEDIDO (igual que payout.ts:53)
    provenance: "didit",
    reasons: approved ? [] : [`didit_status_${decision}`, `aml_hits_${amlHits}`],
  });
}
```

> **CD-7 acá**: del JSON de Didit se leen **solo** `status`, `aml.hits`, `session_id`. **PROHIBIDO** leer
> o loguear `id_verifications[]`, `first_name`, `last_name`, `document_number`, `date_of_birth`.
> `reasons[]` es **value-free**: `didit_status_<x>` / `aml_hits_<n>`, nunca interpola valores del partner.

**W1.3 — `FallbackKycProvider.status()`** — no tiene memoria y **no debe fingir que la tiene**:

```ts
async status(verificationId: string): Promise<KycStatusResult> {
  // NO es verificación real y NO hay store: determinístico y SIEMPRE tageado local-fallback.
  // Es INOCUO por construcción: REAL_KYC_PROVENANCES lo bloquea en prod SIEMPRE (rama B3).
  return {
    approved: true,
    verificationId,
    provenance: "local-fallback",
    reasons: ["fallback_no_real_verification"],   // mismo reason que verify() (L61)
  };
}
```

> El `approved: true` acá **no abre nada**: la seguridad NO vive en este valor sino en la allowlist del
> gate (B3/B4). Es el mismo diseño ya auditado de `FallbackKycProvider.verify()` (L67, `approved = hasLegalId`).

**W1.4 — tests** (`kyc.test.ts`, ver tabla §7). Es el **primer mock de `fetch` del repo** — patrón:

```ts
vi.stubGlobal("fetch", vi.fn(async () =>
  new Response(JSON.stringify({ status: "Approved", session_id: "v1" }), { status: 200 })));
// y en el describe: afterEach(() => vi.unstubAllGlobals());
```

**Cierre W1 (verificable)**: `npm run typecheck` **verde** + `npm run test` **verde** (el agente todavía
no usa el gate → los 59 baseline siguen pasando, + los nuevos de `kyc.test.ts`).

---

### W2 — `src/agents/cashout-payout.ts` + `cashout-payout.test.ts` (el gate)

**W2.1 — schema (DT-4)**: borrar la línea `kycPayoutAllowed: z.boolean(),` (**`cashout-payout.ts:21`**).

> **⚠️ NO te asustes ni lo dejes "por las dudas" — dato VERIFICADO, decisión CERRADA.**
> Zod **3.25.76** (instalado), `z.object` **sin `.strict()`** (`cashout-payout.ts:17`; `grep -rn
> "strict()\|passthrough()\|catchall" src/` → **0 resultados** en todo el repo) → **strippea las keys
> desconocidas en silencio**. Ejecutado contra el Zod real de este repo:
> `z.object({a:z.string()}).safeParse({a:"x", kycPayoutAllowed:true})` → `success: true`, `data: {"a":"x"}`.
> ⇒ **NO rompe compat con `chaski-v2`** (que lo sigue mandando hardcodeado) y **AC-6 se cumple sola, sin
> escribir código**. La premisa del work-item ("rompe compat inmediata") era **falsa**.
> Beneficio: `input.kycPayoutAllowed` **deja de compilar** → un dev futuro no puede reintroducir la
> confianza en el input por accidente. Esa es la forma más fuerte de AC-2/AC-3.

**W2.2 — borrar el hard-gate legacy** (`cashout-payout.ts:82-93`, el `if (!input.kycPayoutAllowed)`).
Lo reemplaza el gate nuevo, que devuelve el **mismo `reason: "kyc_gate_not_passed"` y el mismo shape de 8
campos**. Autorizado por CD-3 ("el hard-gate legacy puede cambiar de semántica/implementación").

**W2.3 — el gate**. Agregar (fn a nivel módulo, junto a `assertPayoutProviderSafe`):

```ts
// WKH-203: el input NO decide compliance. Se consulta la fuente autoritativa por verificationId.
// Espejo EXACTO de isPayoutAllowed() (kyc-validator.ts:56-69) — misma allowlist, mismo default false.
async function isKycGatePassed(verificationId: string): Promise<boolean> {
  const kycProvider = getKycProvider();               // B7: FUERA del try (ver aviso abajo)
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
  if (s.approved !== true) return false;              // B2 + B9: estricto, NUNCA truthy (CD-8)
  if (REAL_KYC_PROVENANCES.has(s.provenance)) return true;   // B1
  const isProd = process.env.NODE_ENV === "production";
  if (!isProd && process.env.ALLOW_FALLBACK_KYC === "true") { // B5
    console.warn("[remit-payout] gate KYC pasado con provenance FALLBACK (no verificación real) — solo dev/CI");
    return true;
  }
  return false;                                       // B3/B4/B8: default = BLOQUEAR
}
```

> **🔴 `getKycProvider()` va FUERA del `try` — es load-bearing.** Si lo metés adentro, su throw
> (`didit_adapter_not_ready`) se convierte en `kyc_gate_unavailable` y **rompés la rama B7** (fail-loud) y
> su test. Key sin readiness = **error propagado**, nunca downgrade silencioso al fallback (CD-12).

Imports nuevos en `cashout-payout.ts` (estilo relativo, como L11): `getKycProvider` y
`REAL_KYC_PROVENANCES` de `"../providers/kyc"`; `KycStatusResult` (type) de `"../providers/types"`.

**W2.4 — wiring. El ORDEN es load-bearing** (no lo cambies):

```ts
export async function runCashoutPayout(raw: unknown): Promise<CashoutPayoutOutput> {
  const input = CashoutPayoutInputSchema.parse(raw);   // 1. (ya sin kycPayoutAllowed — DT-4)

  assertPayoutProviderSafe();                          // 2. INTACTO (CD-1) — throws primero, como hoy
  const provider = getPayoutProvider();                // 3. INTACTO — throws adapter_not_ready, como hoy

  // 4. GATE NUEVO (WKH-203): la decisión de compliance se re-deriva server-side.
  if (!(await isKycGatePassed(input.kycVerificationId))) {
    return { slug: SLUG, executed: false, status: "blocked", payoutId: null,
             deliveredLocal: null, txRef: null, reason: "kyc_gate_not_passed", provenance: "n/a" };
  }

  const travelRuleData = await resolveTravelRuleData(input.kycVerificationId);  // 5. sigue STUB (DT-2)
  const result = await provider.execute({ /* ...igual que hoy... */ });          // 6. inalcanzable sin B1/B5
  return { /* ...los MISMOS 8 campos que hoy... */ };
}
```

> **Por qué el gate va DESPUÉS de los pasos 2 y 3**: es lo que hace que **5 de los 7 tests protegidos
> queden literalmente intactos** (lanzan en el paso 2 o 3 y nunca alcanzan el gate). Es **inerte y
> seguro**: `getPayoutProvider()` solo hace `new TransFiPayoutProvider(key)` / `new FallbackPayoutProvider()`
> (`payout.ts:108-118`) — **cero I/O, cero side-effects, cero movimiento de plata**. Todas las ramas siguen
> fail-closed en cualquier orden; el orden solo decide **qué error gana** cuando hay dos problemas a la vez,
> y preservar el error de payout es lo que pide CD-1.
> **`assertPayoutProviderSafe()` (L48-72) NO se toca: byte-idéntica y primera.** El STUB
> `resolveTravelRuleData()` (L125-133) **tampoco se toca** — sigue siendo el TODO de WKH-168 (DT-2).

**W2.5 — tests** (§7). Incluye reemplazar el `describe` de **L13-21** (`"kycPayoutAllowed=false →
blocked"`, **fuera** del rango protegido) por los tests del gate: con DT-4 el campo se strippea, así que
ese test ya no describe nada real.

**Cierre W2 (verificable)**: `npm run typecheck` verde + `npm run test` verde, **incluyendo los 7 tests
protegidos con sus asserts intactos** y `kyc-validator.test.ts` (4 tests) **sin modificar**.

---

### W3 — `route.test.ts` + `project-context.md`

**W3.1 — `beforeEach`** (`route.test.ts:34-37`): agregar `vi.stubEnv("ALLOW_FALLBACK_KYC", "true");`
junto a los 2 stubs ya existentes. Motivo: en vitest `NODE_ENV="test"` (≠ production) → el gate toma la
rama **B5** y los tests que ejercen el happy-path HTTP siguen pasando.

**W3.2 — reemplazar el test (1)** (`route.test.ts:43-51`, `"kycPayoutAllowed:false → 200 blocked"`): con
DT-4 el campo se strippea → ya no bloquea nada. Reemplazarlo por el equivalente real del gate: KYC no
confirmable → 200 blocked (ver §7 AC-5/AC-1-HTTP).

**W3.3 — 🔴 arreglar el test (6)** (`route.test.ts:103-112`, `"PROD + PAYOUT_ALLOW_MOCK → 200 mock"`).
**Esto NO estaba en el SDD — ver §10 corrección C1.** Stubea `NODE_ENV=production` y espera
`provenance: "local-fallback"`; con el gate nuevo cae en **B3** (prod + fallback KYC → block) → devolvería
`provenance: "n/a"` y el test **fallaría**. Es el **mismo caso estructural que el test 57** de
`cashout-payout.test.ts`, a nivel HTTP → **mismo tratamiento (§2.1): asserts intactos, crece el arrange**:
agregar `DIDIT_API_KEY="k"` + `DIDIT_ADAPTER_READY="true"` + `vi.stubGlobal("fetch", ...)` → `{ status:
"Approved", session_id: "v1" }`, y `afterEach(() => vi.unstubAllGlobals())`.

> Los tests (2), (3), (4) de `route.test.ts` corren en `NODE_ENV="test"` → los cubre el B5 de W3.1, sin
> tocar sus asserts. Los tests (5), (7), (8), (9) no llegan al gate → intactos.
> **El test (2) (`route.test.ts:60-69`) assertea EXACTAMENTE los 8 keys del output: NO se toca** — el shape
> de salida no cambia en esta HU.

**W3.4 — `project-context.md`**: en `## Variables de Entorno` (L192-208) actualizar la línea de
`ALLOW_FALLBACK_KYC` (L198) para reflejar que **ahora también** habilita el gate KYC del agente de
**payout** en no-prod (antes solo `payoutAllowed` del `kyc-validator`), y notar que `DIDIT_API_KEY` +
`DIDIT_ADAPTER_READY` ahora gatean también el gate de `remit-cashout-payout`. **NO agregar env vars
nuevas** (no hay).

**Cierre W3 (verificable)**: `npm run typecheck` + `npm run test` verdes — **suite COMPLETA**, ≥59 tests,
**0 rojos**.

---

## 5. Las 10 ramas fail-closed (B1-B10) — una por una

> **Precedente real y obligatorio: WKH-198 fue un fail-OPEN que se coló por un `NaN`** (una comparación
> con NaN daba `false` → el quote nunca vencía). Por eso cada rama acá es **explícita** y el default es
> **BLOQUEAR**. **No hay ninguna rama "else → allow".**

| # | Condición | Resultado esperado |
|---|-----------|--------------------|
| **B1** | `status()` → `approved === true` **y** `provenance ∈ REAL_KYC_PROVENANCES` | **ALLOW** → sigue a `execute()`. **Única rama que abre en prod.** |
| **B2** | `approved !== true`, provenance real | **BLOCK** → 200 `{ executed:false, status:"blocked", reason:"kyc_gate_not_passed", provenance:"n/a" }` |
| **B3** | provenance ∉ allowlist (ej. `local-fallback`) **y** `NODE_ENV === "production"` | **BLOCK** 200. El fallback **JAMÁS** abre en prod, **ninguna env puede abrirlo** (espejo de `kyc-validator.ts:60-68`) |
| **B4** | provenance ∉ allowlist, no-prod, `ALLOW_FALLBACK_KYC !== "true"` | **BLOCK** 200. Sin opt-in explícito no abre. |
| **B5** | provenance ∉ allowlist, no-prod, `ALLOW_FALLBACK_KYC === "true"` | **ALLOW** + `console.warn` ruidoso. **Solo dev/CI.** |
| **B6** | `status()` **lanza** (timeout `AbortSignal`, DNS, `!res.ok`, JSON inválido, id mismatch) | **THROW `kyc_gate_unavailable`** → la route lo mapea a **502 `{ error:"payout_unavailable" }`** |
| **B7** | `getKycProvider()` lanza (`DIDIT_API_KEY` sin `DIDIT_ADAPTER_READY=true`) | **THROW `didit_adapter_not_ready` PROPAGA** → 502. Fail-loud, **NO** downgrade silencioso (CD-12) |
| **B8** | provenance desconocido / typo (ej. `"didit-v2"`, `""`) | **BLOCK** (cae en B3/B4). Es **allowlist, nunca denylist** |
| **B9** | `status()` devuelve `approved` no-booleano / `undefined` / NaN-ish | **THROW** en `assertValidKycStatus` → 502 |
| **B10** | el partner eco-a un `session_id` distinto al pedido | **THROW `didit_status_id_mismatch`** → 502 |

**Invariante que el AR va a verificar**: en **TODAS** las ramas salvo **B1 y B5**, `provider.execute()`
**NO se invoca**. B1/B5 son las únicas dos rutas de ejecución y ambas exigen una señal **server-side**
(no el input).

**Por qué B6/B7/B9/B10 son 502 y no 200-blocked**: **"no sé" ≠ "está rechazado"**. Devolver
`{ status:"blocked", reason:"kyc_gate_not_passed" }` ante un timeout le mentiría al orquestador (le diría
"este KYC no sirve" cuando puede estar perfecto). El 502 opaco ya es el contrato de error del repo
(`route.ts:29`) y es **igual de fail-closed** (no ejecuta). AC-1 admite explícitamente "o un `reason`
equivalente explícito".

### 🔴 CD-8 — anti-WKH-198 (regla de oro de esta HU)

```ts
if (s.approved !== true) return false;   // ✅ comparación ESTRICTA
if (!s.approved) return false;           // ❌ truthiness
if (s.approved == true) ...              // ❌ coerción
if (Boolean(s.approved)) ...             // ❌
```
**PROHIBIDO** truthiness, `!!`, `Number()`, `==` o cualquier coerción sobre la señal de compliance.
`assertValidKycStatus()` rechaza cualquier `approved` no-booleano **antes** de que llegue al gate.

---

## 6. El caso `local-fallback` y `REAL_KYC_PROVENANCES`

- `getKycProvider()` (`kyc.ts:103-113`) devuelve `FallbackKycProvider` **cuando no hay `DIDIT_API_KEY`**
  → es lo que pasa **en todos los tests y en dev**. Su `status()` devuelve
  `provenance: "local-fallback"`, que **NO está** en `REAL_KYC_PROVENANCES` (`= new Set(["didit"])`).
- Por eso, en dev/CI, ejecutar un payout ahora exige **`ALLOW_FALLBACK_KYC=true`** (rama B5) — el
  **mismo opt-in explícito y ruidoso** que ya exige `kyc-validator` para marcar `payoutAllowed`. No es un
  mecanismo nuevo: es el existente, aplicado también acá.
- **En producción no hay opt-in posible**: B3 bloquea antes de mirar `ALLOW_FALLBACK_KYC`. Ese orden de
  chequeos (`isProd` primero) es deliberado — **no lo inviertas**.
- **CD-9**: existe **UNA sola** `REAL_KYC_PROVENANCES` (`src/providers/kyc.ts`), consumida por
  `kyc-validator.ts` **y** `cashout-payout.ts`. **PROHIBIDO duplicarla** (el drift es exactamente lo que
  la allowlist existe para prevenir). Es **allowlist, nunca denylist**.

---

## 7. Tests requeridos (≥1 por AC)

> **🔴 ARRANGE OBLIGATORIO en TODO test nuevo de `cashout-payout.test.ts` que llegue al gate**
> (§10 corrección C2): como el gate va **después** de `assertPayoutProviderSafe()`, y vitest setea
> **`NODE_ENV="test"`** (verificado: `process.env.NODE_ENV ??= "test"` en el runtime de vitest) → la rama
> **dev** exige `ALLOW_FALLBACK_PAYOUT="true"`. **Sin ese stub el test muere en `payout_refused` y nunca
> ejerce el gate.** Usá uno de los dos setups:
> - **dev**: `vi.stubEnv("TRANSFI_API_KEY", ""); vi.stubEnv("ALLOW_FALLBACK_PAYOUT", "true");`
> - **prod**: `vi.stubEnv("NODE_ENV","production"); vi.stubEnv("TRANSFI_API_KEY",""); vi.stubEnv("PAYOUT_ALLOW_MOCK","true");`
>
> Y para forzar **KYC real aprobado**: `vi.stubEnv("DIDIT_API_KEY","k"); vi.stubEnv("DIDIT_ADAPTER_READY","true");`
> + `vi.stubGlobal("fetch", ...)` → `{ status:"Approved", session_id:"v1" }`.

| AC / rama | Archivo | Caso | Aserción |
|---|---|---|---|
| **AC-1** | `cashout-payout.test.ts` | setup **prod** + KYC no confirmable (fallback, sin DIDIT) | `{ executed:false, status:"blocked", reason:"kyc_gate_not_passed" }` **y** `provider.execute` **NUNCA invocado** (spy vía `vi.mock("../providers/payout")`) |
| **AC-2** | `cashout-payout.test.ts` | idem **con `kycPayoutAllowed: true` presente en el raw** | **bloqueado igual** → prueba directa de "el booleano del input no basta" |
| **AC-3a** | `cashout-payout.test.ts` | setup **dev** + input `kycPayoutAllowed:false` + Didit mock `Approved` | **ejecuta** (`executed:true`) → la fuente autoritativa manda sobre el input |
| **AC-3b** | `cashout-payout.test.ts` | setup **dev** + input `kycPayoutAllowed:true` + Didit mock `Declined` | **blocked** → idem, al revés |
| **AC-4** | `cashout-payout.test.ts:23-83` | los **7** tests (L26,32,39,49,57,68,77) | verdes, **asserts intactos** (§2.1). L39: +`ALLOW_FALLBACK_KYC="true"`. L57: +`DIDIT_API_KEY`/`DIDIT_ADAPTER_READY`/fetch mock `Approved` |
| **AC-5a** | `route.test.ts` | response `blocked` | `JSON.stringify(body)` NO contiene `"Bob"` / `"999888777"` / `"travelRuleData"` |
| **AC-5b** | `route.test.ts` | `kyc_gate_unavailable` (fetch mock que lanza) | **502** `{ error:"payout_unavailable" }` **exacto**, sin `kyc_gate_unavailable` ni PII en el body |
| **AC-6** | `cashout-payout.test.ts` | `CashoutPayoutInputSchema.safeParse({...validInput, kycPayoutAllowed:true})` | `success === true` **y** `!("kycPayoutAllowed" in parsed.data)` → compat (no-400) **y** el campo no llega al core |
| **B6** | `cashout-payout.test.ts` | setup dev + DIDIT ON + `fetch` que lanza (o `!res.ok`) | `rejects.toThrow(/kyc_gate_unavailable/)` **y** `execute` no invocado — **el anti-fail-open explícito** |
| **B7** | `cashout-payout.test.ts` | setup dev + `DIDIT_API_KEY="k"` + `DIDIT_ADAPTER_READY=""` | `rejects.toThrow(/didit_adapter_not_ready/)` (sin downgrade silencioso) |
| **B9** | `kyc.test.ts` | `assertValidKycStatus({ approved: undefined as unknown as boolean, ... })` | `toThrow(/invalid_kyc_status_approved/)` — **anti-WKH-198** |
| **B10** | `kyc.test.ts` | fetch mock que eco-a `session_id: "otro"` | `rejects.toThrow(/didit_status_id_mismatch/)` |
| **provider** | `kyc.test.ts` | `DiditKycProvider.status()`: `Approved` / `Declined` / `!res.ok` | `approved:true`+`provenance:"didit"` / `approved:false`+reason value-free / `didit_status_error_<n>` |
| **provider** | `kyc.test.ts` | `FallbackKycProvider.status("x")` | `provenance:"local-fallback"`, `verificationId:"x"`, reason `fallback_no_real_verification` |
| **no-regresión** | `kyc-validator.test.ts` | **SIN TOCAR** | sus **4** tests verdes tras mover la allowlist (§2.2) |
| **contrato** | `route.test.ts:60-69` | **SIN TOCAR** | el output sigue teniendo **exactamente los 8 campos** |

**Gotcha verificado**: `DIDIT_BASE` (`kyc.ts:7`) se evalúa **a nivel de módulo (import time)** →
`vi.stubEnv("DIDIT_BASE_URL")` **NO** lo afecta. No hace falta: los tests mockean `fetch`, no la URL.

---

## 8. Comandos y gate de verificación por wave

```bash
cd /home/ferdev/.openclaw/workspace/wasiai-remittance-agents
npm run typecheck   # tsc --noEmit  ← AUTORITATIVO
npm run test        # vitest run — suite COMPLETA
```

> **🔴 PROHIBIDO validar solo con `npm run build` (lección WKH-196).** `npm run build` es `next build` y
> **NO typechequea los tests**. En WKH-196 eso dejó pasar un error de tipos en un test.
> **Verificado en ESTE repo**: `tsconfig.json` tiene `"include": ["next-env.d.ts", "**/*.ts", "**/*.tsx",
> ".next/types/**/*.ts"]` → **`npm run typecheck` SÍ cubre `*.test.ts`**. Ese es el comando de esta HU.

| Wave | Gate de cierre |
|------|----------------|
| **W0** | `npm run typecheck` **FALLA a propósito** (providers sin `status()`) — señal de contrato bien atado. Sin `any`/`@ts-ignore`/`status?`. |
| **W1** | `npm run typecheck` verde **+** `npm run test` verde (≥59). |
| **W2** | `npm run typecheck` verde **+** `npm run test` verde, **7 protegidos con asserts intactos** + `kyc-validator.test.ts` sin tocar. |
| **W3** | `npm run typecheck` verde **+** `npm run test` **suite completa, 0 rojos**. |

**Imports**: estilo existente — **relativos** dentro de `src/` (`../providers/kyc`, como
`kyc-validator.ts:10` y `cashout-payout.ts:11`). El alias `@/` se usa **solo** desde `app/api/**` y está
resuelto en `vitest.config.ts` (`resolve.alias`) — verificado, no asumido.

---

## 9. Riesgo residual — leelo, no lo "arregles"

| # | Riesgo | Qué hacer |
|---|--------|-----------|
| **R-1** | **Compat Didit v2↔v3**: `verify()` **crea** con `POST /v2/session/` (`kyc.ts:17`) y `status()` **consulta** `GET /v3/session/{id}/decision/`. Que un `session_id` creado por v2 sea consultable por v3 es **plausible pero NO verificado** (no hay sandbox). | **Es sandbox-unverified A PROPÓSITO.** Todo el adapter está detrás de `DIDIT_ADAPTER_READY=true` (`kyc.ts:106-110`), que **hoy nadie setea**. Dejá el `TODO(sandbox / DIDIT_ADAPTER_READY — R-1)` del W1.2: es **item OBLIGATORIO del checklist de `DIDIT_ADAPTER_READY`**. Si v3 no acepta ids de v2 → cae en **B6 → 502 fail-closed**, **NUNCA** fail-open. **PROHIBIDO** "arreglarlo" cambiando `verify()` a v3 (CD-10, Scope OUT). |
| **R-2 / G4** | **No hay binding `verificationId` ↔ sender.** El gate confirma "está aprobada", no "es de quien pide el payout". Un caller con un `verificationId` aprobado **ajeno** pasa el gate. `chaski-v2` mitiga con `vendorData === address` (`authority.ts:76-79`) pero **no es portable acá**: en este repo `vendor_data = input.legalId` (DNI, `kyc.ts:27`), no una wallet, y el input de payout **no trae identidad del sender**. | **Es WKH-204** (§2.3). **NO lo implementes ni lo diseñes.** No dejes TODOs huérfanos: referenciá `WKH-204`. |
| **R-3** | **G1 / WKH-202** (`chaski-v2`, `/api/a2a/payout/submit`) corre **en paralelo AHORA**, repo distinto, sin colisión de archivos. | Nada. Complementario. |
| **R-4** | **G3 / WKH-168** (value-delivery / principal-in) + Travel Rule real: `resolveTravelRuleData()` (`cashout-payout.ts:125-133`) **sigue STUB** y devuelve datos sintéticos vacíos — **NO** recupera nada real por `kycVerificationId` (entrada de Auto-Blindaje del `project-context.md`). | **Diferida, intacta.** Esta HU **NO** la toca (DT-2). No asumas que existe un store real. |
| **R-5** | `chaski-v2:gateways.ts:127` sigue mandando `kycPayoutAllowed: true` hardcodeado. | Ya **inocuo** (Zod lo strippea). Cleanup **cosmético** posterior. **CD-2: no se toca acá.** |

> **⛔ Cerrar WKH-203 NO habilita la Fase A.** El gate se declara cerrado solo con **G1 (WKH-202) + G2
> (esta HU) + G3 (WKH-168) + G4 (WKH-204)**, más la confirmación sandbox de R-1.

---

## 10. Corrección al SDD (defectos reales hallados al traducir — **avisados al orquestador**)

> El SDD es la fuente de verdad, pero al traducirlo a instrucciones ejecutables verifiqué cada claim
> contra el disco y la suite. Tres defectos reales. El Story File (arriba) **ya los corrige**; se listan
> acá para que el AR no los lea como desviación del Dev.

**C1 — 🔴 (impacto real) El SDD omite el test (6) de `route.test.ts` en el análisis de impacto de W3.**
El SDD §6/W3 solo menciona "reemplazo del test (1)". Pero el test **(6)** (`route.test.ts:103-112`,
`"PROD + PAYOUT_ALLOW_MOCK → 200 mock"`) stubea `NODE_ENV=production` + corre `validInput` + assertea
`output.provenance === "local-fallback"`. Con el gate nuevo cae en **B3** → `provenance: "n/a"` → **el
test falla**. Es el gemelo HTTP exacto del test 57 de `cashout-payout.test.ts` (que el SDD sí analizó en
§7.1) — el SDD hizo el análisis del rango protegido a nivel unit pero **no lo replicó a nivel route**.
**Corregido en W3.3** con el mismo criterio ratificado (§2.1): asserts intactos, crece el arrange.
*Sin esto, W3 cerraba con la suite en rojo.*

**C2 — 🔴 (impacto real) El SDD §7.2 omite el arrange del fail-safe de payout en los tests nuevos.**
Como el gate va **después** de `assertPayoutProviderSafe()` (§5 del SDD) y vitest setea **`NODE_ENV="test"`**
(verificado: `process.env.NODE_ENV ??= "test"` en `node_modules/vitest/dist/chunks/cli-api.*.js:11873`),
la rama **dev** exige `ALLOW_FALLBACK_PAYOUT="true"`. Los tests **B7**, **B6** y **AC-3a/AC-3b** del §7.2
especifican **solo** los stubs de `DIDIT_*` → tal como están escritos **morirían en `payout_refused`** y
nunca ejercerían el gate (el B7 fallaría su propio `toThrow(/didit_adapter_not_ready/)`). **Corregido**
con el bloque ARRANGE OBLIGATORIO al tope de §7. (AC-1/AC-2 no sufren: ya usan el setup prod+MOCK.)

**C3 — 🟡 (cosmético, cero impacto en código) Citación stale en el SDD §2.**
El SDD cita `chaski-v2/app/api/payout/validate/route.ts:60-61` como evidencia del `GET
/v3/session/{id}/decision/`. **Ese código ya no está ahí**: WKH-202/DT-1 lo movió a
**`chaski-v2/src/infrastructure/payout/authority.ts:53-86`** (`validate/route.ts` es hoy un wrapper
delgado de 22 líneas que delega en `resolvePayoutAuthority`). **La evidencia SIGUE SIENDO VÁLIDA** —
verifiqué el endpoint, el header `x-api-key`, el `AbortSignal.timeout(10_000)`, y las ramas fail-closed
(`!res.ok → kyc_reauth_failed` 502, `status !== "Approved" → kyc_not_approved` 200, `catch → 502`) en el
path nuevo. Solo la ruta/líneas citadas estaban desactualizadas. **DT-1(a) se sostiene.**
*(Dato adicional que refuerza R-1: `chaski-v2` crea la sesión con **`POST /v3/session/`**
(`app/api/kyc/session/route.ts:63`) — o sea, su par live es v3+v3. Este repo crea con **v2**
(`kyc.ts:17`). El mismatch v2-create ↔ v3-decision es **específico de este repo** y por eso R-1 es real y
queda gated tras `DIDIT_ADAPTER_READY`.)*

---

## 11. Anti-Hallucination Checklist (verificá ANTES de codear)

- [ ] **Baseline**: `npm run test` da **59 tests / 9 archivos en verde** ANTES de tocar nada. Si no, parás.
- [ ] `assertPayoutProviderSafe()` está en `cashout-payout.ts:48-72` y **NO se toca** (CD-1). El hard-gate
      legacy a **borrar** es el `if (!input.kycPayoutAllowed)` de **L82-93** — son cosas **distintas**.
- [ ] `PayoutProvider.status(payoutId)` (`types.ts:84-90`) es el **exemplar de forma**; `payout.ts:44-60`
      es el **exemplar de impl** (GET + `encodeURIComponent` + `AbortSignal.timeout(8000)` +
      `if (!res.ok) throw` + **eco del id pedido**, L53); `assertValidPayout` (`payout.ts:99-105`) es el
      **exemplar del guard de salida**. Los tres verificados en disco.
- [ ] `REAL_KYC_PROVENANCES` hoy es **const privada** en `kyc-validator.ts:54` → se **mueve** a
      `providers/kyc.ts` y se **exporta**. Va en `kyc.ts` y **NO** en `types.ts` porque `types.ts` es
      **puro tipos** (cero valores runtime hoy) — verificado.
- [ ] `getKycProvider()` (`kyc.ts:103-113`) **lanza** `didit_adapter_not_ready` si hay key sin readiness.
      Va **FUERA del try** de `isKycGatePassed` (rama B7, CD-12).
- [ ] La comparación del gate es **`s.approved !== true`**. PROHIBIDO truthiness (CD-8, WKH-198).
- [ ] `z.object` **sin `.strict()`** → Zod **strippea**: quitar `kycPayoutAllowed` del schema **NO** rompe
      a `chaski-v2`. Verificado ejecutando Zod 3.25.76 del repo. **No lo dejes "por las dudas".**
- [ ] El output sigue teniendo **exactamente 8 campos** (`route.test.ts:60-69` lo assertea) — la rama
      blocked usa `provenance: "n/a"` y `reason: "kyc_gate_not_passed"`, igual que el legacy.
- [ ] **`vi.stubEnv` + `afterEach(vi.unstubAllEnvs)`** es el patrón del repo (`cashout-payout.test.ts:23-52`).
      Para el mock de `fetch` (**el primero del repo**): `vi.stubGlobal` + `afterEach(vi.unstubAllGlobals)`.
- [ ] Test no-PII: patrón `expect(JSON.stringify(out)).not.toContain(...)` (`kyc-validator.test.ts:16-22`).
- [ ] Mock del core en route: `vi.hoisted` + `vi.mock` con `importActual` (`route.test.ts:6-11`).
- [ ] **NO** crear `.env.example` (esta HU no agrega env vars). **NO** agregar DB/KV (CD-11).
- [ ] **NO** tocar `route.ts` de producción, `kyc-validator.test.ts`, ni nada fuera de este repo (CD-2).

---

## 12. Constraint Directives — chequealas UNA POR UNA

| CD | Regla | Cómo la cumplís |
|----|-------|-----------------|
| **CD-1** 🔴 | PROHIBIDO debilitar/saltear/volver condicionales los fail-safes de `assertPayoutProviderSafe()` (`cashout-payout.ts:48-72`): `TRANSFI_API_KEY`+`TRANSFI_ADAPTER_READY`, `PAYOUT_ALLOW_MOCK` en prod, `ALLOW_FALLBACK_PAYOUT` en dev. **Son intocables.** Esta HU **AGREGA** un gate, **no relaja ninguno**. | La fn queda **byte-idéntica** y **primera** en el orden (§4 W2.4) |
| **CD-2** 🔴 | PROHIBIDO modificar `chaski-v2` / `wasiai-a2a` / el demo live (`agentshop-*`, `wasiai-agentshop.vercel.app`, PWA `chaski-ai.vercel.app`). **Leerlos como referencia: SÍ.** | Solo tocás los 8 archivos del §3 |
| **CD-3** | Los 7 tests de `cashout-payout.test.ts:23-83` en verde **con asserts intactos**. | §2.1 (decisión CERRADA) + §7 |
| **CD-4** 🔴 | PROHIBIDO exponer `beneficiary.name` / `beneficiary.destination` / `travelRuleData` en **cualquier** response (200/400/502). | blocked = shape de 8 campos; 502 = body fijo opaco (`route.ts:29`); el `console.warn` del gate loguea **solo `err.name`** |
| **CD-5** 🔴 | **PROHIBIDO habilitar el payout real.** Ninguna wave toca `TRANSFI_API_KEY`/`TRANSFI_ADAPTER_READY`. El objetivo es cerrar el gate de compliance, NO encender Fase A. | Ningún archivo del §3 los toca |
| **CD-6** | Persistencia solo si es decisión consciente del SDD. | **Cerrada**: DT-1(a) alcanza → sin DB/KV |
| **CD-7** 🔴 | `KycStatusResult` **NUNCA** incluye `travelRuleData`/`legalId`/`vendor_data`/identidad. El endpoint de decisión de Didit **SÍ devuelve PII** → **el mapper la descarta y no la lee**. `reasons[]` **value-free**. | §4 W0.1 + W1.2 |
| **CD-8** 🔴 | **Anti-WKH-198**: comparación **`=== true`** / `!== true`. PROHIBIDO truthiness, `!!`, `Number()`, coerción. `assertValidKycStatus()` rechaza `approved` no-booleano. | §5 |
| **CD-9** | PROHIBIDO duplicar `REAL_KYC_PROVENANCES`. **Una sola** (`providers/kyc.ts`), consumida por los 2 agentes. Allowlist, **nunca** denylist. | §4 W0.2/W0.3 |
| **CD-10** | **Extender ≠ modificar**: `KycProvider.verify()` y ambas impls **no se tocan**. `isPayoutAllowed()` no cambia de comportamiento (solo el origen del símbolo). | §2.2 |
| **CD-11** | PROHIBIDO agregar persistencia (DB/KV). DT-1(b) **descartada con evidencia**. | — |
| **CD-12** | PROHIBIDO capturar el throw de `getKycProvider()` para caer al fallback. Key sin readiness = **error**, nunca downgrade silencioso (B7). | §4 W2.3 (fuera del `try`) |
| **CD-13** | PROHIBIDO condicionar el gate KYC a otro flag (`PAYOUT_ALLOW_MOCK`, realness del payout provider, etc.) "para no romper tests". Única excepción: **B5** (espeja la excepción ya auditada de `isPayoutAllowed()`). | §2.1 (alternativa rechazada) |

---

## 13. Done Definition

- [ ] Los **8 archivos** del Scope IN (§3) modificados; **ningún otro** tocado; nada fuera de este repo.
- [ ] `kycPayoutAllowed` **eliminado** del `CashoutPayoutInputSchema`; `input.kycPayoutAllowed` **no compila**.
- [ ] Hard-gate legacy (L82-93) borrado; `isKycGatePassed()` wired en el **orden** de §4 W2.4.
- [ ] `assertPayoutProviderSafe()` **byte-idéntica y primera** (CD-1). `resolveTravelRuleData()` **STUB intacto**.
- [ ] Las **10 ramas B1-B10** implementadas; **default = BLOQUEAR**; `execute()` inalcanzable salvo B1/B5.
- [ ] `REAL_KYC_PROVENANCES` exportada **una sola vez** de `providers/kyc.ts`, consumida por los 2 agentes (CD-9).
- [ ] `kyc-validator.test.ts` (**4 tests**) verde **SIN modificación** (§2.2).
- [ ] Los **7 tests protegidos** (L26,32,39,49,57,68,77) verdes con **asserts intactos**; solo crecieron los
      arrange de **L39** y **L57** (§2.1).
- [ ] `route.test.ts` test **(6)** arreglado (§4 W3.3 / C1); test **(2)** (8 keys) **sin tocar**.
- [ ] ≥1 test por AC (§7) + B6/B7/B9/B10 + el **anti-fail-open explícito** (B6).
- [ ] `project-context.md` actualizado (`ALLOW_FALLBACK_KYC` ahora también gatea el payout). **Sin env vars nuevas.**
- [ ] Cero `any` explícito nuevo, cero `@ts-ignore`, cero `status?` opcional (TS strict).
- [ ] **`npm run typecheck` verde** (AUTORITATIVO — **no** `npm run build`, lección WKH-196).
- [ ] **`npm run test` verde: suite COMPLETA, ≥59 tests, 0 rojos.**
- [ ] Ningún TODO huérfano: R-1 → `DIDIT_ADAPTER_READY` checklist; R-2 → **WKH-204**.
