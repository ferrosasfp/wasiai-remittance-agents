# Story File — HU-300 (#010): Los 3 agentes `remit-*` publican su forma de cobro en su propio manifiesto

> SDD: `doc/sdd/010-wkh-300-agent-payment-manifest/sdd.md` (SPEC_APPROVED)
> Work item: `doc/sdd/010-wkh-300-agent-payment-manifest/work-item.md`
> Fecha: 2026-07-28
> Repo: `wasiai-remittance-agents`
> Branch: `feat/010-wkh-300-agent-payment-manifest` (crear desde `main`)
> Fase: F2.5 → consumido por F3 (Dev)

**Este documento es autosuficiente. El Dev NO lee el SDD ni el work-item.** Si algo no está acá,
PARÁ y escalá al Architect (ver §12 Escalation). No inventes paths, firmas, ni valores.

---

## 1. Goal

Hoy `remit-kyc-validator` corre en producción **cobrando $0**: el caller le paga al gateway, el paso
se ejecuta, y el settle hacia el operador del agente se saltea **en silencio** porque la fila del
agente en el registro nunca declaró cómo cobra. Los dos agentes que sí cobran tienen ese dato porque
alguien lo escribió a mano en la base, por fuera de toda API.

Esta HU hace que **cada agente publique su propia ficha de cobro** en un endpoint HTTP hermano de su
`/invoke`: `GET /api/agents/<pathSlug>/manifest`. La ficha es **fail-closed**: si el `payTo` no está
configurado o está mal formado, el manifiesto **no se emite** (503). Nunca un `200` con ficha a
medias, porque una ficha a medias es exactamente lo que alguien copia a un registro y termina en un
agente que cobra cero sin que nadie se entere.

Este repo publica la ficha. Que el **registro rechace** a un agente sin ficha es código del otro repo
(`wasiai-a2a`) y se despacha como HU hermana: **no se implementa acá** (§11).

---

## 2. Las 5 cosas que no se pueden resolver mal

Leé esto antes que nada. Son el corazón de la HU; si quedan ambiguas, el resultado es un agente que
cobra cero con un documento que dice que todo está bien.

1. **Fail-closed de verdad.** Sin `payTo` configurado, o mal formado, la respuesta es **503**. Nunca
   un `200` sin `payment`, nunca un `200` con `contract: ""`, nunca un `payment` parcial. **No existe
   ninguna rama de código que emita `200` sin `payment.contract` válido.** Un 200 incompleto es peor
   que un error, porque alguien lo copia y lo registra.
2. **El cruce de familias se rechaza.** Una dirección EVM (`0x…`) en un slot `solana-devnet`, o una
   base58 en el slot `avalanche-fuji`, **falla con 503**. Es el error más probable del operador
   (copy-paste entre las 3 envs) y hoy no lo atrapa nadie: el settle lo rechazaría en silencio con
   `INVALID_PAY_TO_FORMAT` y el agente cobraría cero igual, pero con un manifiesto diciendo OK.
3. **La cadena es constante de código, no variable de entorno.** `chain` vive en la tabla estática de
   `src/manifest/registry.ts`, tipada como `"avalanche-fuji" | "solana-devnet"`. Ninguna env puede
   llevar un manifiesto a mainnet: es imposible por construcción, no por disciplina. **PROHIBIDO**
   leer `chain` (o cualquier parte de `payment` que no sea `contract`) de una env o del request.
4. **Los tests de dinero miden el efecto.** No alcanza con afirmar "se llamó a tal función" o "el
   objeto tiene tal key". Cada test de dinero pasa el `payment` **realmente emitido por el
   manifiesto** por el oráculo `evaluateSettle()` (§7, F10), que portea las guardas reales del
   gateway, y afirma `WOULD_SETTLE` o el skip-code exacto. **Un rojo tiene que leerse: "este agente
   cobraría cero por tal motivo".** Poné eso literalmente en el nombre del test.
5. **El orden operativo.** Los gemelos Fuji (`remit-corridor-fx`, `remit-cashout-payout`) se
   deslistan **DESPUÉS** de confirmar que el par Solana (`*-solana`) cobra. Al revés deja a FX y
   payout sin ninguna ruta de cobro. Esto **no es código** (es ops `!` humano), pero **tiene que
   quedar escrito en el README con ese orden explícito** (F18) — si no queda escrito, alguien lo hace
   al revés.

---

## 3. Acceptance Criteria (copiados del SDD aprobado — QA los verifica en F4)

- **AC-1** — WHEN se hace `GET` al manifiesto de `remit-kyc-validator`, THE system SHALL responder
  `200` con `capabilities = ["kyc-verification","aml-screening","travel-rule","remittance-compliance"]`
  y `payment = { method:"x402", chain:"avalanche-fuji", contract:<payTo EVM del operador>, asset:"USDC" }`.
- **AC-2** — WHEN se hace `GET` al manifiesto de los endpoints de FX y payout, THE system SHALL
  responder `200` con `payment.chain = "solana-devnet"` y `slug` = `remit-corridor-fx-solana` /
  `remit-cashout-payout-solana` respectivamente.
- **AC-3** — IF el `payTo` de un agente no está configurado (env ausente, vacía o sólo whitespace),
  THEN THE system SHALL responder `503 { error:"manifest_unavailable", missing:["payment.contract"], invalid:[] }`
  **sin** ninguna clave `payment` en el body.
- **AC-4** — WHILE esta HU se implementa y despliega, THE system SHALL no producir ninguna escritura
  sobre `a2a_agents` ni ninguna otra fuente externa: el path del manifiesto no hace **ninguna** I/O
  saliente (verificable con `fetch` stubbeado a `throw`).
- **AC-5** — WHEN el operador registra/actualiza un agente con los valores del manifiesto, THE system
  SHALL producir un `payment` que (a) el lector de specs del gateway acepta y (b) **no** dispara
  ninguno de los skip-codes del leg downstream (`NO_PAYMENT_FIELD`, `METHOD_NOT_SUPPORTED`,
  `CHAIN_NOT_SUPPORTED`, `INVALID_PAY_TO_FORMAT`, `ZERO_PAY_TO`). Verificable acá con el oráculo (F10).
- **AC-6** — IF el `payTo` configurado no tiene el formato válido de la familia de su chain (EVM: `0x`
  + 40 hex y distinto de la zero-address; Solana: base58 que decodifica a **exactamente 32 bytes**),
  THEN THE system SHALL responder `503 { error:"manifest_unavailable", missing:[], invalid:["payment.contract"] }`
  **sin** emitir el manifiesto y **sin** ecoar el valor recibido.
- **AC-7** — WHEN cambia el valor de la env del `payTo` en el entorno de ejecución, THE system SHALL
  reflejarlo en la siguiente respuesta (sin rebuild y sin caché): ruta dinámica + `Cache-Control: no-store`.
- **AC-8** — WHILE se sirve el manifiesto, THE system SHALL no exponer ningún valor de configuración
  distinto del `payTo` declarado, ni ecoar parámetros de query, ni variar su salida según headers del
  caller.

---

## 4. Contrato de salida (el wire, exacto)

**Ruta:** `GET /api/agents/<pathSlug>/manifest` — hermana del `/invoke` ya deployado.
Regla de derivación que usará el consumidor: `manifestUrl = agentUrl.replace(/\/invoke\/?$/, '/manifest')`.

**200 OK** — exactamente **7 claves** de primer nivel, ni una más:

```json
{
  "manifestVersion": "1",
  "slug": "remit-corridor-fx-solana",
  "name": "remit-corridor-fx-solana",
  "description": "<texto estático, sin PII>",
  "capabilities": ["remittance-fx-quote", "usdc-to-pen", "corridor-pricing"],
  "priceUsdc": 0.03,
  "payment": { "method": "x402", "chain": "solana-devnet", "contract": "<base58 32B>", "asset": "USDC" }
}
```

`payment` tiene exactamente 4 claves (`method`, `chain`, `contract`, `asset`) y se copia **tal cual**
al registro: no hay transformación pendiente ni normalización del lado del consumidor.

**503 Service Unavailable** — ficha no publicable (fail-closed):

```json
{ "error": "manifest_unavailable", "missing": ["payment.contract"], "invalid": [] }
```

- `missing` e `invalid` contienen **nombres de campo**, nunca valores. **PROHIBIDO** ecoar el valor de
  la env (ni truncado, ni hasheado, ni en logs).
- Ambas claves están **siempre** presentes (arrays, eventualmente vacíos), para que el consumidor no
  tenga que hacer narrowing.
- El body de 503 **nunca** lleva una clave `payment`.

**Códigos permitidos: `200` y `503`. Nada más.** Ni 400, ni 404, ni 500, ni 502.

**Header en ambas respuestas:** `Cache-Control: no-store`.

---

## 5. Tabla de declaración (la fuente de verdad — copiala tal cual)

| pathSlug (directorio de la ruta) | slug canónico (registro) | chain | family | asset | env del payTo | priceUsdc | capabilities |
|---|---|---|---|---|---|---|---|
| `remit-kyc-validator` | `remit-kyc-validator` | `avalanche-fuji` | `evm` | `USDC` | `REMIT_KYC_VALIDATOR_PAYTO` | `PRICE_USDC` de `src/agents/kyc-validator.ts` (= 0.02) | `kyc-verification`, `aml-screening`, `travel-rule`, `remittance-compliance` |
| `remit-corridor-fx` | `remit-corridor-fx-solana` | `solana-devnet` | `solana` | `USDC` | `REMIT_CORRIDOR_FX_PAYTO` | `PRICE_USDC` de `src/agents/corridor-fx.ts` (= 0.03) | `remittance-fx-quote`, `usdc-to-pen`, `corridor-pricing` |
| `remit-cashout-payout` | `remit-cashout-payout-solana` | `solana-devnet` | `solana` | `USDC` | `REMIT_CASHOUT_PAYOUT_PAYTO` | `PRICE_USDC` de `src/agents/cashout-payout.ts` (= 0.03) | `remittance-payout`, `cashout`, `value-delivery`, `fiat-disbursement` |

**`pathSlug ≠ slug` en FX y payout, y es deliberado.** El directorio de la ruta es el histórico
(`remit-corridor-fx`) porque el `agentUrl` ya registrado apunta ahí y **no se toca**; el `slug` que el
manifiesto declara es el canónico de cobro (`remit-corridor-fx-solana`). No "corrijas" esta asimetría.

`name` debe cumplir `name.toLowerCase().replace(/\s+/g,'-') === slug` (es la derivación real de slug
del registro). Con los valores de arriba se cumple con `name === slug`.

**`description` — textos exactos (estáticos, sin PII, no los reescribas):**

| pathSlug | description |
|---|---|
| `remit-kyc-validator` | `KYC/AML + Travel Rule screening para remesas. Respuestas sin PII.` |
| `remit-corridor-fx` | `Cotizacion de corredor USDC to PEN: tasa mid real + spread declarado.` |
| `remit-cashout-payout` | `Cash-out a Peru (Yape/Plin/CCI): value delivery del corredor de remesas.` |

**Env vars nuevas (sólo lectura, ninguna con default):** `REMIT_KYC_VALIDATOR_PAYTO`,
`REMIT_CORRIDOR_FX_PAYTO`, `REMIT_CASHOUT_PAYOUT_PAYTO`. **No las setees vos.** El código es
fail-closed sin ellas (503) y los tests usan fixtures vía `vi.stubEnv`.

---

## 6. Archivos a crear / modificar (nada fuera de esta tabla)

| # | Archivo | Acción | Qué hace |
|---|---|---|---|
| F1 | `src/manifest/types.ts` | **Crear** | Tipos del módulo: `PayTo` (branded), `ChainFamily`, `ManifestChain`, `AgentPaymentSpec`, `AgentManifest`, `ManifestEntry`, `PayToResolution`, `ManifestResult` |
| F2 | `src/manifest/wallet-format.ts` | **Crear** | Port **verbatim** del criterio del consumidor: `ADDRESS_RE`, `isValidEvmAddress`, `isValidSolanaAddress` (decode a 32 bytes), `isZeroAddress` |
| F3 | `src/manifest/wallet-format.test.ts` | **Crear** | Tests del port (incluye la base58 que la regex laxa dejaría pasar) |
| F4 | `src/manifest/registry.ts` | **Crear** | La tabla de §5 como constante estática. Importa `PRICE_USDC` de los 3 agentes (sólo lectura) |
| F5 | `src/manifest/registry.test.ts` | **Crear** | Invariantes de la tabla (slug↔name, chain en allowlist testnet, capabilities exactas, price === constante importada, sin duplicados) |
| F6 | `src/manifest/paytos.ts` | **Crear** | `resolvePayTo(entry)`: **única fábrica** de `PayTo`. Fail-closed, trim, typeof-narrowing, despacho por familia |
| F7 | `src/manifest/build.ts` | **Crear** | `buildManifest(pathSlug)`: arma el manifiesto o el resultado fail-closed. Nunca lanza |
| F8 | `src/manifest/build.test.ts` | **Crear** | Fail-closed: env ausente / `""` / `"   "` / formato inválido / zero-address / cross-family / pathSlug desconocido |
| F9 | `src/manifest/manifest.contract.test.ts` | **Crear** | Ancla del wire: set de 7 claves + `typeof` por campo, para los 3 manifiestos |
| F10 | `src/manifest/settle-preconditions.ts` | **Crear** | **Oráculo de test**: `evaluateSettle(payment)` + `readPaymentSpecAccepts(raw)`. Port de las guardas reales del gateway. **No lo importa nadie de `src/app/`** |
| F11 | `src/manifest/settle-preconditions.test.ts` | **Crear** | **Tests de dinero**: ¿cobraría o no cobraría cada agente? + auto-test del oráculo |
| F12 | `src/app/api/agents/remit-kyc-validator/manifest/route.ts` | **Crear** | `GET` → 200/503, `dynamic = "force-dynamic"`, `Cache-Control: no-store` |
| F13 | `src/app/api/agents/remit-corridor-fx/manifest/route.ts` | **Crear** | Ídem, `PATH_SLUG = "remit-corridor-fx"` |
| F14 | `src/app/api/agents/remit-cashout-payout/manifest/route.ts` | **Crear** | Ídem, `PATH_SLUG = "remit-cashout-payout"` |
| F15 | `src/app/api/agents/remit-kyc-validator/manifest/route.test.ts` | **Crear** | 200/503, `no-store`, `dynamic` exportado, sin I/O, sin eco de query |
| F16 | `src/app/api/agents/remit-corridor-fx/manifest/route.test.ts` | **Crear** | Ídem + `chain === "solana-devnet"`, `slug === "remit-corridor-fx-solana"` |
| F17 | `src/app/api/agents/remit-cashout-payout/manifest/route.test.ts` | **Crear** | Ídem + `chain === "solana-devnet"`, `slug === "remit-cashout-payout-solana"` |
| F18 | `README.md` | **Modificar** | Sección nueva "Manifiesto de cobro (`/manifest`)" al final del archivo. **Sólo agregar**, no reescribir secciones existentes |

**Ningún otro archivo se toca.** Ni `src/agents/**`, ni `src/providers/**`, ni `src/contracts/**`, ni
`src/app/api/agents/*/invoke/**`, ni `package.json`, ni `tsconfig.json`, ni `vitest.config.ts`, ni
`doc/sdd/_INDEX.md`.

---

## 7. Especificación por archivo (firmas exactas)

### F1 — `src/manifest/types.ts`

```ts
// Brand nominal: un `string` NO es asignable a `PayTo`. Sólo resolvePayTo() (F6) puede producir uno.
declare const payToBrand: unique symbol;
export type PayTo = string & { readonly [payToBrand]: "agent-pay-to" };

export type ChainFamily = "evm" | "solana";

/** Conjunto CERRADO. Mainnet no es representable: CD-3 por construcción, no por disciplina. */
export type ManifestChain = "avalanche-fuji" | "solana-devnet";

export interface AgentPaymentSpec {
  method: "x402";
  chain: ManifestChain;
  contract: PayTo;
  asset: "USDC";
}

export interface AgentManifest {
  manifestVersion: "1";
  slug: string;
  name: string;
  description: string;
  capabilities: readonly string[];
  priceUsdc: number;
  payment: AgentPaymentSpec;
}

export interface ManifestEntry {
  readonly pathSlug: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly capabilities: readonly string[];
  readonly chain: ManifestChain;
  readonly family: ChainFamily;
  readonly asset: "USDC";
  readonly payToEnv: string;
  readonly priceUsdc: number;
}

export type ManifestFailureReason = "missing" | "invalid_format" | "zero_address" | "unknown_agent";

export type PayToResolution =
  | { readonly ok: true; readonly payTo: PayTo }
  | { readonly ok: false; readonly reason: Exclude<ManifestFailureReason, "unknown_agent"> };

export type ManifestResult =
  | { readonly ok: true; readonly manifest: AgentManifest }
  | {
      readonly ok: false;
      readonly missing: readonly string[];
      readonly invalid: readonly string[];
      readonly reason: ManifestFailureReason;
    };
```

**Por qué el branded type:** `AgentPaymentSpec["contract"]` es `PayTo`. Un `string` cualquiera —un
literal nuevo, un `process.env.X ?? ""`— **no compila** en esa posición. El compilador, no la
revisión de código, garantiza que ninguna dirección llegue al manifiesto sin pasar por la validación.
El patrón ya existe en el repo: `TransFiBaseUrl` en `src/providers/transfi-env.ts:28-31`.

### F2 — `src/manifest/wallet-format.ts` (port **verbatim**, no lo "mejores")

Cabecera obligatoria del archivo, citando origen (anti-drift):

```
// Port VERBATIM del criterio de formato del consumidor real (repo `wasiai-a2a`):
//   `src/lib/wallet-format.ts:20` (ADDRESS_RE), `:46-71` (isValidSolanaAddress, decode a 32 bytes)
//   `src/lib/downstream-payment.ts:218-231` (zero-address → skip ZERO_PAY_TO)
// Si el manifiesto valida MÁS LAXO que el consumidor, el agente cobra $0 igual pero con un
// documento que dice que todo está bien. PROHIBIDO relajar este criterio (ver CD-9).
```

Contenido exacto a portear:

```ts
import type { ChainFamily } from "./types";

export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function isValidEvmAddress(w: string | null | undefined): w is `0x${string}` {
  return typeof w === "string" && ADDRESS_RE.test(w);
}

export function isZeroAddress(w: string): boolean {
  return w.toLowerCase() === "0x0000000000000000000000000000000000000000";
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const SOLANA_PUBKEY_BYTES = 32;

export function isValidSolanaAddress(w: string): boolean {
  if (typeof w !== "string" || w.length === 0) return false;
  const bytes: number[] = [];
  for (let i = 0; i < w.length; i++) {
    let carry = BASE58_ALPHABET.indexOf(w[i] as string);
    if (carry < 0) return false; // char fuera del charset base58
    for (let j = 0; j < bytes.length; j++) {
      carry += (bytes[j] as number) * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // Cada `1` inicial representa un byte cero de alto orden.
  for (let i = 0; i < w.length && w[i] === "1"; i++) bytes.push(0);
  return bytes.length === SOLANA_PUBKEY_BYTES;
}

export function isValidPayToForFamily(w: string, family: ChainFamily): boolean {
  return family === "solana" ? isValidSolanaAddress(w) : isValidEvmAddress(w);
}
```

> **PROHIBIDO** reusar `BASE58_ADDR_RE` de `src/providers/payout.ts:53` (`{32,44}` chars) como
> validador del `payTo`. Ese criterio es **más laxo** que el del consumidor: una base58 de 44 chars
> que decodifica a **33 bytes** pasa la regex y el settle la rechaza. `payout.ts` **no se toca**
> (cumple otro propósito, es el escape-hatch de deposit address).

### F4 — `src/manifest/registry.ts`

```ts
import { PRICE_USDC as KYC_PRICE_USDC } from "@/agents/kyc-validator";
import { PRICE_USDC as FX_PRICE_USDC } from "@/agents/corridor-fx";
import { PRICE_USDC as PAYOUT_PRICE_USDC } from "@/agents/cashout-payout";
import type { ManifestEntry } from "./types";

export const MANIFEST_ENTRIES: readonly ManifestEntry[] = Object.freeze([ /* §5, 3 entradas */ ]);

export function findEntry(pathSlug: string): ManifestEntry | undefined;
```

- Importar `PRICE_USDC` (lectura) **es lo correcto**: evita una segunda verdad del precio. No
  redeclares el número. Los módulos de agentes no hacen I/O al importarse (verificado).
- `findEntry` con `.find(...)`; con `noUncheckedIndexedAccess:true` no uses indexado crudo de arrays.

### F6 — `src/manifest/paytos.ts`

```ts
export function resolvePayTo(entry: ManifestEntry): PayToResolution;
```

Algoritmo, en este orden exacto:

1. `const rawUnknown: unknown = process.env[entry.payToEnv];`
   **Leer `process.env` EN TIEMPO DE LLAMADA, nunca en el scope del módulo** (si lo leés al importar,
   AC-7 se rompe y el manifiesto sirve un `payTo` congelado).
2. `const raw = typeof rawUnknown === "string" ? rawUnknown : "";`
   **PROHIBIDO `String(x ?? "")`**: `String(123)` es `"123"`, no `""` → fail-open. (Bug histórico
   real de este repo, WKH-204.)
3. `const value = raw.trim();` → si `value === ""` ⇒ `{ ok:false, reason:"missing" }`.
   **El trim va ANTES del check de vacío**: `"   "` es *ausente*, no un valor. (`min(1)` no trimea —
   otro bug histórico de este repo.)
4. `if (!isValidPayToForFamily(value, entry.family)) return { ok:false, reason:"invalid_format" };`
   Acá es donde muere el cruce de familias: una `0x…` en un slot `solana` falla `isValidSolanaAddress`
   (el `0`/`x` no están en el charset base58) y una base58 en un slot `evm` falla `ADDRESS_RE`.
5. `if (entry.family === "evm" && isZeroAddress(value)) return { ok:false, reason:"zero_address" };`
6. `return { ok: true, payTo: value as PayTo };` — **este es el ÚNICO `as PayTo` de todo el repo.**

**Nunca lanza. Nunca loguea el valor.**

### F7 — `src/manifest/build.ts`

```ts
export function buildManifest(pathSlug: string): ManifestResult;
```

1. `const entry = findEntry(pathSlug);`
   Si `undefined` ⇒ `{ ok:false, missing:["agent"], invalid:[], reason:"unknown_agent" }`.
   (No puede pasar hoy: las rutas son directorios estáticos y pasan un literal; existe para que la
   función sea total y nunca lance.)
2. `const resolved = resolvePayTo(entry);`
   - `reason === "missing"` ⇒ `{ ok:false, missing:["payment.contract"], invalid:[], reason:"missing" }`
   - `reason === "invalid_format"` ⇒ `{ ok:false, missing:[], invalid:["payment.contract"], reason:"invalid_format" }`
   - `reason === "zero_address"` ⇒ `{ ok:false, missing:[], invalid:["payment.contract"], reason:"zero_address" }`
3. Éxito ⇒ arma el `AgentManifest` con las 7 claves de §4, `payment` con las 4 claves, `contract` = el
   `PayTo` branded.

**Sin I/O de ningún tipo. Sin `async`. Sin `try/catch` que trague.** La única fuente de datos es
`registry.ts` + `process.env`.

### F10 — `src/manifest/settle-preconditions.ts` (oráculo de test)

Cabecera obligatoria:

```
// ORÁCULO DE TEST — NO es código de producción. PROHIBIDO importarlo desde `src/app/**`.
// Port de las guardas REALES que deciden si un leg downstream paga o se saltea, en `wasiai-a2a`:
//   `src/lib/downstream-payment.ts:506-514` (agent.payment ausente → NO_PAYMENT_FIELD)
//   `src/lib/downstream-payment.ts:518-528` (method !== 'x402' exacto → METHOD_NOT_SUPPORTED)
//   `src/lib/downstream-payment.ts:532-546` (chain no resuelta/no inicializada → CHAIN_NOT_SUPPORTED)
//   `src/lib/downstream-payment.ts:218-231` (EVM: formato → INVALID_PAY_TO_FORMAT; 0x0 → ZERO_PAY_TO)
//   `src/lib/downstream-payment.ts:255-262` (Solana: isValidSolanaAddress → INVALID_PAY_TO_FORMAT)
//   `src/lib/payment-spec-reader.ts:129-179` (qué specs sobreviven a la lectura)
// Existe para poder afirmar EFECTO ("este agente cobraría / no cobraría") sin cadena ni fondos.
```

```ts
export type SettleVerdict =
  | "WOULD_SETTLE"
  | "NO_PAYMENT_FIELD"
  | "METHOD_NOT_SUPPORTED"
  | "CHAIN_NOT_SUPPORTED"
  | "INVALID_PAY_TO_FORMAT"
  | "ZERO_PAY_TO";

/** Familias de las chains que el rail downstream conoce y este repo puede declarar. */
const ORACLE_CHAINS: Readonly<Record<string, ChainFamily>> = Object.freeze({
  "avalanche-fuji": "evm",
  "solana-devnet": "solana",
});

export function evaluateSettle(payment: unknown): SettleVerdict;
export function readPaymentSpecAccepts(raw: Record<string, unknown>): boolean;
```

`evaluateSettle`, en este orden exacto (el orden **es** el contrato: reproduce el del gateway):

1. `payment` ausente / no-objeto / `method` no-string / `chain` no-string / `contract` no-string
   ⇒ `"NO_PAYMENT_FIELD"` (el lector de specs devolvería `undefined` y el leg vería `agent.payment`
   ausente).
2. `method !== "x402"` (comparación **exacta**, sin trim ni lowercase — `"x402 "` con espacio falla)
   ⇒ `"METHOD_NOT_SUPPORTED"`.
3. `ORACLE_CHAINS[chain]` indefinido ⇒ `"CHAIN_NOT_SUPPORTED"`.
4. familia `evm`: `!isValidEvmAddress(contract)` ⇒ `"INVALID_PAY_TO_FORMAT"`;
   `isZeroAddress(contract)` ⇒ `"ZERO_PAY_TO"`.
5. familia `solana`: `!isValidSolanaAddress(contract)` ⇒ `"INVALID_PAY_TO_FORMAT"`.
6. ⇒ `"WOULD_SETTLE"`.

`readPaymentSpecAccepts(raw)`: `true` sólo si `raw.payment` es objeto, con `method` string (o
`protocol` string), `chain` string (o `raw.chain` string) **y** `contract` string, y la chain está en
`ORACLE_CHAINS`. Es el port del lector de specs del gateway; sirve para T9 (el `payment` del
manifiesto sobrevive a la lectura del consumidor).

### F12/F13/F14 — las 3 rutas (patrón idéntico, sólo cambia `PATH_SLUG`)

```ts
// src/app/api/agents/remit-kyc-validator/manifest/route.ts
import { NextRequest, NextResponse } from "next/server";
import { buildManifest } from "@/manifest/build";

// Next 14: sin esto el GET se evalúa en BUILD y sirve el payTo congelado del momento de compilar
// (rotar la env en Vercel no surtiría efecto). Es un fail-open silencioso — ver AC-7.
export const dynamic = "force-dynamic";

const PATH_SLUG = "remit-kyc-validator";
const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(_req: NextRequest) {
  try {
    const result = buildManifest(PATH_SLUG);
    if (!result.ok) {
      // value-free: nombre de campo + razón, NUNCA el valor de la env.
      console.warn("[manifest] not publishable:", {
        slug: PATH_SLUG,
        field: "payment.contract",
        reason: result.reason,
      });
      return NextResponse.json(
        { error: "manifest_unavailable", missing: result.missing, invalid: result.invalid },
        { status: 503, headers: NO_STORE },
      );
    }
    return NextResponse.json(result.manifest, { status: 200, headers: NO_STORE });
  } catch (err) {
    console.warn("[manifest] unexpected failure:", {
      slug: PATH_SLUG,
      errorName: err instanceof Error ? err.name : "unknown",
    });
    return NextResponse.json(
      { error: "manifest_unavailable", missing: [], invalid: [] },
      { status: 503, headers: NO_STORE },
    );
  }
}
```

- `_req` se recibe y **se ignora por completo**: PROHIBIDO leer query, headers, cookies o `Host`. Es
  lo que hace que AC-8 sea cierto por construcción.
- Nunca `500`. Nunca `err.message` ni stack en el log.
- Este patrón es el mismo wrapper fino de `src/app/api/agents/remit-kyc-validator/invoke/route.ts:9-31`
  (body de error fijo y opaco, `console.warn` sólo con `err.name`).

### F18 — `README.md` (sección nueva al final del archivo)

Debe contener, sí o sí:

1. Las 3 URLs de manifiesto y el shape de `200` y de `503` (copiar §4).
2. Las 3 env vars y que **no tienen default** (sin env ⇒ 503, a propósito).
3. La semántica fail-closed explicada en una línea: *"un 200 con ficha a medias es peor que un error,
   porque alguien lo copia a un registro y el agente termina cobrando $0 en silencio"*.
4. La tabla `pathSlug` → `slug` canónico → chain (§5), con la nota de que `pathSlug ≠ slug` en FX y
   payout es deliberado.
5. **El runbook operativo, con el orden numerado y esta advertencia literal:**
   1. Setear las 3 envs en Vercel (Production) y redeploy. Para las 2 de Solana: usar las **mismas**
      addresses que ya declaran las filas `*-solana` en el registro (leerlas de `/discover` antes de
      setear; no inventar una segunda verdad).
   2. Verificar los 3 manifiestos por `curl`: `200`, `payment.chain` correcto, `Cache-Control: no-store`.
      Con una env borrada a propósito, confirmar el `503` (prueba viva del fail-closed).
   3. Drift check sin escribir: comparar el `payment` del manifiesto contra el de `/discover` para los
      2 slugs `*-solana`. Si difieren, **no** se corrige a mano.
   4. Registrar/actualizar `remit-kyc-validator` con su `payment` (requiere la HU hermana del otro repo).
   5. **Deslistar los gemelos Fuji (`remit-corridor-fx`, `remit-cashout-payout`) SÓLO DESPUÉS de haber
      confirmado el paso 3.** Hacerlo antes deja a FX y payout sin ninguna ruta de cobro. El
      deslistado es reversible; quedarse sin ruta de cobro no es gratis.
6. Nota de que el registro/deslistado **no lo hace este repo**: es ops `!` humano en `wasiai-a2a`.

---

## 8. Tests requeridos — qué afirma cada uno, por AC

Framework: **Vitest** (`npm run test`, `vitest run`), `environment: node`, alias `@` → `src/`.
Patrón de test de ruta: importar el handler directo, construir `NextRequest`, `vi.stubEnv` en
`beforeEach` y `vi.unstubAllEnvs()` + `vi.unstubAllGlobals()` en `afterEach`
(exemplar: `src/app/api/agents/remit-cashout-payout/invoke/route.test.ts:1-49`).

### Fixtures obligatorios (verificados por el Architect — usá exactamente estos)

| Nombre | Valor | Propiedad verificada |
|---|---|---|
| `EVM_OK` | `0x1111111111111111111111111111111111111111` | 0x + 40 hex |
| `EVM_ZERO` | `0x0000000000000000000000000000000000000000` | zero-address |
| `EVM_SHORT` | `0x111111111111111111111111111111111111111` | 39 hex → inválida |
| `SOL_OK` | `Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr` | 44 chars, decodifica a **32 bytes** |
| `SOL_33B` | `zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz` (44 `z`) | 44 chars, decodifica a **33 bytes** → pasa la regex laxa, **debe rechazarse** |

> `SOL_OK` y `SOL_33B` son fixtures de **formato**, no wallets reales. No los uses en ningún runbook.

### Tabla de tests

| ID | Archivo | AC | Qué afirma exactamente | ¿Mide efecto de dinero? |
|---|---|---|---|---|
| T1 | F15 | AC-1 | Con `REMIT_KYC_VALIDATOR_PAYTO=EVM_OK`: `200`; `capabilities` `toEqual` el array exacto de 4; `payment` `toEqual` `{method:"x402",chain:"avalanche-fuji",contract:EVM_OK,asset:"USDC"}` | contrato |
| T2 | F11 | AC-1, AC-5 | `evaluateSettle(buildManifest("remit-kyc-validator").manifest.payment) === "WOULD_SETTLE"` sobre el payment **realmente emitido**. Nombre del test: *"remit-kyc-validator COBRARÍA (WOULD_SETTLE) con su payTo Fuji configurado"* | **SÍ** |
| T3 | F16, F17 | AC-2 | `200`; `payment.chain === "solana-devnet"`; `slug === "remit-corridor-fx-solana"` / `"remit-cashout-payout-solana"`; `name === slug` | contrato |
| T4 | F11 | AC-2, AC-5 | `evaluateSettle(...) === "WOULD_SETTLE"` para FX y payout con `SOL_OK`. Nombres: *"remit-corridor-fx-solana COBRARÍA…"*, *"remit-cashout-payout-solana COBRARÍA…"* | **SÍ** |
| T5 | F15, F16, F17 | AC-3 | Con la env sin stubear (ausente): `503`; `("payment" in body) === false`; `body.missing` incluye `"payment.contract"`; `body.invalid` es `[]`; `body.error === "manifest_unavailable"` | **SÍ** (nadie puede registrar un $0) |
| T6 | F8 | AC-3 | `""` y `"   "` producen **`missing`** (no `invalid`), y `ok === false`. Explícito: el whitespace-only es *ausente* | **SÍ** |
| T7 | F9 | AC-3, CD-5 | Para los 3 pathSlugs con envs válidas: `typeof body.payment.contract === "string" && body.payment.contract.length > 0`. Y con env ausente: el body **no** tiene la clave `payment` | **SÍ** |
| T8 | F15, F16, F17 | AC-4 | `vi.stubGlobal("fetch", () => { throw new Error("no-io-allowed") })` → los 3 `GET` siguen devolviendo `200`. Ninguna I/O saliente | **SÍ** |
| T9 | F11 | AC-5 | `readPaymentSpecAccepts({ payment: manifest.payment }) === true` para los 3 agentes: el `payment` emitido sobrevive a la lectura del consumidor y mapea 1:1 a `metadata.payment` | **SÍ** |
| T10 | F8 | AC-6 | `EVM_SHORT`, un valor sin `0x`, uno con char no-hex y uno con espacio interno (`"0x11 11…"`) ⇒ `invalid:["payment.contract"]`, sin manifiesto | **SÍ** |
| T11 | F8 + F11 | AC-6 | `EVM_ZERO` ⇒ `invalid` en `buildManifest`; **y** `evaluateSettle({...,contract:EVM_ZERO})` ⇒ `"ZERO_PAY_TO"`. Nombre: *"la zero-address no se publica: cobraría $0 (ZERO_PAY_TO) para siempre"* | **SÍ** |
| T12 | F3 + F8 | AC-6 | `isValidSolanaAddress(SOL_33B) === false` (aunque tenga 44 chars del charset) **y** `buildManifest("remit-corridor-fx")` con `SOL_33B` ⇒ `invalid`. Nombre: *"base58 de 44 chars que decodifica a 33 bytes: el settle la rechazaría, el manifiesto también"* | **SÍ** |
| T13 | F8 | AC-6 | **Cross-family, los dos sentidos**: `EVM_OK` en `REMIT_CORRIDOR_FX_PAYTO` (slot `solana-devnet`) ⇒ `invalid`; `SOL_OK` en `REMIT_KYC_VALIDATOR_PAYTO` (slot `avalanche-fuji`) ⇒ `invalid`. Nombre: *"payTo de la familia equivocada: el agente cobraría $0 (INVALID_PAY_TO_FORMAT) — se rechaza en origen"* | **SÍ** |
| T14 | F15, F16, F17 | AC-7 | (a) el módulo exporta `dynamic === "force-dynamic"`; (b) la respuesta lleva `cache-control: no-store` (200 **y** 503); (c) **dos `GET` con `vi.stubEnv` distintos dentro del mismo test devuelven `contract` distinto** (prueba que no hay lectura de env congelada ni caché) | **SÍ** |
| T15 | F15, F16, F17 | AC-8 | `GET` a `…/manifest?payTo=0xEVIL&debug=1` con headers arbitrarios (`x-forwarded-host`, `authorization`) devuelve **el mismo body** que sin query; y el body de 503 **no contiene** el valor de la env (probar con una env inválida distintiva, ej. `"0xDEADBEEF-not-an-address"`, y afirmar `expect(JSON.stringify(body)).not.toContain("DEADBEEF")`) | **SÍ** |
| T16 | F5 | AC-1, AC-2, CD-3 | Invariantes de la tabla: 3 entradas; `name.toLowerCase().replace(/\s+/g,"-") === slug`; `chain ∈ {"avalanche-fuji","solana-devnet"}` (**ninguna mainnet**); `family` coherente con `chain`; `priceUsdc === PRICE_USDC` importado del agente; `capabilities` `toEqual` los arrays exactos; sin `slug` ni `payToEnv` duplicados | contrato |
| T17 | F11 | AC-5 | **Auto-test del oráculo** (valida el instrumento): `undefined` ⇒ `NO_PAYMENT_FIELD`; `{method:"x402 ",…}` ⇒ `METHOD_NOT_SUPPORTED`; `{chain:"polygon",…}` ⇒ `CHAIN_NOT_SUPPORTED`; `contract:""` (evm) ⇒ `INVALID_PAY_TO_FORMAT`; `contract:EVM_ZERO` ⇒ `ZERO_PAY_TO`; caso completo válido ⇒ `WOULD_SETTLE` | **SÍ** |
| T18 | F9 | AC-1..AC-3 | Ancla del wire: `Object.keys(body).sort()` `toEqual` las 7 claves exactas y `typeof` por campo, para los 3 manifiestos; `Object.keys(body.payment).sort()` `toEqual` `["asset","chain","contract","method"]` | contrato |
| T19 | F8 | fail-closed total | `buildManifest("no-existe")` ⇒ `{ok:false, reason:"unknown_agent"}` y **no lanza** | **SÍ** |

**Criterio test-first:** lógica de validación (F2, F6, F7) y rutas HTTP (F12-F14) ⇒ **test primero**.
El README (F18) no lleva test.

**Cómo se lee un rojo:** el nombre de cada test de dinero tiene que decir el efecto. `expect(verdict).toBe("WOULD_SETTLE")` fallando con
`Expected "WOULD_SETTLE", received "INVALID_PAY_TO_FORMAT"` en un test llamado *"remit-corridor-fx-solana
COBRARÍA…"* se lee, sin abrir el código: **este agente cobraría cero, y por qué**.

---

## 9. Waves

### Wave -1 — Environment Gate (OBLIGATORIO, antes de tocar código)

```bash
cd /home/ferdev/.openclaw/workspace/wasiai-remittance-agents
git checkout -b feat/010-wkh-300-agent-payment-manifest
npm install
npm run typecheck                 # debe pasar en limpio ANTES de empezar
npx vitest run --reporter=basic   # anotá el número exacto: es tu baseline
ls src/agents/kyc-validator.ts src/agents/corridor-fx.ts src/agents/cashout-payout.ts \
   src/providers/transfi-env.ts src/app/api/agents/remit-kyc-validator/invoke/route.ts
```

**Baseline medido por el Architect el 2026-07-28: `12 test files, 245 tests passed`.**
(El SDD menciona 224: es un número viejo. Vale el que medís vos en Wave -1; anotalo en el report.)
Si Wave -1 falla, **PARÁ** y reportá. No se implementa sobre un entorno roto.

### Wave 0 — Serial gate: tipos y criterio de formato

Nada empieza antes de que W0 esté verde: todo lo demás consume estos tipos, y el branded type sólo
funciona si existe primero.

- [ ] **W0.1** — F1 `src/manifest/types.ts`
- [ ] **W0.2** — F2 `src/manifest/wallet-format.ts` (port verbatim + cabecera de origen)
- [ ] **W0.3** — F3 `src/manifest/wallet-format.test.ts` (incluye T12 parte a)
- [ ] **Gate W0**: `npm run typecheck` **completo** + `npm run test` verdes

### Wave 1 — Núcleo declarativo (depende de W0; W1.1 → W1.2 es secuencial)

- [ ] **W1.1** — F4 `registry.ts` + F5 `registry.test.ts` (T16)
- [ ] **W1.2** — F6 `paytos.ts` + F7 `build.ts` + F8 `build.test.ts` (T6, T10, T11a, T12b, T13, T19)
- [ ] **Gate W1**: typecheck + test verdes **+ mutation self-checks M1, M2, M3, M4** (§10)

`resolvePayTo` **es** la fábrica del branded type: sin W1.2 nada puede construir un `AgentPaymentSpec`.

### Wave 2 — Superficie HTTP (depende de W1; W2.1/W2.2/W2.3 son paralelizables entre sí)

- [ ] **W2.1** — F12 + F15 (`remit-kyc-validator`): T1, T5, T8, T14, T15
- [ ] **W2.2** — F13 + F16 (`remit-corridor-fx`): T3, T5, T8, T14, T15
- [ ] **W2.3** — F14 + F17 (`remit-cashout-payout`): T3, T5, T8, T14, T15
- [ ] **Gate W2**: typecheck + test **+ M5 + `npm run build`** (confirma que las 3 rutas compilan como
      dinámicas; si `build` las marca como estáticas, AC-7 está roto → PARÁ)

### Wave 3 — Efecto y documentación (depende de W2)

- [ ] **W3.1** — F10 `settle-preconditions.ts` + F11 `settle-preconditions.test.ts`: **los tests de
      dinero** (T2, T4, T9, T11b, T17)
- [ ] **W3.2** — F9 `manifest.contract.test.ts`: ancla del wire (T7, T18)
- [ ] **W3.3** — F18 `README.md` (con el runbook y el **orden del deslistado**, §7-F18 punto 5)
- [ ] **Gate W3**: `npm run typecheck` + `npm run test` completos; **los 245 tests base siguen verdes**
      (cero regresión); **M6 + M7**; y el smoke manual de §9.1

### 9.1 — Smoke manual de W3 (obligatorio, dejá el output en el report)

```bash
# 3 manifiestos publicables (fixtures de FORMATO, no wallets reales)
REMIT_KYC_VALIDATOR_PAYTO=0x1111111111111111111111111111111111111111 \
REMIT_CORRIDOR_FX_PAYTO=Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr \
REMIT_CASHOUT_PAYOUT_PAYTO=Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr \
npm run dev &
curl -sD- http://localhost:3030/api/agents/remit-kyc-validator/manifest
curl -sD- http://localhost:3030/api/agents/remit-corridor-fx/manifest
curl -sD- http://localhost:3030/api/agents/remit-cashout-payout/manifest
# → 200 + Cache-Control: no-store + payment completo

# y sin envs: los 3 en 503, sin clave `payment` en el body
npm run dev &
curl -s http://localhost:3030/api/agents/remit-kyc-validator/manifest
```

### Verificación incremental

| Wave | Verificación al completar |
|---|---|
| W-1 | typecheck + suite base verdes; baseline anotado |
| W0 | `npm run typecheck` + `npm run test` |
| W1 | idem + M1-M4 muertos |
| W2 | idem + M5 muerto + `npm run build` OK |
| W3 | suite completa sin regresión + M6-M7 muertos + smoke manual §9.1 |

> **`npm run typecheck` COMPLETO en cada wave, no sólo `npm run test`.** Los `*.test.ts` sí se
> typechequean (`tsconfig.json` incluye `**/*.ts`) y `npm run build` **no** los cubre. Bug histórico
> real de este repo. Con `noUncheckedIndexedAccess:true`, `mock.calls[0]` es `T | undefined`: usá
> `mock.calls[0]!` o un guard.

---

## 10. Mutation self-checks (OBLIGATORIO — probalos uno por uno)

Cada mutante se aplica sobre una **copia de respaldo**, se corre la suite, y se restaura. **Todos
deben MORIR** (la suite se pone roja). Si alguno **sobrevive**, falta un test: escribilo antes de
cerrar la wave. Dejá la tabla de resultados en el report de F3.

**Procedimiento (respaldo con `cp`, nunca `git checkout`):**

```bash
SCRATCH=/tmp/claude-1000/-home-ferdev--openclaw-workspace-wasiai-a2a/09093fcc-fffd-496d-96e4-bed79f905a62/scratchpad
mkdir -p "$SCRATCH/mut"
cp src/manifest/wallet-format.ts "$SCRATCH/mut/wallet-format.ts.bak"   # respaldo ANTES de mutar
# ...aplicar el mutante con Edit, correr `npx vitest run`, anotar rojo/verde...
cp "$SCRATCH/mut/wallet-format.ts.bak" src/manifest/wallet-format.ts   # restaurar
npx vitest run   # confirmar que volvió a verde antes del siguiente mutante
```

> **PROHIBIDO `git checkout <archivo>`** para restaurar: en este repo ya borró trabajo sin commitear.
> Restaurá siempre desde la copia del scratchpad.

| ID | Archivo | Mutación exacta a aplicar | Debe morir por | Qué probaría si sobrevive |
|---|---|---|---|---|
| **M1** | F2 `wallet-format.ts` | Reemplazar el cuerpo de `isValidSolanaAddress` por `return /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{32,44}$/.test(w);` (el criterio laxo que ya vive en `payout.ts`) | **T12** | Que el manifiesto validaría más laxo que el settle: publicaría una address que el gateway rechaza ⇒ agente en $0 con ficha "OK" |
| **M2** | F6 `paytos.ts` | Borrar el `.trim()`: `const value = raw;` | **T6** | Que `"   "` pasaría como valor ⇒ 200 con un `contract` de whitespace |
| **M3** | F6 `paytos.ts` | Cambiar `typeof rawUnknown === "string" ? rawUnknown : ""` por `String(rawUnknown ?? "")` | **T6 / T10** | El fail-open clásico: un no-string se convierte en un string plausible en vez de vaciarse |
| **M4** | F6 `paytos.ts` | Borrar la rama `isZeroAddress(...)` completa | **T11** | Que la zero-address se publicaría ⇒ el leg corta con `ZERO_PAY_TO` y el agente cobra $0 para siempre |
| **M5** | F12 (una de las 3 rutas) | Borrar `export const dynamic = "force-dynamic";` | **T14** | Que el `payTo` quedaría congelado en build: rotar la env en Vercel no cambiaría nada |
| **M6** | F6 `paytos.ts` | Invertir el despacho por familia: `family === "solana" ? isValidEvmAddress(value) : isValidSolanaAddress(value)` | **T13** | Que el cruce de familias pasaría: una EVM publicada como payTo de Solana (y viceversa) ⇒ `INVALID_PAY_TO_FORMAT` en el settle |
| **M7** | F12 (una ruta) | En la rama de error, devolver `NextResponse.json({ error:"manifest_unavailable", payment: { method:"x402", chain:"avalanche-fuji", contract:"", asset:"USDC" } }, { status: 200, headers: NO_STORE })` | **T5 + T7** | El bug exacto que la HU viene a matar: una ficha a medias con `200`, lista para que alguien la copie |

**Regla de lectura:** si un mutante sobrevive, el problema **no es el mutante** — es que ningún test
inyecta el valor raro que lo distingue. Agregá ese test.

---

## 11. Out of Scope (no lo toques, bajo ninguna circunstancia)

- `src/agents/**`, `src/providers/**`, `src/contracts/**` — ni código ni tests. La lógica de negocio
  de los 3 agentes **no cambia**: esta HU es puramente declarativa. Importar `PRICE_USDC` es lectura y
  **sí** está permitido.
- `src/app/api/agents/*/invoke/**` — ni código ni tests.
- `package.json` — **PROHIBIDO agregar dependencias**. No hay `@solana/web3.js` ni `viem` en el repo y
  no se agregan: los validadores son puros y propios.
- `tsconfig.json`, `vitest.config.ts`, `next.config.mjs`.
- `doc/sdd/_INDEX.md` — **no lo toques** (lo actualiza `nexus-docs` en el cierre).
- El repo `wasiai-a2a`: el write-path (`POST`/`PATCH /agents` aceptando `payment`), el gate de rechazo
  al registrar, y cualquier cambio en el lector de specs o el settle. **Es HU hermana en ese repo.**
- Supabase / cualquier escritura en `a2a_agents`: registrar, actualizar o deslistar filas es **ops `!`
  humano**, nunca código de esta HU. **PROHIBIDO ejecutar acciones con credenciales reales.**
- Setear las 3 envs de `payTo` en Vercel o en cualquier entorno: es acción del operador.
- Activar Solana en prod (`SOLANA_ADAPTER_ENABLED`, `WASIAI_DOWNSTREAM_X402`): config founder-gated.
- Mainnet, en cualquier eje.
- El `payoutWallet`/`payoutChain` del creator-split (1%): es un campo **distinto** de `payment`, el
  consumidor ni siquiera persiste `payoutChain`. El manifiesto **no lo declara** y **no lo deriva** de
  `payment`.
- Un índice global de manifiestos (`/.well-known/agent.json`): descartado a propósito. Este deploy
  sirve 3 agentes con 2 cadenas distintas; un manifiesto por origen obligaría a elegir una cadena para
  todo el deploy. **1 URL = 1 agente = 1 cadena.**
- Git destructivo (`reset --hard`, `checkout` de archivos no commiteados, `push --force`). Repo
  público. **Sin `Co-Authored-By` en los commits.**
- No "mejorar" código adyacente. No agregar funcionalidad no listada.

---

## 12. Escalation Rule

**Si algo no está en este Story File, PARÁ y preguntá al Architect.** No inventes, no asumas, no
improvises. El Architect resuelve y actualiza este documento antes de que sigas.

Escalá si:
- Un archivo exemplar citado no existe o cambió (`src/providers/transfi-env.ts`,
  `src/app/api/agents/remit-kyc-validator/invoke/route.ts`, `src/contracts/contracts.provider.test.ts`).
- `PRICE_USDC` o `SLUG` de algún agente no coincide con §5.
- El baseline de Wave -1 no da verde, o da un número muy distinto de 245.
- `npm run build` marca alguna ruta de manifiesto como estática pese a `force-dynamic`.
- Un mutante de §10 **sobrevive** y no ves qué test lo mataría.
- Necesitás tocar un archivo fuera de la tabla de §6.
- Encontrás ambigüedad en un AC.

---

## 13. Done Definition

- [ ] Los 18 archivos de §6 creados/modificados, y **ningún otro** (verificá con `git status`).
- [ ] `npm run typecheck` verde (completo, incluye `*.test.ts`).
- [ ] `npm run test` verde: los **245** tests base sin regresión **+** los tests nuevos T1-T19.
- [ ] `npm run build` verde, con las 3 rutas de manifiesto compiladas como dinámicas.
- [ ] Los **7 mutantes** de §10 probados uno por uno, **todos muertos**, con la tabla de resultados en
      el report de F3 (mutante → test que lo mató).
- [ ] Smoke manual de §9.1 ejecutado, con el output pegado en el report (3× `200` con envs, 3× `503`
      sin envs).
- [ ] `README.md` documenta el manifiesto, las 3 envs, la semántica fail-closed y el runbook **con el
      deslistado de los gemelos Fuji explícitamente DESPUÉS del drift check**.
- [ ] Cero valores de env ecoados en bodies HTTP o logs (grepeá tus propios `console.warn`).
- [ ] Cero mainnet en cualquier valor de `chain` (T16 lo ancla).
- [ ] Ningún archivo tocado fuera de este repo. Ninguna escritura en Supabase. Ningún commit con
      `Co-Authored-By`.

---

*Story File generado por NexusAgil — F2.5 (Architect)*
