[Español](README.es.md)

# wasiai-remittance-agents

Three autonomous agents of the **USDC → PEN** remittance corridor (United States → Peru) that **charge
for their work in USDC on `solana-devnet`**, over x402. They are discoverable, invoked over HTTP, and
paid per call. **No collection leg touches an EVM chain**: the three charge on `solana-devnet`, and the
`chain` in the manifest is a code constant typed as a closed set of test networks, so no environment
variable can move it. The **disbursement** leg is a separate axis: the TransFi off-ramp adapter is
multi-network by configuration (`TRANSFI_USDC_NETWORK`), and among the networks it accepts there are
EVM ones (`base`, `polygon`, `arbitrum`, …). This corridor declares `solana`.

| agent (billing slug) | what it does | price | charges on |
|---|---|---|---|
| `remit-kyc-validator` | KYC/AML: identity + OFAC/PEP/sanctions screening + Travel Rule data. Hard gate: if KYC does not pass, there is no payout. | 0.02 USDC | `solana-devnet` |
| `remit-corridor-fx-solana` | Prices the USDC→PEN corridor: real market rate + declared spread + ETA. | 0.03 USDC | `solana-devnet` |
| `remit-cashout-payout-solana` | Cash-out to Peru (Yape/Plin/CCI): the value delivery to the beneficiary. | 0.03 USDC | `solana-devnet` |

⚠️ That last column is what the three **manifests** declare. What actually pays is the gateway's
registry, and today the `remit-kyc-validator` row there has no `payment` block: it charges **$0** while
its manifest answers `200`. Both halves are public, so anyone can see the mismatch (measured
2026-07-31):

```bash
curl -s https://wasiai-remittance-agents.vercel.app/api/agents/remit-kyc-validator/manifest | jq .payment
# {"method":"x402","chain":"solana-devnet","contract":"<base58 32B>","asset":"USDC"}
curl -s https://wasiai-a2a-production.up.railway.app/discover \
  | jq '.agents[] | select(.slug=="remit-kyc-validator") | .payment'
# null
```

The order that avoids leaving an agent like that is the runbook at the end of this document.

**Where this actually stands.** The three `/invoke` and the three `/manifest` endpoints are
implemented and green (**469 tests across 21 files**, no network). What is real today: the **FX
quote** (live market rate, cascade over two independent sources, and **fail-closed**: with no rate
it can back, it does not quote) and the **billing manifests**, which are never published half-filled.
What is **not** real yet: KYC (Didit) and disbursement (TransFi). Both run on a **deterministic
fallback**, tagged as such in every response. The payout **does not move money**, on purpose and with
a fail-safe that prevents it in production.

- **License**: MIT. **Runtime**: Node 22, Next.js App Router, TypeScript strict.
- **Every environment variable**: [`.env.example`](.env.example) (single source of truth).

---

## Where is the code that moves the USDC? (read this first)

**It is not in this repo, and that is deliberate.** `package.json` has no Solana dependency: no
`@solana/web3.js`, no keypair, no RPC call. If the thesis is "agents that get paid on Solana", it is
worth spelling out where the link that actually collects the money lives.

| | this repo (`wasiai-remittance-agents`) | the gateway (`wasiai-a2a`) |
|---|---|---|
| **role** | does the work and **declares** where to get paid | **executes** the payment |
| **artifact** | `GET /api/agents/<agent>/manifest` → `payment` block | SPL USDC transfer on `solana-devnet` |
| **data** | `{ method:"x402", chain:"solana-devnet", contract:"<base58 32B>", asset:"USDC" }` | signs and sends the transaction to the address in `contract` |
| **keys** | none: the wallet is an environment variable, not a secret | the rail's keys live over there |

An agent that wants to get paid only has to honor two endpoints:

```
POST /api/agents/<agent>/invoke   body = step input (JSON)  →  200 { result: {...} }
GET  /api/agents/<agent>/manifest                           →  200 { …, payment: {…} }  |  503
```

The operator copies that `payment` block into the gateway's registry, and from there the gateway pays
the agent on every invocation. **Why this split:** an agent signing its own settlements would need a
hot key per agent and would reimplement the rail once per agent. With this split, the entire surface
of this repo facing **its own billing** is **one base58 address read from an environment variable**.
The code that validates it (`src/manifest/wallet-format.ts`) applies **the same criterion as the
consumer's settle**, not one of its own.

That is the billing surface, and it is not the only place in the repo where money is described. The
payout adapter builds an off-ramp order with `source.currency`, `source.walletAddress`, `source.amount`
and the beneficiary's destination (`src/providers/payout.ts:149-188`): that is money surface too. What
this repo does not have is the ability to *move* the funds by itself: it has no signing key on either
leg, and the payout adapter is off in stage 1. The variables that hold that lock are listed in the
`remit-cashout-payout` section.

That split is also the reason `src/manifest/settle-preconditions.ts` exists: a **test oracle** that
ports the gateway's real sequence guard by guard and in the same order (`NO_PAYMENT_FIELD`,
`METHOD_NOT_SUPPORTED`, `CHAIN_NOT_SUPPORTED`, `INVALID_PAY_TO_FORMAT`, `ZERO_PAY_TO`). It makes it
possible to assert *"this agent would / would not get paid"* **with no chain and no funds**, which is
what makes the fail-closed behavior of billing demonstrable inside CI.

One consequence worth stating: a `200` from the manifest says *where* the agent charges, not that it
already got paid. Executing the payment is the gateway's half of the split.

---

## How I run it

Requires **Node 22** (see [`.nvmrc`](.nvmrc) and `engines` in `package.json`). No database, no chain,
no third-party credentials.

```bash
nvm use            # optional: picks up the version in .nvmrc
npm install

npm run typecheck  # tsc --noEmit
npm test           # vitest run  →  469 tests, 21 files
npm run build      # next build
```

The suite **does not touch the network**: FX sources and partner APIs are mocked, and the fail-closed
behavior of the manifests is exercised by setting and clearing the envs inside each test. That is why
it runs clean with nothing configured. It is the same thing CI runs
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

### Bringing the service up

The `/invoke` endpoints start with no envs at all. The `/manifest` endpoints **require** the 3 `payTo`
envs: without them they answer `503`, which is the intended behavior and not a bug.

```bash
cp .env.example .env.local      # then replace the 3 *_PAYTO with Solana base58 addresses
npm run dev                     # http://localhost:3030

curl -s -X POST http://localhost:3030/api/agents/remit-corridor-fx/invoke \
     -H 'content-type: application/json' -d '{"amountUsd":100}'
curl -sD- http://localhost:3030/api/agents/remit-kyc-validator/manifest
```

### Environment variables

**They are all in [`.env.example`](.env.example), which is the single source of truth.** This README
does not repeat the list on purpose: two lists drift apart and someone ends up copying half of one.
The only thing to retain here is that the 3 `*_PAYTO` are **mandatory today** and have no default;
everything else has a sensible default or belongs to stage 2 (partners).

### Deploy

Next.js App Router on Vercel, its own project. Envs are set as project variables (Production /
Preview), never in a file in the repo: rotating a wallet is editing a variable and redeploying. The
`agent_url` registered in the gateway is
`https://<deploy>.vercel.app/api/agents/<agent>/invoke`, and the manifest is derived from it:
`manifestUrl = agentUrl.replace(/\/invoke\/?$/, '/manifest')`.

---

## Architecture: how a partner plugs in

Every external capability is an interface in `src/providers/types.ts` with **two** implementations:

- the **partner adapter** (`DiditKycProvider`, `TransFiPayoutProvider`, …), active only with its
  credential **and** its `*_ADAPTER_READY` flag: the credential alone is not enough, so nobody talks
  to a half-configured partner;
- the **deterministic fallback**, which runs with no credentials and stays **tagged in the output**
  (`provenance: "local-fallback"`), never disguised as real data.

The factory (`getKycProvider()`, `getPayoutProvider()`, …) picks based on the environment. The day
the partner sandbox arrives, two variables get set: zero wiring changes.

The exact shape of the partner responses is still to be confirmed against their sandbox: the adapters
follow the documented shape, and every uncertain field is read from an environment variable and fails
loudly if the partner requires it and it is not set.

This repo **signs nothing**: it has no signing key and issues no signed receipts. The pattern of an
agent here is `zod input → provider → { result }`: trust in the result rests on the `provenance`
field (which method produced that datum) and not on a signature from the agent itself.

### Pending (post-sandbox)

- Map the exact fields of the Didit/TransFi responses (today the adapters use the documented shape).
- Real value delivery: moving the principal and settling it to the beneficiary. Today the payout leg
  answers with a mock and moves nothing. See `remit-cashout-payout`.

---

## HTTP endpoint (stage 1: `remit-corridor-fx`)

```
POST /api/agents/remit-corridor-fx/invoke
body: { "amountUsd": 100, "destCountry": "PE", "payoutMethod": "yape" }  # only amountUsd is required
→ 200 { "result": { "slug", "rate", "feeUsd", "netDeliveredLocal", "localCurrency": "PEN",
                     "etaMinutes", "quoteId", "expiresAt", "provenance",
                     "rateSource", "rateAsOf" } }
→ 400 { "error": "invalid_input", "details": {...} }   # invalid body (e.g. amountUsd <= 0)
→ 400 { "error": "fx_amount_below_minimum", "minSendUsd": 5 }  # the send does not reach the minimum
→ 400 { "error": "fx_amount_above_maximum", "maxSendUsd": 10000 }  # the request is over the cap
→ 502 { "error": "quote_unavailable" }                 # no usable rate source / misconfig
```

> **Why the minimum and the maximum are their own `400` and not the `502`.** "You sent too little" and
> "you asked for too much" are caller errors, not an outage on our side: flattening them into the
> `502` would tell someone to "come back later" when their retry will never work until the amount
> changes. The value in force travels in `minSendUsd` / `maxSendUsd` so the caller does not have to
> find it by bisection. Both guards run in the **agent core** (`runCorridorFx`), before the provider
> is chosen: that way they cover both providers and do not disappear the day the partner adapter is
> switched on.
>
> **They are two distinct codes on purpose**: the two errors are fixed in opposite directions, and a
> single code would leave the integrator unsure whether to raise or lower the amount.

> **The cap belongs to the AGENT, not to each caller.** That way it protects the operator from any
> caller, including the ones that do not exist yet; a per-caller cap is an explicit exception to be
> added the day a large client asks for it, not a door left open by default. The 10,000 covers a
> person's remittance with plenty of headroom and leaves a request for a million on the obviously
> wrong or malicious side. Before the cap, an `amountUsd` of 1e6, of 1e15 and even of 1e300 returned
> `200` with a well formed quote, in band and fresh, that the agent committed to honour for ten
> minutes; the overflow to `Infinity` only cuts in at 1e308. Numeric robustness was not what was
> missing: the policy was.

### Rate provenance (HTTP contract change)

The agent quotes **only** with a market rate it can back. `provenance` is no longer a generic label:
each value maps 1:1 to an auditable method of obtaining the rate.

| `provenance` | What it means |
|---|---|
| `fx-mid-live` | mid fetched LIVE from a registered source, in this quote |
| `fx-mid-cached` | the same mid, served from the in-memory cache within its freshness window |
| `transfi` | effective corridor rate, from the licensed partner (stage 2) |

Two **additive** fields accompany every quote:

- **`rateSource`**: id of the registered source (`"er-api"`, `"currency-api"`, `"transfi"`).
- **`rateAsOf`**: ISO, the date of the datum **according to the source**, never the moment it was
  served. A cached response keeps the ORIGINAL date of the datum: if it showed the moment of serving,
  it would be lying about its own freshness.

> ⚠️ **`"local-fallback"` was REMOVED from the FX agent.** Previously, when the feed failed, the quote
> was computed from the `STATIC_USD_PEN` constant (default **3.75**) and labeled `"local-fallback"`,
> **just like** a market rate. Measured on 2026-07-29 against three independent sources
> (`open.er-api.com` 3.4033, `currency-api` 3.3956, **official BCRP** 3.404), the market was at
> **~3.40**: the constant sat **+10.2% above it**. Whenever that fallback kicked in, the quote
> **promised more soles than the market gives**: on a $400 remittance, **~140 PEN** that somebody has
> to cover. This was not a labeling problem: it was money. The value is still alive in KYC and payout,
> which are a different axis.

### Fail-closed: with no verifiable rate there is NO quote

If no registered source returns a usable rate **and** there is no fresh cache, the endpoint answers
**`502 quote_unavailable`**. There is no branch that returns "something equivalent":

- **An expired cache is NOT served.** On expiry it re-fetches; if the fetch fails, it fails. An
  expired cache is the static constant with a better pedigree: a number nobody can back at the moment
  of using it.
- **There is no fallback constant.** It was deleted from the code.
- A quote nobody can back is worse than no quote: someone ties it to a real disbursement.

Every discarded source emits a **value-free** `console.warn` (`{ sourceId, code }`, never the source's
body nor the full URL) with one of these codes: `fx_mid_http_<status>`, `fx_mid_fetch_failed`,
`fx_mid_bad_shape`, `fx_mid_no_usable_pen_rate`, `fx_mid_out_of_band`, `fx_mid_stale_data`.

### Registered sources (not free-form URLs)

`FX_MID_SOURCES` names **ids from an in-code registry**, not URLs. Each source brings **its own
parser**, so an env that accepted any URL *would look like* an extension point and would not be one:
pointing it at another source would yield "invalid shape" forever (the **dead control** pattern). Only
the **host** is overridable. An unregistered id ⇒ `fx_mid_config_invalid:FX_MID_SOURCES`.

| id | canonical URL | rate field | date field |
|---|---|---|---|
| `er-api` | `https://open.er-api.com/v6/latest/USD` | `rates.PEN` | `time_last_update_unix` (s) |
| `currency-api` | `https://latest.currency-api.pages.dev/v1/currencies/usd.json` | `usd.pen` | `date` (`YYYY-MM-DD`) |

Every registered source **must declare the date of its datum**: with no date it is treated as an
invalid shape. You cannot claim freshness for a datum that does not say when it was produced, and
"I don't know when this is from" must not collapse into "it is from now" (this is the real case of a
CDN serving a frozen JSON with a recent 200).

The **BCRP** (official rate) is **not** used as a runtime source: it publishes with ~7 days of lag and
does not publish on weekends or holidays. It serves as a documented anchor for the band and as runbook
verification.

Stage 1 runs 100% on the real mid rate + declared spread. TransFi is left for stage 2.

### FX config: why every number is a money guard

The variables live in [`.env.example`](.env.example) with their valid ranges. What matters here is
**why** they are validated.

They are all read on **every quote**, so rotating them takes effect without a redeploy. Invalid config
**throws** `fx_mid_config_invalid:<field>` instead of quoting with a disabled guard: `Number("abc")`
is `NaN`, and comparing against `NaN` is always `false`: a non-numeric maximum would **silently
disable the band**.

⚠️ **`STATIC_USD_PEN` is OBSOLETE and HAS NO EFFECT.** It is no longer read anywhere in the code. It
was the fallback constant (3.75) that quoted +10.2% over the real market; setting it today moves no
quote at all. **Delete it from the deploy** so nobody believes it still controls anything.

⚠️ **The minimum and the fee are TIED TOGETHER, and that is not a detail**: the fee cannot exceed
**20%** of the minimum. If it does, `resolveFxConfig()` **throws** and the agent quotes nothing. The
reason is that a loose minimum switches itself off: with the fee at 6 and the minimum at 5, the
smallest accepted send would deliver **zero soles** again, with the minimum sitting right there
protecting nothing. To charge a higher fee you have to raise the minimum, which is exactly the
decision somebody should be making consciously. With the defaults (minimum 5, fee 0.50) the fee is
**10%** at the floor, half of the ceiling.

⚠️ The **spread** and the **fee** are money guards too, not preferences: the rate the user receives is
`mid * (1 - spread/10000)`, and the band validates the **mid**, not the emitted rate. A negative
spread quotes **above the market**: measured against a mid of 3.40, `-1000` bps emitted 3.74
(+10.0%), the very same error as the 3.75 constant, through another door. That is why they are now
range-validated and the **emitted rate** also goes through the band (`fx_rate_out_of_band`).

Every default **asserts something about the outside world** (evidence measured on 2026-07-29): both
sources are alive and publish USD/PEN with a date; the feed promises a ~24 h cycle, so 48 h tolerates
**one** missed cycle, not two; and with the market at ~3.40 the `[2.50, 5.00]` band lets real currency
movement through while catching a zero, a negative, an order of magnitude, or the rate of **another**
currency (if the feed changed and returned `PYG` ≈ 7300 or `EUR` ≈ 0.92).

---

## HTTP endpoint (stage 1: `remit-kyc-validator`)

```
POST /api/agents/remit-kyc-validator/invoke
body: { "senderName": "Alice", "senderCountry": "US", "legalId": "<DNI>", "amountUsd": 100,
        "receiverName": "Bob", "receiverCountry": "PE", "purpose": "family support" }
→ 200 { "result": { "slug", "approved", "riskLevel", "reasons",
                     "verificationId", "provenance", "payoutAllowed" } }   # NO legalId, NO travelRuleData
→ 400 { "error": "invalid_input", "details": {...} }   # invalid body (Zod messages, no PII)
→ 502 { "error": "verification_unavailable" }          # provider failure / misconfig
```

Stage 1 runs 100% on the **KYC fallback** (`provenance: "local-fallback"`): deterministic verification,
no real network. **Didit stays OFF** (stage 2): `DIDIT_API_KEY` / `DIDIT_ADAPTER_READY` **not set** in
the deploy. **Hard NO-PII guarantee:** the output NEVER exposes `legalId` (national ID) or
`travelRuleData` in any response (200/400/502).

---

## HTTP endpoint (stage 1: `remit-cashout-payout`)

```
POST /api/agents/remit-cashout-payout/invoke
body: { "quoteId": "<the quoteId EXACTLY as remit-corridor-fx returned it>", "amountUsd": 100,
        "kycVerificationId": "v1",
        "senderIdentity": "<the vendor_data bound to that verification: national ID or wallet address>",
        "beneficiary": { "name": "<PII>", "country": "PE", "method": "yape", "destination": "<Yape/CCI>" },
        "idempotencyKey": "idem-1" }
→ 200 { "result": { "slug", "executed", "status", "payoutId", "deliveredLocal", "txRef",
                    "reason", "provenance", "depositAddress" } }  # NO beneficiary, NO travelRuleData
→ 200 { "result": { "executed": false, "status": "blocked", "reason": "quote_amount_mismatch" } }  # amountUsd is not the amount quoted under that quoteId
→ 200 { "result": { "executed": false, "status": "blocked", "reason": "quote_unresolvable" } }     # we did not issue that quoteId (or it can no longer be resolved)
→ 200 { "result": { "executed": false, "status": "blocked", "reason": "kyc_gate_not_passed" } }  # KYC hard gate (server-side, not the caller's) or identity mismatch
→ 200 { "result": { "executed": false, "status": "blocked", "reason": "kyc_identity_claim_missing" } }  # identity claim missing
→ 400 { "error": "invalid_input", "details": {...} }  # invalid body (Zod messages, no PII)
→ 502 { "error": "payout_unavailable" }               # fail-safe / provider misconfig
```

> **`quoteId` and `amountUsd` are NOT two independent fields.** The `quoteId` returned by
> `remit-corridor-fx` carries the quoted amount signed inside it, and this agent verifies it:
> `amountUsd` must be **exactly** that amount. That was not the case until 2026-07-31, when a 100 USD
> quote could be used to request a one million payout. What this means if you integrate: forward the
> `quoteId` **verbatim**, do not normalize or truncate it, and never invent it or reuse one from
> another remittance. The two rejections are **deliberately distinct**: `quote_amount_mismatch` is
> fixed by sending the right amount; `quote_unresolvable` is fixed by getting a real quote (it also
> shows up if the deployment's signing secret was rotated or is missing, which is worth an alert).
> Intended side effect: since `FX_MAX_SEND_USD` is enforced **before** the `quoteId` is issued, the
> quote ceiling reaches the payout without the payout re-reading that policy.

The `result` of the happy path carries **9 keys**. The last one, **`depositAddress`**, is the address
dedicated to the order that TransFi returns on create-order: the address the sender is supposed to send
the USDC to on-chain. It is `null` in the mock and in every `blocked` response, so a non-null value is
also the sign that a real order was created (`src/agents/cashout-payout.ts:59`).

> **Note**: the `kycPayoutAllowed` field was **removed from the schema**. The KYC hard gate is
> **re-derived server-side** against Didit: `KycProvider.status(verificationId, identityClaim)` →
> `REAL_KYC_PROVENANCES` allowlist. (The 2nd parameter is **required**: an optional one can be
> forgotten at a new call site and would silently degrade the binding; a required one **does not
> compile**.) If legacy code still sends `kycPayoutAllowed: true`, **Zod strips it silently** (schema
> without `.strict()`); the field has no effect whatsoever.

### Identity binding: `senderIdentity`

The hard gate confirms that the verification is **approved**, not that it belongs to **whoever is
requesting the payout**. The binding ties the two together: the caller presents `senderIdentity` and
the agent compares it against the **real** `vendor_data` that the authoritative source (Didit) has
bound to that verification. No match → **blocked**.

- **`senderIdentity`** (`string`, optional in the schema): the value that was bound as `vendor_data`
  to that verification **at creation time** (the **national ID** if `remit-kyc-validator` created it,
  the **wallet address** if the consuming app did). The comparison normalizes with `trim()` +
  `toLowerCase()`: it leaves a national ID untouched and absorbs the case differences of an address.
  The value is **never** echoed in a response and never logged.
- **`address`** (`string`, optional): **DEPRECATED**. Compatibility bridge for the consuming app,
  which today sends `address` and not `senderIdentity`. It is used **only** if `senderIdentity` is
  absent (precedence: the explicit one wins). A new integration should send `senderIdentity`.
- **Fail-closed**: no claim (or an empty/whitespace claim) → `kyc_identity_claim_missing` **without
  calling Didit**. If the verification has no `vendor_data` to compare against → **blocked** (a match
  is not assumed).
- **Non-oracle**: "not approved" and "approved but not yours" collapse into the **same** `reason:
  "kyc_gate_not_passed"`, so the endpoint does not become a national-ID confirmation service.

> ⚠️ **Real scope of this protection (no euphemisms).** The `kycVerificationId` ↔ `senderIdentity`
> binding **raises the bar** (it stops being a single-datum attack) but does **NOT constitute
> cryptographic proof of possession**: there is no signature and no SIWE, and `senderIdentity` is
> caller-controlled just like `kycVerificationId`. An attacker who obtains **both** values gets
> through. On top of that, when the KYC session was created with a **public** `vendor_data` (e.g. a
> wallet address), the protection of **that** flow is **≈nil**: the attacker who wants to impersonate
> that victim already knows their address. Real proof of possession is still pending.

Stage 1 runs 100% on the **MOCK payout** (`FallbackPayoutProvider`, `provenance:"local-fallback"`,
`deliveredLocal:null`, `txRef:null`): it NEVER moves real money. **TransFi stays OFF** (stage 2).

### Which variables actually hold the lock on the disbursement

The real adapter is chosen by `getPayoutProvider()` (`src/providers/payout.ts:310-325`), and the same
four are re-checked by the `assertPayoutProviderSafe()` fail-safe (`src/agents/cashout-payout.ts:67-71`):

| variable | what happens if it is missing |
|---|---|
| `TRANSFI_USERNAME` | falls back to the mock; any one of the three credentials missing is enough |
| `TRANSFI_PASSWORD` | idem |
| `TRANSFI_MID` | idem |
| `TRANSFI_ADAPTER_READY` (must be `"true"`) | with the 3 credentials set and this one not `"true"`, it **throws** `transfi_adapter_not_ready`; it does not quietly downgrade to the mock |

> ⚠️ **`TRANSFI_API_KEY` does NOT gate the disbursement.** It is read by the **FX** adapter (`fx.ts`)
> and by nothing on the payout path: the code states it out loud at `src/providers/payout.ts:308`.
> Setting it or clearing it moves nothing in the payout. Auditing the disbursement through that
> variable is watching the wrong one.

A fifth variable is not part of the selection gate, but the real adapter cannot create a single order
without it: **`TRANSFI_USDC_NETWORK`** decides which chain the USDC leaves through (`solana` ⇒
`USDCSOL`). Unset, empty or whitespace-only, `execute()` throws `transfi_usdc_network_unset` **before
touching the network** (`payout.ts:140-147`). There is no default and no guessing: turning the adapter
on without this variable gets you an adapter that fails on its first order.

**`PAYOUT_ALLOW_MOCK` flag:** the `assertPayoutProviderSafe()` fail-safe throws `payout_refused` under
`NODE_ENV=production` with no real provider. Since Vercel pins `NODE_ENV=production`, the stage 1
deploy sets `PAYOUT_ALLOW_MOCK=true` to allow ONLY the mock. **It enables no path to a real
disbursement** (that one remains gated by the four variables in the table above). ⚠️ Turning
`PAYOUT_ALLOW_MOCK` on in any deploy other than the stage 1 (mock) one is a **money-path security
incident**.

**Hard NO-PII guarantee:** the output NEVER exposes `beneficiary.name`, `beneficiary.destination`
(Yape/CCI) or `travelRuleData` in any response (200/400/502).

---

## Billing manifest (`/manifest`)

Every agent publishes **its own billing sheet** on an endpoint sibling to its `/invoke`. It is what
the operator copies into the gateway's registry so that the agent **gets paid for its work**. The
registry is what decides: an agent whose row there has no `payment` block **charges $0 silently**, and
nothing looks broken while it happens (the caller pays the gateway, the step runs, and the settlement
toward the operator is skipped without an error). That is the state of `remit-kyc-validator` today,
and the two `curl`s at the top of this document show it.

### URLs

| Method | URL |
|---|---|
| `GET` | `/api/agents/remit-kyc-validator/manifest` |
| `GET` | `/api/agents/remit-corridor-fx/manifest` |
| `GET` | `/api/agents/remit-cashout-payout/manifest` |

Derivation from the already-registered `agentUrl`:
`manifestUrl = agentUrl.replace(/\/invoke\/?$/, '/manifest')`.

**The `GET` answers `200` or `503`, nothing else** (there is no third code for the supported method).
Both responses carry `Cache-Control: no-store`. Other methods and other paths are not part of the
contract and are handled by the framework: a `POST` to the same path returns `405`, and a nonexistent
path returns `404`. In particular, the **canonical slug**
(`/api/agents/remit-corridor-fx-solana/manifest`) **is not a URL**: the 3 valid URLs are the ones in
the table above, which use the `pathSlug`.

### `200 OK`: exactly 7 top-level keys

```json
{
  "manifestVersion": "1",
  "slug": "remit-corridor-fx-solana",
  "name": "remit-corridor-fx-solana",
  "description": "<static text, no PII>",
  "capabilities": ["remittance-fx-quote", "usdc-to-pen", "corridor-pricing"],
  "priceUsdc": 0.03,
  "payment": { "method": "x402", "chain": "solana-devnet", "contract": "<base58 32B>", "asset": "USDC" }
}
```

`payment` has exactly 4 keys (`method`, `chain`, `contract`, `asset`) and is **copied verbatim** into
the registry: there is no transformation or normalization pending on the consumer side.

### `503 Service Unavailable`: sheet not publishable (fail-closed)

```json
{ "error": "manifest_unavailable", "missing": ["payment.contract"], "invalid": [] }
```

`missing` and `invalid` contain **field names, never values**: the env's value is not echoed in the
body nor in the logs (not truncated, not hashed). Both keys are always present. The `503` body
**never** carries a `payment` key.

### Fail-closed semantics (why there is no "half-filled 200")

> **A `200` with a half-filled sheet is worse than an error, because somebody copies it into a
> registry and the agent ends up charging $0 silently.**

Hence: with no `payTo` configured, or with a malformed `payTo`, the manifest **is not emitted**
(`503`). There is no code branch that returns `200` without a valid `payment.contract`.

The 3 slots are `solana-devnet`, and the validator is there precisely to **reject anything that is
not**, including a `0x…` address from another chain family pasted by mistake, which is the operator's
most likely slip when copying between environments. Without that rejection, the consumer's settle
would discard it with `INVALID_PAY_TO_FORMAT`, the agent would charge zero anyway, and the manifest
would keep saying everything was fine.

The format criterion is the **same** one the consumer applies, and for these 3 agents it reduces to a
single rule: base58 that decodes to **exactly 32 bytes**, not "between 32 and 44 characters". A
base58 string of valid length that decodes to 33 bytes passes the loose regex and the settle rejects
it all the same.

### `payTo` envs (no defaults, on purpose)

| Agent | `payTo` env | Only accepted format |
|---|---|---|
| `remit-kyc-validator` | `REMIT_KYC_VALIDATOR_PAYTO` | Solana base58, 32 bytes |
| `remit-corridor-fx` | `REMIT_CORRIDOR_FX_PAYTO` | Solana base58, 32 bytes |
| `remit-cashout-payout` | `REMIT_CASHOUT_PAYOUT_PAYTO` | Solana base58, 32 bytes |

Full detail on all 3 (which agent, which network, what happens if it is missing, where they are
really set): [`.env.example`](.env.example). **Today all 3 point to the same wallet on purpose**, and
the three live manifests show it. They are separate variables so that giving each agent its own is a
change to an environment variable, with no code change and no deploy. No address lives in the code.

**None of them has a default.** Without the env (absent, empty, or whitespace only) the endpoint
answers `503`: that is the intended behavior, not a bug. The `chain` is **not** configurable: the 3
agents declare it as a code constant in `src/manifest/registry.ts`, and its type is a **closed set of
test networks** where mainnet is not representable. No environment variable can take a manifest to
mainnet: it is impossible by construction, not by discipline.

### `pathSlug` → canonical `slug` → chain table

| pathSlug (route directory) | canonical slug (registry) | chain |
|---|---|---|
| `remit-kyc-validator` | `remit-kyc-validator` | `solana-devnet` |
| `remit-corridor-fx` | `remit-corridor-fx-solana` | `solana-devnet` |
| `remit-cashout-payout` | `remit-cashout-payout-solana` | `solana-devnet` |

> **`pathSlug ≠ slug` on FX and payout is deliberate, and it is not a typo.** The route directory is
> the historical one, because the `agentUrl` already registered in the gateway points there; the
> `slug` the manifest declares is the canonical billing one (`*-solana`). Lining the two up would
> break the registered URL.

### Operational runbook (the order matters)

Registration and delisting are **not done by this repo**: they are manual operations against the
gateway (`wasiai-a2a`). This repo only publishes the sheet.

1. **Set the 3 envs** in Vercel (Production) and redeploy. All 3 are Solana base58. For FX and
   payout: use the **same** addresses already declared by the `*-solana` rows in the registry (read
   them from `/discover` **before** setting them; do not invent a second truth). For KYC: today,
   **the same wallet as the other two**; the day it gets separated, it is this variable and nothing
   else.
2. **Verify the 3 manifests by `curl`**: `200`, correct `payment.chain`, and `Cache-Control: no-store`.
   With one env deliberately cleared, confirm the `503` (live proof of the fail-closed behavior).
3. **Drift check without writing**: compare the manifest's `payment` against `/discover`'s for the 2
   `*-solana` slugs. If they differ, it is **not** fixed by hand.
   > ⚠️ This check **proves nothing about billing**: they match **by construction**, because step 1
   > instructs you to copy the addresses **from those very rows**. It is a documentary consistency
   > check.
4. **Register/update the 3 agents** with the `payment` their manifest declares (`solana-devnet`). If a
   registry row was left with an old `payment`, the manifest and the registry say different things and
   **the registry wins**: the payment comes from there, not from this repo.
5. **Prove that the billing rail is ON** (positive proof, not agreement between documents):
   - **Mandatory minimum**: `GET /capabilities` on the gateway and check that `chains[].key` includes
     `solana-devnet`. If it is not there, the gateway cannot pay on that chain and the downstream leg
     is skipped with `CHAIN_NOT_SUPPORTED` for **all three** agents: they charge **$0**, manifest
     `200` and all.
   - **Ideal**: a real devnet invocation against each `*-solana` slug, confirming in the result / the
     gateway logs that the leg **settled** (none of the skip codes `NO_PAYMENT_FIELD`,
     `METHOD_NOT_SUPPORTED`, `CHAIN_NOT_SUPPORTED`, `INVALID_PAY_TO_FORMAT`).
6. ⚠️ **Delist any previous row for these agents ONLY AFTER step 5 has given positive proof of
   payment** (steps 2 and 3 are not enough: both go green without ever touching the rail). Doing it
   earlier leaves the agent **with no billing route at all**. Delisting is reversible; being left
   without a billing route is not free.
7. **Stage 2 only (not today): turning the real disbursement on.** Steps 1-6 are about *charging*; this
   one is about *paying out*, and it is the step that moves real money. Set the four variables of the
   lock (`TRANSFI_USERNAME`, `TRANSFI_PASSWORD`, `TRANSFI_MID`, `TRANSFI_ADAPTER_READY=true`) **and**
   `TRANSFI_USDC_NETWORK` (for this corridor, `solana`). Skipping that last one is the trap: the gate
   lets the adapter through and then every order dies with `transfi_usdc_network_unset`. Once a real
   provider is in place, remove `PAYOUT_ALLOW_MOCK` from that deploy.

---

## License

MIT. See [`LICENSE`](LICENSE).
