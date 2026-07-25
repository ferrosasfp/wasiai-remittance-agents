# Work Item — [WKH-236] HU-SOL-30 · `remit-cashout-payout` nativo en Solana (registro + discovery + fee USDC-SOL)

## Resumen
Hacer que `remit-cashout-payout` sea descubrible/facturable de forma NATIVA en el namespace Solana
(payTo base58, fee x402 en USDC-devnet), en paralelo a su registro EXISTENTE en Avalanche Fuji
(WKH-172), sin regresionarlo. **Hallazgo crítico de F0**: el repo `wasiai-remittance-agents` es
VM-neutral por diseño — `/invoke` no tiene NINGUNA noción de chain/pago (eso lo resuelve
`wasiai-a2a`). El Scope IN de código real de esta HU vive casi enteramente FUERA de este repo.

## Sizing
- SDD_MODE: **mini** (Scope IN de código en este repo = 0 archivos de `src/`; documentación opcional)
- Estimación: **S**
- Branch sugerido: `feat/008-wkh-236-cashout-payout-solana-native` (probablemente sin commits de código,
  solo si se decide documentar en README.md)

> **Nota de riesgo real**: el money-path de esta HU (payTo/payoutChain, registro en `a2a_agents`) no
> vive en este branch/repo — vive en una mutación de prod de `wasiai-a2a` (`!` humano). El "riesgo
> QUALITY" que amerita escrutinio está en ESE repo, no en este work-item.

## Grounding (F0) — hallazgos clave

### 1. Este repo no tiene NINGÚN código de payment/chain (confirmado, no supuesto)
`project-context.md:172-174`: *"la auth/pago del caller la resuelve el gateway `wasiai-a2a`... Este
repo no implementa auth propia."* `README.md:24`: *"Nada de lógica de pago/x402/on-chain del lado del
agente — eso lo hace el gateway."* Confirmado leyendo el código real:
- `src/app/api/agents/remit-cashout-payout/invoke/route.ts` (31 líneas): Zod parse → `runCashoutPayout()`
  → `{result}` / `400` / `502`. CERO referencia a `payTo`, `chain`, `x-payment-chain`, headers de pago.
- `src/agents/cashout-payout.ts`: CERO referencia a chain/wallet — su único "wallet-like" es
  `beneficiary.destination` (Yape/CCI, PII, no cripto).
- `Glob **/*registr*`, `Glob **/register*`, `Glob scripts/**` en este repo → **0 resultados**. No existe
  agent-card, registry, ni script de registro en `wasiai-remittance-agents`.
- No existe `.env` de payTo/wallet para este agente en `project-context.md` §Variables de Entorno.

### 2. El mecanismo de registro (dónde vive `payTo`) ya fue documentado por WKH-172 — y NO requiere código
El work-item de WKH-172 (`wasiai-a2a/doc/sdd/170-wkh-172-remit-cashout-payout/work-item.md:26-31`) ya
estableció el precedente exacto: *"El registro en `wasiai-a2a` NO requiere código nuevo... Registrar
`remit-cashout-payout` es una llamada HTTP en runtime, cero código nuevo en `wasiai-a2a`."* El mecanismo
es `POST /agents` (self-serve, WKH-134/173) → persiste en `a2a_agents` (`src/services/agent.ts`).

### 3. La infraestructura Solana-native de ese mecanismo YA está mergeada (WKH-234) — otra vez cero código
Verificado leyendo `wasiai-a2a/src/services/agent.ts:191-221` y `wasiai-a2a/src/routes/agents.ts:74-95`:
`publishedAgentService.publish()`/`.update()` ya son **namespace-aware**: `payoutChain` se resuelve vía
`normalizeChainSlug()` (`src/adapters/chain-resolver.ts:65-66`, `'solana-devnet'`/`'solana'` →
`ChainKey 'solana-devnet'`), y si resuelve a Solana, `payoutWallet` se valida como **base58** (helper
`isValidPayoutWallet(v, 'solana')` de `src/lib/wallet-format.ts`) en vez del formato EVM. Devnet-only:
`chain-resolver.ts:64` documenta explícitamente *"sin `solana-mainnet`"*.

### 4. ⚠️ HALLAZGO CRÍTICO — `a2a_agents` solo admite UN `payout_wallet`/`payout_chain` por slug
`AgentRow` (`agent.ts:47-58`) tiene columnas singulares `payout_wallet`/(chain resuelto por parámetro,
no persistido como array). `slug` es la PK. **Registrar `payoutChain: solana-devnet` sobre el slug
EXISTENTE `remit-cashout-payout` (hoy Fuji, WKH-172) REEMPLAZARÍA su `payout_wallet` actual** — esto
violaría el AC-3 de esta misma HU ("el path Avalanche/Fuji existente sigue byte-idéntico"). El
mecanismo, tal como está construido, es **un chain por slug, no multi-chain por agente**. Ver Missing
Input #1 (bloqueante) — determina si esta HU necesita un slug nuevo (`remit-cashout-payout-solana` o
similar) o si `wasiai-a2a` necesita una extensión de schema (multi-chain payout) que NO existe hoy y que
sería Scope OUT de esta HU en este repo de todas formas.

### 5. El fee x402 en USDC-Solana del CALLER (AC-2 del brief) es ORTOGONAL al registro del agente
El `x-payment-chain: solana` header (verificado por el facilitator vía el adapter Solana, WKH-205,
`wasiai-a2a/src/adapters/solana/payment.ts`, ya mergeado) lo elige el **caller** en tiempo de invocación
(`resolveChainKey()`, prioridad header > manifest > default, `chain-resolver.ts:92-103`) — es
**independiente** de en qué chain el agente declaró su `payout_wallet` propio. Es decir: **hoy mismo**,
sin tocar el registro de `remit-cashout-payout` (que sigue en Fuji), un caller YA puede pagar la
invocación en USDC-Solana-devnet si manda `x-payment-chain: solana`. Este sub-AC no depende de ningún
cambio de registro — es verificable contra el estado actual del sistema.

### 6. Distinción con WKH-209/WKH-232 (no confundir, ya DONE en este repo)
`TRANSFI_USDC_NETWORK=solana` + `TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS` (README.md:50-51,
project-context.md:158,167) es la red del **off-ramp de cash-out** (a dónde TransFi manda el USDC para
liquidar Yape/Plin) — un concern totalmente distinto del `payTo`/fee de invocación del agente en el
marketplace A2A. Esta HU (WKH-236) NO toca eso; ya está DONE.

### 7. `PAYOUT_ALLOW_MOCK` / `assertPayoutProviderSafe()` no tienen relación con esta HU
El gate de desembolso (`cashout-payout.ts:66-93`) decide si el mock/real EJECUTA el payout — es
ortogonal a en qué chain se cobra el fee de invocar el agente. Confirmado que esta HU no tiene ninguna
razón técnica para tocar ese fail-safe.

## Acceptance Criteria (EARS)

- AC-1: WHEN un caller consulta `GET /agents/remit-cashout-payout-solana/agent-card` (o el slug que
  resulte del Missing Input #1) en `wasiai-a2a`, the system SHALL devolver un agente activo con
  `payoutChain: "solana-devnet"` y un `payoutWallet` en formato base58 válido — SIN requerir código
  nuevo en `wasiai-a2a` (WKH-234 ya lo soporta) ni en este repo. `[NEEDS CLARIFICATION: slug — ver
  Missing Input #1]`
- AC-2: WHEN un caller invoca `remit-cashout-payout` (el slug Fuji EXISTENTE de WKH-172, sin cambios)
  mandando `x-payment-chain: solana`, the system SHALL liquidar el fee de invocación en USDC sobre
  Solana devnet vía el adapter del facilitator (WKH-205, ya mergeado) — **verificable HOY, sin esperar
  ningún registro nuevo** (Grounding #5). Este AC es una confirmación de infraestructura existente, no
  requiere Scope IN de código.
- AC-3: WHILE el registro Fuji de `remit-cashout-payout` (slug, `payout_wallet`, `payout_chain`
  implícito EVM) existe en `a2a_agents`, the system SHALL preservarlo byte-idéntico — ninguna acción de
  esta HU (incluyendo cualquier llamada `!` humano `POST`/`PATCH /agents`) SHALL mutar esa fila.
- AC-4: WHILE se completa esta HU, the system SHALL mantener `PAYOUT_ALLOW_MOCK` y
  `assertPayoutProviderSafe()` (`src/agents/cashout-payout.ts`) sin ningún cambio — el desembolso real
  sigue gated por su mecanismo actual, ajeno al chain de cobro del fee.
- AC-5: IF se agrega documentación en `README.md` de este repo, THEN the system SHALL limitarla a una
  sección aditiva nueva (no editar las secciones existentes de `remit-corridor-fx`/`remit-kyc-validator`/
  `remit-cashout-payout` etapa 1) y SHALL declarar explícitamente que el payTo/chain vive en el registro
  de `wasiai-a2a`, no en este código.

## Scope IN

### `wasiai-remittance-agents` (este repo — el único que me corresponde declarar)
- **CERO archivos de `src/`.** Confirmado por grounding #1: no hay superficie de código de
  payment/chain en este repo para tocar.
- `README.md` — **opcional**, una subsección nueva ("Registro Solana-native — WKH-236") documentando
  que el `payTo`/`payoutChain` de este agente en Solana se gestiona en `wasiai-a2a` (fuera de este
  código), mirror informativo de cómo ya se documentó Fuji (README.md:118-179). NO bloqueante para
  cerrar la HU si el humano prefiere omitirlo.
- `doc/BACKLOG.md` — opcional, entrada cross-repo apuntando a la acción operativa pendiente en
  `wasiai-a2a` (mismo patrón que la fila "Cross-repo" existente, `doc/BACKLOG.md:30-35`).

### `wasiai-a2a` (fuera de mi scope de escritura — SOLO para que el orquestador lo vea)
- CERO código nuevo (WKH-234/WKH-205 ya construyeron la infraestructura genérica).
- Acción operativa `!` humano: `POST /agents` (registro de un slug nuevo, ver Missing Input #1) o
  `PATCH /agents/:slug` — mutación de datos de prod, gated por `!` humano, análoga a WKH-172 Missing
  Input #2/#3.

## Scope OUT
- Cualquier archivo de `src/agents/cashout-payout.ts`, `src/providers/payout.ts`,
  `src/app/api/agents/remit-cashout-payout/invoke/route.ts` — el core es VM-neutral, esta HU no cambia
  su lógica (confirmado, no hay ningún gap de código que resolver ahí).
- `TRANSFI_USDC_NETWORK` / `TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS` (WKH-209/WKH-232) — ya DONE, concern
  distinto (red del off-ramp de cash-out, no el fee de invocación del agente).
- Cualquier código en `wasiai-a2a` (`src/adapters/solana/*`, `src/services/agent.ts`,
  `src/routes/agents.ts`, `src/adapters/chain-resolver.ts`) — ya mergeado, no se toca.
- La lógica de payout real / integración TransFi (WKH-209 cubre el off-ramp USDCSOL) — igual que el
  brief original.
- El discovery chain-agnóstico (`discoveryService`) — igual que el brief original, ya funciona.
- `remit-corridor-fx` / `remit-kyc-validator` — no se tocan desde esta HU (ver WKH-235 para el
  hermano de FX).
- Cualquier extensión de schema multi-chain-por-slug en `a2a_agents` — si el Missing Input #1 se
  resuelve por esa vía, es una HU aparte en `wasiai-a2a`, no de este repo.

## Decisiones técnicas (DT-N)
- DT-1: Este repo NO aporta código funcional a esta HU — confirmado por grounding, no por conveniencia
  (VM-neutral core, README.md:24).
- DT-2: El mecanismo de registro es el self-serve `POST`/`PATCH /agents` de `wasiai-a2a` (WKH-134/173),
  con soporte namespace-aware para Solana YA mergeado (WKH-234) — cero código nuevo en ningún repo.
- DT-3 (recomendación del Analyst, sujeta a Missing Input #1): registrar un **slug NUEVO y distinto**
  (ej. `remit-cashout-payout-solana`) apuntando al MISMO `agent_url` (mismo deploy Vercel, mismo
  `/invoke`), en vez de mutar el slug Fuji existente — porque `a2a_agents` solo admite un
  `payout_wallet`/chain por fila (grounding #4), y mutar la fila existente violaría AC-3. Cero deploy
  nuevo, cero código nuevo — solo una segunda llamada `POST /agents` con `payoutChain: "solana-devnet"`.
- DT-4: El AC-2 del brief (fee del CALLER en USDC-Solana) es verificable HOY contra el slug Fuji
  existente sin ningún cambio de registro — es ortogonal (grounding #5).
- DT-5: `PAYOUT_ALLOW_MOCK`/`assertPayoutProviderSafe()` permanecen intactos — no hay ninguna razón
  técnica encontrada en el grounding para tocarlos en esta HU.

## Constraint Directives (CD-N)
- CD-1: PROHIBIDO modificar `src/agents/cashout-payout.ts`, `src/providers/payout.ts` o
  `src/app/api/agents/remit-cashout-payout/invoke/route.ts` en el marco de esta HU.
- CD-2: PROHIBIDO que cualquier acción `!` humano de registro mute la fila EXISTENTE
  `a2a_agents.slug = 'remit-cashout-payout'` (Fuji, WKH-172) — cualquier registro Solana-native usa un
  slug nuevo y distinto (DT-3). Un `PATCH` sobre el slug Fuji con `payoutChain: solana-devnet` es
  BLOQUEANTE / incidente de regresión de AC-3.
- CD-3: PROHIBIDO hardcodear el `payoutWallet` base58 en cualquier archivo de este repo (no hay ningún
  archivo de este repo donde deba vivir — si aparece, es señal de que se malinterpretó el scope).
- CD-4: OBLIGATORIO devnet-only — ningún `payoutChain` distinto de `solana-devnet` (no existe
  `solana-mainnet` en `chain-resolver.ts`, confirmado).
- CD-5: PROHIBIDO tocar `TRANSFI_USDC_NETWORK`/`TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS` o cualquier
  archivo de `src/providers/payout.ts` relacionado al off-ramp Solana (WKH-209/232, concern distinto).
- CD-6: Si se agrega la sección opcional a `README.md`, OBLIGATORIO coordinar con WKH-235 (HU hermana,
  puede tocar el mismo archivo con su propia subsección) para evitar conflicto de merge — cada HU
  agrega su propia sección al final, sin editar líneas de la otra.

## Missing Inputs

1. **[BLOQUEANTE, decisión humana/Architect — antes de F2, y afecta principalmente a `wasiai-a2a`]**
   `a2a_agents` no soporta multi-chain-por-slug (grounding #4). Opciones:
   - **(a)** (recomendada por el Analyst) Slug nuevo `remit-cashout-payout-solana` (o convención similar)
     apuntando al mismo `agent_url` — cero código, cero regresión, aditivo. Análogo al patrón "v2 en
     paralelo, slug nuevo" que ya usó todo el trío `remit-*` frente a `agentshop-*`.
   - **(b)** Extender `a2a_agents` a multi-chain-por-agente (columna JSONB de payouts por chain) — HU
     aparte en `wasiai-a2a`, fuera de scope de este repo, mayor superficie de cambio (money-path,
     AR obligatorio).
   Esta decisión determina el slug exacto de AC-1 y el contenido exacto de la llamada `!` humano.
2. **[BLOQUEANTE, `!` humano, ejecuta en `wasiai-a2a` no en este repo]** Wallet Solana **devnet**
   base58 a declarar como `payoutWallet` del registro nuevo (creator-split) — cero plata real, pero
   necesita una keypair devnet real generada u operativa.
3. **[BLOQUEANTE, `!` humano]** a2a-key/owner_ref con el que se ejecuta el `POST /agents` en
   `wasiai-a2a` prod — mismo patrón que WKH-172 Missing Input #2 (puede ser el mismo owner del trío
   `remit-*` o uno nuevo, indistinto porque el slug es nuevo).
4. **[NEEDS CLARIFICATION, no bloqueante]** El brief menciona "consulta /discover por la capability de
   payout/disbursement en Solana" — no se confirmó en este grounding (repo remit-agents no tiene
   discovery) si `/discover` filtra agentes POR CHAIN hoy, o si el filtrado por chain es responsabilidad
   exclusiva del caller vía `x-payment-chain` en tiempo de invocación (independiente de qué muestra
   `/discover`). Si `/discover` no filtra por chain, AC-1 solo se cumple a nivel de "el agent-card
   individual expone `payoutChain: solana-devnet`", no a nivel de un filtro de búsqueda — verificar en
   `wasiai-a2a` antes de F2 (fuera de mi grounding en este repo).
5. **[NEEDS CLARIFICATION, no bloqueante]** Si el humano prefiere NO documentar nada en `README.md` de
   este repo (dado que Scope IN es 0 código), esta HU podría cerrarse en este repo sin ningún commit —
   el "DONE" real ocurriría enteramente como una acción operativa en `wasiai-a2a`. Confirmar con el
   orquestador si igual se desea el commit de documentación mínimo por trazabilidad.

## Análisis de paralelismo
- **WKH-235** (`remit-corridor-fx` nativo Solana) es la HU hermana simétrica, corriendo en paralelo
  (ya tiene su propio work-item registrado en este `_INDEX.md`, fila 007). Por el mismo grounding (este
  repo es VM-neutral), es altamente probable que WKH-235 llegue a la MISMA conclusión: 0 archivos de
  `src/` en Scope IN. El único archivo potencialmente COMPARTIDO entre ambas en este repo es `README.md`
  (si ambas deciden documentar) — mismo archivo, pero cada HU agrega su propia subsección nueva al final
  (bajo riesgo de conflicto real de merge, pero coordinar el ORDEN). Ningún archivo de `src/agents/`,
  `src/providers/` ni `src/app/api/` se superpone (`cashout-payout.ts` vs `corridor-fx.ts` son módulos
  distintos).
- Esta HU **no bloquea** ni es bloqueada por ninguna HU en curso de este repo (no toca `src/`).
- El verdadero prerequisito/bloqueante para el AC-1 real es CROSS-REPO y vive en `wasiai-a2a`: la
  decisión del Missing Input #1 (slug nuevo vs schema multi-chain) y la ejecución `!` humano del
  registro. Recomendación al orquestador: considerar abrir (o verificar si ya existe) un work-item
  espejo en `wasiai-a2a` para esa acción operativa — el trabajo real de "registro" de WKH-236 vive ahí,
  no en este repo, tal como pasó con WKH-172 (Scope IN de `wasiai-a2a` = "CERO código, 1 llamada HTTP").
