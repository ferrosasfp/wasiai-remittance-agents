# Work Item — [WKH-208] Reescribir el adapter de payout de TransFi a la API REAL (sandbox e2e, sin plata real)

> F0+F1 (NexusAgil QUALITY) · Repo: `wasiai-remittance-agents` · Origen: el founder obtuvo
> credenciales de sandbox reales de TransFi. El adapter `src/providers/payout.ts` se construyó a
> ciegas en WKH-172 (comentarios `TODO(sandbox): confirmar endpoint/shape`) y está desactualizado
> en los 4 ejes verificados contra `doc/transfi-offramp-api-spec.md` (2026-07-17): endpoint, auth,
> idempotencia, y — el más grave — el modelo de flujo (síncrono vs asíncrono).

---

## Resumen

El adapter TransFi de payout asume hoy un modelo *push-payout* síncrono (`POST /v1/payouts` →
`Bearer` → `{settled}` en la misma respuesta). La API real es distinta en los 4 ejes: endpoint
(`POST /v3/orders`, `orderType:"offramp"`), auth (`Basic base64(user:pass)` + header `mid`, NO
Bearer), idempotencia (campo `partnerId` en el body, NO header), y sobre todo el **flujo**: crear
la orden devuelve una `walletAddress` de depósito por orden, y la confirmación real
(`fund_settled`) llega **async por webhook** — no en la respuesta del POST. Esta HU reescribe el
adapter (`TransFiPayoutProvider`) contra el contrato real, verificado en vivo contra
`sandbox-api.transfi.com` con credenciales de sandbox, **sin mover plata real en ningún momento**
(tokens testnet + simulador de TransFi). El `FallbackPayoutProvider` (mock) sigue siendo el
default en todo entorno sin `TRANSFI_ADAPTER_READY=true` — ningún fail-safe existente se toca.

Esta HU **NO** cierra el circuito completo: el envío on-chain del USDC de la wallet plataforma al
`depositAddress` de TransFi y el webhook receiver que consume `fund_settled` quedan **fuera de
scope**, documentados como HU de seguimiento (ver DT-1 y Scope OUT). Cerrar solo esos dos huecos
sin el adapter rescrito sería inútil (nada que consuma la API real); rescribir el adapter sin
resolver el flujo async completo sería sobre-prometer que el payout "funciona" cuando en realidad
queda a medio camino — por eso el Analyst documenta el corte explícitamente en vez de forzar todo
en una sola HU (ver Sizing).

---

## Sizing

- **SDD_MODE**: full
- **Estimación**: L, con **split recomendado en 2 HUs** (ver abajo) — sin el split sería XL y
  mezclaría dos espacios de diseño independientes (contrato HTTP del adapter vs. arquitectura de
  estado async) bajo un solo Story File, lo que dificulta el AR/CR (dos radios de blast distintos:
  uno es "cambiar cómo hablamos con TransFi", el otro es "dónde vive el estado de una remesa en
  vuelo y quién la reconcilia").
- **Sizing override esperado**: money-path + integración con partner licenciado + flujo async
  nuevo → QUALITY como mínimo, sin importar lo que un sizing automático sugiera.
- **Branch sugerido**: `feat/003-wkh-208-transfi-offramp-real-api`

### Recomendación de split (para el Architect en F2)

- **WKH-208 (esta HU)** — reescribir el contrato HTTP del adapter (`payout.ts`) contra la API real,
  validado en sandbox: auth, endpoint, idempotencia, mapeo de status, extensión aditiva del shape
  de salida (`depositAddress`, `orderId`) para que la HU de seguimiento no necesite otro cambio de
  contrato. **NO** incluye el envío on-chain del USDC ni el webhook receiver.
- **WKH-XXX (seguimiento, a crear en F2 o después)** — (a) el paso de infraestructura de wallet
  que manda el USDC de la wallet plataforma al `depositAddress` que devuelve cada orden, y (b) el
  webhook receiver (`X-Transfi-Hmac-Hash`) que consume `asset_deposited→fund_settled` y actualiza
  el estado terminal — encaja con WKH-207 (el ledger de `chaski-v2`, ya en branch
  `feat/019-wkh-207-remittance-persistence-reconciliation`). Ver DT-1 para la recomendación de
  ubicación.
- **fx.ts (mismo bug Bearer, `src/providers/fx.ts`)** — se separa a una HU propia. La spec
  entregada (`doc/transfi-offramp-api-spec.md`) documenta solo el endpoint de off-ramp
  (`/v3/orders`); el endpoint real de cotización (`/v1/quotes` en el código actual) NO está
  verificado contra docs.transfi.com — mezclarlo acá extendería el scope sobre una superficie sin
  grounding. Ver DT-3.

---

## Hechos verificados en disco (grounding, 2026-07-17)

1. **`src/providers/payout.ts:16-31`**: `TransFiPayoutProvider.execute()` hace
   `POST /v1/payouts` con `authorization: Bearer ${apiKey}` + header `idempotency-key` + body
   `{quoteId, amount, beneficiary, travelRule}`, y asume que la respuesta ya trae `status` final
   (`settled`/`failed`/`submitted` vía `normalizeStatus`, línea 91-96). Ningún dato de este shape
   coincide con la API real.
2. **`src/providers/payout.ts:44-60`**: `status()` pega a `GET /v1/payouts/{id}` con el mismo
   Bearer — también incorrecto (real: `GET /v3/orders/{id}`).
3. **`src/providers/payout.ts:108-118`**: `getPayoutProvider()` decide el provider real vs. mock
   leyendo **una sola env var** `TRANSFI_API_KEY` + `TRANSFI_ADAPTER_READY`. La API real no usa API
   key — usa usuario+contraseña+`mid`. Este factory necesita 3 variables nuevas, no 1.
4. **`src/providers/payout.test.ts:49-65`**: la suite de la factory (`sin key → fallback`, `key sin
   readiness → throws`, `key + readiness → adapter TransFi`) usa `TRANSFI_API_KEY` como única
   señal. Esta HU debe migrar esos 3 tests a las variables nuevas SIN cambiar su intención
   (mismo patrón fail-loud, mismo default mock).
5. **`src/agents/cashout-payout.ts:65-89` (`assertPayoutProviderSafe`)**: el fail-safe de prod
   (`PAYOUT_ALLOW_MOCK`) y de dev (`ALLOW_FALLBACK_PAYOUT`) leen **directamente**
   `process.env.TRANSFI_API_KEY` (línea 66-67) — este archivo TAMBIÉN necesita el cambio de
   variable, o el fail-safe queda comparando contra una env var que ya no se setea nunca (lo que en
   la práctica lo dejaría SIEMPRE en la rama "no hay real" — fail-closed por accidente, no
   catastrófico pero sí un bug de esta HU si no se corrige a propósito).
6. **`src/providers/types.ts:112-119` (`PayoutResult`)**: `status` ya es
   `"submitted" | "settled" | "failed"` — el vocabulario YA soporta el estado intermedio async.
   Falta el campo `depositAddress` (dónde mandar el USDC) — no existe hoy en ningún tipo.
7. **`src/agents/cashout-payout.ts:237-254` (`runCashoutPayout`)**: llama
   `provider.execute(...)` y mapea 1:1 los campos de `PayoutResult` al output del agente
   (`CashoutPayoutOutput`, líneas 50-59) — **NO** re-mapea `depositAddress` porque no existe hoy en
   ninguno de los dos tipos. Si esta HU agrega `depositAddress` a `PayoutResult` sin tocar
   `CashoutPayoutOutput`, el campo queda disponible para el provider/tests pero invisible para el
   caller a2a — deliberado (ver Scope OUT: exponerlo al output público del agente es decisión de la
   HU de seguimiento, junto con el resto del flujo async).
8. **`chaski-v2/app/api/a2a/payout/submit/route.ts:308-327`**: el proxy de `chaski-v2` lee
   `result.status`/`result.payoutId` de la respuesta **síncrona** del `POST /invoke` del agente y
   los persiste 1:1 en el ledger (WKH-207, `mapped = okResult.status === "settled" ? "settled" :
   okResult.status === "submitted" ? "submitted" : "failed"`). Esto YA tolera un `"submitted"`
   inmediato — el mapeo no se rompe si el agente empieza a devolver `submitted` en vez de asumir
   `settled`. Lo que el ledger de WKH-207 **NO** hace hoy es actualizarse más tarde cuando llegue un
   estado terminal async — su reconciliación (`AC-6` de esa HU) solo marca `manual_review`, nunca
   reintenta ni resuelve automáticamente. Confirma DT-1: el webhook receiver es trabajo NUEVO, no
   existe en ningún repo hoy.
9. **`doc/transfi-offramp-api-spec.md:38-39`**: `USDCAVAX` (Avalanche) **NO** está en la lista
   publicada de códigos `source.currency` soportados (`USDC`, `USDCPOLYGON`, `USDCBASE`, `USDCARB`,
   `USDCBSC`, `USDCSOL`, `USDCCELO`, `USDCLINEA`, `USDCALGO`, `USDCXLM`, `USDCFUSE`). Chaski settlea
   el principal en Avalanche (Fuji hoy). Esto es una discrepancia de red sin resolver — no se puede
   cerrar sin probarlo en sandbox (`list-tokens`), ver DT-2.

---

## Acceptance Criteria (EARS)

- **AC-1** (Ubiquitous): WHILE `TRANSFI_USERNAME`/`TRANSFI_PASSWORD`/`TRANSFI_MID` están
  configuradas Y `TRANSFI_ADAPTER_READY==="true"`, THE system SHALL autenticar cada request a
  TransFi con `Authorization: Basic base64(usuario:contraseña)` + header `mid: <TRANSFI_MID>` —
  NUNCA `Bearer`.

- **AC-2** (Event-driven): WHEN se ejecuta un payout, THE system SHALL enviar
  `POST {TRANSFI_BASE_URL}/v3/orders` con `orderType:"offramp"` y `partnerId` **igual al
  `idempotencyKey` del input** (sin regenerar, sin derivar) — NUNCA el endpoint `/v1/payouts` ni un
  header `idempotency-key`.

- **AC-3** (Event-driven): WHEN TransFi responde 2xx a la creación de la orden, THE system SHALL
  devolver `status:"submitted"` (NUNCA asumir `"settled"` sincrónico) junto con el `orderId`
  (mapeado a `payoutId`) y el `depositAddress` que TransFi asigna a esa orden — la confirmación
  terminal (`fund_settled`) llega async por webhook y queda **fuera de scope** de esta HU (ver
  Scope OUT / DT-1).

- **AC-4** (Ubiquitous — pedido explícito del orquestador): THE system SHALL validar el circuito
  create-order (`POST /v3/orders`) + consulta de estado (`GET /v3/orders/{id}`) contra
  `sandbox-api.transfi.com` usando las credenciales de sandbox y montos de prueba, en NINGÚN
  momento de F3/QA contra `api.transfi.com` (producción) ni moviendo plata real.

- **AC-5** (State-driven — pedido explícito del orquestador): WHILE `TRANSFI_ADAPTER_READY` no es
  `"true"` O falta cualquiera de `TRANSFI_USERNAME`/`TRANSFI_PASSWORD`/`TRANSFI_MID`, THE system
  SHALL usar `FallbackPayoutProvider` (mock) como default — el comportamiento actual de
  `assertPayoutProviderSafe()` + `getPayoutProvider()` (fail-safe de prod `PAYOUT_ALLOW_MOCK`, de
  dev `ALLOW_FALLBACK_PAYOUT`) permanece intacto en su intención, aunque las env vars que lee
  cambien de nombre (ver Hecho #5).

- **AC-6** (Unwanted condition): IF la red USDC solicitada (`source.currency`) no aparece en la
  respuesta de `GET /v3/payment-methods` (o el endpoint equivalente de tokens soportados)
  verificado en sandbox, THEN THE system SHALL fallar explícitamente (throw fail-loud) en vez de
  enviar una orden con una moneda adivinada o mapeada a ciegas.

- **AC-7** (Unwanted condition): IF TransFi devuelve un error HTTP (4xx/5xx, incluyendo
  `PARTNER_ID_ALREADY_USED`), THEN THE system SHALL propagar un error tipado (`transfi_payout_error_<status>`
  o equivalente) — NUNCA silenciarlo, NUNCA interpretarlo como éxito, NUNCA hacer downgrade
  silencioso al mock.

- **AC-8** (Ubiquitous): THE system SHALL mapear los estados TransFi documentados
  (`initiated`, `asset_deposited` → `"submitted"`; `fund_settled` → `"settled"`; `fund_failed`,
  `expired` → `"failed"`) en `normalizeStatus()`, reemplazando el mapeo actual basado en valores
  inventados (`"completed"`, `"success"`, `"error"`, `"rejected"`) que no corresponden al
  vocabulario real de TransFi.

`[NEEDS CLARIFICATION]` — AC-3/AC-6 dependen de hechos que solo se confirman ejecutando contra el
sandbox real en F3 (shape exacto de `depositAddress` en la respuesta, endpoint exacto para listar
tokens soportados). El Analyst no los prescribe a ciegas — el Architect/Dev los verifican en F3 con
evidencia, no los asumen del spec doc.

---

## Scope IN

- `src/providers/payout.ts` (líneas 1-119, reescritura completa de `TransFiPayoutProvider` +
  `normalizeStatus` + `getPayoutProvider`) — el foco central de la HU.
- `src/providers/payout.test.ts` (líneas 1-65) — actualizar/extender: nuevas env vars en la suite
  de la factory (líneas 49-65), nuevos tests de shape de request/response contra fixtures del
  sandbox real (auth header, `partnerId`, mapeo de status).
- `src/providers/types.ts` (`PayoutResult`, líneas 112-119) — extensión **aditiva**:
  `depositAddress: string | null`. PROHIBIDO romper el shape existente (`payoutId`, `status`,
  `deliveredLocal`, `txRef`, `failureReason`, `provenance` se mantienen).
- `src/agents/cashout-payout.ts` (líneas 65-89, `assertPayoutProviderSafe`) — SOLO el cambio de
  qué env vars lee para decidir "hay provider real configurado" (de `TRANSFI_API_KEY` a las 3
  variables nuevas). PROHIBIDO tocar la lógica de gates (`PAYOUT_ALLOW_MOCK`,
  `ALLOW_FALLBACK_PAYOUT`, el orden de chequeos).
- `project-context.md` (si existe) — documentar las env vars nuevas y el patrón Basic+mid.
- **Investigación en sandbox (sin código de producción)**: llamadas reales a
  `sandbox-api.transfi.com` durante F3 para confirmar `GET /v3/payment-methods` (campos del
  beneficiario PE), `list-tokens` (soporte de red USDC), `purposeCode` válido, flujo de `userId`
  (UX-...) — documentado como evidencia en el done-report, no como script permanente del repo salvo
  que el Architect decida lo contrario en F2.

## Scope OUT

- **`src/providers/fx.ts`** (mismo bug Bearer/endpoint) — HU propia (DT-3). Requiere verificar
  primero el endpoint real de cotización contra docs.transfi.com (no cubierto por
  `doc/transfi-offramp-api-spec.md`).
- **Envío on-chain del USDC** de la wallet plataforma al `depositAddress` que devuelve cada orden
  — no existe hoy en ningún repo (ni `wasiai-remittance-agents` ni `chaski-v2`); es infraestructura
  de wallet nueva. HU de seguimiento (ver Sizing).
- **Webhook receiver** (`X-Transfi-Hmac-Hash`, estados `asset_deposited→fund_settled`) — HU de
  seguimiento. Ubicación (este repo vs. `chaski-v2`) es DT-1, `[NEEDS CLARIFICATION]` para F2.
- **`CashoutPayoutOutput`** (`src/agents/cashout-payout.ts:50-59`) — el contrato público del agente
  a2a NO se extiende con `depositAddress` en esta HU (queda en `PayoutResult` internamente, listo
  para que la HU de seguimiento lo exponga cuando el flujo async completo esté diseñado).
- **`chaski-v2`** (consumidor, incluyendo `submit/route.ts` y el ledger WKH-207) — repo distinto,
  solo lectura de referencia en esta HU. Ver Hecho #8.
- **Activación en producción** (`TRANSFI_ADAPTER_READY=true` en un deploy real) — bloqueada
  además por el KYB de TransFi (founder, 2-3 días), y por G3 (WKH-168, verificación de que el
  sender pagó el principal, diferida). Esta HU deja el adapter LISTO, no ACTIVADO.
- **Cualquier movimiento de plata real** — CD-1.
- **El demo live** (`agentshop-*`, `wasiai-agentshop.vercel.app`, `chaski-ai.vercel.app`).
- **Transcripción de credenciales a archivos** — las mueve el founder/orquestador a
  `.env.local`, nunca el Dev de esta HU.

---

## Decisiones técnicas (DT-N)

### DT-1 — CENTRAL, `[NEEDS CLARIFICATION]`: dónde vive el webhook receiver + reconciliación async

El agente `remit-cashout-payout` es **stateless hoy** (`src/agents/cashout-payout.ts` no persiste
nada; `wasiai-remittance-agents` no tiene DB). `chaski-v2` **sí** tiene persistencia propia
(`remittance_settlements`, WKH-207, branch `feat/019-...`), con CD-10 de esa HU prohibiendo
explícitamente usar cualquier DB que no sea la de `chaski-v2` ("PROHIBIDO la DB de `wasiai-a2a`" —
por extensión, cualquier DB nueva en `wasiai-remittance-agents` repetiría el mismo antipatrón que
esa HU evitó a propósito).

**Recomendación no vinculante del Analyst**: el webhook receiver de TransFi debería vivir en
`chaski-v2`, actualizando `remittance_settlements` cuando llegue `fund_settled`, correlacionado por
`payoutId`/`orderId` (que esta HU ya persiste vía `recordPayoutOutcome`, `submit/route.ts:282-289`).
Motivos: (a) evita una segunda base de datos/estado en un repo que hoy es cero-persistencia por
diseño, (b) el ledger que necesita actualizarse YA existe ahí, (c) `chaski-v2` ya expone rutas
`app/api/**` públicas (Vercel) donde un webhook público es un patrón existente, mientras que
`wasiai-remittance-agents` es el servicio a2a interno (Railway, según `REMIT_AGENTS_BASE_URL`
server-only) — exponerlo a un webhook público de un partner externo cambia su superficie de forma
que hoy no tiene.

**El Analyst NO decide esta DT** — es arquitectura mayor (nueva superficie pública, nuevo secreto
`TRANSFI_WEBHOOK_SECRET`, cross-repo). Queda para el Architect en F2 de la HU de seguimiento, con
esta recomendación como punto de partida.

### DT-2 — `[NEEDS CLARIFICATION]`: red del USDC (Avalanche no confirmado)

`USDCAVAX` no aparece en la lista publicada de `source.currency` de TransFi (Hecho #9). Chaski
settlea el principal en Avalanche/Fuji. Si sandbox confirma que TransFi NO soporta Avalanche, hay
2-3 caminos (bridging del USDC recibido a una red soportada como Base/Polygon antes de mandarlo al
`depositAddress`; o cambiar la red de settlement de Chaski, que es un cambio de arquitectura mucho
mayor y toca el demo). Se verifica en sandbox durante F3 de esta HU (vía `list-tokens`/
`payment-methods`) pero la DECISIÓN de qué camino tomar si Avalanche no está soportado excede el
scope de esta HU — puede generar su propia HU. AC-6 asegura que, mientras tanto, el adapter falla
fail-loud en vez de mandar una orden con una red inválida.

### DT-3 — split de `fx.ts` a HU futura

Mismo bug de auth (`Bearer` en vez de `Basic+mid`) que `payout.ts`, pero el endpoint real de
cotización (hoy `/v1/quotes` en el código, línea `fx.ts:19`) no está en
`doc/transfi-offramp-api-spec.md` — esa ficha documenta únicamente el endpoint de off-ramp
(`/v3/orders`). Rescribir `fx.ts` sin verificar el endpoint real contra docs.transfi.com repetiría
el mismo error que esta HU corrige (construir a ciegas). Se separa para no bloquear el rewrite de
`payout.ts` (que SÍ tiene spec verificada) con una investigación pendiente.

### DT-4 — extensión aditiva de `PayoutResult`

Se agrega `depositAddress: string | null` a `PayoutResult` (`types.ts`) de forma aditiva — no
rompe ningún consumidor existente (el campo es nuevo, nadie lo lee hoy). Prepara el terreno para
que la HU de seguimiento (envío on-chain + webhook) no necesite otro cambio de contrato de tipos,
sin comprometer a esta HU a implementar el consumo de ese campo.

### DT-5 — reemplazo de env vars en 2 archivos, no 1

`TRANSFI_API_KEY` (singular) se reemplaza por `TRANSFI_USERNAME`/`TRANSFI_PASSWORD`/`TRANSFI_MID`
en **dos** lugares que hoy la leen de forma independiente: `getPayoutProvider()` (`payout.ts:109`)
y `assertPayoutProviderSafe()` (`cashout-payout.ts:66-67`). Si solo se cambia uno, el fail-safe
queda inconsistente con la factory — Scope IN incluye explícitamente ambos (ver Hecho #5).

---

## Constraint Directives (CD-N)

### PROHIBIDO
- **CD-1 (sandbox-only, dinero real)**: PROHIBIDO que cualquier test, script de validación o
  request de esta HU apunte a `https://api.transfi.com` (producción) o mueva plata real en
  cualquier paso de F3/QA. Todo corre contra `sandbox-api.transfi.com` con montos de prueba y (si
  aplica) USDC de testnet.
- **CD-2 (credenciales)**: PROHIBIDO hardcodear o transcribir
  `TRANSFI_USERNAME`/`TRANSFI_PASSWORD`/`TRANSFI_MID`/`TRANSFI_WEBHOOK_SECRET` en cualquier archivo
  de este repo (código, tests, docs, commits) — solo vía env vars que mueve el founder/orquestador
  a `.env.local`. Los tests que necesiten simular auth usan credenciales FAKE (`vi.stubEnv`).
- **CD-3 (mock sigue siendo default)**: PROHIBIDO alterar `assertPayoutProviderSafe()` /
  `getPayoutProvider()` de forma que el `FallbackPayoutProvider` deje de ser el default cuando no
  hay credenciales completas o `TRANSFI_ADAPTER_READY!=="true"`. Los fail-safes existentes
  (`PAYOUT_ALLOW_MOCK` en prod, `ALLOW_FALLBACK_PAYOUT` en dev) se preservan en su intención (Hecho
  #5/DT-5).
- **CD-4 (no envío real ni webhook en esta HU)**: PROHIBIDO implementar en esta HU el envío
  on-chain del USDC al `depositAddress`, ni el webhook receiver (`X-Transfi-Hmac-Hash`) — quedan
  explícitamente diferidos (Scope OUT, DT-1).
- **CD-5 (no silenciar errores)**: PROHIBIDO que un error HTTP de TransFi (incluyendo
  `PARTNER_ID_ALREADY_USED`) se interprete como éxito o se degrade en silencio al mock — siempre
  throw tipado (AC-7).

### OBLIGATORIO
- **CD-6 (idempotencia real)**: el campo `partnerId` del body de `POST /v3/orders` DEBE ser
  exactamente el `idempotencyKey` recibido en `PayoutInput` — sin regenerar, sin derivar, sin
  truncar (AC-2).
- **CD-7 (mapeo de estados verificado, no inventado)**: `normalizeStatus()` DEBE mapear
  únicamente los estados documentados por TransFi (`initiated`, `asset_deposited`, `fund_settled`,
  `fund_failed`, `expired`) — PROHIBIDO dejar los valores inventados actuales
  (`"completed"`/`"success"`/`"error"`/`"rejected"`) sin verificar contra la spec/sandbox real
  (AC-8).
- **CD-8 (gate de verificación)**: `npm run typecheck` completo (`tsc --noEmit`, cubre `*.test.ts`
  — NUNCA solo `npm run build`, que los excluye — lección WKH-196/WKH-207 CD-16) + `npm run test`
  antes de cerrar cada wave.

---

## Categorías de riesgo de seguridad (obligatorio)

| Categoría | Aplica | Detalle |
|---|---|---|
| **Money-path** | SÍ | El adapter, una vez `TRANSFI_ADAPTER_READY=true`, ejecutaría desembolsos reales de PEN. Hoy inerte (nadie setea las 3 env vars + readiness), pero el diseño debe ser correcto AHORA. |
| **Integración con partner licenciado** | SÍ | TransFi es el partner regulado (KYB pendiente). Un contrato HTTP mal mapeado (auth, idempotencia, estados) puede producir órdenes duplicadas (`PARTNER_ID_ALREADY_USED` mal manejado) o estados mal interpretados (`submitted` leído como `settled`). |
| **Credenciales / secretos** | SÍ | 4 secretos nuevos (`TRANSFI_USERNAME/PASSWORD/MID/WEBHOOK_SECRET`) que hoy viven en `chaski-v2/.env.local` con nombres viejos y deben migrar sin transcribirse a texto plano en ningún archivo versionado (CD-2). |
| **Discrepancia de red (Avalanche)** | SÍ (bloqueante de arquitectura, DT-2) | Si USDC en Avalanche no está soportado, todo el corredor Chaski→TransFi queda bloqueado hasta resolver bridging/cambio de red — no es un detalle menor, es potencialmente el hallazgo más caro de esta HU. |
| **Estado huérfano / async no resuelto** | SÍ (diferido, no cerrado por esta HU) | Sin webhook receiver, toda orden creada queda `submitted` para siempre desde la perspectiva del sistema — invisible para la reconciliación de WKH-207 hasta que exista la HU de seguimiento. Esta HU NO empeora el estado actual (hoy el adapter ni siquiera crea órdenes reales), pero tampoco lo cierra. |

---

## Qué cierra / Qué NO cierra (obligatorio, sin sobre-prometer)

### Cierra (objetivo de esta HU, una vez implementada)
- El adapter deja de estar "construido a ciegas": los 4 ejes (endpoint, auth, idempotencia, mapeo
  de estados) quedan verificados contra la API real y probados en sandbox e2e para la creación +
  consulta de una orden.
- El shape de salida (`PayoutResult` + `depositAddress`) queda listo para que la HU de seguimiento
  no necesite otro cambio de contrato.
- Confirma (o refuta) en sandbox el soporte de Avalanche — hoy es una incógnita documentada, al
  cerrar esta HU es un hecho verificado.

### NO cierra (límite honesto, verificado, no se puede tapar)
- **El corredor no queda operable end-to-end.** Crear una orden y obtener un `depositAddress` no
  mueve el USDC ahí — ese paso (wallet plataforma → TransFi) no existe en ningún repo hoy y es HU
  de seguimiento.
- **Ninguna remesa real llegará a `settled` a través de este sistema** hasta que exista el webhook
  receiver (DT-1) — el `submitted` que esta HU sí puede producir en sandbox no tiene forma de
  convertirse en un estado terminal observable por `chaski-v2` todavía.
- **No habilita producción.** Bloqueada además por el KYB de TransFi (founder) y por G3 (WKH-168,
  diferida).

---

## Missing Inputs

- **[NEEDS CLARIFICATION, bloqueante-arquitectura, resuelto en F2]** DT-1: dónde vive el webhook
  receiver (`chaski-v2` vs. `wasiai-remittance-agents`) — recomendación del Analyst: `chaski-v2`.
- **[NEEDS CLARIFICATION, bloqueante-arquitectura, resuelto en F2/F3]** DT-2: si USDC en Avalanche
  no está soportado por TransFi, qué camino toma Chaski (bridge vs. cambio de red de settlement).
  Se verifica primero en sandbox (F3), la decisión de camino puede exceder esta HU.
- **[resuelto en F3, no bloqueante para F1]** Shape exacto de `additionalPaymentDetails` del
  beneficiario peruano (`GET /v3/payment-methods`), `purposeCode` válido, flujo de creación de
  `userId` (UX-...) — se descubren ejecutando contra sandbox, no se pueden prescribir en F1.
- **[decisión tomada, no bloqueante]** `fx.ts` se separa a HU futura (DT-3) — endpoint de quote sin
  verificar contra docs.transfi.com.
- **[dato operativo, no bloqueante]** Las credenciales (`TRANSFI_USERNAME`, `TRANSFI_PASSWORD`,
  `TRANSFI_MID`, `TRANSFI_WEBHOOK_SECRET`, `TRANSFI_BASE_URL`) deben moverse de
  `chaski-v2/.env.local` a `wasiai-remittance-agents/.env.local` ANTES de F3 — el founder o el
  orquestador las mueve, el Analyst no las transcribió a ningún archivo de este work-item.

---

## Análisis de paralelismo

- **Este repo (`wasiai-remittance-agents`)**: `_INDEX.md` tiene 2 filas previas (WKH-203, WKH-204,
  ambas DONE) — sin HUs abiertas hoy, sin riesgo de colisión de archivos con esta HU.
- **`chaski-v2` / WKH-207**: repo y archivos distintos → sin colisión de código. Hay una dependencia
  de **diseño, no de archivos**: el `payoutId`/`orderId` que esta HU empieza a devolver es lo que
  `submit/route.ts:282-289` (WKH-207) ya persiste vía `recordPayoutOutcome` — el shape es
  compatible hoy (Hecho #8), pero la HU de seguimiento de DT-1 sí tocará ese mismo archivo/tabla.
- **Bloquea**: la HU de seguimiento (envío on-chain + webhook receiver) depende de que esta HU
  termine primero (necesita el `depositAddress` real que devuelve el adapter rescrito).
- **No bloquea**: cualquier trabajo en `chaski-v2` no relacionado a payout/TransFi puede correr en
  paralelo sin conflicto.
- **`fx.ts`** (DT-3): independiente, puede ir en paralelo con esta HU (archivos distintos,
  `fx.test.ts` no se toca acá) una vez que alguien verifique el endpoint real de cotización.

---

## Plan de tests (≥1 test por AC)

| AC | Test(s) mínimo(s) |
|---|---|
| AC-1 | `payout.test.ts`: request mockeada/interceptada verifica header `authorization` = `Basic ${base64(user:pass)}` y header `mid` presente; NUNCA `Bearer`. |
| AC-2 | `payout.test.ts`: body del POST a `/v3/orders` tiene `orderType:"offramp"` y `partnerId === input.idempotencyKey`; endpoint exacto `${BASE}/v3/orders` (no `/v1/payouts`). |
| AC-3 | `payout.test.ts`: respuesta 2xx del mock devuelve `{status:"submitted", payoutId, depositAddress}` — nunca `"settled"` en el primer POST. |
| AC-4 | Evidencia F3 (no test unitario): request real contra `sandbox-api.transfi.com` documentada en el done-report con host/respuesta (redactando credenciales). |
| AC-5 | `payout.test.ts` (migración de líneas 49-65): sin las 3 env vars → fallback; con las 3 pero sin readiness → throw; con las 3 + readiness → `TransFiPayoutProvider`. `cashout-payout.test.ts`: `assertPayoutProviderSafe()` sigue bloqueando el mock fuera de `ALLOW_FALLBACK_PAYOUT`/`PAYOUT_ALLOW_MOCK`. |
| AC-6 | `payout.test.ts`: red no soportada (mock de `list-tokens`/`payment-methods` sin el código pedido) → throw fail-loud, nunca una orden enviada. |
| AC-7 | `payout.test.ts`: respuesta 4xx/5xx del mock (incluido `PARTNER_ID_ALREADY_USED`) → throw tipado, `execute()` nunca resuelve con un resultado "exitoso". |
| AC-8 | `payout.test.ts`: tabla de mapeo `initiated/asset_deposited→submitted`, `fund_settled→settled`, `fund_failed/expired→failed` — un caso por estado documentado. |

**Gate de verificación**: `npm run typecheck` (tsc --noEmit completo, incluye tests — CD-8) +
`npm run test`. Baseline a preservar: toda la suite existente (payout.test.ts, cashout-payout.test.ts,
fx.test.ts, kyc.test.ts) sigue verde.

---

*Generado por nexus-analyst — F0+F1. Próximo paso: orquestador presenta este work-item al humano
para el gate `HU_APPROVED`.*
