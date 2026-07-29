# Work Item — [WKH-300] Los 3 agentes remit-* deben declarar su forma de cobro en su propio manifiesto

## Resumen
`remit-kyc-validator` corre en producción **cobrando $0**: el caller paga al gateway, el paso se
ejecuta, pero el settle downstream hacia el operador del agente se saltea en silencio
(`NO_PAYMENT_FIELD`, `wasiai-a2a/src/lib/downstream-payment.ts:508-514`) porque su fila en
`a2a_agents` nunca declaró `metadata.payment`. Esta HU introduce un **manifiesto publicado por cada
agente** (`wasiai-remittance-agents`) como fuente de verdad de `capabilities` + forma de cobro
(chain/contract/asset), en vez de que ese dato se tipee a mano fila por fila en Supabase — y define
que un agente sin manifiesto válido **debe ser rechazado al registrarse**, no aceptado en silencio.
Arquitectura objetivo: KYC cobra en Avalanche (Fuji), FX y payout cobran en Solana (devnet).

## Sizing
- **QUALITY** — fundamento:
  1. Toca money-path activo en producción (el fee real que cobra cada agente, no solo lectura).
  2. Cruza 2 repos (`wasiai-remittance-agents` publica el manifiesto; `wasiai-a2a` necesita un
     write-path nuevo que lo consuma con validación — hoy `POST /agents` **no acepta** un campo
     `payment` en absoluto, confirmado leyendo `src/services/agent.ts` de `wasiai-a2a`: `buildMetadata()`
     solo mergea `inputSchema`/`outputSchema`/`discoverable`).
  3. Introduce un gate fail-closed NUEVO (rechazar registro sin manifiesto) — exactamente el ítem
     que el propio AR de WKH-241 dejó diferido como pre-requisito (`AR-4`, ver Grounding #3): *"will
     need allowlist of operator's allowed payment chains + payTo ownership verification, else
     becomes BLQ-ALTO... schedule as gating issue for write-path HU"*.
  4. Hay una tensión de diseño real sin resolver (manifiesto por URL vs. por slug — ver Missing
     Input #1) que exige diseño explícito en F2, no un parche.
- Branch sugerido: `feat/010-wkh-300-agent-payment-manifest`

## Grounding (F0) — hallazgos clave

### 1. La causa raíz confirmada: `remit-kyc-validator` nunca declaró `payment`, y hoy NO HAY forma de hacerlo vía API
El runbook de registro de WKH-170 (`wasiai-a2a/doc/sdd/169-wkh-170-remit-kyc-validator/done-report.md`,
sección W4) usa el payload `{ name, agentUrl, priceUsdc, capabilities, payoutWallet, ... }` — **sin
campo `payment`**. `payoutWallet` no es el mismo dato: alimenta el creator-split del 1% del protocol
fee (`resolveAgentSplitContext`), NO el payTo del precio completo del agente que consume
`signAndSettleDownstream`. Ese campo (`metadata.payment`) hoy solo llegó a 2 filas
(`remit-corridor-fx-solana`, `remit-cashout-payout-solana`) por escritura directa en Supabase, **fuera
de cualquier API** — confirmado en `wasiai-a2a/doc/sdd/184-wkh-241-expose-self-published-payment-spec/work-item.md`
("Missing Inputs": *"¿Cómo llegó `metadata.payment`?... Asumido: escritura directa en DB (SQL/migración)
fuera de este repo"*). `remit-corridor-fx`/`remit-cashout-payout` (los slugs Fuji originales, WKH-171/172)
tampoco lo tienen — mismo patrón que dejó a KYC en $0, solo que a ellos los salvó el `x-payment-chain`
default del gateway (Fuji), no una declaración explícita.

### 2. El mecanismo de LECTURA ya existe (WKH-241, mergeado) — el gap es de ESCRITURA + VALIDACIÓN
`readPaymentSpec()` (`wasiai-a2a/src/lib/payment-spec-reader.ts`) es el único choke-point que deriva
`Agent.payment` desde `metadata.payment`, usado por `mapRowToAgent` (self-published) y `mapAgent`
(registries federados). Está probado (17 tests, AR/CR APPROVED, `done-report.md` de WKH-241). **No
hace falta tocar esta pieza.** El gap es 100% en cómo ese `metadata.payment` LLEGA a la fila.

### 3. El propio AR de WKH-241 ya pidió esta HU (AR-4, no ejecutado hasta ahora)
Cita textual del `done-report.md` de WKH-241: *"AR-4 (pre-existing, not new to this HU): When
write-path API is added (POST/PATCH /agents accepting metadata.payment), will need allowlist of
operator's allowed payment chains + payTo ownership verification, else becomes BLQ-ALTO (anyone can
re-route their agent's fee to a wallet they don't own). Schedule as gating issue for write-path HU."*
Esta HU **es** esa write-path HU.

### 4. Este repo (`wasiai-remittance-agents`) NO publica ningún manifiesto hoy
Confirmado por `Glob` de `src/**/*.ts`: no existe `.well-known/`, ni ruta `agent.json`, ni endpoint de
manifiesto/capabilities. Los 3 endpoints (`/api/agents/<slug>/invoke`) son wrappers finos
`zod → provider → {result}` sin ningún concepto de "quién soy, qué cobro" — eso vivió siempre
**fuera** del código (el payload W4 tipeado a mano en el runbook, o el SQL directo de los 2 Solana).

### 5. Tensión de diseño no resuelta: el manifiesto es por URL, pero hay slugs duplicados sobre la MISMA URL
`remit-corridor-fx` (Fuji, WKH-171) y `remit-corridor-fx-solana` (WKH-235) — igual con
`remit-cashout-payout`/`remit-cashout-payout-solana` (WKH-236) — comparten el **mismo** `agentUrl`
desplegado (DT-2 de WKH-235: *"Se reusa el endpoint HTTP YA deployado... el core no distingue
chain"*). Un manifiesto fetcheado desde ese `agentUrl` solo puede declarar **una** chain de cobro por
endpoint. Si "FX y payout cobran en Solana" es la arquitectura objetivo, esto implica que el slug
canónico de FX/payout pasa a declarar Solana — lo cual puede leerse como **reemplazo** del par de
slugs Fuji+Solana por uno solo, o como **coexistencia** donde solo el manifiesto de la app entera
(no por-slug) declara Solana y el slug Fuji queda deprecado. Ver Missing Input #1 — bloqueante para F2.

### 6. `remit-kyc-validator` no tiene hoy ninguna variante Solana — su chain objetivo es Avalanche/Fuji
Consistente con el resto del trío original (WKH-170/171/172, todos registrados con
`x-payment-chain: avalanche-fuji`). El manifiesto de KYC debe declarar `chain: 'avalanche-fuji'`,
`contract: <payTo EVM testnet>`.

## Acceptance Criteria (EARS)

- AC-1: WHEN se consulta el manifiesto publicado de `remit-kyc-validator`, the system SHALL exponer
  `capabilities` (mínimo `["kyc-verification","aml-screening","travel-rule","remittance-compliance"]`,
  consistente con el registro original WKH-170) y `payment: { method: "x402", chain:
  "avalanche-fuji", contract: "0x<payTo>", asset: "USDC" }` en el mismo shape `AgentPaymentSpec` que
  ya consume `readPaymentSpec()` en `wasiai-a2a`.
- AC-2: WHEN se consulta el manifiesto de las variantes de `remit-corridor-fx` y
  `remit-cashout-payout` que este repo declara como canónicas para cobro, the system SHALL exponer
  `payment.chain: "solana-devnet"` — `[NEEDS CLARIFICATION]` bajo qué slug exacto (ver Missing
  Input #1: reemplazo del slug Fuji vs. coexistencia).
- AC-3: IF un agente se registra en `wasiai-a2a` (`POST /agents`, self-serve) sin un `payment`
  válido en el payload/manifiesto, THEN the system SHALL rechazar el registro (422, sin persistir
  fila) — nunca aceptar en silencio una fila que después cobra $0 sin ninguna señal. Aplica **solo**
  a agentes nuevos registrados después de que esta política entre en vigor (ver CD-2, no
  retroactivo).
- AC-4: WHILE las filas ya registradas de `remit-corridor-fx`/`remit-cashout-payout` (Fuji, WKH-171/172)
  y las variantes Solana (WKH-235/236) siguen activas, the system SHALL preservar su comportamiento
  actual byte-idéntico durante esta HU — ningún UPDATE/PATCH sobre esas filas como efecto colateral
  de introducir el manifiesto.
- AC-5: WHEN el operador registra o actualiza `remit-kyc-validator` con los datos de su manifiesto
  (chain Avalanche/Fuji, contract = payTo del operador), the system SHALL persistir `metadata.payment`
  de forma que `GET /discover`/`getAgent` lo exponga (vía `readPaymentSpec`, sin cambios en esa
  pieza) y `signAndSettleDownstream` deje de emitir `NO_PAYMENT_FIELD` para ese slug.
- AC-6: IF el `payment.contract` declarado en un manifiesto no tiene el formato válido para su
  familia de chain (EVM `0x`+40-hex / Solana base58 32 bytes) o el caller no puede demostrar
  ownership del `payTo` declarado, THEN el write-path SHALL rechazar la escritura — cierra el hueco
  que el propio AR-4 de WKH-241 dejó pendiente (nadie puede redirigir el fee de un agente ajeno a su
  propia wallet).

## Scope IN

### `wasiai-remittance-agents` (este repo — código real de esta HU)
- Manifiesto por agente: expone `capabilities` + `payment` para los 3 slugs canónicos del trío
  (`remit-kyc-validator`, y los 2 slugs de FX/payout que se definan en F2 tras Missing Input #1).
  Forma exacta (una ruta `.well-known/agent.json` por deploy vs. `GET /api/agents/<slug>/manifest`
  por endpoint) se decide en F2 — el Architect debe resolver la tensión del hallazgo #5 antes de
  fijar la ruta.
- `README.md` — sección documentando el manifiesto y cómo un operador lo usa para poblar el
  registro (reemplaza el payload "tipeado a mano" del runbook W4 de WKH-170).
- Ningún archivo de `src/agents/*.ts` o `src/providers/*.ts` se toca (lógica core intacta, CD-1).

### `wasiai-a2a` (cross-repo, companion — ver Missing Inputs, NO ejecutado por esta HU directamente)
- Extender `POST /agents` (y `PATCH /agents` si aplica) para aceptar `payment` explícito, con
  allowlist de chains conocidas + validación de formato de `contract` + verificación de ownership del
  `payTo` (cierra AR-4 de WKH-241). Esta pieza es código NUEVO en un repo distinto — se documenta acá
  como dependencia bloqueante, no se implementa en este work-item (mismo criterio de separación de
  repos que usaron WKH-235/236).
- Gate fail-closed de registro sin `payment` (AC-3/AC-6) — vive en esa misma extensión.
- Fix inmediato/interino para `remit-kyc-validator`: mientras el write-path API no existe, se puede
  desbloquear el bug de $0 con el MISMO mecanismo usado para las 2 filas Solana (escritura directa en
  Supabase de `metadata.payment`), como runbook `!` humano — no requiere esperar a esta HU completa.
  Recomendado como acción inmediata desacoplada (ver Missing Input #4).

## Scope OUT
- Tocar `src/agents/kyc-validator.ts`, `src/agents/corridor-fx.ts`, `src/agents/cashout-payout.ts`
  o sus providers — la lógica de negocio no cambia, solo la declaración de cobro.
- Modificar las filas EXISTENTES de `a2a_agents` (Fuji WKH-171/172, Solana WKH-235/236) como parte
  del código de esta HU (AC-4) — cualquier migración de esas filas es una decisión operativa aparte.
- Implementar el write-path (`POST`/`PATCH /agents` con `payment`) dentro de este repo — es código de
  `wasiai-a2a`, fuera de este repo por diseño (mismo patrón WKH-235/236/241).
- Rediseñar `readPaymentSpec()` o el settle downstream — ya code-complete y testeado (WKH-241/234).
- Activar Solana en prod (`SOLANA_ADAPTER_ENABLED`, `WASIAI_DOWNSTREAM_X402`) — config/ops
  founder-gated, ya cubierto por el checklist de activación de WKH-241.
- Mainnet — devnet/testnet-only en todo el alcance (CD-3).

## Decisiones técnicas (DT-N)
- DT-1: El manifiesto es la fuente de verdad DECLARADA por el agente; el registro en `a2a_agents`
  sigue siendo la fuente de verdad PERSISTIDA/consultada en runtime (discovery no hace fetch en
  caliente al manifiesto en cada request — sigue el patrón actual de `metadata` JSONB). El
  manifiesto se lee **al registrar/actualizar**, no en cada `/discover`.
- DT-2: `metadata.payment` sigue siendo el campo que consume `readPaymentSpec()` (WKH-241) —
  ningún shape nuevo, ninguna segunda fuente de `Agent.payment`. El manifiesto de este repo produce
  exactamente ese shape (`AgentPaymentSpec`) para que el mapeo al registro sea 1:1.
- DT-3: `payout_wallet`/`payoutChain` (creator-split 1%) y `payment` (payTo del precio completo)
  siguen siendo campos DISTINTOS (heredado de DT-2/CD-3 de WKH-241) — el manifiesto de esta HU
  declara ambos por separado si corresponde, nunca los deriva uno del otro.

## Constraint Directives (CD-N)
- CD-1: PROHIBIDO modificar la lógica de negocio de los 3 agentes (`kyc-validator.ts`,
  `corridor-fx.ts`, `cashout-payout.ts`, sus `providers/*`) — esta HU es puramente declarativa
  (manifiesto), no cambia qué hace cada agente.
- CD-2: OBLIGATORIO que el gate fail-closed de "sin manifiesto → rechazado" (AC-3) NO sea
  retroactivo — las filas ya registradas sin `metadata.payment` (la mayoría de agentes self-published
  hoy, per WKH-241 AC-2) siguen funcionando byte-idéntico hasta que se migren explícitamente. Un
  gate retroactivo tumbaría agentes de terceros en producción sin aviso.
- CD-3: OBLIGATORIO devnet/testnet-only (`avalanche-fuji`, `solana-devnet`) en cualquier valor de
  `chain` declarado por el manifiesto — cero mainnet en esta HU.
- CD-4: PROHIBIDO hardcodear wallets/RPCs/contracts en código — el `payTo` de cada agente es config
  (env var o input del operador al registrar), nunca un literal en `src/`.

## Missing Inputs

1. **[BLOQUEANTE, antes de F2]** Hallazgo #5: ¿el manifiesto de FX/payout declara Solana bajo el
   slug Fuji EXISTENTE (`remit-corridor-fx`/`remit-cashout-payout`, deprecando de facto su cobro en
   Avalanche) o bajo los slugs Solana ya registrados (`remit-corridor-fx-solana`/
   `remit-cashout-payout-solana`, WKH-235/236, dejando el par Fuji intacto y sin manifiesto de
   cobro)? Determina cuántas rutas de manifiesto expone este repo y si AC-4 alcanza a los slugs Fuji.
2. **[BLOQUEANTE, `!` humano]** `payTo` EVM testnet (Avalanche Fuji) del operador para el manifiesto
   de `remit-kyc-validator` — mismo dato que faltó en el runbook W4 original de WKH-170.
3. **[BLOQUEANTE, cross-repo]** Confirmar si el humano quiere que esta HU incluya la implementación
   del write-path en `wasiai-a2a` (companion HU en ESE repo) como parte del mismo ciclo, o si se
   despacha como HU separada allá (recomendación del Analyst: separada, mismo patrón que
   WKH-235/236/241 — evita mezclar dos repos en un solo Story File).
4. **[no bloqueante, acción inmediata sugerida]** Mientras el write-path no exista, el bug de $0 de
   `remit-kyc-validator` se puede parchear YA con una escritura directa de `metadata.payment` en
   Supabase (mismo mecanismo ad-hoc que ya se usó para los 2 agentes Solana) — desacoplado de esta
   HU, requiere solo el dato del Missing Input #2.
5. **[NEEDS CLARIFICATION, no bloqueante]** ¿El gate de AC-3/AC-6 aplica a TODO agente self-published
   futuro (cualquier operador externo) o solo a los `remit-*` de este ecosistema? Se asume lo primero
   (gate genérico en `wasiai-a2a`, consistente con AR-4 que lo planteó sin acotar a remit-*); si el
   humano quiere acotarlo, es una decisión de F2 en el repo `wasiai-a2a`.

## Análisis de paralelismo
- **Depende de (mergeado)**: WKH-241 (`readPaymentSpec`, lectura) y WKH-234 (adapter Solana, settle)
  — ambos DONE en `wasiai-a2a`. Sin estos, el manifiesto no tendría a quién hablarle.
- **Bloquea**: cualquier intento de "activar Solana en prod" para FX/payout de forma sostenible —
  hoy ese cobro depende de una fila seedeada a mano (frágil, sin gate); esta HU es la que lo hace
  reproducible.
- **NO bloquea** WKH-235/236 (ya DONE/in-progress con su propio mecanismo ad-hoc) — esta HU es un
  endurecimiento posterior, no un prerequisito de esas.
- **Companion cross-repo obligatorio** en `wasiai-a2a` (Missing Input #3) — no puede cerrar
  end-to-end sin código nuevo allá (write-path + gate). Recomendación: HU hermana en `wasiai-a2a`,
  mismo patrón de split que WKH-235/236/241.
- Puede correr en paralelo con cualquier HU que no toque `README.md` de este repo o
  `src/services/agent.ts`/`discovery.ts` del lado `wasiai-a2a`.
