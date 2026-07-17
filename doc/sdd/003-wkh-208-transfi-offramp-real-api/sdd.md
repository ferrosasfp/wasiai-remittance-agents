# SDD — [WKH-208] Reescribir el adapter de payout de TransFi a la API REAL (sandbox e2e, sin plata real)

> F2 (NexusAgil QUALITY) · Repo: `wasiai-remittance-agents` · SDD_MODE: **full**
> Input: `work-item.md` (HU_APPROVED 2026-07-17) + `project-context.md` + `doc/transfi-offramp-api-spec.md`
> Baseline verificado por ejecución: `eca36cf` · **123/123 verde** (9 files) · `tsc --noEmit` limpio.
> Branch sugerido: `feat/003-wkh-208-transfi-offramp-real-api`
> Alcance: SOLO el contrato HTTP del adapter (`payout.ts`). El envío on-chain del USDC y el
> webhook receiver son la HU de SEGUIMIENTO — fuera de scope (CD-4, DT-1).

---

## 1. Context Map — qué leí y qué extraje

Todo verificado con `Read`/`grep`/ejecución **antes** de citarlo (lección auto-blindaje WKH-203/204:
no contar líneas ni asumir shapes de memoria).

| Archivo / fuente | Por qué lo leí | Qué extraje (hecho verificado) |
|---|---|---|
| `doc/transfi-offramp-api-spec.md` (70 L) | **La spec verificada** — grounding del contrato real | Base sandbox `https://sandbox-api.transfi.com` (L7); auth `Basic base64(user:pass)` + header `mid` (L11-19, NO Bearer); endpoint `POST /v3/orders` `orderType:"offramp"` (L21); body con `partnerId`/`source.currency`/`destination` (L23-34); idempotencia campo `partnerId` (L50-51); estados `initiated→asset_deposited→fund_settled`/`fund_failed`/`expired` (L43); `GET /v3/orders/{id}` (L37); códigos USDC soportados sin `USDCAVAX` (L38-39); webhook `X-Transfi-Hmac-Hash` (L44, HU seguimiento); cabos sueltos a descubrir en sandbox (L65-69). |
| `src/providers/payout.ts` (118 L) | El archivo central a reescribir | `TransFiPayoutProvider.execute()` L14-42: `POST /v1/payouts` + `Bearer` + header `idempotency-key` + body `{quoteId,amount,beneficiary,travelRule}` — **los 4 ejes están mal**. `status()` L44-60: `GET /v1/payouts/{id}`. `normalizeStatus()` L91-96: mapea valores inventados (`completed/success/error/rejected`). `getPayoutProvider()` L107-118: lee **una** env var `TRANSFI_API_KEY`. `assertValidPayout()` L99-105 exportado. `TRANSFI_BASE` L8 default **prod**. |
| `src/providers/types.ts` (127 L) | Contrato `PayoutInput`/`PayoutResult`/`PayoutProvider` | `PayoutInput` L98-110 = `{quoteId, amountUsd, beneficiary{name,country,method,destination}, travelRuleData, idempotencyKey}` — **NO tiene** `network`, `userId`, `walletAddress`, `paymentCode`, ni monto PEN. `PayoutResult` L112-119 = `{payoutId, status:"submitted"|"settled"|"failed", deliveredLocal, txRef, failureReason, provenance}` — el vocabulario `status` **ya soporta** `"submitted"`; **falta** `depositAddress`. `PayoutProvider` L121-127 = `execute()` + `status()`. |
| `src/agents/cashout-payout.ts` (269 L) | Blast radius del env var swap (DT-5) | `assertPayoutProviderSafe()` L65-89 lee `process.env.TRANSFI_API_KEY` (L66-67) para decidir `hasReal`; el resto (`PAYOUT_ALLOW_MOCK` prod L75, `ALLOW_FALLBACK_PAYOUT` dev L83) es lógica de gate **intocable**. `runCashoutPayout()` L237-254 mapea `PayoutResult`→`CashoutPayoutOutput` **sin leer `depositAddress`** (no existe) → agregar el campo a `PayoutResult` NO obliga a tocar el output público (Scope OUT). |
| `src/providers/kyc.ts` (247 L) | **Exemplar** de adapter+fallback+factory con readiness gate | Patrón `getKycProvider()` L237-247: key ausente→fallback; key sin `X_ADAPTER_READY`→**throw fail-loud**; nunca downgrade silencioso. `DiditKycProvider` construye headers, `fetch` con `AbortSignal.timeout(8000)`, `if(!res.ok) throw ...error_${res.status}`. Este es el molde exacto a espejar. |
| `src/providers/fx.ts` (L8, L115-119) | **Colisión de env vars** — fx sigue en scope OUT (DT-3) | `fx.ts` **también** lee `TRANSFI_API_KEY` (L115) y `TRANSFI_ADAPTER_READY` (L117) y `TRANSFI_BASE_URL` (L8). ⇒ **PROHIBIDO borrar `TRANSFI_API_KEY` globalmente** (rompe fx) y **PROHIBIDO renombrar `TRANSFI_ADAPTER_READY`** (fx lo comparte). Ver CD-9. |
| `src/providers/kyc.test.ts` (L55-97) | Patrón de test con fetch mockeado | `jsonResponse(body,status)` helper (L55-57) + `vi.stubGlobal("fetch", vi.fn(async()=>jsonResponse(...)))` + `afterEach(()=>vi.unstubAllGlobals())`. Molde para los tests de `execute()`/`status()`. |
| `src/providers/payout.test.ts` (65 L) | Suite a migrar | 7 `it(`. Factory tests L49-64 usan `TRANSFI_API_KEY` como única señal → **migrar a 3 vars** (AC-5). |
| `src/agents/cashout-payout.test.ts` (L507-518) | **Test que ROMPE con el swap** | L507 `"PROD + PAYOUT_ALLOW_MOCK + TRANSFI_API_KEY sin READY → throws transfi_adapter_not_ready"` setea `TRANSFI_API_KEY="k"` (L511). Tras el swap, `getPayoutProvider()` ya NO lee esa var → NO throwea → **el test falla**. Debe migrarse a `TRANSFI_USERNAME/PASSWORD/MID`. Ver §5 blast radius. |
| `src/app/api/agents/**/invoke/route.test.ts`, `corridor-fx.test.ts`, `fx.test.ts` | ¿más fallout? | Stubbean `TRANSFI_API_KEY=""` para forzar fallback. Tras el swap eso queda **vestigial pero inocuo** (con `TRANSFI_USERNAME` ausente igual cae al fallback). Ver §5. |
| `doc/sdd/002-.../sdd.md`, `project-context.md §Auto-Blindaje` | Formato + aprendizaje histórico | Ver §9 y §11. |

**Comandos ejecutados** (no conté a mano):
- `npm run typecheck` → **OK, limpio**. `npx vitest run` → **123/123, 9 files**.
- `grep -rn "TRANSFI_" src --include=*.ts` → mapeado el blast radius completo del env var swap (§5).
- `git rev-parse --short HEAD` → `eca36cf`.

---

## 2. Contexto — qué se construye y por qué

El adapter `TransFiPayoutProvider` se construyó a ciegas en WKH-172 (`TODO(sandbox)`) y está mal en
los 4 ejes que ahora la spec verificada corrige: **endpoint** (`/v1/payouts`→`POST /v3/orders`
offramp), **auth** (`Bearer`→`Basic base64(user:pass)`+`mid`), **idempotencia** (header
`idempotency-key`→campo `partnerId`), y el **flujo** (asumía `settled` síncrono → el real es
create-order asíncrono: la orden devuelve una `depositAddress` dedicada y la confirmación
`fund_settled` llega después por webhook). Esta HU reescribe **solo el contrato HTTP** del adapter y
lo valida en sandbox para create-order + consulta de estado, **sin mover plata real**. El
`FallbackPayoutProvider` (mock) sigue siendo el default en todo entorno sin las credenciales + 
`TRANSFI_ADAPTER_READY=true`.

**Lo que esta HU NO cierra** (límite honesto, CD-4): el envío on-chain del USDC a la `depositAddress`
y el webhook receiver que consume `fund_settled` son la HU de seguimiento (DT-1). Con este adapter,
una orden creada en sandbox queda en `submitted` para siempre desde la perspectiva del sistema — es
el estado correcto y esperado, no un bug.

---

## 3. Decisiones técnicas (DT-N)

### DT-1 — Ubicación del webhook receiver (HU de seguimiento) — **recomendación documentada, NO se implementa acá**

**Recomendación del Architect: el webhook receiver vive en `chaski-v2`, NO en este repo.** Coincide
con la recomendación no vinculante del Analyst (work-item DT-1) y se cierra con estos argumentos
verificados:

1. **El estado que hay que actualizar YA vive en `chaski-v2`.** El ledger `remittance_settlements`
   (WKH-207) persiste `payoutId`/`orderId`; el webhook `fund_settled` correlaciona por ese id y
   marca el estado terminal. Poner el receiver acá exigiría una **segunda** base de datos en un repo
   que hoy es **cero-persistencia por diseño** (`project-context.md §Stack`: "NO tiene ninguna capa
   de persistencia") — el mismo antipatrón que WKH-207 evitó a propósito (su CD-10).
2. **Superficie pública.** `chaski-v2` ya expone rutas `app/api/**` públicas en Vercel — un webhook
   público de un partner externo es un patrón existente ahí. `wasiai-remittance-agents` es el
   servicio a2a **interno** (Railway, consumido por el gateway); exponerle un webhook público de
   TransFi le cambia la superficie de forma que hoy no tiene.
3. **El secreto nuevo `TRANSFI_WEBHOOK_SECRET`** (HMAC-SHA256 sobre el body crudo, header
   `X-Transfi-Hmac-Hash`, comparación constant-time) vive donde se valida la firma → `chaski-v2`.

**Qué deja lista esta HU para esa HU:** `PayoutResult.depositAddress` (DT-4) + `orderId` (→`payoutId`)
en la respuesta, de modo que la HU de seguimiento **no necesita otro cambio de contrato de tipos**.
El nombre de env var `TRANSFI_WEBHOOK_SECRET` se **reserva/documenta** (project-context) pero **NO se
lee en el código de esta HU** — leer una env var muerta sería dead-code (CD-4).

### DT-2 — Red del USDC: **CERRADA = Base** (decisión del humano, 2026-07-17) + adapter configurable

La spec (`doc/transfi-offramp-api-spec.md:38-39`) lista los códigos `source.currency` publicados:
`USDC`(eth), `USDCPOLYGON`, **`USDCBASE`**, `USDCARB`, `USDCBSC`, `USDCSOL`, `USDCCELO`, `USDCLINEA`,
`USDCALGO`, `USDCXLM`, `USDCFUSE`. **`USDCAVAX` (Avalanche) NO está** — y Chaski hoy settlea el
principal en Avalanche/Fuji (WKH-168).

**Decisión del humano (gate previo a SPEC_APPROVED): el corredor va por Base.**
- Red objetivo = **Base** → `source.currency` = **`USDCBASE`** (está en la lista publicada, así que
  AC-6 **no** falla para Base). El default documentado de `TRANSFI_USDC_NETWORK` es **`base`**.
- **Diseño: el adapter sigue configurable por red** (`TRANSFI_USDC_NETWORK` → allowlist §6.4 →
  código `source.currency`), pero **Base es la elección por default/documentada**, no "agnóstico sin
  decidir". Cualquier red **fuera del allowlist** (incluida `avalanche`, que a propósito no está) →
  **fail-loud** `transfi_unsupported_network_<network>` (AC-6) antes de armar/enviar la orden — nunca
  una `source.currency` adivinada. F3 confirma `USDCBASE` contra sandbox (`list-tokens`).

> 🔗 **Implicación downstream — SOLO NOTA, NO se implementa en esta HU (follow-up en `chaski-v2`):**
> con Base como red del corredor, el settlement del **principal** de Chaski debe pasar de
> **Avalanche** (WKH-168: EIP-3009 en Fuji 43113 / mainnet 43114) a **Base** (Base Sepolia 84532
> testnet / Base mainnet 8453). **Buena noticia:** `wasiai-facilitator` ya soporta settle en Base
> Sepolia (`BaseEip3009Adapter` existe) → la infra está. Apuntar Chaski a Base es una **HU/cambio de
> seguimiento en `chaski-v2`**, fuera del scope de WKH-208. Se anota acá (§13 Dependencias/Follow-up)
> para que la HU siguiente lo tome. Esta HU **no toca** WKH-168 ni `chaski-v2`.

### DT-3 — `fx.ts` se difiere a HU propia (heredado del work-item)

`fx.ts` tiene el mismo bug (`Bearer` + `/v1/quotes`) pero su endpoint de cotización real **no está**
en `doc/transfi-offramp-api-spec.md` (que solo documenta off-ramp). Reescribirlo a ciegas repetiría
el error que esta HU corrige. **Fuera de scope.** Consecuencia operativa crítica: `fx.ts` **sigue
leyendo `TRANSFI_API_KEY`, `TRANSFI_ADAPTER_READY` y `TRANSFI_BASE_URL`** → esta HU **NO** puede
borrar `TRANSFI_API_KEY` ni renombrar `TRANSFI_ADAPTER_READY` (CD-9).

### DT-4 — extensión **aditiva** de `PayoutResult` (`depositAddress: string | null`)

Se agrega `depositAddress: string | null` a `PayoutResult` (`types.ts`). Es aditivo: ningún
consumidor lo lee hoy (`runCashoutPayout` mapea campo por campo sin tocarlo). `FallbackPayoutProvider`
y `TransFiPayoutProvider` deben devolverlo (`null` el fallback; el valor real el adapter). No se
extiende `CashoutPayoutOutput` (Scope OUT): el campo queda interno, listo para la HU de seguimiento.

### DT-5 — env var swap en **2 archivos** (`payout.ts` + `cashout-payout.ts`), no 1

`TRANSFI_API_KEY` (singular) se reemplaza por `TRANSFI_USERNAME`/`TRANSFI_PASSWORD`/`TRANSFI_MID`
como señal de "hay provider real" en los **dos** lugares que la leen independientemente:
`getPayoutProvider()` (`payout.ts:109`) y `assertPayoutProviderSafe()` (`cashout-payout.ts:66-67`).
Si se cambia solo uno, el fail-safe queda inconsistente con la factory. Ambos en Scope IN.

### DT-6 — Validación de red por **allowlist estático verificado**, no por llamada en runtime (AC-6)

AC-6 exige fail-loud si la red no está soportada. Dos opciones: (i) allowlist estático (de la lista
publicada + confirmado en F3) o (ii) llamar `list-tokens` en cada `execute()`. **Elegida (i)**:
cero I/O extra en el money-path, determinístico y testeable con mock puro. La lista publicada es la
fuente inicial; F3 la confirma/extiende contra el sandbox. Un valor fuera del allowlist → throw, sin
enviar orden. (ii) agregaría latencia y un punto de falla de red al hot path sin beneficio (la lista
cambia rara vez y F3 la fija).

### DT-7 — campos del body que requieren descubrimiento en sandbox: **F3, no inventados**

`POST /v3/orders` (spec L23-34) necesita `userId` (UX-, usuario con KYC en TransFi), `purposeCode`,
`destination.paymentCode` (de `/v3/payment-methods`), `destination.additionalPaymentDetails` (campos
del beneficiario PE) y `destination.amount` (PEN). **Ninguno está en `PayoutInput` hoy** y sus
valores exactos **no están en la spec** (marcados "descubrir en runtime"). Decisión: el body-builder
del adapter ensambla los campos **contrato-fijos** (verificados: `orderType`, `partnerId`,
`source.currency` resuelta, `source.amount`, `destination.currency:"PEN"`) y toma los campos
**F3-resueltos** de config (`TRANSFI_SOURCE_WALLET_ADDRESS`, `TRANSFI_PURPOSE_CODE`) o los marca
`TODO(F3)` con `[NEEDS CLARIFICATION]` explícito (ver §8). Los tests unitarios (mockeados) **no
dependen** de esos valores — asertan los ejes contrato-críticos. El smoke de sandbox (AC-4, §7 W3) se
**acota** a lo que sea verificable sin un `userId` KYC'd provisto (auth + endpoint + shape del error);
la creación de una orden completa depende de que F3 descubra el flujo de `userId`. Esto respeta el
split del Analyst: esta HU es el **contrato HTTP**, no el flujo de datos completo.

---

## 4. Constraint Directives (CD-N)

Heredan todos los del work-item + `project-context.md §Guardrails`. Específicos de esta HU:

### PROHIBIDO
- **CD-1 (sandbox-only / cero plata real):** PROHIBIDO que cualquier test, script o request apunte a
  `https://api.transfi.com` (prod) o mueva plata real en F3/QA. Todo contra
  `sandbox-api.transfi.com` con montos de prueba. El default de `TRANSFI_BASE_URL` en `payout.ts`
  pasa a **sandbox** (hoy es prod, `payout.ts:8`) — un olvido de env no debe apuntar a prod.
- **CD-2 (credenciales solo en env):** PROHIBIDO hardcodear/transcribir
  `TRANSFI_USERNAME/PASSWORD/MID/WEBHOOK_SECRET` en cualquier archivo versionado (código, tests,
  docs, commits). Los tests usan credenciales **FAKE** vía `vi.stubEnv` (ej. `"u"`/`"p"`/`"m"`).
- **CD-3 (mock sigue siendo default):** PROHIBIDO que el swap de env vars altere que
  `FallbackPayoutProvider` sea el default cuando falta cualquiera de las 3 credenciales o
  `TRANSFI_ADAPTER_READY!=="true"`. Los fail-safes (`PAYOUT_ALLOW_MOCK` prod, `ALLOW_FALLBACK_PAYOUT`
  dev) se preservan **byte a byte en su lógica** — solo cambia qué env vars leen.
- **CD-4 (no envío on-chain ni webhook en esta HU):** PROHIBIDO implementar el envío del USDC a la
  `depositAddress` o el webhook receiver (`X-Transfi-Hmac-Hash`). `TRANSFI_WEBHOOK_SECRET` se
  **documenta** pero NO se lee en código.
- **CD-5 (no silenciar errores):** PROHIBIDO que un error HTTP de TransFi (incl.
  `PARTNER_ID_ALREADY_USED`) se lea como éxito o degrade en silencio al mock — siempre throw tipado
  (AC-7). PROHIBIDO asumir `status:"settled"` en la respuesta del `POST` (AC-3): el create-order
  siempre devuelve `"submitted"`.
- **CD-9 (no romper `fx.ts`):** PROHIBIDO borrar `TRANSFI_API_KEY` (fx lo usa, DT-3) o renombrar
  `TRANSFI_ADAPTER_READY` (fx lo comparte). Se **agregan** vars nuevas; no se quitan las de fx.

### OBLIGATORIO
- **CD-6 (idempotencia real):** el campo `partnerId` del body DEBE ser **exactamente**
  `input.idempotencyKey` — sin regenerar, derivar ni truncar (AC-2).
- **CD-7 (mapeo de estados verificado):** `normalizeStatus()` mapea **solo** los estados documentados
  (`initiated`, `asset_deposited` → `"submitted"`; `fund_settled` → `"settled"`; `fund_failed`,
  `expired` → `"failed"`). Estado desconocido → `"submitted"` (no-terminal, **nunca** `"settled"`
  fabricado) + `console.warn`. PROHIBIDO dejar los valores inventados (`completed/success/error/rejected`).
- **CD-8 (auth Basic+mid, nunca Bearer):** cada request lleva `Authorization: Basic
  base64(user:pass)` + header `mid` (AC-1). PROHIBIDO `Bearer`, `x-api-key` o header `idempotency-key`.
- **CD-10 (gate de verificación):** `npm run typecheck` (`tsc --noEmit` completo, incluye `*.test.ts`
  — NUNCA solo `npm run build`, lección WKH-196) + `npm run test` verdes antes de cerrar cada wave.
  Baseline a preservar: **123/123** (las 4 suites existentes siguen verdes).
- **CD-11 (no PII — hereda project-context):** ningún log/error expone `beneficiary.*`,
  `travelRuleData`, `legalId` ni el body crudo. Errores tipados por `status` (value-free).

---

## 5. Blast radius del env var swap (crítico — no romper la baseline)

`grep -rn "TRANSFI_API_KEY" src` (ejecutado) mapea **todo** el fallout. El swap toca 2 archivos de
producción; los tests se dividen en "hay que migrar" vs "queda inerte pero pasa":

| Archivo | Uso de `TRANSFI_API_KEY` | Acción en esta HU |
|---|---|---|
| `src/providers/payout.ts:109` | señal de provider real en `getPayoutProvider()` | **Migrar** a las 3 vars (W1). |
| `src/agents/cashout-payout.ts:66-67` | `hasReal` en `assertPayoutProviderSafe()` | **Migrar** a las 3 vars (W1) — solo esa línea; el resto intocable (CD-3). |
| `src/providers/payout.test.ts:52-63` | factory tests | **Migrar** a las 3 vars (W2, AC-5). |
| `src/agents/cashout-payout.test.ts:507-518` | `"...TRANSFI_API_KEY sin READY → throws"` | **⚠️ ROMPE con el swap → migrar** a `TRANSFI_USERNAME/PASSWORD/MID` (W2). Sin esto, `getPayoutProvider()` ya no throwea y el test falla. |
| `src/agents/cashout-payout.test.ts` (~13 stubs `=""`) | fuerzan fallback | **Inerte pero inocuo**: con las 3 vars ausentes igual cae al fallback. Recomendado que W2 los deje estables; opcionalmente añadir `vi.stubEnv("TRANSFI_USERNAME","")` para que la intención sea explícita (ver CD-12). |
| `src/app/api/.../route.test.ts`, `corridor-fx.test.ts`, `fx.test.ts` | `TRANSFI_API_KEY=""` | **NO tocar** (fx sigue usando esa var — DT-3/CD-9). Quedan correctos. |

- **CD-12 (determinismo de tests — hardening):** los tests que dependen del fallback NO deben confiar
  en la **ausencia** de `TRANSFI_USERNAME/PASSWORD/MID` (si el founder mueve las creds a `.env.local`
  y vitest las cargara, romperían). Los tests que asertan el path fallback/real DEBEN **stubbear
  explícitamente** las 3 vars (a `""` para fallback, a FAKE para real) con
  `afterEach(()=>vi.unstubAllEnvs())`. Espejo del patrón ya usado en la suite.

---

## 6. Contratos exactos

### 6.1 `types.ts` — extensión aditiva (W0)

```ts
export interface PayoutResult {
  payoutId: string;
  status: "submitted" | "settled" | "failed";
  deliveredLocal: number | null;
  txRef: string | null;
  failureReason: string | null;
  provenance: Provenance;
  depositAddress: string | null; // NUEVO (DT-4): address dedicada de TransFi para depositar el USDC.
                                  // null en el fallback y en consultas de estado sin address.
}
```

### 6.2 Env vars (W0 — documentar en project-context, NO transcribir valores — CD-2)

| Env var | Rol | Notas |
|---|---|---|
| `TRANSFI_USERNAME` | Basic auth (usuario) | **secreto**. Reemplaza a `TRANSFI_API_KEY` como señal de "real" en payout. |
| `TRANSFI_PASSWORD` | Basic auth (contraseña) | **secreto**. |
| `TRANSFI_MID` | header `mid` (merchant id) | ej. `WIIB1V_NA_NA` (spec L15). |
| `TRANSFI_BASE_URL` | base host | **default cambia a `https://sandbox-api.transfi.com`** (CD-1). En prod se setea explícito al host prod (gated por KYB + READY). |
| `TRANSFI_USDC_NETWORK` | red de settlement del USDC | **default `base`** (DT-2 cerrada). Resuelta por allowlist a `source.currency` (§6.4). Fail-loud si no soportada (AC-6). |
| `TRANSFI_SOURCE_WALLET_ADDRESS` | `source.walletAddress` del body | wallet plataforma que envía el USDC. Config, no secreto. Confirmar forma en F3. |
| `TRANSFI_PURPOSE_CODE` | `purposeCode` del body | valor válido para remesa a PE — **descubrir en F3** (spec L69). |
| `TRANSFI_WEBHOOK_SECRET` | firma HMAC del webhook | **RESERVADO — NO se lee en esta HU** (CD-4, HU seguimiento). Solo documentado. |
| `TRANSFI_API_KEY` | (legado) | **NO borrar** — `fx.ts` lo sigue usando (DT-3/CD-9). |
| `TRANSFI_ADAPTER_READY` | opt-in del adapter real | **compartido con fx** — no renombrar (CD-9). |

### 6.3 Body de `POST /v3/orders` (offramp) — lo que arma `execute()`

Campos **contrato-fijos** (verificados, tests los asertan) + **F3-resueltos** (config/`TODO(F3)`):

```jsonc
{
  "orderType": "offramp",                          // fijo (AC-2)
  "partnerId": "<input.idempotencyKey>",           // fijo, sin transformar (CD-6/AC-2)
  "userId": "<F3: flujo de userId UX- — [NEEDS CLARIFICATION], §8>",
  "purposeCode": "<TRANSFI_PURPOSE_CODE — F3>",
  "source": {
    "currency": "<resuelto del allowlist por TRANSFI_USDC_NETWORK — fail-loud si no (AC-6)>",
    "walletAddress": "<TRANSFI_SOURCE_WALLET_ADDRESS>",
    "amount": <input.amountUsd>                    // fijo
  },
  "destination": {
    "currency": "PEN",                             // fijo
    "paymentType": "bank_transfer",                // fijo (spec L48; mapear beneficiary.method en F3 si aplica)
    "paymentCode": "<de GET /v3/payment-methods — F3>",
    "amount": <F3: monto PEN — hoy no viaja en PayoutInput, §8>,
    "additionalPaymentDetails": { /* campos beneficiario PE — F3 (spec L40) */ }
  }
}
```

### 6.4 Allowlist de red (DT-2/DT-6) — constante en `payout.ts`, verificada contra spec L38

```ts
// Mapea red lógica → código source.currency de TransFi (spec doc L38, confirmar/extender en F3).
// Default del corredor = "base" → "USDCBASE" (DT-2 cerrada). USDCAVAX (Avalanche) NO está a
// propósito → red "avalanche" cae en AC-6 fail-loud.
const TRANSFI_DEFAULT_NETWORK = "base"; // DT-2: decisión del humano 2026-07-17
const TRANSFI_USDC_CURRENCY: Record<string, string> = {
  ethereum: "USDC", polygon: "USDCPOLYGON", base: "USDCBASE", arbitrum: "USDCARB",
  bsc: "USDCBSC", solana: "USDCSOL", celo: "USDCCELO", linea: "USDCLINEA",
  algorand: "USDCALGO", stellar: "USDCXLM", fuse: "USDCFUSE",
};
function resolveSourceCurrency(network: string): string {
  const code = TRANSFI_USDC_CURRENCY[network.trim().toLowerCase()];
  if (!code) throw new Error(`transfi_unsupported_network_${network}`); // AC-6, antes de armar/enviar
  return code;
}
// uso: resolveSourceCurrency(process.env.TRANSFI_USDC_NETWORK ?? TRANSFI_DEFAULT_NETWORK)
```

### 6.5 Mapeo de estados (AC-8/CD-7) — `normalizeStatus()` (exportar para test directo)

| TransFi (`status`) | `PayoutResult.status` |
|---|---|
| `initiated` | `"submitted"` |
| `asset_deposited` | `"submitted"` |
| `fund_settled` | `"settled"` |
| `fund_failed` | `"failed"` |
| `expired` | `"failed"` |
| (desconocido) | `"submitted"` + `console.warn` (nunca `"settled"`) |

### 6.6 Respuesta de create-order → `PayoutResult` (AC-3)

En `2xx`: `status:"submitted"` **forzado** (no leer status de la respuesta del POST — CD-5),
`payoutId = <orderId de la respuesta>`, `depositAddress = <walletAddress dedicada de la respuesta>`,
`deliveredLocal: null` (aún no entregado), `provenance:"transfi"`. Los **nombres exactos** de los
campos `orderId`/`walletAddress` en la respuesta se **confirman en F3** (spec L36 dice "walletAddress
dedicada por orden"; parseo defensivo + `[NEEDS CLARIFICATION]` §8). En `!2xx` → `throw new
Error(`transfi_payout_error_${res.status}`)` (AC-7).

### 6.7 Auth headers (AC-1/CD-8)

```ts
function transfiHeaders(c: {username:string; password:string; mid:string}): HeadersInit {
  const basic = Buffer.from(`${c.username}:${c.password}`).toString("base64");
  return { "content-type": "application/json", authorization: `Basic ${basic}`, mid: c.mid };
}
```

### 6.8 Factory (AC-5) + fail-safe (DT-5)

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
`assertPayoutProviderSafe()` (`cashout-payout.ts`): solo cambia `hasReal`:
```ts
const hasReal = !!process.env.TRANSFI_USERNAME && !!process.env.TRANSFI_PASSWORD &&
  !!process.env.TRANSFI_MID && process.env.TRANSFI_ADAPTER_READY === "true";
```
Todo lo demás del método (orden de chequeos, `PAYOUT_ALLOW_MOCK`, `ALLOW_FALLBACK_PAYOUT`, warns)
**intocable** (CD-3).

---

## 7. Waves de implementación

### W0 — Contratos y tipos (SERIAL — todo lo demás depende de esto)
- `types.ts`: agregar `depositAddress: string | null` a `PayoutResult` (DT-4).
- `payout.ts`: constante `TRANSFI_USDC_CURRENCY` + `resolveSourceCurrency()` (§6.4); cambiar el
  default de `TRANSFI_BASE` a sandbox (CD-1).
- Documentar env vars nuevas en `project-context.md §Variables de Entorno` (CD-2: solo nombres/roles).
- **Gate:** `npm run typecheck` (rompe en los returns de `PayoutResult` que aún no tienen
  `depositAddress` — se completan en W1; puede quedar rojo hasta cerrar W1).

### W1 — Adapter HTTP + fail-safe (depende de W0)
- `payout.ts`: reescribir `TransFiPayoutProvider` (auth Basic+mid §6.7; `execute()` `POST /v3/orders`
  §6.3/§6.6; `status()` `GET /v3/orders/{id}`); **exportar** `normalizeStatus()` con el mapeo §6.5;
  `FallbackPayoutProvider` devuelve `depositAddress:null` en ambos métodos; `getPayoutProvider()` 3
  vars §6.8.
- `cashout-payout.ts`: swap de `hasReal` en `assertPayoutProviderSafe()` (§6.8) — **solo esa línea**.
- **Gate:** `npm run typecheck` limpio (los tests viejos pueden fallar hasta W2).

### W2 — Tests mockeados (depende de W1) — ver §8 Test Plan
- `payout.test.ts`: AC-1/2/3/6/7/8 con `vi.stubGlobal("fetch",...)` + factory AC-5 (3 vars).
- `cashout-payout.test.ts`: migrar el test `:507-518` a las 3 vars (§5); CD-12 en los stubs que lo
  requieran.
- **Gate:** `npm run typecheck` + `npm run test` → **≥123 verde** (baseline + nuevos).

### W3 — Smoke de sandbox (AC-4) — evidencia, no test permanente (CD-1)
- Un script/llamada **acotada** contra `sandbox-api.transfi.com`: `POST /v3/orders` (con creds reales
  del founder en `.env.local`) + `GET /v3/orders/{id}`, documentando en el done-report host +
  respuesta (redactando credenciales, CD-2/CD-11). Descubrir en este paso: nombres reales de
  `orderId`/`depositAddress` en la respuesta, `paymentCode` (`GET /v3/payment-methods`), soporte de
  red (`list-tokens` — **confirma/refuta Avalanche, DT-2**), `purposeCode`, flujo de `userId`.
- **Acotado sin plata:** si la creación completa requiere un `userId` KYC'd no disponible, el smoke
  se limita a probar **auth (nunca 401) + endpoint + shape del error 4xx** — suficiente para AC-4.
- **NO** deja un script permanente en el repo salvo que se decida (gated, sandbox-only).

W0→W1→W2 son serial-ish (dependencia de tipos/símbolos). W3 va al final. No hay paralelización real
(un solo archivo central) — el orden importa más que el paralelismo acá.

---

## 8. Test Plan (≥1 test por AC — todos MOCKEADOS salvo el smoke W3)

Helper: `jsonResponse(body,status)` + `vi.stubGlobal("fetch", vi.fn(async()=>jsonResponse(...)))` +
`afterEach(()=>{vi.unstubAllGlobals(); vi.unstubAllEnvs();})` (espejo de `kyc.test.ts:55-60`). Creds
FAKE (`"u"/"p"/"m"`, CD-2). El provider se instancia directo (`new TransFiPayoutProvider({...})`) para
los tests de `execute()`/`status()`.

| AC | Test(s) en `payout.test.ts` (salvo indicado) |
|---|---|
| **AC-1** | `execute()` con fetch mock captura el request: `headers.authorization === "Basic " + base64("u:p")` **y** `headers.mid === "m"`; **NUNCA** contiene `Bearer` ni `x-api-key`. |
| **AC-2** | body del POST: `url` termina en `/v3/orders` (no `/v1/payouts`); `orderType==="offramp"`; `partnerId===input.idempotencyKey` (byte-idéntico); **sin** header `idempotency-key`. |
| **AC-3** | respuesta `2xx` mock (con `orderId` + `walletAddress`) → `{status:"submitted", payoutId:<orderId>, depositAddress:<walletAddress>, deliveredLocal:null, provenance:"transfi"}`. Un mock que devuelva `status:"fund_settled"` en el POST **NO** debe producir `"settled"` (se fuerza `submitted`). |
| **AC-4** | Evidencia F3/W3 (no unit): request real a `sandbox-api.transfi.com` documentada en done-report (host + respuesta, creds redactadas). |
| **AC-5** | factory: sin las 3 vars → `FallbackPayoutProvider`; las 3 pero sin `READY` → throw `transfi_adapter_not_ready`; las 3 + `READY=true` → `TransFiPayoutProvider`. Además **`cashout-payout.test.ts:507` migrado**: PROD + `PAYOUT_ALLOW_MOCK` + 3 vars sin `READY` → throw. |
| **AC-6** | `TRANSFI_USDC_NETWORK="avalanche"` (o cualquier no soportada) → `execute()` throw `transfi_unsupported_network_avalanche` **sin** que `fetch` se haya llamado (`expect(fetchMock).not.toHaveBeenCalled()`). Caso feliz: `"polygon"` → body con `source.currency==="USDCPOLYGON"`. |
| **AC-7** | fetch mock `4xx`/`5xx` (incl. body `{code:"PARTNER_ID_ALREADY_USED"}`) → `execute()` **throws** `transfi_payout_error_<status>`; nunca resuelve con un resultado exitoso ni cae al mock. Idem `status()` → `transfi_payout_status_error_<status>`. |
| **AC-8** | tabla directa sobre `normalizeStatus()` (exportado): `initiated`/`asset_deposited`→`"submitted"`; `fund_settled`→`"settled"`; `fund_failed`/`expired`→`"failed"`; desconocido→`"submitted"`. Un caso por estado. |
| baseline | `FallbackPayoutProvider` ahora devuelve `depositAddress:null` (extender los asserts existentes L21-28); `assertValidPayout` sigue verde. |

**Gate final:** `npm run typecheck` (completo, incluye tests — CD-10) + `npm run test` → toda la suite
(payout, cashout-payout, fx, kyc, route.test) verde. Baseline mínima: **123/123** + los nuevos.

---

## 9. Exemplars verificados (paths confirmados)

| Para... | Exemplar (verificado con Read) |
|---|---|
| adapter partner + fallback + factory con readiness gate | `src/providers/kyc.ts:26-247` (`DiditKycProvider`/`FallbackKycProvider`/`getKycProvider`) |
| headers + `fetch` + `AbortSignal.timeout` + `if(!res.ok) throw ..._${res.status}` | `src/providers/kyc.ts:33-98` |
| tests con fetch mockeado (`jsonResponse` + `vi.stubGlobal`) | `src/providers/kyc.test.ts:55-97` |
| tests de factory env-driven (`vi.stubEnv` + `afterEach(unstubAllEnvs)`) | `src/providers/payout.test.ts:49-64` (a migrar) |
| shape a preservar de `PayoutResult`/`PayoutInput`/`PayoutProvider` | `src/providers/types.ts:98-127` |
| fail-safe money-path a NO tocar (salvo `hasReal`) | `src/agents/cashout-payout.ts:65-89` |

---

## 10. `[NEEDS CLARIFICATION]` — abiertos, resueltos en F3 (no bloquean F2)

Consistente con el work-item (AC-3/AC-6 y Missing Inputs marcados F3-discovery):

1. **Nombres exactos de `orderId` y `depositAddress`** en la respuesta del `POST /v3/orders` — la
   spec dice "walletAddress dedicada por orden" (L36) pero no fija los nombres JSON. F3 los confirma
   contra sandbox; el parseo se codea defensivo hasta entonces.
2. **Flujo del `userId` (UX-)** — cómo se obtiene/mapea un usuario TransFi KYC'd para una remesa
   Chaski (cuya KYC es vía Didit, no TransFi). Probablemente requiere un `user-create` en TransFi →
   candidato a la HU de seguimiento. Para esta HU no bloquea el contrato; sí acota el smoke W3.
3. **`paymentCode`, `additionalPaymentDetails` (beneficiario PE), `purposeCode`, monto PEN
   (`destination.amount`)** — descubrir en sandbox (`GET /v3/payment-methods`, spec L40/L66-69). El
   monto PEN hoy **no viaja** en `PayoutInput` (solo `amountUsd`) → si F3 confirma que TransFi lo
   exige, la HU de seguimiento extiende `PayoutInput` (fuera de scope acá).
4. ~~Soporte de Avalanche~~ — **RESUELTO: DT-2 cerrada = Base** (decisión del humano). F3 solo
   confirma `USDCBASE` contra sandbox (`list-tokens`); Avalanche queda como red no soportada
   deliberada (AC-6 fail-loud). Ya no es un `[NEEDS CLARIFICATION]`.

Ninguno bloquea el diseño del **contrato** (el foco de esta HU): el adapter queda correcto y
fail-loud para todo lo verificado, y los huecos son datos que F3 rellena sin cambiar la arquitectura.

---

## 13. Dependencias / Follow-up (para las HUs siguientes — NO se implementa acá)

| Item | Dónde | Detalle |
|---|---|---|
| **Webhook receiver + reconciliación async** | `chaski-v2` (DT-1) | consume `X-Transfi-Hmac-Hash` + `fund_settled`, actualiza `remittance_settlements` (WKH-207) por `orderId`/`payoutId`. Secreto `TRANSFI_WEBHOOK_SECRET` vive ahí. Depende del `depositAddress`/`orderId` que esta HU deja listos. |
| **Envío on-chain del USDC** a la `depositAddress` | infra nueva (repo TBD) | wallet plataforma → address dedicada de la orden. No existe hoy en ningún repo. |
| **Settlement del principal Avalanche → Base** | `chaski-v2` / WKH-168 | consecuencia de DT-2=Base. Hoy Chaski settlea el principal con EIP-3009 en **Avalanche** (Fuji 43113 / mainnet 43114); debe pasar a **Base** (Base Sepolia 84532 / mainnet 8453). `wasiai-facilitator` **ya** tiene `BaseEip3009Adapter` (Base Sepolia soportado) → la infra existe; apuntar Chaski a Base es HU/cambio de seguimiento en `chaski-v2`, **fuera del scope de WKH-208** (esta HU no toca WKH-168 ni `chaski-v2`). |
| **Flujo del `userId` (UX-) TransFi** | esta HU F3 / follow-up | provisión/mapeo de un usuario TransFi KYC'd para la remesa (§10.2). |
| **`fx.ts` (mismo bug Bearer/endpoint)** | HU propia (DT-3) | requiere verificar el endpoint real de quote contra docs.transfi.com. |
| **`CashoutPayoutOutput.depositAddress`** | HU de seguimiento | exponer el campo al output público del agente cuando el flujo async completo esté diseñado. |

---

## 11. Aprendizaje histórico aplicado (Auto-Blindaje — project-context §Auto-Blindaje)

| Lección previa | Cómo se aplica acá |
|---|---|
| WKH-204: `String(x ?? "")` para "sanitizar" a `""` **nace fail-open** (`String(123)==="123"`) | El parseo de la respuesta usa narrowing por tipo, no `String()` coercitivo, para `orderId`/`depositAddress`; un campo ausente/no-string → `null`/throw, nunca un valor fabricado. |
| WKH-203/204: comparaciones de gate `!== true` estrictas, nunca truthiness | El fail-safe (`assertPayoutProviderSafe`) se preserva **byte a byte** salvo `hasReal`; no se relaja ninguna comparación. |
| WKH-196: `npm run build` **excluye** tests → correr `tsc --noEmit` completo | CD-10: gate = `typecheck` (no solo build) + `test`. |
| WKH-204: mutation-testing — un mutante `!== true`→truthiness sobrevivía sin un test con truthy-no-booleano | AC-3/AC-7 incluyen el caso adversarial (POST que devuelve `fund_settled` no debe dar `settled`; 4xx no debe resolver exitoso) para matar el mutante "leer el status del POST". |
| WKH-203 F0: `resolveTravelRuleData()` es un STUB | No se toca; el Travel Rule sigue por canal seguro (CD-11). |

---

## 12. Readiness Check

| Ítem | Estado |
|---|---|
| Contrato real verificado contra spec (endpoint/auth/idempotencia/estados) | ✅ `doc/transfi-offramp-api-spec.md` (§1, §6) |
| Shape actual de `PayoutInput`/`PayoutResult`/`PayoutProvider` verificado en código | ✅ `types.ts:98-127` (§1) |
| Cómo se consume `execute()` verificado | ✅ `cashout-payout.ts:237-254` (mapeo 1:1, no lee `depositAddress`) |
| Env vars nuevas no colisionan / no rompen `fx.ts` | ✅ mapeado (§5, CD-9) — `TRANSFI_API_KEY` y `TRANSFI_ADAPTER_READY` preservados para fx |
| Blast radius del swap identificado (incl. test que ROMPE) | ✅ `cashout-payout.test.ts:507` (§5) |
| Exemplars con paths reales confirmados | ✅ (§9) |
| Test plan ≥1 por AC-1..8, mockeado (+ smoke AC-4) | ✅ (§8) |
| Baseline verde registrado | ✅ 123/123, `eca36cf`, tsc limpio |
| DT-1 (webhook) recomendación documentada, no implementada | ✅ `chaski-v2` (§3 DT-1, §13) |
| DT-2 (red del USDC) **CERRADA = Base** | ✅ (§3 DT-2) — default `base`→`USDCBASE`; follow-up de settlement Avalanche→Base anotado (§13) |
| `[NEEDS CLARIFICATION]` acotados a F3, no bloqueantes de F2 | ✅ (§10) — todos F3-discovery, ninguno bloquea el contrato |

**Veredicto: SDD LISTO para `SPEC_APPROVED`.** DT-2 quedó **cerrada = Base** (decisión del humano):
sin puntos abiertos para el gate. El adapter se implementa configurable por red con default `base`
(`USDCBASE`). El único trabajo que DT-2 dispara — mover el settlement del principal de Chaski de
Avalanche a Base — es **follow-up en `chaski-v2` (WKH-168)**, fuera del scope de esta HU (§13). Los
`[NEEDS CLARIFICATION]` restantes son datos que F3 descubre en sandbox sin cambiar la arquitectura.

---

*Generado por nexus-architect — F2. DT-2 cerrada = Base (decisión del humano, 2026-07-17). Próximo
paso: orquestador presenta este SDD al humano para el gate `SPEC_APPROVED`. Tras aprobación → F2.5
Story File.*
