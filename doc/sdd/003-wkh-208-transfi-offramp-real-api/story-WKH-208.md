# Story File — [WKH-208] Adapter de payout TransFi → API REAL (sandbox e2e, sin plata real)

> F2.5 (NexusAgil QUALITY) · Repo: `wasiai-remittance-agents` · SPEC_APPROVED ✅
> Contrato autocontenido para el Dev. **Leé SOLO este archivo.** Todo lo que no está acá, no se hace.
> Fuente: `sdd.md` (F2, DT-2=Base cerrado) · `doc/transfi-offramp-api-spec.md` · `work-item.md`.
> Baseline verificado **por ejecución** (`npx vitest run`): **123 PASS / 0 FAIL**. `tsc --noEmit` limpio. HEAD `eca36cf`.
> Branch: `feat/003-wkh-208-transfi-offramp-real-api`.

---

## 1. Contexto mínimo (qué se construye y por qué)

Reescribir **solo el contrato HTTP** del `TransFiPayoutProvider` (`src/providers/payout.ts`) contra la
API real de off-ramp de TransFi. Hoy está mal en 4 ejes (se construyó a ciegas en WKH-172):

| Eje | Hoy (mal) | Real (esta HU) |
|---|---|---|
| Endpoint | `POST /v1/payouts` | `POST /v3/orders` con `orderType:"offramp"` |
| Auth | `Bearer TRANSFI_API_KEY` | `Basic base64(user:pass)` + header `mid` |
| Idempotencia | header `idempotency-key` | campo `partnerId` en el body |
| Flujo | síncrono (1 POST → `settled`) | create-order async → devuelve `depositAddress` dedicada; `settled` llega DESPUÉS por webhook (fuera de scope) |

- **Red del USDC = Base** (DT-2 cerrada por el humano): `source.currency = "USDCBASE"`. El adapter es
  configurable por red vía `TRANSFI_USDC_NETWORK` (default `base`), con **fail-loud** si la red no está
  en el allowlist (AC-6). Avalanche NO está soportada a propósito → cae en fail-loud.
- **Sandbox-only, cero plata real.** Default de `TRANSFI_BASE_URL` pasa a `https://sandbox-api.transfi.com`.
- **El mock (`FallbackPayoutProvider`) sigue siendo el default** en todo entorno sin las 3 credenciales +
  `TRANSFI_ADAPTER_READY=true`. Ningún fail-safe existente cambia su intención.
- **Lo que esta HU NO cierra** (CD-4): el envío on-chain del USDC a la `depositAddress` y el webhook
  receiver son HU de seguimiento (viven en `chaski-v2`). Una orden creada en sandbox queda `submitted`
  para siempre desde la perspectiva del sistema — eso es correcto, no un bug.

---

## 2. Scope IN — archivos EXACTOS que se tocan (nada más)

| # | Archivo | Nuevo/Modif | Qué |
|---|---|---|---|
| 1 | `src/providers/types.ts` | Modif | `PayoutResult` += `depositAddress: string \| null` (aditivo) |
| 2 | `src/providers/payout.ts` | Modif | reescritura de `TransFiPayoutProvider` + `normalizeStatus` + `getPayoutProvider` + allowlist de red + default base sandbox |
| 3 | `src/agents/cashout-payout.ts` | Modif | **SOLO** la línea `hasReal` en `assertPayoutProviderSafe()` (L66-67) |
| 4 | `src/providers/payout.test.ts` | Modif | migrar factory a 3 vars + tests nuevos AC-1/2/3/6/7/8 |
| 5 | `src/agents/cashout-payout.test.ts` | Modif | migrar el test `:507` + hardening CD-12 |
| 6 | `project-context.md` (o `.nexus/project-context.md`) | Modif | documentar env vars nuevas (solo nombres/roles, CD-2) |

**PROHIBIDO tocar cualquier otro archivo.** En especial: `src/providers/fx.ts`, `fx.test.ts`,
`corridor-fx.test.ts`, `src/app/api/**/route.test.ts` (todos usan `TRANSFI_API_KEY` para fx — CD-9).
`CashoutPayoutOutput` NO se extiende (Scope OUT).

---

## 3. Anti-Hallucination Checklist (verificado en disco por el Architect — NO re-inventar)

- [x] `PayoutResult` hoy = `{payoutId, status:"submitted"|"settled"|"failed", deliveredLocal, txRef, failureReason, provenance}` — `types.ts:112-119`. El vocabulario `status` YA soporta `"submitted"`. Falta `depositAddress`.
- [x] `PayoutInput` = `{quoteId, amountUsd, beneficiary{name,country,method,destination}, travelRuleData, idempotencyKey}` — `types.ts:98-110`. **NO tiene** `network`, `userId`, `walletAddress`, `paymentCode` ni monto PEN. NO agregar campos a `PayoutInput` (eso es HU de seguimiento).
- [x] `runCashoutPayout` (`cashout-payout.ts:237-254`) mapea `PayoutResult` campo por campo y **NO lee `depositAddress`** → agregar el campo NO obliga a tocar el output público.
- [x] Orden en `runCashoutPayout`: `assertPayoutProviderSafe()` (L197) → `getPayoutProvider()` (L198). El `transfi_adapter_not_ready` sale de `getPayoutProvider()`.
- [x] `fx.ts` lee `TRANSFI_API_KEY`, `TRANSFI_ADAPTER_READY`, `TRANSFI_BASE_URL` → **NO borrar `TRANSFI_API_KEY`, NO renombrar `TRANSFI_ADAPTER_READY`** (CD-9).
- [x] Exemplar del adapter+fallback+factory: `src/providers/kyc.ts` (`DiditKycProvider` L26-66, `getKycProvider` L237-246). Patrón: key ausente→fallback; key sin READY→throw fail-loud; `AbortSignal.timeout`; `if(!res.ok) throw ..._${res.status}`.
- [x] Exemplar de test con fetch mockeado: `kyc.test.ts:55-97` (`jsonResponse` + `vi.stubGlobal("fetch", vi.fn(...))` + `afterEach(vi.unstubAllGlobals)`).
- [x] `assertValidPayout` (`payout.ts:99-105`) exportado — se preserva; sus 3 tests (`payout.test.ts:31-47`) siguen verdes.
- [x] Nombres JSON de `orderId`/`depositAddress` en la respuesta, `userId`, `paymentCode`, `purposeCode`, monto PEN → **NO están fijados en la spec** → ver §7 (F3-discovery: TODO + test mockeado, se validan en W3/sandbox).
- [x] `USDCBASE` está en la lista publicada (spec L38). `USDCAVAX` NO está (fail-loud deliberado, AC-6).
- [x] No existe `npm run qa` en este repo. **El gate es `npm run typecheck` + `npm run test`** (`package.json`).

---

## 4. Constraint Directives como reglas VERIFICABLES

| CD | Regla | Cómo se verifica |
|---|---|---|
| **CD-1** | sandbox-only, cero plata real. Default de `TRANSFI_BASE_URL` → `https://sandbox-api.transfi.com`. Ningún test/script apunta a `api.transfi.com`. | `grep -rn "api.transfi.com" src` → 0 (salvo sandbox). Default en `payout.ts` L8. |
| **CD-2** | creds SOLO de env. Nunca hardcodear `TRANSFI_USERNAME/PASSWORD/MID/WEBHOOK_SECRET`. Tests usan FAKE (`"u"/"p"/"m"`) vía `vi.stubEnv`. | `grep` de valores reales → 0. Tests con literales fake. |
| **CD-3** | el mock sigue siendo default sin las 3 creds + `READY=true`. Fail-safes (`PAYOUT_ALLOW_MOCK`, `ALLOW_FALLBACK_PAYOUT`) intactos byte-a-byte salvo `hasReal`. | Diff de `cashout-payout.ts` = SOLO L66-67. |
| **CD-4** | NO envío on-chain, NO webhook receiver. `TRANSFI_WEBHOOK_SECRET` se documenta pero **NO se lee en código**. | `grep -rn "TRANSFI_WEBHOOK_SECRET\|X-Transfi-Hmac" src` → 0. |
| **CD-5** | error HTTP (incl. `PARTNER_ID_ALREADY_USED`) → throw tipado. NUNCA éxito silencioso ni downgrade al mock. NUNCA asumir `settled` en el POST. | Test AC-7 + AC-3 adversarial. |
| **CD-6** | `partnerId === input.idempotencyKey` **byte-idéntico**, sin regenerar/derivar/truncar. | Test AC-2. |
| **CD-7** | `normalizeStatus` mapea SOLO estados documentados (§6.5). Desconocido → `"submitted"` + `console.warn`, NUNCA `"settled"` fabricado. Borrar `completed/success/error/rejected`. | Test AC-8 (tabla) + mutation self-check §8. |
| **CD-8** | auth `Basic base64(user:pass)` + header `mid`. NUNCA `Bearer`, `x-api-key` ni `idempotency-key`. | Test AC-1. |
| **CD-9** | **NO borrar `TRANSFI_API_KEY`** (fx lo usa) · **NO renombrar `TRANSFI_ADAPTER_READY`** (fx lo comparte). Se AGREGAN vars, no se quitan las de fx. | `grep -rn "TRANSFI_API_KEY\|TRANSFI_ADAPTER_READY" src/providers/fx.ts` sigue presente. |
| **CD-10** | gate = `npm run typecheck` (completo, incluye `*.test.ts` — NUNCA solo `npm run build`) + `npm run test`. Baseline **123** preservada. | Ver §9 por wave. |
| **CD-11** | ningún log/error expone `beneficiary.*`, `travelRuleData`, `legalId` ni el body crudo. Errores tipados por `status`, value-free. | revisión de strings de error. |
| **CD-12** | tests que dependen del fallback NO deben confiar en la AUSENCIA de `TRANSFI_USERNAME/PASSWORD/MID`. Stubbear explícito (`""` fallback / FAKE real) + `afterEach(vi.unstubAllEnvs)`. | Ver §7 W2. |

---

## 5. Contratos exactos (del SDD — no reabrir)

### 5.1 `types.ts` (W0)
```ts
export interface PayoutResult {
  payoutId: string;
  status: "submitted" | "settled" | "failed";
  deliveredLocal: number | null;
  txRef: string | null;
  failureReason: string | null;
  provenance: Provenance;
  depositAddress: string | null; // NUEVO (DT-4). null en fallback y en status() sin address.
}
```

### 5.2 Env vars (W0 — documentar en project-context, NO transcribir valores — CD-2)
| Env var | Rol | Nota |
|---|---|---|
| `TRANSFI_USERNAME` | Basic auth user | secreto. Señal de "real" en payout (reemplaza a `TRANSFI_API_KEY`). |
| `TRANSFI_PASSWORD` | Basic auth pass | secreto. |
| `TRANSFI_MID` | header `mid` | ej. `WIIB1V_NA_NA`. |
| `TRANSFI_BASE_URL` | base host | default → `https://sandbox-api.transfi.com` (CD-1). |
| `TRANSFI_USDC_NETWORK` | red del USDC | default `base` → `USDCBASE`. Fail-loud si fuera del allowlist (AC-6). |
| `TRANSFI_SOURCE_WALLET_ADDRESS` | `source.walletAddress` | config, no secreto. Confirmar forma en F3. |
| `TRANSFI_PURPOSE_CODE` | `purposeCode` del body | descubrir valor válido en F3. |
| `TRANSFI_WEBHOOK_SECRET` | firma webhook | **RESERVADO — NO se lee en esta HU** (CD-4). Solo documentar. |
| `TRANSFI_API_KEY` | (legado) | **NO borrar** — fx lo usa (CD-9). |
| `TRANSFI_ADAPTER_READY` | opt-in adapter real | **compartido con fx — no renombrar** (CD-9). |

### 5.3 Body de `POST /v3/orders` (offramp) que arma `execute()`
Campos **contrato-fijos** (tests los asertan) + **F3-resueltos** (config o `TODO(F3)`, §7):
```jsonc
{
  "orderType": "offramp",                       // fijo (AC-2)
  "partnerId": "<input.idempotencyKey>",        // fijo, byte-idéntico (CD-6/AC-2)
  "userId": "<F3 — TODO(F3): flujo userId UX- KYC'd>",
  "purposeCode": "<TRANSFI_PURPOSE_CODE — F3>",
  "source": {
    "currency": "<resolveSourceCurrency(TRANSFI_USDC_NETWORK) — fail-loud si no soportada (AC-6)>",
    "walletAddress": "<TRANSFI_SOURCE_WALLET_ADDRESS>",
    "amount": <input.amountUsd>                 // fijo
  },
  "destination": {
    "currency": "PEN",                          // fijo
    "paymentType": "bank_transfer",             // fijo (spec L48)
    "paymentCode": "<GET /v3/payment-methods — F3>",
    "amount": <F3: monto PEN — hoy NO viaja en PayoutInput, §7>,
    "additionalPaymentDetails": { /* beneficiario PE — F3 */ }
  }
}
```

### 5.4 Allowlist de red (constante en `payout.ts`)
```ts
const TRANSFI_DEFAULT_NETWORK = "base"; // DT-2 (humano, 2026-07-17)
const TRANSFI_USDC_CURRENCY: Record<string, string> = {
  ethereum: "USDC", polygon: "USDCPOLYGON", base: "USDCBASE", arbitrum: "USDCARB",
  bsc: "USDCBSC", solana: "USDCSOL", celo: "USDCCELO", linea: "USDCLINEA",
  algorand: "USDCALGO", stellar: "USDCXLM", fuse: "USDCFUSE",
};
function resolveSourceCurrency(network: string): string {
  const code = TRANSFI_USDC_CURRENCY[network.trim().toLowerCase()];
  if (!code) throw new Error(`transfi_unsupported_network_${network}`); // AC-6, ANTES de armar/enviar
  return code;
}
// uso: resolveSourceCurrency(process.env.TRANSFI_USDC_NETWORK ?? TRANSFI_DEFAULT_NETWORK)
```

### 5.5 `normalizeStatus()` — EXPORTAR para test directo (CD-7/AC-8)
| TransFi `status` | `PayoutResult.status` |
|---|---|
| `initiated` | `"submitted"` |
| `asset_deposited` | `"submitted"` |
| `fund_settled` | `"settled"` |
| `fund_failed` | `"failed"` |
| `expired` | `"failed"` |
| (desconocido) | `"submitted"` + `console.warn` (**nunca** `"settled"`) |

Borrar los valores inventados actuales (`completed/success/error/rejected`).

### 5.6 Respuesta create-order → `PayoutResult` (AC-3)
En `2xx`: `status:"submitted"` **forzado** (NO leer status del POST — CD-5), `payoutId = <orderId>`,
`depositAddress = <walletAddress dedicada>`, `deliveredLocal:null`, `provenance:"transfi"`.
Nombres JSON de `orderId`/`walletAddress` → parseo defensivo (narrowing por tipo, NO `String()`
coercitivo) + `TODO(F3)`. En `!2xx` → `throw new Error(`transfi_payout_error_${res.status}`)` (AC-7).
`status()` en `!2xx` → `transfi_payout_status_error_${res.status}`.

### 5.7 Auth headers (AC-1/CD-8)
```ts
function transfiHeaders(c: {username:string; password:string; mid:string}): HeadersInit {
  const basic = Buffer.from(`${c.username}:${c.password}`).toString("base64");
  return { "content-type": "application/json", authorization: `Basic ${basic}`, mid: c.mid };
}
```

### 5.8 Factory + fail-safe (AC-5/DT-5)
```ts
export function getPayoutProvider(): PayoutProvider {
  const username = process.env.TRANSFI_USERNAME;
  const password = process.env.TRANSFI_PASSWORD;
  const mid = process.env.TRANSFI_MID;
  if (!username || !password || !mid) return new FallbackPayoutProvider(); // falta cualquiera → mock
  if (process.env.TRANSFI_ADAPTER_READY !== "true") {
    throw new Error("transfi_adapter_not_ready: credenciales TransFi seteadas pero " +
      "TRANSFI_ADAPTER_READY!=true — confirmá el mapeo + el flujo de depósito con el sandbox antes de mover plata.");
  }
  return new TransFiPayoutProvider({ username, password, mid });
}
```
`assertPayoutProviderSafe()` (`cashout-payout.ts` L66-67) — **SOLO** cambia `hasReal`:
```ts
const hasReal = !!process.env.TRANSFI_USERNAME && !!process.env.TRANSFI_PASSWORD &&
  !!process.env.TRANSFI_MID && process.env.TRANSFI_ADAPTER_READY === "true";
```
Todo lo demás del método (orden de chequeos, `PAYOUT_ALLOW_MOCK`, `ALLOW_FALLBACK_PAYOUT`, warns)
**intocable** (CD-3).

---

## 6. Waves — archivos + qué + tests + gate + DoD

### W0 — Contratos y tipos (SERIAL, todo depende de esto)
**Archivos:** `types.ts`, `payout.ts` (parcial), `project-context.md`.
- [ ] `types.ts`: `PayoutResult += depositAddress: string | null` (§5.1).
- [ ] `payout.ts`: constante `TRANSFI_USDC_CURRENCY` + `resolveSourceCurrency()` (§5.4); cambiar default de `TRANSFI_BASE` a sandbox (§5.2, CD-1).
- [ ] `project-context.md`: documentar env vars nuevas (§5.2, solo nombres/roles — CD-2).
- **Gate:** `npm run typecheck` (puede quedar ROJO en los `return` de `PayoutResult` sin `depositAddress` — se completan en W1; eso es esperado).
- **DoD:** el tipo compila salvo los returns pendientes de W1; env vars documentadas.

### W1 — Adapter HTTP + fail-safe (depende de W0)
**Archivos:** `payout.ts`, `cashout-payout.ts`.
- [ ] `payout.ts`: reescribir `TransFiPayoutProvider`:
  - constructor `{username, password, mid}` (no `apiKey`).
  - `transfiHeaders` (§5.7).
  - `execute()`: resolver `source.currency` (§5.4), armar body `POST /v3/orders` (§5.3), forzar `status:"submitted"` en 2xx (§5.6), throw tipado en !2xx (§5.6/AC-7), `AbortSignal.timeout` (espejo kyc.ts).
  - `status()`: `GET /v3/orders/{id}` con Basic+mid; `normalizeStatus` en 2xx; throw `transfi_payout_status_error_${res.status}` en !2xx; `depositAddress:null` (sin address en status).
  - **exportar** `normalizeStatus()` con el mapeo §5.5.
  - `FallbackPayoutProvider`: devolver `depositAddress:null` en `execute()` y `status()`.
  - `getPayoutProvider()`: 3 vars (§5.8).
- [ ] `cashout-payout.ts`: swap de `hasReal` (§5.8) — **SOLO L66-67, nada más**.
- **Gate:** `npm run typecheck` **LIMPIO** (los tests viejos pueden fallar hasta W2 — no es bloqueante del typecheck).
- **DoD:** typecheck verde; `assertValidPayout` intacto; fail-safe intacto salvo `hasReal`.

### W2 — Tests mockeados + migración de blast-radius (depende de W1) — ver §7 y §8
**Archivos:** `payout.test.ts`, `cashout-payout.test.ts`.
- [ ] `payout.test.ts`: tests AC-1/2/3/6/7/8 (§8) con `vi.stubGlobal("fetch", vi.fn(...))`; migrar factory (AC-5) a las 3 vars; extender el assert del `FallbackPayoutProvider` con `depositAddress:null`.
- [ ] `cashout-payout.test.ts`: migrar el test **`:507-514`** a las 3 vars (§7); hardening CD-12 en los stubs que lo requieran.
- **Gate:** `npm run typecheck` + `npm run test` → **≥123 PASS / 0 FAIL** (baseline + nuevos), **contando por ejecución** (`npx vitest run`), no leyendo.
- **DoD:** toda la suite verde; ningún test de fx/route/corridor tocado.

### W3 — Smoke de sandbox (AC-4) — evidencia, NO test permanente (CD-1)
**Acción GATEADA — la corre el orquestador/founder con `!`, no el Dev en piloto automático.**
- [ ] Con las creds reales del founder ya en `.env.local`: `POST /v3/orders` + `GET /v3/orders/{id}` contra `sandbox-api.transfi.com`, documentando en el done-report: host + respuesta (creds/PII redactadas — CD-2/CD-11).
- [ ] Descubrir/confirmar en este paso los F3-items (§7): nombres reales de `orderId`/`depositAddress`, `paymentCode` (`GET /v3/payment-methods`), soporte de red (`list-tokens` → confirma `USDCBASE`), `purposeCode`, flujo de `userId`.
- **Acotado sin plata:** si crear una orden completa requiere un `userId` KYC'd no disponible, el smoke se limita a **auth (nunca 401) + endpoint + shape del error 4xx** — suficiente para AC-4.
- **NO** dejar script permanente en el repo salvo decisión explícita (gated, sandbox-only).
- **DoD:** evidencia en done-report; F3-items resueltos o marcados como pendientes de la HU de seguimiento.

Orden: W0→W1→W2 serial (dependencia de tipos/símbolos, un solo archivo central). W3 al final.

---

## 7. Blast-radius del env var swap — QUÉ tests migrar (contar EJECUTANDO, baseline 123)

`grep` ejecutado. División exacta:

### MIGRAR — obligatorio (rompen o pierden intención con el swap)
| Archivo:línea | Test | Acción |
|---|---|---|
| `payout.test.ts:49-64` | factory (3 `it`: `sin key→fallback`, `key sin readiness→throws`, `key+readiness→adapter`) | reemplazar `TRANSFI_API_KEY` por las 3 vars (`TRANSFI_USERNAME/PASSWORD/MID`). `""` para fallback, FAKE para real. |
| `cashout-payout.test.ts:507-514` | `"PROD + PAYOUT_ALLOW_MOCK + ... sin READY → throws transfi_adapter_not_ready"` | **⚠️ ROMPE**: hoy setea `TRANSFI_API_KEY="k"` (L511). Tras el swap `getPayoutProvider()` ya no lee esa var → no throwea. Migrar a `stubEnv("TRANSFI_USERNAME/PASSWORD/MID","fake")` + `TRANSFI_ADAPTER_READY=""`. Flujo verificado: `assertPayoutProviderSafe` (prod+PAYOUT_ALLOW_MOCK→warn+return) → `getPayoutProvider` (3 vars + READY≠true → throw). El nombre del test/assert (`transfi_adapter_not_ready`) se mantiene. |

### HARDENING CD-12 — recomendado en W2 (pasan hoy pero dependen de la AUSENCIA de las 3 vars)
| Archivo:línea | Detalle |
|---|---|
| `cashout-payout.test.ts:516-521` | `"PROD sin PAYOUT_ALLOW_MOCK → throws payout_refused"`: hoy setea `TRANSFI_API_KEY=""`. Pasa igual tras el swap, pero para determinismo agregar `vi.stubEnv("TRANSFI_USERNAME/PASSWORD/MID","")`. |
| `cashout-payout.test.ts` L47,62,75,88,102,114,130,154,260,281,455,461,468,492 (14 stubs `TRANSFI_API_KEY=""`) | Inertes pero dependen de que las 3 vars nuevas NO estén en el env de vitest. Recomendado: donde el test asierte decisivamente el path fallback, agregar stub explícito de las 3 vars a `""`. `afterEach(vi.unstubAllEnvs)`. |

### NO TOCAR (fx sigue usando `TRANSFI_API_KEY` — CD-9)
- `src/app/api/agents/remit-cashout-payout/invoke/route.test.ts:39,137,147`
- `src/app/api/agents/remit-corridor-fx/invoke/route.test.ts:25`
- `src/agents/corridor-fx.test.ts:6`
- `src/providers/fx.test.ts:66,70,71,75,76`

### F3-discovery items (contrato documentado + `TODO(F3)` + test mockeado; sandbox valida en W3)
Construir el adapter con el contrato documentado y dejar estos puntos con `TODO(F3)` claro y test
mockeado (los unit-tests NO dependen de estos valores; asertan los ejes contrato-críticos):
1. **Nombres JSON exactos de `orderId` y `depositAddress`** en la respuesta del POST — parseo defensivo (narrowing por tipo, no `String()` coercitivo). W3 confirma.
2. **`userId` (UX-)**: flujo de usuario TransFi KYC'd → `TODO(F3)`. Probable HU de seguimiento.
3. **`paymentCode`** (`GET /v3/payment-methods`), **`additionalPaymentDetails`** (beneficiario PE), **`purposeCode`**, **monto PEN** (`destination.amount`, hoy NO viaja en `PayoutInput`) → `TODO(F3)` / de config. Si F3 confirma que TransFi exige el monto PEN, extender `PayoutInput` es HU de seguimiento (fuera de scope).

---

## 8. Tests requeridos (≥1 por AC — todos MOCKEADOS salvo W3)

Helper (espejo `kyc.test.ts:55-60`): `jsonResponse(body,status)` + `vi.stubGlobal("fetch", vi.fn(async()=>jsonResponse(...)))` + `afterEach(()=>{vi.unstubAllGlobals(); vi.unstubAllEnvs();})`. Creds FAKE (`"u"/"p"/"m"`). Provider directo: `new TransFiPayoutProvider({username:"u",password:"p",mid:"m"})`.

| AC | Test en `payout.test.ts` (salvo indicado) |
|---|---|
| **AC-1** | `execute()` captura el request: `headers.authorization === "Basic " + Buffer.from("u:p").toString("base64")` **y** `headers.mid === "m"`; NUNCA contiene `Bearer` ni `x-api-key`. |
| **AC-2** | body: `url` termina en `/v3/orders` (no `/v1/payouts`); `orderType==="offramp"`; `partnerId===input.idempotencyKey` (byte-idéntico); **sin** header `idempotency-key`. |
| **AC-3** | `2xx` mock (con `orderId`+`walletAddress`) → `{status:"submitted", payoutId:<orderId>, depositAddress:<walletAddress>, deliveredLocal:null, provenance:"transfi"}`. **Adversarial:** mock que devuelve `status:"fund_settled"` en el POST **NO** produce `"settled"` (se fuerza `submitted`). |
| **AC-4** | Evidencia W3/sandbox (no unit) — done-report. |
| **AC-5** | factory: sin las 3 vars→`FallbackPayoutProvider`; las 3 sin `READY`→throw `transfi_adapter_not_ready`; las 3 + `READY=true`→`TransFiPayoutProvider`. + `cashout-payout.test.ts:507` migrado. |
| **AC-6** | `TRANSFI_USDC_NETWORK="avalanche"` (o cualquier no soportada) → `execute()` throw `transfi_unsupported_network_avalanche` **sin** llamar `fetch` (`expect(fetchMock).not.toHaveBeenCalled()`). Feliz: `"polygon"`→body con `source.currency==="USDCPOLYGON"`; `"base"`→`"USDCBASE"`. |
| **AC-7** | mock `4xx`/`5xx` (incl. body `{code:"PARTNER_ID_ALREADY_USED"}`) → `execute()` **throws** `transfi_payout_error_<status>`; nunca resuelve exitoso ni cae al mock. Idem `status()`→`transfi_payout_status_error_<status>`. |
| **AC-8** | tabla directa sobre `normalizeStatus()` (exportado): `initiated`/`asset_deposited`→`"submitted"`; `fund_settled`→`"settled"`; `fund_failed`/`expired`→`"failed"`; desconocido→`"submitted"`. Un caso por estado. |
| baseline | `FallbackPayoutProvider` ahora devuelve `depositAddress:null` (extender asserts existentes L21-28); `assertValidPayout` verde. |

---

## 9. Auto-blindaje (correr ANTES de entregar cada wave)

- [ ] **`grep -rn "MUTANT" src doc/sdd/003*` = 0** antes de entregar (verificado hoy = 0; no introducir marcadores).
- [ ] **`npm run typecheck` COMPLETO** (incluye `*.test.ts`) — NUNCA solo `npm run build` (excluye tests, lección WKH-196). Es el gate real.
- [ ] **`npm run test` contando por ejecución** (`npx vitest run` → línea `PASS (N)`), no leyendo. Baseline **123**; entregar `≥123 PASS / 0 FAIL`.

**Mutation self-checks (matar mutantes que un test flojo dejaría vivos):**
- [ ] **Mapeo de estados (CD-7/AC-8):** un test con `status:"fund_settled"` **en la respuesta del POST** que NO debe dar `"settled"` (mata el mutante "leer status del POST"). Un caso `desconocido→submitted` que NO devuelva `settled` (mata el mutante "default settled").
- [ ] **Fail-loud de red no soportada (AC-6):** aserción `expect(fetchMock).not.toHaveBeenCalled()` junto al throw (mata el mutante "resolver la red igual manda la orden"). Sin esa aserción, un mutante que arma `source.currency` a ciegas sobrevive.
- [ ] **`String()` coercitivo (WKH-204):** el parseo de `orderId`/`depositAddress` usa narrowing por tipo; campo ausente/no-string → `null`/throw, NUNCA valor fabricado. `String(x ?? "")` nace fail-open — prohibido para estos campos.
- [ ] **Comparación de gate estricta (WKH-203/204):** `TRANSFI_ADAPTER_READY === "true"` estricto, nunca truthiness. `hasReal` con `!!` en cada var.
- [ ] **Fixtures de fetch:** usar **`mockImplementation`** (`vi.fn(async () => jsonResponse(...))`), NO `mockResolvedValue`, para poder inspeccionar los args del request (headers/body/url) en las aserciones AC-1/2/6. Los `vi.fn` de unión tipados correctamente (evitar `any` explícito — golden path TS strict).

---

## 10. Done Definition (la HU termina cuando)

- [ ] W0-W2 implementadas; los 6 archivos de Scope IN modificados, ninguno fuera.
- [ ] `npm run typecheck` limpio + `npm run test` = `≥123 PASS / 0 FAIL` (por ejecución).
- [ ] Blast-radius migrado: `payout.test.ts:49-64` + `cashout-payout.test.ts:507-514`; hardening CD-12 aplicado.
- [ ] Adapter: `POST /v3/orders`, Basic+mid, `partnerId=idempotencyKey`, `normalizeStatus` §5.5 exportado, `depositAddress` en `PayoutResult`/ambos providers, allowlist con fail-loud AC-6, default sandbox.
- [ ] `fx.ts`/`fx.test.ts`/route.test.ts/corridor NO tocados; `TRANSFI_API_KEY` y `TRANSFI_ADAPTER_READY` preservados (CD-9). `TRANSFI_WEBHOOK_SECRET` NO leído (CD-4).
- [ ] `grep MUTANT`=0; mutation self-checks §9 cubiertos.
- [ ] W3 smoke (AC-4) corrido gateado por orquestador/founder; evidencia en done-report; F3-items resueltos o derivados a HU de seguimiento.

---

*Generado por nexus-architect — F2.5. Contrato para nexus-dev (F3). Baseline 123 verificada por ejecución.
El Dev NO reabre el SDD; toda decisión ya está acá. Los F3-items se resuelven en sandbox (W3), no se inventan.*
