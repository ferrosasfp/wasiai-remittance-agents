# Work Item — [WKH-213] Escape-hatch devnet-only para `depositAddress` Solana (M5 smoke enabler)

## Resumen
`remit-cashout-payout` solo devuelve un `depositAddress` real cuando `getPayoutProvider()` elige
`TransFiPayoutProvider` (3 creds + `TRANSFI_ADAPTER_READY=true`); sin eso cae al mock
(`FallbackPayoutProvider`), que hoy siempre devuelve `depositAddress: null`. El smoke on-chain de
M5 (deposit→escrow→release verificable en Solana Explorer, **devnet, cero plata real**) necesita
que el escrow tenga un beneficiary real, y hoy no hay credenciales sandbox de TransFi para
generarlo. Esta HU agrega un **escape-hatch devnet-only, opt-in, fail-safe**: cuando una env
explícita (`TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS`) está seteada Y el contexto es Solana devnet,
`FallbackPayoutProvider` devuelve esa address (una ATA USDC devnet del equipo) con
`provenance: "devnet-stub"` — sin llamar a TransFi. Es un **ENABLER** del smoke de M5, NO un
producto: no mueve plata, no reemplaza el off-ramp real (WKH-208/WKH-209).

## Sizing
- Smart Sizing: **QUALITY** (chico) — tamaño de código pequeño, pero toca directamente el
  money-path del payout (`FallbackPayoutProvider`, factory de providers) y es seguridad-sensible
  (riesgo de que un escape-hatch se filtre a producción/real); exige el mismo rigor de AR/CD que
  WKH-203/204/208.
- SDD_MODE (convención local del repo): mini — 1 archivo de lógica (`src/providers/payout.ts`) +
  tests + docs, sin cambio de contrato HTTP ni de schema de entrada/salida (el campo
  `depositAddress`/`provenance` ya existe desde WKH-212).
- Estimación: S
- Branch sugerido: `feat/wkh-213-devnet-beneficiary-escape-hatch`

## Grounding (F0 — hallazgos)
- `getPayoutProvider()` (`src/providers/payout.ts:246-258`) es la factory: devuelve
  `TransFiPayoutProvider` SOLO si `TRANSFI_USERNAME` + `TRANSFI_PASSWORD` + `TRANSFI_MID` están
  las 3 Y `TRANSFI_ADAPTER_READY==="true"`; si falta cualquiera, devuelve `FallbackPayoutProvider`
  (mock). Esto da **precedencia estructural gratis**: si el real está configurado, el stub nunca se
  evalúa porque `FallbackPayoutProvider` ni se instancia.
- `assertPayoutProviderSafe()` (`src/agents/cashout-payout.ts:66-93`) es el fail-safe que ya existe
  hoy para el mock: en `NODE_ENV==="production"` exige `PAYOUT_ALLOW_MOCK==="true"` explícito para
  permitir el fallback; en dev/CI exige `ALLOW_FALLBACK_PAYOUT==="true"`. Se ejecuta ANTES de
  `getPayoutProvider()` (L201-202) y de que el mock corra. El escape-hatch, si vive dentro de
  `FallbackPayoutProvider`, **hereda este gate de prod automáticamente** — no crea un camino nuevo
  alrededor de él.
- `FallbackPayoutProvider.execute()`/`.status()` (`payout.ts:185-208`) hoy devuelven SIEMPRE
  `depositAddress: null`, `provenance: "local-fallback"`. Es el lugar natural para el escape-hatch.
- `resolveSourceCurrency()`/`TRANSFI_USDC_CURRENCY` (`payout.ts:23-45`) ya resuelve
  `TRANSFI_USDC_NETWORK==="solana" → "USDCSOL"` (WKH-209, DONE) — es la env que ya identifica
  "contexto Solana" en el repo; se reutiliza como guard de red, no se crea una env de red nueva.
- `Provenance` (`src/providers/types.ts:6`) es `type Provenance = string` — agregar el literal
  `"devnet-stub"` no requiere cambio de tipo ni de schema.
- `PayoutResult.depositAddress` (`types.ts:119-122`) ya es `string | null` — el shape de salida no
  cambia; el agente (`cashout-payout.ts:260`) ya hace passthrough opaco de
  `result.depositAddress`/`result.provenance` (WKH-212), así que **no se espera tocar
  `src/agents/cashout-payout.ts`**.
- No existe hoy ninguna validación de formato (base58 / EVM) en runtime — `readString()` en el path
  real es pass-through opaco (confirmado en WKH-209 F0/DT-2). El escape-hatch es la PRIMERA vez que
  el repo valida formato de una address; se acota a validación de charset/longitud base58, no
  verificación criptográfica de curva (fuera de scope).
- Repo sin `.env.example`/`vercel.json` (confirmado WKH-209) — la doc de env vars vive en
  `README.md` + `project-context.md` (tabla L152-166).

## Acceptance Criteria (EARS)
- AC-1: WHEN `TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS` está seteada a un valor base58 válido Y
  `TRANSFI_USDC_NETWORK === "solana"` Y el provider real de TransFi NO está activo (creds
  incompletas o `TRANSFI_ADAPTER_READY !== "true"`), the system SHALL devolver esa address como
  `depositAddress` con `provenance: "devnet-stub"`, sin invocar `fetch` a TransFi.
- AC-2: IF el provider real de TransFi SÍ está activo (3 creds + `TRANSFI_ADAPTER_READY==="true"`),
  THEN the system SHALL ignorar `TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS` por completo y ejecutar el
  path real (`provenance: "transfi"`) — el real SIEMPRE tiene precedencia sobre el stub.
- AC-3: WHILE `TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS` no está seteada, the system SHALL comportarse
  byte-idéntico al comportamiento actual del mock (`depositAddress: null`,
  `provenance: "local-fallback"`) — cero regresión, todos los tests existentes de
  `FallbackPayoutProvider` siguen pasando sin modificación.
- AC-4: IF `TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS` está seteada pero (a) el valor NO es base58 válido,
  O (b) `TRANSFI_USDC_NETWORK !== "solana"`, THEN the system SHALL fail-closed al comportamiento del
  mock estándar (`depositAddress: null`, `provenance: "local-fallback"`) — NUNCA propagar una
  address malformada ni una address devnet fuera de contexto Solana.
- AC-5: the system SHALL NUNCA activar el path del escape-hatch en un deploy donde
  `NODE_ENV === "production"` salvo que el fail-safe de money-path ya existente
  (`PAYOUT_ALLOW_MOCK==="true"`, `assertPayoutProviderSafe()`) también esté explícitamente seteado
  — el escape-hatch hereda ese gate, no lo bypassea ni crea uno nuevo en paralelo.
- AC-6: WHEN el escape-hatch responde, the system SHALL taggear el resultado con
  `provenance: "devnet-stub"` de forma distinguible tanto de `"transfi"` (real) como de
  `"local-fallback"` (mock puro) — trazabilidad honesta de que NO hubo off-ramp real ni tampoco es
  el mock genérico sin dirección.

## Scope IN
- `src/providers/payout.ts` — `FallbackPayoutProvider.execute()`/`.status()`: lógica del
  escape-hatch (lectura de env, guard de red, validación base58, fail-closed). Posible helper nuevo
  (ej. `resolveDevnetStubAddress()`), acotado a este archivo.
- `src/providers/payout.test.ts` — tests nuevos para AC-1..AC-6 (activo, precedencia del real,
  byte-idéntico sin env, fail-closed malformado, fail-closed red≠solana, provenance honesto),
  siguiendo el patrón `vi.stubEnv` + `afterEach(vi.unstubAllEnvs)` ya usado en el archivo.
- `project-context.md` — nueva fila en la tabla de env vars TransFi payout (L152-166):
  `TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS`.
- `README.md` — documentar la env con advertencia explícita "devnet-only, NUNCA producción".

## Scope OUT
- `src/agents/cashout-payout.ts` — no se espera tocarlo; el passthrough de `depositAddress`/
  `provenance` ya existe (WKH-212). Si el grounding en F2 encuentra un gap real, es una sorpresa a
  escalar, no a resolver a ciegas.
- `TransFiPayoutProvider` (path real) — cero cambios; el real es intocable en esta HU (CD).
- `getPayoutProvider()` — cero cambio de firma ni de lógica de selección; la precedencia del real se
  obtiene GRATIS por la estructura ya existente (Scope IN nota de grounding), no requiere tocar la
  factory.
- Validación criptográfica de curva Ed25519 de la pubkey (solo charset/longitud base58) — suficiente
  para el fail-closed pedido; una librería de validación de curva completa es over-engineering para
  un stub devnet.
- Generar/fondear la ATA USDC devnet real del equipo — es una acción operativa (founder/dev-ops),
  no código; ver Missing Inputs.
- Integración con `/api/payout/prepare` de chaski (rama Solana, HU-SOL-11) — vive en otro repo
  (chaski-v2), fuera de este work-item.
- Deploy a mainnet o cualquier uso con plata real — el escape-hatch es devnet-only por diseño.
- Nueva env de "modo devnet" genérica — se reutiliza `TRANSFI_USDC_NETWORK==="solana"` como guard de
  red existente en vez de introducir una env de contexto nueva.

## Decisiones técnicas (DT-N)
- DT-1: El escape-hatch vive DENTRO de `FallbackPayoutProvider` (no en `getPayoutProvider()` ni en
  `cashout-payout.ts`). Motivo: `getPayoutProvider()` ya devuelve `TransFiPayoutProvider` cada vez
  que las 3 creds + `TRANSFI_ADAPTER_READY` están presentes, sin importar qué otras envs existan —
  poner el stub adentro del mock hace que "el real gana" sea una propiedad ESTRUCTURAL del código
  (imposible de romper por accidente), no un `if` manual que alguien puede desordenar.
- DT-2: Fail-closed (AC-4) significa "cae al comportamiento del mock estándar"
  (`depositAddress: null`, `provenance: "local-fallback"`) — NO lanzar una excepción nueva. Se
  prefiere sobre un `throw` porque (a) preserva el contrato de salida existente del mock (nunca
  lanza), y (b) evita introducir un nuevo modo de fallo en un path que hoy es 100% estable.
- DT-3: Guard de red = reutilizar `TRANSFI_USDC_NETWORK==="solana"` (la misma env que ya resuelve
  `resolveSourceCurrency()`, WKH-209) en vez de crear una env de "modo devnet" nueva — un solo lugar
  de verdad para "estamos en contexto Solana".
- DT-4: Validación base58 = charset (`123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz`,
  sin `0OIl`) + rango de longitud típico de pubkey Solana (32-44 chars) — sin decodificación
  criptográfica completa. Suficiente para el fail-closed pedido (AC-4); una librería de Solana
  (`@solana/web3.js` `PublicKey`) es una dependencia nueva que el Architect debe evaluar en F2 si el
  charset/longitud no alcanza.

## Constraint Directives (CD-N)
- CD-1: PROHIBIDO que el escape-hatch se dispare cuando `TransFiPayoutProvider` está activo — el
  real SIEMPRE tiene precedencia (AC-2). PROHIBIDO cualquier `||`/rama que permita que el stub gane
  sobre el real.
- CD-2: OBLIGATORIO doble-gate mínimo: (a) `TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS` seteada Y (b)
  `TRANSFI_USDC_NETWORK==="solana"`. Ninguna de las dos por sí sola activa el escape-hatch.
  PROHIBIDO colapsar el gate a una sola condición "por simplicidad".
- CD-3: OBLIGATORIO `provenance: "devnet-stub"` — PROHIBIDO reusar `"transfi"` (mentira: no hubo
  off-ramp real) o `"local-fallback"` (pierde trazabilidad: no se distingue del mock sin address).
- CD-4: OBLIGATORIO que `TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS` NO seteada produzca comportamiento
  byte-idéntico al `FallbackPayoutProvider` actual (AC-3) — cero regresión en los tests existentes
  de `payout.test.ts`, cero cambio en su output sin la env.
- CD-5: OBLIGATORIO fail-closed (nunca fail-open) ante address malformada o red≠solana (AC-4) — el
  default ante cualquier ambigüedad es "no hay depositAddress", nunca "propagar lo que sea que
  vino".
- CD-6: PROHIBIDO que el escape-hatch cree un camino nuevo alrededor de
  `assertPayoutProviderSafe()` / `PAYOUT_ALLOW_MOCK` — el gate de prod ya existente para el mock
  DEBE seguir aplicando también al stub (AC-5), sin excepción ni bypass.
- CD-7: PROHIBIDO tocar `TransFiPayoutProvider`, `resolveSourceCurrency()`,
  `TRANSFI_USDC_CURRENCY`, o el contrato HTTP real de TransFi — cero cambio de comportamiento del
  path real (heredado del patrón CD-1 de WKH-209).
- CD-8: PROHIBIDO loguear el valor completo de `TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS` en un warn/log
  de forma que sugiera que es una address de producción — si se loguea (ej. al activarse el stub),
  el mensaje debe ser explícito "DEVNET STUB, NO real off-ramp" (mismo patrón de warns ruidosos que
  `assertPayoutProviderSafe()` ya usa para el mock).

## Missing Inputs
- [NEEDS CLARIFICATION] **numeración de ticket**: no se proveyó un ID de HU/WKH explícito para esta
  tarea; se usó `WKH-213` como placeholder secuencial (siguiente libre tras WKH-212 en este repo).
  A reconciliar con la numeración maestra del backlog Solana LATAM Labs (HU-SOL-N) si corresponde.
  No bloquea F1/F2 — solo requiere renombrar el folder/título si el humano da el ID real.
- [NEEDS CLARIFICATION] **founder-only**: la ATA USDC devnet real del equipo (el valor que va en
  `TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS` en el entorno de smoke de M5) — no es un bloqueante de
  código (los tests usan fixtures), pero SÍ bloquea la ejecución real del smoke on-chain hasta que
  exista la wallet devnet fondeada.
- [resuelto en F0] Guard de red: se reutiliza `TRANSFI_USDC_NETWORK==="solana"` (ya existe, WKH-209)
  en vez de una env nueva — ver DT-3.
- [resuelto en F0] Ubicación del código: dentro de `FallbackPayoutProvider`, no en la factory ni en
  el agente — ver DT-1 (da precedencia del real gratis, estructuralmente).
- [TBD — Architect en F2] Librería de validación base58 exacta (DT-4: charset/longitud vs.
  `@solana/web3.js PublicKey`) — decisión de F2 si el charset/longitud no es suficientemente
  estricto para el AR.

## Análisis de paralelismo
- Independiente de WKH-209 (DONE) — este work-item CONSUME el guard `TRANSFI_USDC_NETWORK==="solana"`
  que WKH-209 ya validó, pero no lo modifica ni depende de trabajo pendiente ahí.
- Es un **enabler bloqueante** del smoke on-chain de M5 (deposit→escrow→release en Solana Explorer,
  devnet): sin `depositAddress`, `/api/payout/prepare` de chaski (HU-SOL-11, otro repo) fail-close-a
  a 502 y el smoke no puede correr. No bloquea otras HUs de este repo; sí es prerequisito operativo
  para que el equipo de chaski-v2 pueda ejecutar el smoke.
- Puede ir en paralelo con cualquier HU de este repo que no toque `src/providers/payout.ts` (ej.
  trabajo en `src/providers/kyc.ts` o `src/providers/fx.ts`).
