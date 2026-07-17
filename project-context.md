# project-context.md
> Generado por NexusAgil F0 — Bootstrap de Proyecto (WKH-203, 2026-07-15)
> Actualizar cuando cambie el stack, arquitectura o guardrails.

---

## Proyecto

| Campo | Valor |
|-------|-------|
| **Nombre** | wasiai-remittance-agents |
| **Descripcion** | Trío de agentes A2A reales (`remit-kyc-validator`, `remit-corridor-fx`, `remit-cashout-payout`) que repotencia el pipeline de remesas de Chaski (USDC→PEN→Yape) con partners licenciados (Didit KYC, TransFi payout) detrás de una interface de provider, con fallback determinístico para correr sin keys. Corre EN PARALELO al demo live (`agentshop-*` / `wasiai-agentshop.vercel.app`), que queda intacto. |
| **Tipo** | api (Next.js App Router, solo endpoints `/api/agents/*/invoke`, sin UI) |
| **Estado** | prototipo / scaffold (Fase B del plan) — el código de provider real (Didit/TransFi) se activa recién en Fase A (founder, acceso sandbox); hoy corre 100% en fallback |

---

## Stack

| Capa | Tecnologia | Version |
|------|-----------|---------|
| Lenguaje | TypeScript (strict) | ^5.6.2 |
| Framework | Next.js (App Router) | 14.2.35 |
| Runtime UI | React / React DOM (no hay UI real, solo lo que trae Next) | 18.3.1 |
| Base de datos | **NINGUNA** — no hay Supabase/Postgres/Redis/KV en este repo (verificado en `package.json`, sin deps de DB) | - |
| ORM / Cliente DB | N/A (no existe) | - |
| Auth | N/A — el agente confía en el contrato HTTP del gateway `wasiai-a2a` (auth/pago los resuelve el gateway, no este repo) | - |
| Validación de input | Zod | ^3.23.8 |
| Testing | Vitest | ^2.1.1 |
| Deploy | Vercel (proyecto nuevo, separado de `wasiai-agentshop`) | - |

**Nota crítica de grounding (WKH-203):** este repo NO tiene ninguna capa de persistencia (ni DB ni KV). Cualquier diseño que requiera "guardar" un resultado de KYC y recuperarlo después por id (ej. un store de verificaciones) es trabajo NUEVO de infraestructura, no una reutilización de algo existente.

---

## Arquitectura de Carpetas

```
src/
  agents/
    kyc-validator.ts          # runKycValidator() — core testeable, sin HTTP
    kyc-validator.test.ts
    corridor-fx.ts
    corridor-fx.test.ts
    cashout-payout.ts         # runCashoutPayout() — core testeable, sin HTTP
    cashout-payout.test.ts
  providers/
    types.ts                  # interfaces KycProvider / FxQuoteProvider / PayoutProvider
    kyc.ts                    # DiditKycProvider + FallbackKycProvider + getKycProvider()
    kyc.test.ts
    fx.ts
    fx.test.ts
    payout.ts                 # TransFiPayoutProvider + FallbackPayoutProvider + getPayoutProvider()
    payout.test.ts
  app/api/agents/
    remit-kyc-validator/invoke/route.ts       # wrapper HTTP fino sobre runKycValidator()
    remit-kyc-validator/invoke/route.test.ts
    remit-corridor-fx/invoke/route.ts
    remit-corridor-fx/invoke/route.test.ts
    remit-cashout-payout/invoke/route.ts      # wrapper HTTP fino sobre runCashoutPayout()
    remit-cashout-payout/invoke/route.test.ts
```

**Patron de arquitectura**: feature-first por agente. Patrón fijo por agente:
`zod input → provider (adapter partner || fallback determinístico) → { result }`
(forkeado de `cobraya-credit-scorer` de otro repo hermano). El handler HTTP (`route.ts`) es SIEMPRE
un wrapper fino sobre una función core (`runX()`) framework-agnostic y testeable sin HTTP.

---

## Comandos

```bash
# Desarrollo
npm run dev          # next dev -p 3030

# Build produccion
npm run build         # next build

# Tests
npm run test          # vitest run
npm run test:watch    # vitest

# Lint / Typecheck
npm run typecheck      # tsc --noEmit

# Base de datos
# N/A — no hay DB en este repo
```

---

## Patrones de Codigo

### Patron de componente / modulo (agente)
```ts
// src/agents/<slug>.ts
export const SLUG = "remit-<slug>";
export const PRICE_USDC = 0.0X;
export const XInputSchema = z.object({ ... });
export type XInput = z.infer<typeof XInputSchema>;
export interface XOutput { slug: string; ... }

export async function runX(raw: unknown): Promise<XOutput> {
  const input = XInputSchema.parse(raw); // lanza ZodError si inválido
  const provider = getXProvider();
  const result = await provider.doThing(input);
  return { slug: SLUG, ...mapped };
}
```

### Patron de manejo de errores (route.ts)
```ts
// src/app/api/agents/<slug>/invoke/route.ts
export async function POST(req: NextRequest) {
  const parsed = XInputSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_input", details: parsed.error.flatten() }, // SOLO Zod flatten, nunca body crudo
      { status: 400 },
    );
  }
  try {
    const result = await runX(parsed.data);
    return NextResponse.json({ result }, { status: 200 });
  } catch (err) {
    console.warn("[slug] failed:", { errorName: err instanceof Error ? err.name : "unknown" }); // NUNCA err.message/stack/input
    return NextResponse.json({ error: "x_unavailable" }, { status: 502 }); // nunca 500
  }
}
```

### Patron de fail-safe money-path (provider factory)
```ts
// getPayoutProvider(): real solo con las 3 creds TransFi + ADAPTER_READY=true (opt-in explícito,
// fail-loud si falta readiness). WKH-208: el payout usa user+pass+mid (NO TRANSFI_API_KEY).
export function getPayoutProvider(): PayoutProvider {
  const { TRANSFI_USERNAME, TRANSFI_PASSWORD, TRANSFI_MID } = process.env;
  if (!TRANSFI_USERNAME || !TRANSFI_PASSWORD || !TRANSFI_MID) return new FallbackPayoutProvider();
  if (process.env.TRANSFI_ADAPTER_READY !== "true") {
    throw new Error("transfi_adapter_not_ready: ...");
  }
  return new TransFiPayoutProvider({ ... });
}
```

### Env vars TransFi (WKH-208 — payout off-ramp real, sandbox-only)
El adapter de payout (`src/providers/payout.ts`) habla el contrato REAL de TransFi off-ramp. Creds
SOLO por env (nunca hardcode). El mock (`FallbackPayoutProvider`) sigue siendo el default sin las 3
creds + `TRANSFI_ADAPTER_READY=true`.

| Env var | Rol |
|---|---|
| `TRANSFI_USERNAME` | Basic auth user (secreto). Señal de "real" en payout — reemplaza a `TRANSFI_API_KEY` en el payout. |
| `TRANSFI_PASSWORD` | Basic auth pass (secreto). |
| `TRANSFI_MID` | valor del header `mid` (ej. `WIIB1V_NA_NA`). |
| `TRANSFI_BASE_URL` | host base; default `https://sandbox-api.transfi.com` (sandbox-only). |
| `TRANSFI_USDC_NETWORK` | red del USDC del `source`; default `base` → `USDCBASE`. Fail-loud si fuera del allowlist. |
| `TRANSFI_SOURCE_WALLET_ADDRESS` | `source.walletAddress` del body (config, no secreto — TODO(F3-sandbox)). |
| `TRANSFI_SOURCE_URL` | `sourceUrl` del body (URL del merchant, server-only, no secreto — TODO(F3-sandbox): confirmar si es requerido y qué valor). Default `""` → fail-loud (4xx) si el sandbox lo exige. |
| `TRANSFI_PURPOSE_CODE` | `purposeCode` del body (TODO(F3-sandbox): valor válido para PE). |
| `TRANSFI_PAYMENT_CODE` | `destination.paymentCode` (TODO(F3-sandbox): de GET /v3/payment-methods PEN/withdraw). |
| `TRANSFI_USER_ID` | `userId` del body (usuario TransFi KYC'd; TODO(F3-sandbox), probable HU de seguimiento). |
| `TRANSFI_WEBHOOK_SECRET` | firma del webhook off-ramp — **RESERVADO, NO se lee en este repo** (el webhook receiver vive en chaski-v2). |
| `TRANSFI_API_KEY` | **LEGADO — lo usa `fx.ts`, NO borrar.** El payout ya NO lo lee. |
| `TRANSFI_ADAPTER_READY` | opt-in del adapter real; **compartido con `fx.ts`, NO renombrar.** |

### Patron de acceso a base de datos
N/A — no existe capa de persistencia en este repo.

### Patron de auth / autorizacion
N/A — la auth/pago del caller la resuelve el gateway `wasiai-a2a` (repo externo) antes de llegar a
`/invoke`. Este repo no implementa auth propia.

---

## Exemplars

| Cuando crear... | Usar como exemplar |
|----------------|-------------------|
| Nuevo agente (`runX()` core) | `src/agents/kyc-validator.ts` (hard-gate fail-safe, provenance allowlist) |
| Nuevo provider partner + fallback | `src/providers/kyc.ts` (adapter + fallback + factory con readiness gate) |
| Nuevo route.ts HTTP wrapper | `src/app/api/agents/remit-cashout-payout/invoke/route.ts` (CD-6 no-PII) |
| Tests de agente (fail-safe env-driven) | `src/agents/cashout-payout.test.ts` (`vi.stubEnv` + `afterEach(vi.unstubAllEnvs)`) |

---

## Guardrails (Reglas del Proyecto)

### OBLIGATORIO
- Todo agente sigue el patrón `zod input → provider (adapter || fallback) → { result }`.
- Todo `route.ts` es un wrapper fino: la lógica vive en `runX()` (agents/*.ts), testeable sin HTTP.
- Todo provider partner tiene un fallback determinístico tageado `provenance: "local-fallback"`.
- Los fail-safes money-path (`assertPayoutProviderSafe()` en payout, `isPayoutAllowed()` en KYC,
  `isKycGatePassed()` en payout, `getXProvider()` con `X_ADAPTER_READY` gate) son fail-loud por
  defecto: un env olvidado NUNCA abre el money-path.
- **WKH-203 (gate KYC server-side del payout):** `remit-cashout-payout` NO confía en ningún booleano
  del caller para decidir compliance. `isKycGatePassed()` (`src/agents/cashout-payout.ts`) re-deriva
  la decisión server-side consultando `KycProvider.status(verificationId, identityClaim)` contra la fuente
  autoritativa, y aplica `REAL_KYC_PROVENANCES` (allowlist ÚNICA, `src/providers/kyc.ts` — CD-9,
  PROHIBIDO duplicarla). Default = **BLOQUEAR**: no existe rama "else → allow". "No sé" (partner
  caído/timeout) ≠ "aprobado" → `kyc_gate_unavailable` → 502, nunca fail-open. La comparación es
  `approved !== true` **estricta** (PROHIBIDA la truthiness — precedente WKH-198, un fail-open que se
  coló por un `NaN`). En dev/CI el KYC fallback exige `ALLOW_FALLBACK_KYC=true`; en producción el
  fallback **jamás** abre el gate y **ninguna env puede abrirlo**.
- **WKH-204 (identity binding del payout — `senderIdentity`):** el gate de WKH-203 confirma que la
  verificación está **aprobada**, no que sea **del que pide el payout**. `remit-cashout-payout` exige
  además una identity claim y la compara contra el `vendor_data` **real** que la fuente autoritativa
  tiene atado a esa verificación; si no coincide → **blocked**.
  - **`senderIdentity`**: `z.string().min(1).optional()` — **string OPACO** (ver la regla anti-`z.enum`
    en PROHIBIDO). Semántica: el valor ligado como `vendor_data` al crear la verificación (el **DNI**
    si la creó `remit-kyc-validator`; la **wallet address** si la creó `chaski-v2`). El agente NO
    adivina la convención: compara contra la fuente autoritativa. "No sé qué convención es" nunca
    produce un allow. Normalización **ÚNICA**: `normalizeIdentity()` (`src/providers/kyc.ts`,
    `trim()`+`toLowerCase()`) — PROHIBIDO duplicarla (mismo criterio que `REAL_KYC_PROVENANCES`).
  - **`address`**: **DEPRECADO** — puente de compat con `chaski-v2` (que manda `address`, no
    `senderIdentity`). Precedencia determinística: `senderIdentity ?? address` (gana el explícito;
    PROHIBIDA una rama "ambos discrepan → ambiguo"). PROHIBIDO construir features nuevas sobre él.
  - **La comparación vive DENTRO del provider** (`DiditKycProvider.status()`), NO en el agente: en este
    repo `vendor_data` **es el DNI** (`verify()`: `vendor_data: input.legalId`) → exponerlo crudo en
    `KycStatusResult` sería una fuga de PII nueva. Solo cruza el borde `identityMatches: boolean`.
    PROHIBIDO agregar `vendorData`/`legalId`/`identity` a `KycStatusResult`.
  - **Fail-closed en todas las ramas**: sin claim / claim whitespace → `kyc_identity_claim_missing`
    **sin llamar al provider**; `vendor_data` ausente/vacío/**no-string** → `identityMatches:false` →
    blocked (⚠️ **divergencia deliberada de `chaski-v2/authority.ts`, que omite el check si viene
    vacío = fail-OPEN — la divergencia ES el fix**). `identityMatches !== true` **estricto** en el gate.
  - **No-oracle**: "no aprobado" y "aprobado pero no es tuyo" colapsan al mismo
    `reason:"kyc_gate_not_passed"` (no confirmar DNIs de a uno). La discriminación fina va a
    `console.warn` server-side y **value-free** (nunca el claim, nunca el `vendor_data`).
  - ⚠️ **Alcance real**: NO es prueba criptográfica de posesión (no hay firma/SIWE) y `senderIdentity`
    es caller-controlado. Sube la barra (deja de ser un ataque de un solo dato); un atacante con
    **ambos** datos pasa. Para sesiones creadas con `vendor_data` **público** (wallet address, caso
    `chaski-v2`) la protección de **ese** flujo es **≈nula**. Prueba de posesión = HU de seguimiento.
    Riesgo residual: cerrar WKH-204 **NO** habilita la Fase A (falta G3/WKH-168).
- **CD-6 (no-PII, todos los agentes remesa):** ningún response (200/400/502) puede exponer
  `beneficiary.name`/`beneficiary.destination` (Yape/CCI), `legalId` (DNI) ni `travelRuleData` en
  claro. El Travel Rule data viaja solo por `verificationId` (handle), nunca inline en el envelope
  `{ result }` que se persiste en telemetría del gateway (precedente WKH-155 de otro repo).

### PROHIBIDO
- NUNCA `any` explícito en TypeScript.
- NUNCA hardcodear URLs, keys o secrets — todo vía env vars.
- **NUNCA `z.enum`/`z.literal` en un campo de input que pueda contener PII mientras el 400 devuelva
  `parsed.error.flatten()` (WKH-204/CD-11).** Zod **ecoa el valor recibido** en el mensaje del enum:
  `"Invalid enum value. Expected 'wallet_address' | 'legal_id', received 'DNI-12345678'"` — y
  `route.ts` devuelve ese `flatten()` tal cual en el body del 400 (y el gateway lo persiste) →
  **publica el DNI**. `z.string()` es **value-free** (`"Expected string, received number"`).
  Verificado ejecutando contra zod 3.25.76. ⇒ esos campos son `z.string()` **opaco**.
- **NUNCA leer un valor externo con `String(x ?? "")` para "sanitizarlo" a "" y bloquear**
  (WKH-204/C8): `String(123)` es `"123"`, **no** `""`, y `String({})` es `"[object Object]"` → el
  valor **alcanza** la comparación y un claim `"123"` **matchea = fail-open**. Usar
  **`typeof`-narrowing**: `typeof raw === "string" ? raw : ""`. Misma clase de bug que WKH-198.
- NUNCA debilitar, saltear o volver condicional un fail-safe money-path existente
  (`assertPayoutProviderSafe`, `isPayoutAllowed`, los gates `*_ADAPTER_READY`).
- NUNCA tocar el demo live (`agentshop-*`, `wasiai-agentshop.vercel.app`, la PWA `chaski-ai`) ni el
  repo `chaski-v2` desde este repo.
- NUNCA un 500 desde un `route.ts` — los errores del core se mapean a 502 con body opaco
  (`{ error: "x_unavailable" }`), warn con `err.name` solamente (nunca `err.message`/stack/input).

---

## Variables de Entorno

```
DIDIT_API_KEY            — key del partner KYC/AML Didit (activa el adapter real). WKH-203: ahora también gatea el gate KYC server-side de remit-cashout-payout (KycProvider.status())
DIDIT_ADAPTER_READY       — "true" para confirmar el mapeo de campos del adapter Didit (opt-in explícito, separado de solo tener la key). WKH-203: idem, gatea también el gate de remit-cashout-payout
DIDIT_BASE_URL            — override del base URL de Didit (default https://verification.didit.me)
ALLOW_FALLBACK_KYC        — "true" habilita que el fallback KYC (no real) marque payoutAllowed en no-prod (dev/CI). WKH-203: AHORA TAMBIÉN habilita el gate KYC del agente de PAYOUT (remit-cashout-payout) en no-prod → sin esta env, en dev/CI el payout queda blocked. En producción NO abre nada (el fallback jamás pasa el gate)
TRANSFI_API_KEY           — key del partner de payout TransFi (activa el adapter real)
TRANSFI_ADAPTER_READY     — "true" para confirmar el mapeo/flujo del adapter TransFi (opt-in explícito)
TRANSFI_BASE_URL          — override del base URL de TransFi (default https://api.transfi.com)
PAYOUT_ALLOW_MOCK         — "true" permite el payout FALLBACK (mock) en NODE_ENV=production (etapa 1 del deploy; NUNCA abre payout real)
ALLOW_FALLBACK_PAYOUT     — "true" habilita el payout fallback (mock) en dev/CI (fuera de producción)
FALLBACK_FX_SPREAD_BPS    — spread declarado del fallback FX (bps, default 250)
FALLBACK_FX_FLAT_FEE_USD  — fee flat USD del fallback FX (default 0.5)
STATIC_USD_PEN            — fallback si open.er-api.com falla (FX)
AGENT_SIGNER_PRIVATE_KEY  — (mencionada en README, NO usada hoy por estos 3 agentes — reservada para receipts EIP-712 futuros)
```

No existe `.env.example` en el repo — inferido de README + código (`process.env.*` greppeado).

---

## Contexto de Negocio

> No existe `product-context.md` en este repo → `[SIN PRODUCT CONTEXT]`. Mínimo inferido del
> humano/README para esta HU:

- **Usuarios objetivo**: sender cripto-nativo que quiere mandar una remesa USDC → PEN → Yape/Plin a
  un beneficiario en Perú. Los legs regulados (KYC/AML, cash-out fiat) los ejecutan partners
  licenciados (Didit, TransFi); WasiAI es la capa de orquestación A2A, no el money transmitter.
- **Flujo principal**: el orquestador (gateway `wasiai-a2a`, consumido hoy por `chaski-v2`) llama en
  secuencia a `remit-kyc-validator` → `remit-corridor-fx` → `remit-cashout-payout`.
- **Integraciones externas**: Didit (KYC/AML), TransFi (quote FX + payout), `open.er-api.com` (FX mid
  del fallback), gateway `wasiai-a2a` (settlement x402, registro, fee-split — no vive en este repo).

---

## Auto-Blindaje

| Fecha | Error | Fix | Aplicar en |
|-------|-------|-----|-----------|
| 2026-07-15 | (WKH-203 F0) `resolveTravelRuleData()` en `cashout-payout.ts` es un STUB (`TODO(WKH-168/sandbox)`) que devuelve datos sintéticos vacíos — NO recupera nada real por `kycVerificationId`. No asumir que "ya recupera datos por verificationId vía canal seguro" significa que existe un store real. | N/A (hallazgo de grounding, no bug de código) | Cualquier HU futura que toque `kycVerificationId` / Travel Rule en este repo |
| 2026-07-15 | (WKH-204 F3) El SDD especificaba el guard de C8 con `String(v ?? "")` para colapsar un `vendor_data` no-string a `""` y bloquear. **Nace fail-OPEN**: `String(123)` es `"123"` (no `""`), así que un `vendor_data: 123` alcanza la comparación y un claim `"123"` **matchea → ALLOW** (ídem `{}` → `"[object Object]"`). Verificado ejecutando. | `typeof`-narrowing: `typeof vendorRaw === "string" ? vendorRaw : ""`. Test que lo mata: `vendor_data:123` + claim `"123"` → `identityMatches:false`. Regla asentada en PROHIBIDO. | Cualquier guard que "sanitice" un valor externo a `""` para bloquear. Misma clase que WKH-198 (`NaN`) y WKH-203 (`approved` no-booleano): *un valor ausente o de tipo inesperado se lee como señal positiva* |
| 2026-07-15 | (WKH-204 F3) `z.string().min(1)` **NO trimea**: un claim `"   "` **atraviesa Zod** (verificado con zod 3.25.76). Sin una rama explícita, si el `vendor_data` también viniera vacío, `"" === ""` **matchearía = fail-open**. La rama parece redundante ("`min(1)` ya lo cubre") y es exactamente el tipo de código que se "limpia" sin entender. | Rama C4 explícita: `if (normalizeIdentity(claim) === "") return null` → blocked, y además evita gastar una llamada al partner. Defensa en profundidad junto a C5. | Cualquier validación que asuma que `min(1)` implica contenido no-vacío tras normalizar |
| 2026-07-15 | (WKH-204 F3) Mutation testing del gate: el mutante `identityMatches !== true` → `!identityMatches` (truthiness) **sobrevivía** a la suite. Es alcanzable de verdad: `FallbackKycProvider.status()` devuelve un object literal que **no** pasa por `assertValidKycStatus()`, así que el guard C10 no lo cubre y el `!== true` del gate es la última línea de defensa. | Tests con `vi.spyOn(FallbackKycProvider.prototype,"status")` devolviendo `identityMatches: 1` (truthy no-booleano) y `approved: 1` → deben dar blocked. Resultado: **12/12 mutantes muertos** (WKH-203 estaba en 8/9). | Todo gate `!== true`: si ningún test inyecta un truthy-no-booleano, la estrictez **no está testeada** y el mutante sobrevive |

---

*Generado por NexusAgil F0 Bootstrap — actualizar con cada cambio significativo al stack*
