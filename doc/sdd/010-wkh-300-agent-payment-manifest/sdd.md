# SDD #010: [WKH-300] Los 3 agentes remit-* declaran su forma de cobro en su propio manifiesto

> SPEC_APPROVED: no
> Fecha: 2026-07-28
> Tipo: feature
> SDD_MODE: full
> Branch: `feat/010-wkh-300-agent-payment-manifest`
> Artefactos: `doc/sdd/010-wkh-300-agent-payment-manifest/`
> Repo: `wasiai-remittance-agents` (HU hermana obligatoria en `wasiai-a2a`, ver §8)

---

## 1. Resumen

Hoy `remit-kyc-validator` corre en producción **cobrando $0**: el caller le paga al gateway, el paso
se ejecuta, y el settle downstream hacia el operador se saltea **en silencio** con
`NO_PAYMENT_FIELD` (`wasiai-a2a/src/lib/downstream-payment.ts:506-514`) porque su fila en
`a2a_agents` nunca declaró `metadata.payment`. Los dos agentes que **sí** cobran tienen ese dato
porque alguien lo escribió a mano en Supabase, **por fuera de toda API**: el `POST /agents` del
gateway no acepta un campo `payment` en absoluto (`wasiai-a2a/src/routes/agents.ts:230-261` arma el
input sin él; `wasiai-a2a/src/services/agent.ts:177-189` sólo mergea `inputSchema`/`outputSchema`/
`discoverable`).

Esta HU construye la mitad de ese problema que le corresponde a este repo: **cada agente publica su
propia ficha de cobro** en un manifiesto HTTP servido desde su propio endpoint, y esa ficha es
**fail-closed** — si el `payTo` no está configurado, o está mal formado, el manifiesto **no se
emite** (503), en vez de emitir una ficha a medias que termine en una fila que cobra $0 sin que
nadie se entere. El agente pasa a ser la fuente de verdad de lo que cobra, y el dato deja de
tipearse a mano.

La otra mitad (que el registro **rechace** a un agente sin ficha) es código de `wasiai-a2a` y se
despacha como HU hermana en ese repo; §8 le deja el contrato exacto que tiene que aceptar, incluido
el control que cierra `AR-4` de WKH-241 (nadie puede redirigir el fee de un agente a una wallet que
no controla).

**Arquitectura objetivo (decisión del founder, ya tomada — cierra el bloqueante Missing Input #1 del
work-item):**

| Agente (slug canónico de cobro) | Endpoint HTTP (ya deployado) | Chain de cobro |
|---|---|---|
| `remit-kyc-validator` | `/api/agents/remit-kyc-validator/invoke` | `avalanche-fuji` |
| `remit-corridor-fx-solana` | `/api/agents/remit-corridor-fx/invoke` | `solana-devnet` |
| `remit-cashout-payout-solana` | `/api/agents/remit-cashout-payout/invoke` | `solana-devnet` |

Los gemelos Fuji (`remit-corridor-fx`, `remit-cashout-payout`, WKH-171/172) **se deslistan** — es una
acción operativa en `wasiai-a2a`, gated `!` humano, **no** código de esta HU (ver §6 OUT y §9-R1).
Con eso, cada URL sirve **un** agente y declara **una** cadena: la tensión del hallazgo #5 del
work-item desaparece por construcción.

---

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 010 (WKH-300) |
| **Tipo** | feature |
| **SDD_MODE** | full |
| **Objetivo** | Que cada agente `remit-*` publique, desde su propio endpoint, la ficha de cobro (`capabilities` + `payment{method,chain,contract,asset}`) que el registro debe persistir — y que sea imposible publicar una ficha incompleta. |
| **Reglas de negocio** | Ningún agente trabaja gratis. Una ficha ausente o inválida es un **error visible** (503), nunca un default silencioso. Devnet/testnet-only. Cero plata real movida por esta HU. |
| **Scope IN** | §6 IN |
| **Scope OUT** | §6 OUT |
| **Missing Inputs** | §9 — 0 bloqueantes de implementación; 2 inputs operativos `!` humano que **no** bloquean F3 (el código es fail-closed sin ellos). |

### Acceptance Criteria (EARS)

Los AC-1..AC-6 son los del work-item, con **AC-2 resuelto** (ya no tiene `[NEEDS CLARIFICATION]`).
AC-7 y AC-8 son **nuevos de F2** (riesgos detectados en el grounding: caché de Next y I/O oculto).

- **AC-1** — WHEN se hace `GET` al manifiesto de `remit-kyc-validator`, THE system SHALL responder
  `200` con `capabilities = ["kyc-verification","aml-screening","travel-rule","remittance-compliance"]`
  (idéntico al registro original de WKH-170, `wasiai-a2a/doc/sdd/169-wkh-170-remit-kyc-validator/done-report.md:190`)
  y `payment = { method:"x402", chain:"avalanche-fuji", contract:<payTo EVM del operador>, asset:"USDC" }`,
  en el mismo shape `AgentPaymentSpec` que consume `readPaymentSpec()`
  (`wasiai-a2a/src/types/index.ts:163-171`).

- **AC-2** — WHEN se hace `GET` al manifiesto de los endpoints de FX y payout, THE system SHALL
  responder `200` con `payment.chain = "solana-devnet"` y `slug` = `remit-corridor-fx-solana` /
  `remit-cashout-payout-solana` respectivamente (los slugs canónicos de cobro; los gemelos Fuji se
  deslistan como acción operativa, fuera del código — DT-5).

- **AC-3** — IF el `payTo` de un agente no está configurado (env ausente, vacía o sólo whitespace),
  THEN THE system SHALL responder `503 { error:"manifest_unavailable", missing:["payment.contract"] }`
  **sin** ninguna clave `payment` en el body — nunca un `200` con ficha a medias que alguien pueda
  copiar a un registro y terminar cobrando $0.

- **AC-4** — WHILE esta HU se implementa y despliega, THE system SHALL no producir ninguna escritura
  sobre `a2a_agents` ni ninguna otra fuente externa: el path del manifiesto no hace **ninguna** I/O
  saliente (verificable ejecutando con `fetch` stubbeado a `throw`).

- **AC-5** — WHEN el operador registra/actualiza un agente con los valores tomados del manifiesto,
  THE system SHALL producir un `metadata.payment` que (a) `readPaymentSpec()` acepta
  (`wasiai-a2a/src/lib/payment-spec-reader.ts:129-179`) y (b) **no** dispara ninguno de los
  skip-codes del leg downstream (`NO_PAYMENT_FIELD`, `METHOD_NOT_SUPPORTED`, `CHAIN_NOT_SUPPORTED`,
  `INVALID_PAY_TO_FORMAT`, `ZERO_PAY_TO`). Verificable en este repo con el oráculo de
  pre-condiciones de settle (DT-13) y, e2e, con el runbook de §10.

- **AC-6** — IF el `payTo` configurado no tiene el formato válido de la familia de su chain (EVM:
  `0x` + 40 hex y distinto de la zero-address; Solana: base58 que decodifica a **exactamente 32
  bytes**), THEN THE system SHALL responder `503 { error:"manifest_unavailable", invalid:["payment.contract"] }`
  **sin** emitir el manifiesto y **sin** ecoar el valor recibido.

- **AC-7** (nuevo F2) — WHEN cambia el valor de la env del `payTo` en el entorno de ejecución, THE
  system SHALL reflejarlo en la siguiente respuesta del manifiesto (sin rebuild y sin caché): la ruta
  es dinámica y responde `Cache-Control: no-store`.

- **AC-8** (nuevo F2) — WHILE se sirve el manifiesto, THE system SHALL no exponer ningún valor de
  configuración distinto del `payTo` declarado, ni ecoar parámetros de query, ni variar su salida
  según headers del caller.

---

## 3. Context Map (Codebase Grounding)

### 3.1 Archivos leídos — repo de esta HU (`wasiai-remittance-agents`)

| Archivo | Por qué | Patrón extraído |
|---|---|---|
| `project-context.md` | Fuente de verdad del stack | Next 14 App Router + TS strict (`noUncheckedIndexedAccess:true`, `tsconfig.json:7-8`), Zod, Vitest, **sin DB** en el repo, deploy Vercel |
| `package.json` | Verificar deps disponibles | Sólo `next`/`react`/`zod`. **No hay** `@solana/web3.js`, `viem`, ni ninguna lib de addresses → todo validador debe ser puro y propio |
| `src/app/api/agents/remit-kyc-validator/invoke/route.ts:9-31` | Exemplar de route handler | Wrapper fino, body de error **fijo y opaco**, `console.warn` sólo con `err.name`, nunca 500 |
| `src/app/api/agents/remit-cashout-payout/invoke/route.test.ts:1-60` | Exemplar de test de ruta | Importa el handler directo, construye `NextRequest`, `vi.stubEnv` + `afterEach(vi.unstubAllEnvs/Globals)` |
| `src/providers/transfi-env.ts:26-140` | Exemplar de resolver fail-closed de config money-path | **Tipo branded** (`TransFiBaseUrl`) que sólo la función validadora puede producir → un literal suelto **no compila**; fail-closed sin default; errores con código estable (`transfi_env_unset`) |
| `src/providers/payout.ts:50-70` | Ver el validador base58 que ya existe | `BASE58_ADDR_RE` = charset + **longitud 32-44 chars**. Es **más laxo** que el consumidor real (que exige decode a 32 bytes) ⇒ **no** se reusa para el payTo (CD-9) |
| `src/agents/kyc-validator.ts:13-14`, `corridor-fx.ts:10-11`, `cashout-payout.ts:15-16` | Origen de `SLUG` y `PRICE_USDC` | `remit-kyc-validator` 0.02 · `remit-corridor-fx` 0.03 · `remit-cashout-payout` 0.03. El manifiesto los **importa** (no los duplica) |
| `src/contracts/contracts.provider.test.ts:21-27` | Exemplar de contract-test | `assertSameShape` (set de keys + `typeof` por campo) ancla un contrato serializado |
| `doc/sdd/002/auto-blindaje.md`, `003/auto-blindaje.md`, `004/auto-blindaje.md` | Auto-Blindaje histórico (§3.4) | 3 patrones recurrentes → CD-7/CD-8/CD-14/CD-15/CD-16 |

### 3.2 Archivos leídos — repo consumidor (`wasiai-a2a`, sólo lectura)

| Archivo:línea | Por qué | Hallazgo que condiciona el diseño |
|---|---|---|
| `src/lib/downstream-payment.ts:506-514` | La causa raíz del $0 | `if (!agent.payment) → code:'NO_PAYMENT_FIELD'` y `return null` (skip silencioso para el operador del agente) |
| `src/lib/downstream-payment.ts:518-528` | Segundo filtro | `payment.method !== 'x402'` → `METHOD_NOT_SUPPORTED`. El método es **literal exacto**, no case-insensitive |
| `src/lib/downstream-payment.ts:532-546` | Tercer filtro | `normalizeChainSlug(chain)` + `getAdaptersBundle(chainKey)`; slug desconocido o rail no inicializado → `CHAIN_NOT_SUPPORTED` |
| `src/lib/downstream-payment.ts:218-231` | Formato EVM en settle | `validatePayTo`: `isValidWallet` + rechazo explícito de la zero-address (`ZERO_PAY_TO`) |
| `src/lib/downstream-payment.ts:255-262` | Formato Solana en settle | `isValidSolanaAddress(payTo)` → `INVALID_PAY_TO_FORMAT` |
| `src/lib/wallet-format.ts:20,34-38,46-71,79-81` | El criterio real de formato | EVM `^0x[0-9a-fA-F]{40}$`; Solana: decode base-58 y **`bytes.length === 32`** (no una regex de longitud) |
| `src/lib/payment-spec-reader.ts:129-179` | Único productor de `Agent.payment` | Exige `method` string + `chain` string conocida por el resolver + `contract` **string**; `asset` opcional pass-through. **No** valida formato de `contract` (WKH-241 DT-3) |
| `src/adapters/chain-resolver.ts:20-68` | Alias válidos | `'avalanche-fuji'` (:25) y `'solana-devnet'` (:65) son alias canónicos y **pasan tal cual** por `readPaymentSpec` (sólo `'avalanche-testnet'` colapsa) |
| `src/routes/agents.ts:114-268` | Write-path actual | Valida `name`/`agentUrl`/`capabilities` (400), `priceUsdc` (422), `payoutWallet` (422), `referrerRef` (422). **`payment` no existe** en ninguna rama |
| `src/services/agent.ts:177-189` | `buildMetadata()` | Sólo `inputSchema`/`outputSchema`/`discoverable` → confirma que **no hay** camino de escritura para `metadata.payment` |
| `src/services/agent.ts:380` | Derivación del slug | `input.name.toLowerCase().replace(/\s+/g,'-')` — el `name` del manifiesto debe derivar exactamente al `slug` declarado |
| `src/services/agent.ts:125-149` | Lectura | `mapRowToAgent` → `payment: readPaymentSpec(metadata)` (WKH-241, ya mergeado: **no se toca**) |
| `src/types/index.ts:163-171 / 191-218 / 224-239` | Tipos del contrato | `AgentPaymentSpec`; `PublishAgentInput`/`UpdateAgentInput` (sin `payment`) → el delta exacto de la HU hermana |

### 3.3 Exemplars verificados

| Para crear | Seguir patrón de (verificado, existe) | Qué se copia |
|---|---|---|
| `src/app/api/agents/*/manifest/route.ts` | `src/app/api/agents/remit-kyc-validator/invoke/route.ts` | Wrapper fino, body de error fijo, warn value-free, nunca 500 |
| `src/app/api/agents/*/manifest/route.test.ts` | `src/app/api/agents/remit-cashout-payout/invoke/route.test.ts` | Import directo del handler, `NextRequest`, `stubEnv`/`unstubAllEnvs` |
| `src/manifest/paytos.ts` (resolver fail-closed) | `src/providers/transfi-env.ts:26-31,53-81` | Tipo **branded** + fail-closed + códigos de error estables |
| `src/manifest/wallet-format.ts` | `wasiai-a2a/src/lib/wallet-format.ts:20,46-71` | Port **verbatim** del criterio del consumidor (32 bytes) |
| `src/manifest/manifest.contract.test.ts` | `src/contracts/contracts.provider.test.ts:21-27` | `assertSameShape` para anclar el wire |
| `src/manifest/registry.ts` | `src/agents/kyc-validator.ts:13-14` (constantes exportadas) | Declaración estática, sin lógica |

### 3.4 Auto-Blindaje histórico aplicado (últimas 3 HUs DONE)

| Patrón recurrente | Evidencia | Se previene con |
|---|---|---|
| *"Un valor ausente o de tipo inesperado se lee como señal positiva"* — **4 ocurrencias** (WKH-198 `NaN`, WKH-202, WKH-203 `approved` no-booleano, WKH-204 `String(v ?? "")`) | `doc/sdd/002-.../auto-blindaje.md` §Wave 1; `project-context.md` §PROHIBIDO | **CD-7** (typeof-narrowing, prohibido `String(x ?? "")`) |
| `z.string().min(1)` / checks de vacío **no trimean** → `"   "` atraviesa | `doc/sdd/002-.../auto-blindaje.md` §Wave 1 (3ª entrada) | **CD-8** (trim antes del check; `"   "` == ausente) |
| Mutantes de comparaciones estrictas **sobreviven** si ningún test inyecta el valor raro | `project-context.md` Auto-Blindaje 2026-07-15 (12/12 mutantes) | **CD-16** (mutation self-check obligatorio de los validadores, lista en §7.3) |
| `npm run build`/`test` verde **no** implica typecheck verde (los `*.test.ts` sí se typechequean) | `doc/sdd/003-.../auto-blindaje.md` §W2 (2ª entrada) | **CD-14** (`npm run typecheck` completo por wave; `mock.calls[0]!`) |
| `git checkout <file>` durante un mutation self-check **borró** trabajo sin commitear | `doc/sdd/003-.../auto-blindaje.md` §W2 (1ª entrada) | **CD-15** (respaldo con `cp` al scratchpad, nunca `git checkout`) |
| Un cambio de wire rompe aserciones `Object.keys(...).toEqual([...])` no listadas en Scope IN | `doc/sdd/004-.../auto-blindaje.md` §Wave 2 | §6 IN lista **todos** los archivos de test; el wire nuevo se ancla en `manifest.contract.test.ts` |

### 3.5 Estado de BD relevante

| Tabla | Existe | Dónde | Esta HU escribe |
|---|---|---|---|
| `a2a_agents` | Sí (Supabase de `wasiai-a2a`) | Otro repo, otro servicio | **NO** — este repo no tiene cliente de DB ni credenciales (`project-context.md` §Stack: "Base de datos: NINGUNA"). AC-4 se cumple por construcción |

### 3.6 Componentes reutilizables encontrados

- `SLUG` / `PRICE_USDC` de los 3 agentes → se **importan** (no se re-declaran). Import de sólo-lectura: no viola CD-1.
- `assertSameShape` (`src/contracts/contracts.provider.test.ts:21-27`) → se replica el patrón (helper local en el test nuevo; **no** se modifica ese archivo).
- `isValidSolanaAddress`/`isValidWallet` de `wasiai-a2a` → **no se pueden importar** (repos separados, sin paquete compartido) ⇒ port verbatim con nota de origen (DT-9, R-3).

---

## 4. Diseño Técnico

### 4.1 Archivos a crear / modificar

| # | Archivo | Acción | Qué hace | Exemplar |
|---|---|---|---|---|
| F1 | `src/manifest/types.ts` | Crear | `AgentPaymentSpec`, `AgentManifest`, tipo **branded** `PayTo`, unión `ManifestResult` | `src/providers/transfi-env.ts:26-31` · `wasiai-a2a/src/types/index.ts:163-171` |
| F2 | `src/manifest/wallet-format.ts` | Crear | Port verbatim de `isValidEvmAddress` + `isValidSolanaAddress` (32 bytes) + `isZeroAddress` | `wasiai-a2a/src/lib/wallet-format.ts:20,46-71` |
| F3 | `src/manifest/wallet-format.test.ts` | Crear | Tests del port (incluye el caso que la regex laxa dejaría pasar) | `src/providers/didit-env.test.ts` (estilo) |
| F4 | `src/manifest/registry.ts` | Crear | Declaración estática de los 3 agentes: `slug`, `name`, `description`, `capabilities`, `chain`, `asset`, `payToEnv`, `priceUsdc` (importado del agente) | `src/agents/corridor-fx.ts:10-11` |
| F5 | `src/manifest/registry.test.ts` | Crear | Invariantes de la tabla (slug↔name, chain ∈ allowlist testnet, capabilities exactas, price == constante del agente) | `src/contracts/contracts.provider.test.ts` |
| F6 | `src/manifest/paytos.ts` | Crear | `resolvePayTo(entry): PayTo` — **única fábrica** de `PayTo`; fail-closed; trim; typeof-narrowing; despacho por familia de chain | `src/providers/transfi-env.ts:53-140` |
| F7 | `src/manifest/build.ts` | Crear | `buildManifest(pathSlug): {ok:true,manifest} \| {ok:false,missing[],invalid[]}` | — (nuevo; sin equivalente) |
| F8 | `src/manifest/build.test.ts` | Crear | Fail-closed por env ausente / whitespace / formato / zero-address / cross-family | `src/providers/transfi-env.test.ts` (estilo) |
| F9 | `src/manifest/manifest.contract.test.ts` | Crear | Ancla del wire (set de keys + `typeof`) de los 3 manifiestos | `src/contracts/contracts.provider.test.ts:21-27` |
| F10 | `src/manifest/settle-preconditions.ts` | Crear | **Oráculo de test** (no se importa desde `src/app`): port de las 5 pre-condiciones del leg downstream → `evaluateSettle(payment)` → `'WOULD_SETTLE' \| <skip-code>` | `wasiai-a2a/src/lib/downstream-payment.ts:506-546,218-231,255-262` |
| F11 | `src/manifest/settle-preconditions.test.ts` | Crear | **Tests de efecto** (¿cobra o no cobra?) de los 3 agentes + el propio oráculo | idem |
| F12 | `src/app/api/agents/remit-kyc-validator/manifest/route.ts` | Crear | `GET` → 200/503; `dynamic='force-dynamic'`; `Cache-Control: no-store` | `.../invoke/route.ts:9-31` |
| F13 | `src/app/api/agents/remit-corridor-fx/manifest/route.ts` | Crear | idem | idem |
| F14 | `src/app/api/agents/remit-cashout-payout/manifest/route.ts` | Crear | idem | idem |
| F15..F17 | `.../manifest/route.test.ts` (×3) | Crear | 200/503, header `no-store`, `dynamic` exportado, sin I/O, sin eco de query | `.../invoke/route.test.ts:1-60` |
| F18 | `README.md` | Modificar | Sección "Manifiesto de cobro": URLs, shape, envs, runbook de registro, semántica fail-closed, nota de deslistado | `README.md` §"Endpoint HTTP + deploy" |

**Ningún archivo de `src/agents/`, `src/providers/`, `src/contracts/` ni `src/app/api/agents/*/invoke/` se toca** (CD-1/CD-17).

### 4.2 Modelo de datos

N/A en este repo (sin persistencia). El único "modelo" es el **wire del manifiesto** (§4.3) y su
mapeo 1:1 al `metadata.payment` que persiste `wasiai-a2a` (§8).

### 4.3 El manifiesto (contrato de salida)

**Ruta:** `GET /api/agents/<pathSlug>/manifest` — hermana del `/invoke` ya deployado.
**Regla de derivación desde el `agentUrl` registrado (la consume la HU hermana):**
`manifestUrl = agentUrl.replace(/\/invoke\/?$/, '/manifest')`.

**200 OK** (7 claves, orden irrelevante, sin claves extra):

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

**503 Service Unavailable** (ficha no publicable — fail-closed):

```json
{ "error": "manifest_unavailable", "missing": ["payment.contract"], "invalid": [] }
```

`missing` e `invalid` contienen **nombres de campo**, nunca valores (CD-13). Ambas claves siempre
presentes (arrays, eventualmente vacíos) para que el consumidor no tenga que hacer narrowing.

**Tabla de declaración (F4 `registry.ts`)** — la fuente de verdad:

| pathSlug (dir de la ruta) | slug canónico (registro) | chain | asset | env del payTo | familia | priceUsdc | capabilities |
|---|---|---|---|---|---|---|---|
| `remit-kyc-validator` | `remit-kyc-validator` | `avalanche-fuji` | `USDC` | `REMIT_KYC_VALIDATOR_PAYTO` | evm | `PRICE_USDC` de `src/agents/kyc-validator.ts` (0.02) | `kyc-verification`, `aml-screening`, `travel-rule`, `remittance-compliance` |
| `remit-corridor-fx` | `remit-corridor-fx-solana` | `solana-devnet` | `USDC` | `REMIT_CORRIDOR_FX_PAYTO` | solana | `PRICE_USDC` de `src/agents/corridor-fx.ts` (0.03) | `remittance-fx-quote`, `usdc-to-pen`, `corridor-pricing` |
| `remit-cashout-payout` | `remit-cashout-payout-solana` | `solana-devnet` | `USDC` | `REMIT_CASHOUT_PAYOUT_PAYTO` | solana | `PRICE_USDC` de `src/agents/cashout-payout.ts` (0.03) | `remittance-payout`, `cashout`, `value-delivery`, `fiat-disbursement` |

Capabilities verificadas contra los registros originales:
`wasiai-a2a/doc/sdd/169-wkh-170-remit-kyc-validator/done-report.md:190`,
`167-wkh-171-remit-corridor-fx/done-report.md:177`,
`170-wkh-172-remit-cashout-payout/done-report.md:202`.

> **Ojo (DT-5):** `pathSlug ≠ slug` en FX y payout. El directorio de la ruta es el histórico
> (`remit-corridor-fx`) porque el `agentUrl` ya registrado apunta ahí y **no se toca**; el `slug` que
> el manifiesto declara es el canónico de cobro (`remit-corridor-fx-solana`). La HU hermana debe
> cruzar `manifest.slug` contra el slug de la fila, **no** contra la URL.

### 4.4 Decisiones técnicas

**Heredadas del work-item (vigentes, sin cambios):**

- **DT-1** — El manifiesto es la fuente de verdad **declarada**; `a2a_agents` sigue siendo la fuente
  **persistida** que se consulta en runtime. El manifiesto se lee **al registrar/actualizar**, nunca
  por request de `/discover`.
- **DT-2** — `metadata.payment` sigue siendo el único campo que consume `readPaymentSpec()`. El
  manifiesto produce **exactamente** ese shape: `manifest.payment` → `metadata.payment` es copia
  literal, sin transformación.
- **DT-3** — `payment` (payTo del precio completo) y `payout_wallet` (creator-split del 1%) son
  campos **distintos**; el manifiesto **no** los deriva uno del otro (ver DT-11 para por qué el
  creator-split queda fuera).

**Nuevas de F2:**

- **DT-4 — Un manifiesto por endpoint, hermano del `/invoke`; no `.well-known`.**
  `/.well-known/agent.json` es **por origen**, y este deploy sirve 3 agentes con 2 cadenas distintas:
  un manifiesto por origen obligaría a elegir una cadena para todo el deploy o a inventar un formato
  multi-agente que ningún consumidor lee. La ruta hermana del `/invoke` da la propiedad que buscamos:
  **1 URL = 1 agente = 1 cadena**, derivable determinísticamente desde el `agentUrl` ya registrado
  (§4.3), sin tocar la URL de invocación.

- **DT-5 — Slugs canónicos de cobro y deslistado de los gemelos Fuji.**
  Decisión del founder. Las filas Solana (`*-solana`) ya existen y ya tienen `metadata.payment`
  (WKH-235/236, confirmado en `wasiai-a2a/doc/sdd/184-wkh-241-.../work-item.md:5-8`); son las
  canónicas. El deslistado de `remit-corridor-fx`/`remit-cashout-payout` (Fuji) es una acción
  **operativa** en `wasiai-a2a` (`!` humano), fuera del código de esta HU. Hasta que se ejecute, no
  hay daño: esos slugs cobran hoy exactamente como cobran, y este repo no los toca (AC-4).

- **DT-6 — El manifiesto es fail-closed: no existe la ficha a medias.**
  Sin `payTo` válido no hay `200`. Se elige **503** (no 200-parcial, no 500, no 502):
  · un `200` sin `payment` reproduce exactamente el bug que la HU viene a matar (alguien copia y
    registra un agente que cobra $0 sin señal);
  · **500** está prohibido por el guardrail del repo (`project-context.md` §PROHIBIDO);
  · **502** significa "el partner upstream falló" y acá no hay upstream — es config propia;
  · **503** = "este agente todavía no está publicable". El body lleva `missing`/`invalid` con
    **nombres de campo** para que el operador sepa qué le falta. El silencio es justamente lo que hoy
    cuesta plata.

- **DT-7 — La chain es constante de código; el `payTo` es config.**
  `chain` vive en la tabla de F4 (`registry.ts`), no en una env. Consecuencia deliberada:
  **ninguna env puede llevar un manifiesto a mainnet** (CD-3 se vuelve inviolable por construcción, no
  por disciplina). CD-4 ("no hardcodear wallets/RPCs/contracts") se respeta: lo que es config —el
  `payTo`— sigue siendo env; un slug de cadena no es ni wallet ni contract ni RPC.

- **DT-8 — Tipo branded `PayTo`, con una única fábrica.**
  Espejo de `TransFiBaseUrl` (`src/providers/transfi-env.ts:28-31`): `AgentManifest['payment']['contract']`
  es de tipo `PayTo`, y sólo `resolvePayTo()` (F6) puede producir uno. Un `string` cualquiera —un
  literal nuevo, un `process.env.X ?? ''`— **no compila** en esa posición. El compilador, no la
  revisión, garantiza que ninguna dirección llegue al manifiesto sin pasar por la validación.

- **DT-9 — El validador es un port *verbatim* del criterio del consumidor, no el que ya está en el repo.**
  `src/providers/payout.ts:53` valida base58 con `^[charset]{32,44}$`. Ese criterio es **más laxo**
  que el del settle (`isValidSolanaAddress`, decode a **32 bytes** exactos,
  `wasiai-a2a/src/lib/wallet-format.ts:50-71`): una address de 44 chars que decodifica a 33 bytes
  pasaría la regex y sería **rechazada en el settle** con `INVALID_PAY_TO_FORMAT` → el agente cobra
  $0 igual, pero ahora con un manifiesto que dice que todo está bien. El validador del manifiesto
  debe ser **al menos tan estricto como el consumidor**. Se portea el algoritmo tal cual (F2), con
  cabecera citando origen y línea; `payout.ts` **no se toca** (CD-1, otro propósito).

- **DT-10 — Ruta dinámica y sin caché.**
  En Next 14 App Router un `GET` sin APIs dinámicas se **evalúa en build**: el manifiesto quedaría
  con el `payTo` que hubiera al momento de compilar, y rotarlo en Vercel no cambiaría nada hasta el
  siguiente deploy. Es un fail-open silencioso de manual. Cada `route.ts` de manifiesto exporta
  `export const dynamic = "force-dynamic"` y responde `Cache-Control: no-store` (AC-7). No hay
  precedente en el repo: **todas** las rutas actuales son `POST` (siempre dinámicas).

- **DT-11 — Lo que el manifiesto NO declara, y por qué.**
  · **`invokeUrl`/`agentUrl`**: derivarlo de la request es leer el header `Host`, que el caller
    controla. Un documento money-adjacent no debe llevar un campo spoofeable, y el gateway ya conoce
    el `agentUrl` (es de donde derivó la URL del manifiesto). Fuera.
  · **`payoutWallet`/`payoutChain` (creator-split 1%)**: `payoutChain` **no se persiste** en
    `a2a_agents` (hallazgo #3 de `doc/sdd/007-wkh-235-.../work-item.md:40-41`). Declarar en el
    manifiesto un campo que el consumidor descarta es prometer algo que no se cumple. Queda fuera y
    documentado como gap conocido (§9-M3); DT-3 se preserva por ausencia, no por derivación.

- **DT-12 — La zero-address se rechaza en el manifiesto.**
  El leg downstream la corta con `ZERO_PAY_TO` (`downstream-payment.ts:227-229`) porque el gateway
  mueve fondos **propios** del operador. Un manifiesto que la publique produce una fila que cobra $0
  para siempre. Se rechaza en origen (AC-6).

- **DT-13 — El efecto ("¿cobra o no cobra?") se mide con un oráculo de pre-condiciones de settle.**
  El settle real vive en otro repo y necesita cadena, operador y fondos. Para medir **efecto** y no
  "se llamó a una función", F10 portea las 5 guardas que deciden si un leg paga o se saltea
  (`downstream-payment.ts:506-546,218-231,255-262`) en una función pura de test:
  `evaluateSettle(payment, initializedChains) → 'WOULD_SETTLE' | 'NO_PAYMENT_FIELD' | 'METHOD_NOT_SUPPORTED' |
  'CHAIN_NOT_SUPPORTED' | 'INVALID_PAY_TO_FORMAT' | 'ZERO_PAY_TO'`. Los tests de F11 afirman
  `WOULD_SETTLE` sobre el `payment` **realmente emitido** por el manifiesto, y nombran el skip-code
  esperado en los casos negativos: un rojo se lee como *"este agente cobraría $0 por X"*.
  La duplicación tiene riesgo de drift (R-3): se mitiga con (a) cabecera que cita archivo:línea de
  origen, (b) el test espejo que la HU hermana agrega **en `wasiai-a2a`** contra el manifiesto real
  (§8.4), que es donde el drift se detecta de verdad.

  **Fix-pack AR BLQ-1** — la guarda de chain son **DOS** condiciones (`if (!chainKey || !bundle)`),
  no una: slug conocido por el resolver **Y** bundle inicializado en el registry. La 2ª es
  configuración del gateway (`SOLANA_ADAPTER_ENABLED`, **default OFF**), así que el oráculo la recibe
  como parámetro explícito `initializedChains` (default = lo medido en prod el 2026-07-29 vía
  `GET /capabilities`: `avalanche-fuji` + `solana-devnet`). Sin ese parámetro el oráculo afirmaba
  "COBRARÍA" en entornos donde los 2 agentes Solana no cobran. Los tests fijan las dos caras: cobra
  con la chain inicializada, `CHAIN_NOT_SUPPORTED` sin ella.
  ⚠️ `readPaymentSpecAccepts` **no** recibe ese set a propósito: el lector real
  (`payment-spec-reader.ts`) sólo exige `normalizeChainSlug` — la inicialización la chequea el leg.

### 4.5 Flujo principal (Happy Path)

1. El operador setea en Vercel las 3 envs de `payTo` (`!` humano, §9-M1/M2).
2. Un consumidor hace `GET https://wasiai-remittance-agents.vercel.app/api/agents/remit-kyc-validator/manifest`.
3. `route.ts` (F12) llama `buildManifest('remit-kyc-validator')` (F7).
4. F7 busca la entrada en `registry.ts` (F4) y llama `resolvePayTo(entry)` (F6): lee la env,
   `typeof`-narrowing → `trim()` → si queda vacío ⇒ *missing*; valida formato por familia (F2) y
   zero-address ⇒ si falla, *invalid*.
5. F7 ensambla el manifiesto (7 claves) con el `PayTo` branded.
6. `route.ts` responde `200` + `Cache-Control: no-store`.
7. El operador (o, tras la HU hermana, el gateway) toma `capabilities` + `payment` **tal cual** y los
   manda a `POST/PATCH /agents`. `readPaymentSpec` los acepta y `signAndSettleDownstream` deja de
   emitir `NO_PAYMENT_FIELD` para ese slug (AC-5).

### 4.6 Flujo de error

| Condición | Respuesta | Log server-side |
|---|---|---|
| Env del `payTo` ausente / `""` / sólo whitespace | `503 {error:"manifest_unavailable", missing:["payment.contract"], invalid:[]}` | `console.warn` con `{ slug, field:"payment.contract", reason:"missing" }` — **sin** valor |
| `payTo` con formato inválido para su familia (EVM no-`0x40hex`; base58 fuera de charset o decode ≠ 32 bytes) | `503 {..., missing:[], invalid:["payment.contract"]}` | `{ slug, field, reason:"invalid_format" }` — **sin** valor |
| `payTo` EVM = zero-address | `503 {..., invalid:["payment.contract"]}` | `{ slug, field, reason:"zero_address" }` |
| `payTo` de otra familia (EVM en un slot Solana o viceversa) | `503 {..., invalid:["payment.contract"]}` | `{ slug, field, reason:"invalid_format" }` |
| Excepción inesperada dentro del handler | `503 {error:"manifest_unavailable", missing:[], invalid:[]}` + `console.warn` sólo con `err.name` | nunca 500, nunca `err.message`/stack |

---

## 5. Constraint Directives (Anti-Alucinación)

### Heredadas del work-item (vigentes)

- **CD-1** — PROHIBIDO modificar la lógica de negocio de los 3 agentes (`src/agents/*.ts`,
  `src/providers/*`). Esta HU es puramente declarativa. Importar `SLUG`/`PRICE_USDC` **sí** está
  permitido (lectura, sin edición).
- **CD-2** — OBLIGATORIO que el gate "sin ficha → rechazado" **no sea retroactivo**: las filas ya
  registradas sin `metadata.payment` siguen funcionando byte-idéntico. (Se materializa en el
  contrato de §8: obligatorio en `POST`, validado-si-presente en `PATCH`.)
- **CD-3** — OBLIGATORIO devnet/testnet-only (`avalanche-fuji`, `solana-devnet`). Cero mainnet.
- **CD-4** — PROHIBIDO hardcodear wallets/RPCs/contracts en `src/`: el `payTo` es env, siempre.

### Nuevas de F2 — OBLIGATORIO

- **CD-5** — OBLIGATORIO que **todo** `200` del manifiesto lleve `payment.contract` no vacío y
  válido. No existe ninguna rama que emita `200` sin ficha completa.
- **CD-8** — OBLIGATORIO `trim()` **antes** de decidir si la env está vacía: `"   "` es *ausente*, no
  un valor (auto-blindaje WKH-204: `min(1)` no trimea).
- **CD-11** — OBLIGATORIO `export const dynamic = "force-dynamic"` y header `Cache-Control: no-store`
  en las 3 rutas de manifiesto (DT-10).
- **CD-14** — OBLIGATORIO correr `npm run typecheck` **completo** (incluye `*.test.ts`) al cerrar
  cada wave, no sólo `npm run test` (auto-blindaje WKH-208).
- **CD-16** — OBLIGATORIO ejecutar los mutation self-checks de §7.3 y dejar el resultado en el report:
  cada mutante listado debe **morir**.

### Nuevas de F2 — PROHIBIDO

- **CD-6** — PROHIBIDO leer `chain` (o cualquier parte del `payment` que no sea `contract`) de una env
  o del request. Son constantes de `registry.ts` (DT-7).
- **CD-7** — PROHIBIDO `String(x ?? "")` para "sanitizar" la env. Se usa `typeof v === "string" ? v : ""`
  (auto-blindaje WKH-204: `String(123) === "123"`, no `""` → fail-open).
- **CD-9** — PROHIBIDO reusar `BASE58_ADDR_RE` (`src/providers/payout.ts:53`) o cualquier regex de
  longitud como validador del `payTo`. El criterio es el decode a 32 bytes (DT-9).
- **CD-10** — PROHIBIDO cualquier I/O (fetch, fs, red, DB) en el path del manifiesto. La respuesta se
  computa sólo desde `registry.ts` + `process.env` (AC-4/AC-8).
- **CD-12** — PROHIBIDO responder `500`, `502`, `4xx` o cualquier código distinto de `200`/`503` desde
  las rutas de manifiesto.
- **CD-13** — PROHIBIDO ecoar el valor de la env (ni truncado, ni hasheado) en el body HTTP o en los
  logs. Sólo nombre de campo + código de razón.
- **CD-15** — PROHIBIDO `git checkout <archivo>` sobre archivos no commiteados durante los mutation
  self-checks; usar `cp` al scratchpad (auto-blindaje WKH-208).
- **CD-17** — PROHIBIDO tocar `src/agents/**`, `src/providers/**`, `src/contracts/**` y
  `src/app/api/agents/*/invoke/**` (ni código ni tests).
- **CD-18** — PROHIBIDO escribir en el repo `wasiai-a2a`, en Supabase, o ejecutar cualquier acción
  con credenciales reales desde esta HU. El registro/deslistado es ops `!` humano (§10).
- **CD-19** — PROHIBIDO agregar dependencias nuevas al `package.json`. Los validadores son puros
  (no hay `@solana/web3.js` ni `viem` en el repo, verificado).
- **CD-20** — PROHIBIDO que `src/app/**` importe `settle-preconditions.ts` (F10): es oráculo de test,
  no código de producción.

---

## 6. Scope

**IN (este repo):**
- F1..F17 de §4.1 — módulo `src/manifest/` + 3 rutas `GET .../manifest` + sus tests.
- F18 — sección nueva en `README.md` (manifiesto, envs, runbook de registro, fail-closed, deslistado).
- 3 env vars nuevas, sólo de lectura: `REMIT_KYC_VALIDATOR_PAYTO`, `REMIT_CORRIDOR_FX_PAYTO`,
  `REMIT_CASHOUT_PAYOUT_PAYTO`.

**OUT:**
- Cualquier cambio en `src/agents/**`, `src/providers/**`, `src/contracts/**`,
  `src/app/api/agents/*/invoke/**` (CD-1/CD-17).
- El write-path + gate fail-closed de registro (`POST`/`PATCH /agents` aceptando `payment`) — es
  código de `wasiai-a2a`: **HU hermana**, contrato en §8 (mismo criterio de separación que
  WKH-235/236/241).
- Rediseñar `readPaymentSpec()` o el settle downstream (ya DONE en WKH-241/234).
- **Registrar/actualizar/deslistar filas** en `a2a_agents` — ops `!` humano (§10), nunca código de
  este repo (AC-4/CD-18).
- El deslistado de los gemelos Fuji: decidido (DT-5), ejecutado como ops.
- `creator-split` (`payoutWallet`/`payoutChain`) en el manifiesto (DT-11) — gap conocido §9-M3.
- Índice global de manifiestos (`/.well-known/...`) — DT-4.
- Activar Solana en prod (`SOLANA_ADAPTER_ENABLED`, `WASIAI_DOWNSTREAM_X402`) — config founder-gated.
- Mainnet, en cualquier eje (CD-3).

---

## 7. Plan de implementación

### 7.1 Waves

**W0 — Serial gate (contratos y tipos). Nada empieza antes de que W0 esté verde.**
- [ ] **W0.1** `src/manifest/types.ts` (F1): `AgentPaymentSpec` (espejo de `wasiai-a2a/src/types/index.ts:163-171`),
      `AgentManifest` (7 claves de §4.3), `PayTo` branded, `ManifestResult` (unión discriminada),
      `ManifestEntry` (fila de la tabla de F4), `ChainFamily = 'evm'|'solana'`.
      → Exemplar: `src/providers/transfi-env.ts:26-31`.
- [ ] **W0.2** `src/manifest/wallet-format.ts` (F2) — port verbatim con cabecera de origen.
      → Exemplar: `wasiai-a2a/src/lib/wallet-format.ts:20,46-71`.
- [ ] **W0.3** `src/manifest/wallet-format.test.ts` (F3).
- [ ] **Gate W0**: `npm run typecheck` + `npm run test` verdes (CD-14).

**W1 — Núcleo declarativo (serial respecto de W0; W1.1 → W1.2 es secuencial).**
- [ ] **W1.1** `src/manifest/registry.ts` (F4) + `registry.test.ts` (F5). Importa `PRICE_USDC` de los
      3 agentes (lectura). → Exemplar: `src/agents/corridor-fx.ts:10-11`.
- [ ] **W1.2** `src/manifest/paytos.ts` (F6) + `src/manifest/build.ts` (F7) + `build.test.ts` (F8).
      → Exemplar: `src/providers/transfi-env.ts:53-140`.
- [ ] **Gate W1**: typecheck + tests; mutation self-checks M1-M4 de §7.3.

**W2 — Superficie HTTP (los 3 ítems son paralelizables entre sí; dependen de W1).**
- [ ] **W2.1** `remit-kyc-validator/manifest/route.ts` + `route.test.ts` (F12, F15).
- [ ] **W2.2** `remit-corridor-fx/manifest/route.ts` + `route.test.ts` (F13, F16).
- [ ] **W2.3** `remit-cashout-payout/manifest/route.ts` + `route.test.ts` (F14, F17).
      → Exemplar de los 3: `src/app/api/agents/remit-kyc-validator/invoke/route.ts:9-31`.
- [ ] **Gate W2**: typecheck + tests; mutation self-check M5.

**W3 — Efecto y documentación (depende de W2).**
- [ ] **W3.1** `src/manifest/settle-preconditions.ts` (F10) + `settle-preconditions.test.ts` (F11) —
      los tests de dinero.
- [ ] **W3.2** `src/manifest/manifest.contract.test.ts` (F9) — ancla del wire.
- [ ] **W3.3** `README.md` (F18).
- [ ] **Gate W3**: `npm run typecheck` + `npm run test` completos; suite base (224 tests) sin
      regresión; mutation self-checks M6-M7.

**Orden y razón:** W0 fija tipos y el criterio de formato (todo lo demás lo consume y el branded type
sólo funciona si existe primero). W1 no puede empezar antes porque `resolvePayTo` **es** la fábrica
del branded type. W2 son wrappers finos: sin W1 no tienen qué envolver, y entre sí no comparten
estado (paralelizables). W3 mide el efecto sobre lo que W2 **realmente emite**, así que va último.

### 7.2 Plan de tests (≥1 por AC; los de dinero miden efecto)

| ID | Test | Archivo | AC | Qué afirma | ¿Mide efecto? |
|---|---|---|---|---|---|
| T1 | manifiesto de KYC completo | F15 | AC-1 | `200`; `capabilities` `toEqual` el array exacto de 4; `payment` `toEqual` `{method:'x402',chain:'avalanche-fuji',contract:<env>,asset:'USDC'}` | contrato |
| T2 | **KYC cobraría** | F11 | AC-1, AC-5 | `evaluateSettle(manifest.payment) === 'WOULD_SETTLE'` con el payment REALMENTE emitido | **sí** |
| T3 | FX y payout declaran Solana | F16, F17 | AC-2 | `200`; `payment.chain === 'solana-devnet'`; `slug === 'remit-corridor-fx-solana'` / `'remit-cashout-payout-solana'` | contrato |
| T4 | **FX y payout cobrarían** | F11 | AC-2, AC-5 | `evaluateSettle(...) === 'WOULD_SETTLE'` para los 2 | **sí** |
| T5 | env ausente → sin ficha | F15-F17 | AC-3 | `503`; `"payment" in body === false`; `missing` incluye `payment.contract` | **sí** (nadie puede registrar un $0) |
| T6 | env `""` y `"   "` → *missing*, no *invalid* | F8 | AC-3 | ambas ramas dan `missing`, ninguna emite manifiesto (auto-blindaje: `min(1)` no trimea) | **sí** |
| T7 | **ningún 200 sin contract** | F9 | AC-3, CD-5 | para los 3 pathSlugs: `typeof body.payment.contract === 'string' && length > 0` | **sí** |
| T8 | sin I/O | F15-F17 | AC-4 | `vi.stubGlobal('fetch', () => { throw })` → los 3 `GET` siguen dando `200` | **sí** |
| T9 | `payment` mapea 1:1 a `metadata.payment` | F11 | AC-5 | `readPaymentSpecPredicate({payment: manifest.payment})` acepta (port de `payment-spec-reader.ts:152-163`) | **sí** |
| T10 | EVM inválido → 503 | F8 | AC-6 | `0x` + 39 hex, sin `0x`, con char no-hex, con espacios internos → `invalid`, sin manifiesto | **sí** |
| T11 | **zero-address → 503** | F8 | AC-6, DT-12 | `0x000...0` → `invalid`; y `evaluateSettle` de ese payment daría `ZERO_PAY_TO` | **sí** |
| T12 | **base58 laxo → 503** | F3, F8 | AC-6, DT-9 | una base58 de 44 chars que decodifica a **33 bytes** (pasa `BASE58_ADDR_RE`, falla el settle) → `invalid` | **sí** |
| T13 | cross-family → 503 | F8 | AC-6 | payTo EVM en slot `solana-devnet` y base58 en slot `avalanche-fuji` → `invalid` (el copy-paste más probable del operador) | **sí** |
| T14 | ruta dinámica y sin caché | F15-F17 | AC-7 | el módulo exporta `dynamic === 'force-dynamic'`; la respuesta lleva `Cache-Control: no-store`; cambiar `stubEnv` entre dos `GET` cambia el `contract` devuelto | **sí** (el 2º assert prueba que no se cachea) |
| T15 | sin eco ni variación por caller | F15-F17 | AC-8 | `?payTo=0xEVIL` y headers arbitrarios no alteran el body; el body de 503 no contiene el valor de la env | **sí** |
| T16 | invariantes de la tabla | F5 | AC-1, AC-2, CD-3 | `name.toLowerCase().replace(/\s+/g,'-') === slug` (regla real: `wasiai-a2a/src/services/agent.ts:380`); `chain ∈ {avalanche-fuji, solana-devnet}`; `priceUsdc === PRICE_USDC` importado; 3 entradas, sin duplicados de `slug` ni de `payToEnv` | contrato |
| T17 | el oráculo detecta lo que debe | F11 | AC-5 | `evaluateSettle` devuelve el skip-code correcto para: sin payment, `method:'x402 '`, `chain:'polygon'`, contract vacío, zero-address | **sí** (valida el instrumento) |
| T18 | ancla del wire | F9 | AC-1..AC-3 | set de 7 claves + `typeof` por campo, para los 3 manifiestos (patrón `assertSameShape`) | contrato |

### 7.3 Mutation self-checks obligatorios (CD-16)

Cada mutante se aplica sobre una **copia** (`cp` al scratchpad — CD-15), se corre la suite y se
restaura. **Todos deben morir**; si alguno sobrevive, falta un test.

| ID | Mutante | Debe matarlo |
|---|---|---|
| M1 | `isValidSolanaAddress` → `BASE58_ADDR_RE.test(v)` (el criterio laxo del repo) | T12 |
| M2 | `trim()` eliminado en `resolvePayTo` | T6 |
| M3 | `typeof v === "string" ? v : ""` → `String(v ?? "")` | T6 / T10 |
| M4 | rama de zero-address borrada | T11 |
| M5 | `export const dynamic` borrado | T14 |
| M6 | despacho por familia invertido (evm↔solana) | T13 |
| M7 | en el 503, `missing`/`invalid` reemplazados por un `payment` parcial (`contract: ""`) | T5, T7 |

### 7.4 Verificación incremental

| Wave | Verificación |
|---|---|
| W0 | `npm run typecheck` + `npm run test` |
| W1 | idem + M1-M4 |
| W2 | idem + M5 + `npm run build` (confirma que las 3 rutas compilan como dinámicas) |
| W3 | suite completa sin regresión (base 224 tests) + M6-M7 + `curl` local contra `npm run dev` (3 manifiestos con envs de fixture, y los 3 en 503 sin envs) |

---

## 8. Dependencia cross-repo — contrato para la HU hermana en `wasiai-a2a`

> Esta sección **es** el entregable para el otro repo. Ninguna línea de esto se implementa acá
> (CD-18). Cierra AC-3 y AC-6 end-to-end y resuelve `AR-4` de WKH-241.

### 8.1 Lo que este repo GARANTIZA (podés construir sobre esto)

1. Un endpoint **público, sin auth, idempotente, `GET`**, en
   `<agentUrl sin '/invoke'>/manifest`, sobre el mismo origen que el `agentUrl` registrado.
2. `200` ⇒ `payment.contract` **siempre** presente, no vacío, y con formato válido para
   `payment.chain` bajo el criterio de `wasiai-a2a/src/lib/wallet-format.ts` (mismo algoritmo,
   porteado). La zero-address nunca se emite.
3. `payment` es **exactamente** el shape `AgentPaymentSpec` — copiarlo tal cual a `metadata.payment`
   basta; no hay transformación ni normalización pendiente.
4. `503` ⇒ el agente **no está publicable**. No hay ninguna respuesta intermedia.
5. `manifest.slug` es el slug **canónico de registro** (puede diferir del último segmento de la URL:
   `remit-corridor-fx-solana` se sirve desde `/api/agents/remit-corridor-fx/manifest`).
6. `name` cumple `name.toLowerCase().replace(/\s+/g,'-') === slug` (la derivación real de
   `src/services/agent.ts:380`), así que registrar por `name` produce el `slug` declarado.

### 8.2 Lo que la HU hermana DEBE aceptar/rechazar (mínimo, cierra AC-3)

| # | Requisito | Dónde | Nota |
|---|---|---|---|
| C1 | `PublishAgentInput` y `UpdateAgentInput` ganan `payment?: AgentPaymentSpec` | `src/types/index.ts:191-239` | aditivo |
| C2 | `buildMetadata()` mergea `payment` en el JSONB | `src/services/agent.ts:177-189` | es el **único** camino de escritura a `metadata.payment`; sin esto nada más importa |
| C3 | `POST /agents` **sin** `payment` válido ⇒ **422**, **sin persistir la fila** | `src/routes/agents.ts:180-225` (mismo lugar y estilo que los guards de `priceUsdc`/`payoutWallet`) | body sugerido: `{error:'Missing payment spec', field:'payment', reason:'agents must declare how they charge'}` |
| C4 | `PATCH /agents/:slug` valida `payment` **sólo si viene presente** (presente-e-inválido ⇒ 422); **no** lo exige | mismo archivo | **CD-2**: un gate retroactivo tumbaría agentes de terceros que hoy funcionan |
| C5 | `payment.method` debe ser `'x402'` exacto | write-path | cualquier otro valor produce `METHOD_NOT_SUPPORTED` en el settle ⇒ un agente que cobra $0: rechazarlo al registrar, no al cobrar |
| C6 | `payment.chain` debe resolver con `normalizeChainSlug` (`src/adapters/chain-resolver.ts:20-68`); **mainnet ⇒ 422** salvo el mismo opt-in explícito que ya gobierna el leg (`WASIAI_DOWNSTREAM_MAINNET_ALLOW`) | write-path | prohibido un `Set` de slugs paralelo (CD-1/CD-9 de WKH-241) |
| C7 | `payment.contract` se valida con `isValidPayoutWallet(contract, ns)` (`src/lib/wallet-format.ts:79-81`), con `ns` derivado de la chain (`solana-devnet → 'solana'`, resto `'evm'`), **más** rechazo de la zero-address en EVM | write-path | mismo criterio que el settle: si el settle lo va a rechazar, el registro no debe aceptarlo |
| C8 | La respuesta `201`/`200` de publish/update **devuelve** el `payment` persistido (`PublishedAgentRecord`, `src/services/agent.ts:65-77`) | service | hoy el operador **no puede verificar** qué quedó guardado sin acceso a la DB; ese es el agujero que dejó el $0 vivo meses |
| C9 | El guard de ownership existente (`.eq('owner_ref', ...)`) sigue aplicando sin cambios | service | un operador sólo puede declarar el `payment` de **su** fila |

### 8.3 Lo que cierra AR-4 (payTo re-routing) — control obligatorio

`AR-4` de WKH-241: *"anyone can re-route their agent's fee to a wallet they don't own"*.

**Control decidido: binding con el manifiesto del propio origen del agente.**
En write-time, el gateway hace `GET` al `manifestUrl` derivado del `agentUrl` que se está registrando
(`agentUrl.replace(/\/invoke\/?$/,'/manifest')`, o un `manifestUrl` explícito del body **obligado a
ser same-origin** que `agentUrl`) y **compara**:
`payment.method`, `payment.chain`, `payment.contract` (case-sensitive en Solana, case-insensitive en
EVM) y `manifest.slug` contra el slug de la fila. Si no coinciden, o el fetch falla ⇒ **422, sin
persistir**.

- Fetch: `validateRegistryUrl` (SSRF, ya existe y ya se usa en `routes/agents.ts:129-155`), timeout
  corto (≈5s), tamaño acotado, sin follow de redirects cross-origin, sin credenciales.
- **Fail-closed**: manifiesto caído ⇒ el registro falla. Es la elección correcta: registrar es un
  evento raro; cobrar $0 para siempre es el costo del otro lado.
- Efecto: quien no controla el origen del agente **no puede** declarar su payTo, y quien lo controla
  ya es su operador. Combinado con C9 (ownership de la fila), el ataque de AR-4 queda cerrado.
- **Riesgo residual, explícito**: esto es control de **dominio**, no prueba criptográfica de posesión
  de la llave del `payTo`. Un operador legítimo puede declarar una address que no es suya (se hace
  daño a sí mismo), y un compromiso del deploy del agente permite rotar su propio payTo. La prueba de
  posesión (firma EIP-191 / ed25519 sobre un challenge con `slug`+`owner_ref`) es HU de seguimiento —
  se documenta, no se promete. (Mismo criterio de honestidad que WKH-204 §"Alcance real".)

### 8.4 Test espejo pedido a la HU hermana (anti-drift de DT-13)

En `wasiai-a2a`: un test que tome un **fixture del manifiesto real** de los 3 agentes `remit-*` y
verifique que (a) `readPaymentSpec({payment})` devuelve un spec y (b) las guardas de
`downstream-payment.ts` no producen skip-code. Si alguna de las dos piezas cambia, ese test se rompe
en el repo donde vive la verdad — que es exactamente donde tiene que romperse.

---

## 9. Missing Inputs y su resolución

| # | Ítem | Estado | Resolución |
|---|---|---|---|
| **B1** | (work-item MI#1, era **BLOQUEANTE**) ¿manifiesto de FX/payout bajo el slug Fuji o el Solana? | **RESUELTO** | Decisión del founder: se deslistan los gemelos Fuji; los slugs canónicos de cobro son los `*-solana` (DT-5). AC-2 ya no tiene `[NEEDS CLARIFICATION]`. |
| **B2** | (MI#3, era **BLOQUEANTE**) ¿el write-path va en este ciclo? | **RESUELTO** | HU hermana separada en `wasiai-a2a`; contrato completo en §8. |
| **B3** | (MI#5) ¿el gate aplica a todo agente self-published o sólo a `remit-*`? | **RESUELTO** | Genérico (todo agente nuevo), **no retroactivo** — C3+C4 de §8.2. Coherente con AR-4, que nunca lo acotó a `remit-*`. |
| **M1** | `payTo` EVM (Avalanche Fuji) del operador para `REMIT_KYC_VALIDATOR_PAYTO` | `!` humano — **no bloquea F3** | Es input de **deploy/registro**, no de implementación: sin la env el manifiesto responde 503, que es el comportamiento diseñado y testeado (T5). Los tests usan valores de fixture. |
| **M2** | `payTo` Solana devnet para FX y payout | `!` humano — **no bloquea F3** | Ídem M1. Probablemente sean las mismas addresses ya presentes en `metadata.payment` de las filas `*-solana`; el runbook de §10 las verifica contra `/discover` antes de setear (evita introducir una address nueva por descuido). |
| **M3** | El `payoutWallet` del creator-split se sigue tipeando a mano | Gap conocido, **fuera de scope** | Documentado en DT-11 (el consumidor no persiste `payoutChain`). Candidato a HU de seguimiento junto con el write-path. |
| **M4** | (MI#4) parche interino por escritura directa en Supabase para KYC | **Desaconsejado; opcional y `!` humano** | El founder pidió *"no caminos cortos"*. Si se decide desbloquear el $0 antes de la HU hermana, la única forma aceptable es copiar los valores **desde el manifiesto vivo** (nunca tipeados) y re-verificar contra `/discover` cuando el write-path exista. No es parte de esta HU. |

**`[NEEDS CLARIFICATION]` pendientes: 0.**

---

## 10. Runbook operativo (post-merge, `!` humano — no es código)

1. **Setear las 3 envs** en el proyecto Vercel `wasiai-remittance-agents` (Production) y redeploy.
   Antes de setear las de Solana: leer el `payment.contract` actual de `remit-corridor-fx-solana` y
   `remit-cashout-payout-solana` en `GET /discover` del gateway y usar **esas mismas** addresses
   (evita crear una segunda verdad).
2. **Verificar los 3 manifiestos**: `curl` a las 3 URLs → `200`, `payment.chain` correcto,
   `Cache-Control: no-store`. Con una env borrada a propósito, confirmar el `503` (prueba viva del
   fail-closed).
3. **Drift check** (sin escribir): comparar `payment` del manifiesto vs el de `/discover` para los 2
   slugs `*-solana`. Si difieren, **no** se corrige a mano: se corrige vía el write-path de la HU
   hermana.
   ⚠️ **Fix-pack AR BLQ-2**: este paso **no prueba nada del cobro**. Manifiesto y `/discover`
   coinciden **por construcción** (el paso 1 manda copiar las addresses desde esas mismas filas), así
   que el chequeo está **garantizado a dar verde** sin haber tocado el rail. Es consistencia
   documental, no evidencia de settle.
4. **Registrar/actualizar `remit-kyc-validator`** con `payment` — requiere la HU hermana mergeada.
   Verificación de éxito: `GET /discover` muestra `payment` para ese slug **y** un `/compose` sobre él
   deja de loguear `NO_PAYMENT_FIELD` (AC-5 e2e).
5. **Prueba positiva de cobro** (precondición REAL del paso 6):
   - **Mínimo obligatorio**: `GET /capabilities` del gateway → `chains[].key` debe incluir
     `solana-devnet`. El rail Solana es flag-gated con **default OFF**
     (`wasiai-a2a/src/adapters/registry.ts:62-75`, `SOLANA_ADAPTER_ENABLED`): sin él,
     `getAdaptersBundle('solana-devnet')` devuelve `undefined` y el leg se saltea con
     `CHAIN_NOT_SUPPORTED` (`downstream-payment.ts:532-546`) — los 2 agentes `*-solana` cobran $0 con
     manifiesto `200`. Medición del 2026-07-29 sobre prod: `solana-devnet` **está** inicializada.
   - **Ideal**: invocación real en devnet contra cada slug `*-solana`, con el settle visible (ningún
     skip-code en el log del leg).
   - Espejo en tests: `settle-preconditions.test.ts` (describe *"el rail tiene que estar PRENDIDO"*)
     fija que el mismo `payment`, byte por byte, **no cobra** si la chain no está inicializada.
6. **Deslistar los gemelos Fuji** (`remit-corridor-fx`, `remit-cashout-payout`) — decisión del
   founder (DT-5). Ejecutar **después de la prueba positiva del paso 5**, no del paso 3: el paso 5 es
   el único que toca el rail de cobro, y el 6 apaga la única ruta que hoy sí cobra para FX/payout.

---

## 11. Riesgos

| # | Riesgo | Prob. | Impacto | Mitigación |
|---|---|---|---|---|
| R-1 | Se deslistan los gemelos Fuji antes de confirmar que los `*-solana` cobran ⇒ FX/payout sin ruta de cobro | M | Alto | Orden explícito del runbook (§10-6 después de la **prueba positiva** del §10-5; el §10-3 NO alcanza: da verde por construcción — fix-pack AR BLQ-2); el deslistado es reversible (re-enable) |
| R-2 | Next 14 evalúa el `GET` en build y sirve un `payTo` congelado | **A** (default del framework) | Alto (rotar la env no surte efecto) | DT-10 + CD-11 + T14 (dos `GET` con envs distintas dentro del mismo test) + `npm run build` en el gate de W2 |
| R-3 | Drift entre el validador porteado (F2/F10) y el original de `wasiai-a2a` | M | Alto (el manifiesto diría OK y el settle rechazaría) | Cabecera con archivo:línea de origen; §8.4 pide el test espejo en el repo dueño de la verdad; M1 mata el criterio laxo |
| R-4 | El operador copia el payTo Fuji al slot Solana (o al revés) | M | Alto ($0 silencioso otra vez) | T13 (cross-family) + fail-closed 503 |
| R-5 | El manifiesto expone una address que el operador no controla | B | Medio | §8.3 (binding por origen) + riesgo residual documentado; fuera del alcance de este repo |
| R-6 | La HU hermana no se prioriza y el manifiesto queda decorativo | M | Medio | §8 es un contrato ejecutable (C1-C9 + §8.4); §10-4 marca el único paso que la necesita; el resto del valor (fail-closed + fuente única) ya vive sin ella |
| R-7 | Alguien "limpia" el `trim()` o el rechazo de zero-address por parecer redundantes | M | Alto | CD-7/CD-8/DT-12 + mutantes M2/M4 obligatorios en el report |

---

## 12. Dependencias

- **Mergeado y en uso (no se toca):** WKH-241 (`readPaymentSpec`, único productor de `Agent.payment`),
  WKH-234 (adapter Solana + `isValidSolanaAddress` + validación namespace-aware del publish).
- **Este repo:** ninguna dependencia nueva (CD-19). Node/Next/Vitest ya presentes.
- **Bloquea (parcialmente):** el cierre e2e de AC-3/AC-5/AC-6 necesita la HU hermana de §8.
- **No bloquea:** WKH-235/236 (ya operativas con su mecanismo ad-hoc) ni ninguna HU que no toque
  `README.md` de este repo.

---

## 13. Uncertainty Markers

| Marker | Sección | Descripción | Bloqueante |
|---|---|---|---|
| — | — | Ninguno. Los 3 bloqueantes del work-item quedaron resueltos (§9 B1-B3) y los 2 inputs operativos (M1/M2) no bloquean F3 por diseño fail-closed. | No |

---

## 14. Readiness Check

```
READINESS CHECK — SDD #010 (WKH-300)
[x] Cada AC (1-8) tiene al menos 1 archivo en §4.1 y al menos 1 test en §7.2
[x] Cada archivo de §4.1 tiene Exemplar verificado con Read/Glob (paths reales, §3.3)
[x] 0 [NEEDS CLARIFICATION] pendientes (§13)
[x] Constraint Directives: 11 PROHIBIDO nuevos (CD-6,7,9,10,12,13,15,17,18,19,20) + 5 OBLIGATORIO
    nuevos (CD-5,8,11,14,16) + 4 heredados del work-item (CD-1..CD-4)
[x] Context Map: 9 archivos leídos en este repo + 12 en el repo consumidor (§3.1, §3.2)
[x] Scope IN / OUT explícitos y sin ambigüedad (§6)
[x] BD: verificado que este repo NO tiene capa de persistencia → AC-4 por construcción (§3.5)
[x] Happy Path completo (§4.5) y flujo de error con 5 casos (§4.6)
[x] Waves con W0 serial + orden justificado (§7.1)
[x] Plan de test ≥1 por AC; los ACs de dinero miden EFECTO vía oráculo de settle (§7.2 T2,T4,T5,T7,T9,T11,T12)
[x] Auto-Blindaje histórico de las 3 últimas HUs leído y convertido en CD (§3.4)
[x] Contrato cross-repo cerrado y accionable (§8, C1-C9 + AR-4)
[x] Ningún artefacto fuera de doc/sdd/010-wkh-300-agent-payment-manifest/
```

---

*SDD generado por NexusAgil — FULL*
