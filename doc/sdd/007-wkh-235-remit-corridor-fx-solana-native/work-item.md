# Work Item — [WKH-235 / HU-SOL-29] `remit-corridor-fx` nativo en Solana (registro + discovery + fee USDC-SOL)

## Resumen
Publicar una variante Solana-nativa de `remit-corridor-fx` en el marketplace A2A (`wasiai-a2a`): descubrible
en el namespace Solana, con `payTo` base58 y fee cobrado en USDC sobre Solana devnet — sin tocar el agente
Avalanche/Fuji existente (WKH-171). Cierra el track "2 de 3 agentes remit-* corren en Solana" de la tesis
multichain del programa Solana LATAM Labs (WayLearn).

## Sizing
- SDD_MODE: **mini**
- Estimación: **S**
- Branch sugerido: `feat/007-wkh-235-remit-corridor-fx-solana-native`
- **FAST + AR liviano** (no QUALITY completo) — justificación: el grounding (F0, abajo) determinó que esta
  HU NO agrega código de lógica de pago en ningún repo. `wasiai-remittance-agents` no toca `src/` en absoluto
  (el core es VM-neutral y ya no lee ningún header de payment — eso lo resuelve 100% el gateway). El único
  trabajo de código real (PaymentAdapter Solana, validación base58, settle SPL) ya está mergeado en
  `wasiai-a2a` (WKH-234). Lo que queda es (a) una sección de README documentando el registro y (b) una
  llamada runtime `POST /agents` (mutación de datos, gated por `!` humano) en `wasiai-a2a`. Se mantiene AR
  liviano porque toca el money-path adyacente (fee de un agente real, wallet de payout) aunque no cambie código.

## Grounding (F0) — hallazgos clave

### 1. Este repo (`wasiai-remittance-agents`) NO tiene código de registro/payment — cero trabajo de `src/`
`project-context.md`: "N/A — la auth/pago del caller la resuelve el gateway `wasiai-a2a` (repo externo).
Este repo no implementa auth propia." El README confirma: "Nada de lógica de pago/x402/on-chain del lado del
agente — eso lo hace el gateway." `src/app/api/agents/remit-corridor-fx/invoke/route.ts` (leído íntegro) NO
lee ningún header de payment/chain — solo `Zod.safeParse → runCorridorFx → {result}`. **No hay "binding del
payment header Solana en /invoke" que hacer**: esa idea del brief original no aplica a la arquitectura real.

### 2. El registro es SIEMPRE una llamada runtime `POST /agents`, nunca código — mismo patrón que WKH-170/171/172
Confirmado en `doc/sdd/170-wkh-172-remit-cashout-payout/work-item.md` (repo `wasiai-a2a`, DT-1): "El registro
en `wasiai-a2a` NO requiere código nuevo... Registrar `remit-cashout-payout` es una llamada HTTP en runtime,
cero código nuevo." Mismo mecanismo self-serve `POST /agents` (WKH-134/173, gratis, `requireA2AKey()`).

### 3. HALLAZGO CRÍTICO — `a2a_agents` persiste UN `payout_wallet` por slug; el Fuji existente NO puede
convivir con un wallet Solana bajo el MISMO slug
Leído `src/services/agent.ts` (repo `wasiai-a2a`) líneas 190-221 y 371-389:
- `assertValidPayoutWallet(value, payoutChain)` valida el **formato** del wallet contra la familia derivada de
  `payoutChain` (`resolvePayoutNamespace`: ausente → `'evm'`, `'solana-devnet'` → `'solana'`) — pero
  `payoutChain` **NUNCA se persiste** (no aparece en `row` del INSERT ni en `buildMetadata()`). Solo existe
  `row.payout_wallet` (columna única, string).
- Consecuencia: un mismo slug (`a2a_agents.slug` es PK) solo puede tener UN `payout_wallet`, en UN formato
  (EVM `0x...` o Solana base58, no ambos). La fila existente de `remit-corridor-fx` (WKH-171) ya tiene un
  `payout_wallet` EVM en Fuji.
- Como el AC de esta HU exige que Fuji siga **byte-idéntico** (sin tocar esa fila), la variante Solana **no
  puede reusar el slug `remit-corridor-fx`** sin (a) romper Fuji, o (b) requerir extender el schema de
  `a2a_agents` a multi-wallet-por-slug — trabajo de `wasiai-a2a` explícitamente fuera de esta HU (WKH-234 ya
  cerró su alcance sin esa extensión). **Ver DT-1 / AC-6 / Missing Input #1.**

### 4. El rail de pago Solana YA existe y es genérico — confirmado en `doc/sdd/182-wkh-234-solana-payment-adapter/story-WKH-234.md` (repo `wasiai-a2a`)
- `PublishAgentInput.payoutChain?: string` (aditivo) + `isValidPayoutWallet(wallet, 'solana')` (base58, 32
  bytes) ya validan/persisten un `payout_wallet` Solana en el publish (AC-1/AC-5 de WKH-234, ya testeado).
- `SolanaPaymentAdapter.settle()` hace el SPL-transfer real devnet, firmado por el operador del gateway
  (custodial de ese lado, espejo del path EVM) — verificado on-chain vía `verify()` (verify-before-trust).
- `SOLANA_ADAPTER_ENABLED` (flag OFF por default) gatea todo el rail — **debe confirmarse ON en prod antes de
  que un invoke real liquide en Solana** (Missing Input #3).
- El `agentUrl` que se registre puede ser el MISMO endpoint HTTP ya deployado
  (`.../api/agents/remit-corridor-fx/invoke`) — el core no distingue chain, así que no hace falta un deploy
  nuevo ni una ruta nueva.

### 5. El agente `remit-corridor-fx` es 100% VM-neutral (confirmado leyendo el código)
`src/agents/corridor-fx.ts` (`runCorridorFx`) y `src/providers/fx.ts` no referencian ninguna chain, wallet ni
header de payment. `PRICE_USDC = 0.03` (línea 11) es el precio único, independiente de en qué chain se cobre.

## Acceptance Criteria (EARS)

- AC-1: WHEN un caller consulta `POST /discover` (o `GET /agents/<slug-solana>/agent-card`) en `wasiai-a2a`
  filtrando por la capability de FX/quote en Solana, the system SHALL devolver la variante Solana-nativa con
  `payTo` en formato base58 y resoluble vía `x-payment-chain: solana`/`solana-devnet`.
- AC-2: WHEN un caller paga e invoca la variante Solana-nativa, the system SHALL liquidar el fee del agente en
  USDC sobre Solana devnet mediante `SolanaPaymentAdapter.settle()` (WKH-234), verificado on-chain por
  `verify()` antes de considerarse cobrado — nunca un cobro simulado.
- AC-3: WHILE la fila EXISTENTE `remit-corridor-fx` (Avalanche/Fuji, WKH-171) permanece sin modificar (ningún
  UPDATE/PATCH sobre esa fila), the system SHALL seguir resolviendo, cotizando y liquidando ese path
  byte-idéntico a como lo hace hoy — sin regresión del registro WKH-171.
- AC-4: the system SHALL exponer la variante Solana-nativa bajo un slug DISTINTO de `remit-corridor-fx`,
  porque `a2a_agents` persiste un único `payout_wallet` por slug y no guarda `payoutChain` (verificado
  `src/services/agent.ts`) — un slug compartido no puede sostener dos wallets/chains simultáneamente.
  `[NEEDS CLARIFICATION]`: nombre exacto del slug nuevo — ver Missing Input #1.
- AC-5: IF el `payoutWallet` provisto al registrar la variante Solana no es base58 válido / no decodifica a 32
  bytes, THEN the system SHALL rechazar el registro (`422`) y SHALL NOT persistir la fila — comportamiento ya
  implementado y testeado por WKH-234 (`assertValidPayoutWallet`), sin código nuevo requerido por esta HU.
- AC-6: IF el rail Solana del gateway está deshabilitado (`SOLANA_ADAPTER_ENABLED=false`) o falta config de
  settle (RPC/mint/operator key) al momento de invocar la variante Solana-nativa, THEN the system SHALL
  fallar cerrado (`CHAIN_NOT_SUPPORTED` / `502`, comportamiento ya cableado por WKH-234) — SHALL NEVER
  liquidar en una chain distinta a la declarada ni ejecutar el agente gratis.
- AC-7: the system SHALL registrar la variante Solana-nativa con `payoutChain: 'solana-devnet'` (nunca
  `-mainnet`) — devnet-only, cero plata real, consistente con el resto del trío `remit-*`.

## Scope IN

### `wasiai-remittance-agents` (este repo)
- **README.md** — nueva subsección bajo "Endpoint HTTP + deploy" documentando el registro Solana-nativo de
  `remit-corridor-fx` (slug nuevo, `agentUrl` reusado — el mismo `.../api/agents/remit-corridor-fx/invoke` ya
  deployado, `payoutChain: solana-devnet`). **⚠️ ARCHIVO COMPARTIDO con WKH-236** (ambas HUs agregan una
  sección nueva al mismo `README.md`) — ver Análisis de paralelismo.
- Ningún archivo de `src/` se toca (`corridor-fx.ts`, `fx.ts`, `route.ts` quedan intactos — CD-1).
- Ningún deploy nuevo de Vercel — se reusa el proyecto/deploy existente.

### `wasiai-a2a` (mutación de datos runtime, gated por `!` humano — CERO código nuevo)
- 1 llamada `POST /agents` (mecanismo self-serve WKH-134/173, ya gratis) registrando una fila NUEVA:
  - `name`/slug derivado: propuesto `remit-corridor-fx-solana` (ver Missing Input #1).
  - `agentUrl`: el mismo endpoint HTTP ya deployado de `remit-corridor-fx` (sin cambios).
  - `capabilities`: mismo array que la fila Fuji existente (a confirmar en F2 — Missing Input #4).
  - `priceUsdc`: `0.03` (= `PRICE_USDC` de `corridor-fx.ts:11`).
  - `payoutWallet`: base58 Solana devnet (Missing Input #2).
  - `payoutChain`: `'solana-devnet'`.
- Precondición a verificar (no acción de código): `SOLANA_ADAPTER_ENABLED=true` + envs Solana activos en el
  deploy prod de `wasiai-a2a` (Railway) — WKH-234 ya lo shippeó, falta confirmar el flag ON (Missing Input #3).

## Scope OUT
- La lógica de FX (`src/agents/corridor-fx.ts`, `src/providers/fx.ts`) — intacta, VM-neutral.
- El discovery chain-agnóstico (`src/services/discovery.ts` en `wasiai-a2a`) — ya genérico desde WKH-234 (W2),
  sin cambios de lógica.
- El off-ramp TransFi USDCSOL (WKH-209) — leg de cashout, no de FX quote.
- Cualquier código nuevo en `wasiai-a2a` (`PaymentAdapter`, `wallet-format.ts`, `agent.ts`) — ya shippeado por
  WKH-234; esta HU solo EJECUTA una llamada runtime contra ese código existente.
- Extender el schema de `a2a_agents` a soportar múltiples `payout_wallet` por slug (multi-chain-en-un-slug) —
  explícitamente fuera de scope; se resuelve con el slug nuevo (AC-4) en su lugar.
- `remit-kyc-validator` y `remit-cashout-payout` (WKH-236, HU hermana) — no se tocan en esta HU.
- Mainnet — devnet-only en toda esta HU (CD-4).

## Decisiones técnicas (DT-N)
- DT-1: La variante Solana-nativa se registra bajo un slug NUEVO (no `remit-corridor-fx`) porque
  `a2a_agents.payout_wallet` es un valor único por slug y `payoutChain` no se persiste (verificado
  `src/services/agent.ts:355,371-389` de `wasiai-a2a`) — reusar el slug rompería Fuji (AC-3) o exigiría
  schema nuevo (fuera de scope). Propuesta: `remit-corridor-fx-solana`. `[NEEDS CLARIFICATION]` ratificación
  del nombre exacto — Missing Input #1.
- DT-2: Se reusa el endpoint HTTP YA deployado (`/api/agents/remit-corridor-fx/invoke`) como `agentUrl` de la
  fila nueva — cero deploy nuevo, porque el core es VM-neutral y no lee ningún header de chain/payment
  (confirmado leyendo `route.ts` íntegro).
- DT-3: El registro se ejecuta vía el mecanismo self-serve `POST /agents` existente (WKH-134/173) — mismo
  patrón que WKH-170/171/172, cero código nuevo en `wasiai-a2a` (WKH-234 ya cerró la superficie de código
  necesaria: schema/validación/settle).
- DT-4: `priceUsdc = 0.03`, idéntico al `PRICE_USDC` ya exportado por `corridor-fx.ts:11` — mismo fee
  independientemente de la chain de settle.

## Constraint Directives (CD-N)
- CD-1: PROHIBIDO modificar `src/agents/corridor-fx.ts`, `src/providers/fx.ts` o
  `src/app/api/agents/remit-corridor-fx/invoke/route.ts` — el core es VM-neutral y NO debe ganar lógica de
  chain/payment (esa responsabilidad es 100% del gateway).
- CD-2: OBLIGATORIO que la fila EXISTENTE `remit-corridor-fx` (Fuji, WKH-171) en `a2a_agents` permanezca sin
  ningún UPDATE/PATCH — la variante Solana es un INSERT de fila NUEVA, nunca una modificación de la fila Fuji.
- CD-3: PROHIBIDO hardcodear el `payoutWallet` Solana, RPC o mint en cualquier archivo de código de cualquiera
  de los dos repos — es un valor de config provisto por el `!` humano al momento del `POST /agents` runtime
  (el lado del gateway ya lee todo Solana desde `process.env`, WKH-234 CD-3).
- CD-4: OBLIGATORIO devnet-only — `payoutChain: 'solana-devnet'` (nunca `-mainnet`), consistente con CD-4 de
  WKH-234 y con el resto del trío `remit-*` (testnet-only, cero plata real).
- CD-5: OBLIGATORIO coordinar el orden de merge de `README.md` con WKH-236 (mismo archivo, secciones
  distintas y no solapadas) — preferir PRs secuenciales (mergear una, rebasear la otra) sobre mutaciones
  simultáneas del mismo archivo.

## Missing Inputs

1. **[BLOQUEANTE, antes de F2]** Nombre exacto del slug nuevo para la variante Solana-nativa. Recomendación
   del Analyst: `remit-corridor-fx-solana` (legible, sin colisión, consistente con el patrón `remit-<slug>`).
   Alternativa: `remit-corridor-fx-sol`. Determina el `name` exacto del payload `POST /agents`.
2. **[BLOQUEANTE, `!` humano]** `payoutWallet` Solana devnet (base58) a declarar en el registro — mismo
   patrón que WKH-170/171/172 (wallet testnet del founder/operador, distinta de la wallet EVM de Fuji).
3. **[BLOQUEANTE, `!` humano, verificación de infra]** Confirmar que `SOLANA_ADAPTER_ENABLED=true` + los envs
   Solana (`SOLANA_RPC_URL`, `SOLANA_USDC_MINT_DEVNET`, `SOLANA_OPERATOR_PRIVATE_KEY`, etc., WKH-234) están
   seteados en el deploy prod de `wasiai-a2a` (Railway). Si no lo están, la fila se puede registrar igual,
   pero cualquier invoke con settle en Solana fallará cerrado (AC-6) hasta activarlos.
4. **[resuelto en F2, no bloqueante]** `capabilities` array exacto a copiar de la fila Fuji existente de
   `remit-corridor-fx` — el Architect lo puede leer vía `GET /agents/mine` (o `/discover`) contra prod antes
   de armar el payload de registro, para que ambas variantes compartan la misma capability discoverable.
5. **[NEEDS CLARIFICATION, no bloqueante]** ¿El pitch/demo necesita que Fuji y Solana aparezcan combinadas en
   un mismo resultado de `/discover`, o alcanza con que cada slug sea descubrible por separado filtrando por
   chain? Se asume lo segundo (comportamiento default del discovery federado ya existente); si el humano
   quiere una vista unificada en el pitch, es un ítem de UI/demo fuera de scope de estos dos repos.

## Análisis de paralelismo
- **Simétrica con WKH-236** (`remit-cashout-payout` nativo en Solana) — misma naturaleza: registro de slug
  nuevo + cero código de lógica nuevo, mismo hallazgo del constraint de `payout_wallet` único por slug.
- **Archivo COMPARTIDO con WKH-236 (único)**: `README.md` en `wasiai-remittance-agents` — ambas HUs agregan
  una subsección nueva. Sin conflicto de lógica (secciones independientes), pero riesgo de conflicto de merge
  si se codean/mergean simultáneamente. Recomendación: mergear WKH-235 primero, luego rebasear WKH-236 (o
  viceversa) — NO trabajar ambas ramas en paralelo sobre el mismo commit base sin rebase intermedio.
- **NINGÚN archivo de `src/` se comparte** entre WKH-235 y WKH-236 en `wasiai-remittance-agents` (agentes,
  cores y rutas HTTP distintos: `corridor-fx.ts`/`route.ts` de FX vs `cashout-payout.ts`/`route.ts` de payout).
- En `wasiai-a2a`: ambas HUs son mutaciones de datos (`POST /agents`) sobre filas de slug DISTINTO — sin
  conflicto de archivo/código; se recomienda no ejecutar los dos `!` de registro simultáneamente por claridad
  de auditoría, no por riesgo técnico real.
- **No bloquea** ni depende de HUs en curso de `wasiai-a2a` fuera de WKH-234 (ya mergeado) — no toca
  `orchestrate.ts`/`compose.ts`/`discovery.ts`.
- Puede correr en paralelo con `WKH-209` (TransFi off-ramp USDCSOL) — leg distinta del pipeline (FX quote vs
  cashout), sin superficie de archivo compartida.
