# wasiai-remittance-agents

**v2 REAL en PARALELO** del pipeline de remesas de Chaski. Cada agente está "repotenciado en su
especialidad": envuelve una API de partner licenciado detrás de una **interface de provider**, con
**fallback determinístico** para correr sin keys.

> ⚠️ **NO reemplaza el demo.** El demo live (agentes `agentshop-*` en `wasiai-agentshop.vercel.app`
> + la PWA `yarvis`) queda **INTACTO y funcionando** — los jurados del grant Team1 lo pueden estar
> viendo. Esta v2 usa **slugs nuevos** (`remit-*`), **servicio nuevo**, y **registro separado**
> (filas `a2a_agents` propias, `enabled=false`/registry aparte). No se edita `wasiai-agentshop` ni
> se toca ningún `agentshop-*`. Se prueba en paralelo con su propio flujo.

> Estado: **scaffold / foundation** (Fase B del plan). El código de provider real se activa cuando
> exista acceso sandbox a los partners (Fase A — founder). Hasta entonces corre en modo fallback.

## Arquitectura (reusa el protocolo a2a — NO rebuildea nada)
El gateway `wasiai-a2a` ya provee orquestación, settlement x402, fee-split, registro (`a2a_agents`)
y el **contrato HTTP de agente**. Un agente real solo tiene que honrar ese contrato:

```
POST /invoke/{slug}   body = step input (JSON)   →   200 { result: {...} }
```

Nada de lógica de pago/x402/on-chain del lado del agente — eso lo hace el gateway.

Patrón por agente (forkeado de `cobraya-credit-scorer`):
```
zod input  →  provider (adapter partner  ||  fallback determinístico)  →  receipt EIP-712  →  { result }
```

## Los 3 agentes
| slug | reemplaza | provider | qué hace de real |
|------|-----------|----------|------------------|
| `remit-kyc-validator` | agentshop-kyc-validator | **Didit** (`KycProvider`) | DNI + liveness + screening OFAC/PEP/sanciones + datos Travel Rule. Hard-gate: KYC falla → no payout. |
| `remit-corridor-fx` | agentshop-corridor-discoverer | **TransFi quote** (`FxQuoteProvider`) | tasa real USDC→PEN + fee + ETA. (El FX mid ya era real en la demo; se reemplazan los corredores hardcodeados.) |
| `remit-cashout-payout` | agentshop-cashout-matcher | **TransFi payout** (`PayoutProvider`) | **value-delivery**: USDC→PEN→Yape/Plin real al beneficiario. La pieza 100% nueva. |

## Cómo enchufa un partner
Cada provider es una interface (`src/providers/types.ts`). Hay 2 implementaciones por cada una:
- El **adapter del partner** (ej. `DiditKycProvider`) — activo si su env key está seteada.
- El **fallback determinístico** — corre sin keys (para dev/demo/CI), claramente tageado en la salida (`provenance`).

La factory (`getKycProvider()` etc.) elige adapter vs fallback según env. Así el servicio corre HOY
en fallback, y el día que llega el sandbox del partner solo se setea la env key — cero cambio de wiring.

## Env vars (se setean en Fase A, cuando lleguen los sandboxes)
```
DIDIT_API_KEY=            # KYC/AML (Didit)
TRANSFI_API_KEY=          # quote + payout (TransFi)
AGENT_SIGNER_PRIVATE_KEY= # firma EIP-712 de los receipts (hot key por-servicio)
```

## Pendiente (post-sandbox)
- Mapear los campos exactos de las respuestas de Didit/TransFi (hoy los adapters usan la forma documentada + TODOs).
- Tooling de build/deploy (Vercel) — se define con el corredor + la decisión final de arquitectura.
- El value-delivery real (movimiento del principal + settle a wallet de beneficiario, no self-transfer) — ver `remit-cashout-payout`.

## Endpoint HTTP + deploy (etapa 1 — `remit-corridor-fx`)

El agente `remit-corridor-fx` ya es invocable vía Next.js App Router:

```
POST /api/agents/remit-corridor-fx/invoke
body: { "amountUsd": 100, "destCountry": "PE", "payoutMethod": "yape" }  # solo amountUsd es requerido
→ 200 { "result": { "slug", "rate", "feeUsd", "netDeliveredLocal", "localCurrency": "PEN",
                     "etaMinutes", "quoteId", "expiresAt", "provenance" } }
→ 400 { "error": "invalid_input", "details": {...} }   # body inválido (ej. amountUsd <= 0)
→ 502 { "error": "quote_unavailable" }                 # falla del provider / misconfig
```

Etapa 1 corre 100% en **fallback FX** (`provenance: "local-fallback"`): FX mid real de
`open.er-api.com` + spread declarado. **Sin** receipt EIP-712 y **sin** lógica de pago/x402 del lado
del agente (eso lo hace el gateway a2a). TransFi queda para etapa 2.

> El patrón `zod input → provider → receipt EIP-712 → { result }` descrito arriba aplica a los
> agentes que tienen `agent-signer` (ej. `cobraya-credit-scorer`). `remit-corridor-fx` etapa 1
> **omite** el receipt (este repo no tiene `agent-signer`): envuelve directo en `{ result }`.

### Correr local
`npm run dev` → `http://localhost:3030/api/agents/remit-corridor-fx/invoke`

### Deploy (Vercel, proyecto NUEVO — separado de wasiai-agentshop)
Env vars (ver §Env vars del deploy). El `agent_url` a registrar es
`https://<deploy-nuevo>.vercel.app/api/agents/remit-corridor-fx/invoke`.

Env vars relevantes de etapa 1:
```
FALLBACK_FX_SPREAD_BPS=250        # spread declarado (bps). Si se omite, el código usa 250.
FALLBACK_FX_FLAT_FEE_USD=0.5      # fee flat USD. Si se omite, el código usa 0.5.
STATIC_USD_PEN=3.75               # (opcional) fallback si open.er-api.com falla
# NO setear en etapa 1: TRANSFI_API_KEY, TRANSFI_ADAPTER_READY (TransFi es etapa 2).
```

## Endpoint HTTP + deploy (etapa 1 — `remit-kyc-validator`)

El agente `remit-kyc-validator` ya es invocable vía Next.js App Router (mismo deploy que `remit-corridor-fx`):

```
POST /api/agents/remit-kyc-validator/invoke
body: { "senderName": "Alice", "senderCountry": "US", "legalId": "<DNI>", "amountUsd": 100,
        "receiverName": "Bob", "receiverCountry": "PE", "purpose": "family support" }
→ 200 { "result": { "slug", "approved", "riskLevel", "reasons",
                     "verificationId", "provenance", "payoutAllowed" } }   # SIN legalId ni travelRuleData
→ 400 { "error": "invalid_input", "details": {...} }   # body inválido (mensajes Zod, sin PII)
→ 502 { "error": "verification_unavailable" }          # falla del provider / misconfig
```

Etapa 1 corre 100% en **fallback KYC** (`provenance: "local-fallback"`): verificación determinística, sin
red real. **Didit queda OFF** (etapa 2): `DIDIT_API_KEY` / `DIDIT_ADAPTER_READY` **sin setear** en el deploy.
**Garantía dura NO-PII:** el output NUNCA expone `legalId` (DNI) ni `travelRuleData` en ninguna respuesta
(200/400/502). **Sin** receipt EIP-712 y **sin** lógica de pago/x402 del lado del agente (lo hace el gateway a2a).

### Correr local
`npm run dev` → `http://localhost:3030/api/agents/remit-kyc-validator/invoke`

## Endpoint HTTP + deploy (etapa 1 — `remit-cashout-payout`)

El agente `remit-cashout-payout` ya es invocable vía Next.js App Router (mismo deploy que los otros `remit-*`):

```
POST /api/agents/remit-cashout-payout/invoke
body: { "quoteId": "q1", "amountUsd": 100, "kycVerificationId": "v1",
        "senderIdentity": "<el vendor_data ligado a esa verificación: DNI o wallet address>",
        "beneficiary": { "name": "<PII>", "country": "PE", "method": "yape", "destination": "<Yape/CCI>" },
        "idempotencyKey": "idem-1" }
→ 200 { "result": { "slug", "executed", "status", "payoutId",
                    "deliveredLocal", "txRef", "reason", "provenance" } }  # SIN beneficiary ni travelRuleData
→ 200 { "result": { "executed": false, "status": "blocked", "reason": "kyc_gate_not_passed" } }  # hard-gate KYC (WKH-203: server-side, no del caller) o identidad no coincide (WKH-204)
→ 200 { "result": { "executed": false, "status": "blocked", "reason": "kyc_identity_claim_missing" } }  # falta la identity claim (WKH-204)
→ 400 { "error": "invalid_input", "details": {...} }  # body inválido (mensajes Zod, sin PII)
→ 502 { "error": "payout_unavailable" }               # fail-safe / misconfig del provider
```

> **Nota**: el campo `kycPayoutAllowed` fue **removido del schema** (WKH-203). El hard-gate KYC ahora se **re-deriva server-side** contra Didit: `KycProvider.status(verificationId, identityClaim)` → allowlist `REAL_KYC_PROVENANCES`. (El 2º parámetro es **requerido** desde WKH-204: un opcional se puede olvidar en un call site nuevo y degradaría el binding en silencio; uno requerido **no compila**.) Si código legacy (`chaski-v2/gateways.ts`) aún envía `kycPayoutAllowed: true`, **Zod lo strippea silenciosamente** (schema sin `.strict()`); el campo no tiene ningún efecto.

### Identity binding — `senderIdentity` (WKH-204)

El hard-gate de WKH-203 confirma que la verificación está **aprobada**, no que sea **del que pide el payout**.
WKH-204 ata las dos cosas: el caller presenta `senderIdentity` y el agente lo compara contra el `vendor_data`
**real** que la fuente autoritativa (Didit) tiene atado a esa verificación. Si no coincide → **blocked**.

- **`senderIdentity`** (`string`, opcional en el schema): el valor que quedó ligado como `vendor_data` a esa
  verificación **en su creación** — el **DNI** si la creó `remit-kyc-validator`, la **wallet address** si la creó
  `chaski-v2`. La comparación normaliza con `trim()` + `toLowerCase()` (deja el DNI intacto y vuelve el address
  EVM case-insensitive). El valor **nunca** se ecoa en un response ni se loguea.
- **`address`** (`string`, opcional): **DEPRECADO** — puente de compatibilidad con `chaski-v2`, que hoy manda
  `address` y no `senderIdentity`. Se usa **solo** si `senderIdentity` está ausente (precedencia: gana el
  explícito). No construir features nuevas sobre él; se elimina cuando `chaski-v2` mande `senderIdentity`.
- **Fail-closed**: sin claim (o claim vacío/whitespace) → `kyc_identity_claim_missing` **sin llamar a Didit**. Si
  la verificación no tiene `vendor_data` contra qué comparar → **blocked** (no se asume que coincide).
- **No-oracle**: "no aprobado" y "aprobado pero no es tuyo" colapsan al **mismo** `reason:
  "kyc_gate_not_passed"`, para no convertir el endpoint en un confirmador de DNIs.

> ⚠️ **Alcance real de esta protección (sin eufemismos).** El binding `kycVerificationId` ↔ `senderIdentity`
> **sube la barra** (deja de ser un ataque de un solo dato) pero **NO constituye prueba criptográfica de
> posesión**: no hay firma ni SIWE, y `senderIdentity` es caller-controlado igual que `kycVerificationId`. Un
> atacante que consiga **ambos** datos pasa. Además, cuando la sesión KYC fue creada con un `vendor_data`
> **público** (ej. una wallet address, como hace `chaski-v2`), la protección de **ese** flujo es **≈nula**: el
> atacante que quiere suplantar a esa víctima ya conoce su address. La prueba de posesión real es una HU de
> seguimiento.

Etapa 1 corre 100% en **payout MOCK** (`FallbackPayoutProvider`, `provenance:"local-fallback"`,
`deliveredLocal:null`, `txRef:null`): NUNCA mueve plata real. **TransFi queda OFF** (etapa 2 / WKH-168):
`TRANSFI_API_KEY` / `TRANSFI_ADAPTER_READY` **sin setear** en el deploy.

**Flag `PAYOUT_ALLOW_MOCK`:** el fail-safe `assertPayoutProviderSafe()` lanza `payout_refused` en
`NODE_ENV=production` sin provider real. Como Vercel fija `NODE_ENV=production`, el deploy de etapa 1 setea
`PAYOUT_ALLOW_MOCK=true` para permitir SOLO el mock. **NO habilita ningún path a desembolso real** (ese sigue
100% gated por `TRANSFI_API_KEY`+`TRANSFI_ADAPTER_READY`). ⚠️ Activar `PAYOUT_ALLOW_MOCK` en cualquier deploy
que no sea el de etapa 1 (mock) es un **incidente de seguridad money-path**.

**Garantía dura NO-PII:** el output NUNCA expone `beneficiary.name`, `beneficiary.destination` (Yape/CCI) ni
`travelRuleData` en ninguna respuesta (200/400/502). **Sin** receipt EIP-712 y **sin** lógica de pago/x402 del
lado del agente (lo hace el gateway a2a).

### Correr local
`npm run dev` → `http://localhost:3030/api/agents/remit-cashout-payout/invoke`
