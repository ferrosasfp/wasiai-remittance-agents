# Work Item — [WKH-209] HU-SOL-3 · remit-agents: off-ramp TransFi USDCSOL (Solana)

## Resumen
Validar y cubrir con tests el branch `network=solana` del adapter de payout TransFi
(`src/providers/payout.ts`), que ya mapea `solana → USDCSOL` (L29) y selecciona la red por env
(`TRANSFI_USDC_NETWORK`, L83-85). Es config + validación + tests, NO una reescritura del provider.
Documenta la env var `TRANSFI_USDC_NETWORK=solana` en README/project-context (no existe
`.env.example` ni `vercel.json` en este repo). Sprint 1 (Fundación) del plan Solana LATAM Labs,
independiente — arranca en paralelo. Devnet/sandbox TransFi, cero plata real.

## Sizing
- SDD_MODE: mini
- Estimación: S
- Branch sugerido: feat/wkh-209-usdcsol-offramp-config

## Grounding (F0 — hallazgos)
- `resolveSourceCurrency()` (`src/providers/payout.ts:41-45`) ya mapea `solana → "USDCSOL"` via
  `TRANSFI_USDC_CURRENCY` (L29) y es **fail-loud** (`transfi_unsupported_network_<red>`) para redes
  fuera del allowlist — el mapeo Solana YA está completo, no requiere código nuevo.
- `TransFiPayoutProvider.execute()` (L83-85) resuelve la red **antes** de armar el body
  (`process.env.TRANSFI_USDC_NETWORK ?? TRANSFI_DEFAULT_NETWORK`, default `"base"`) — cambiar a
  Solana es 100% config de env, no de código.
- `depositAddress` (L139-149) es un **pass-through opaco**: `readString(d, ["depositAddress",
  "walletAddress"])` no valida formato (ni `0x...` ni base58) — simplemente propaga lo que devuelve
  TransFi. No hay hoy ninguna validación de formato en runtime que discrimine EVM vs Solana.
- `payout.test.ts` ya tiene el patrón exacto a replicar para Solana: `"AC-6 feliz: polygon →
  source.currency USDCPOLYGON"` (L152-160) y `"...base (default) → source.currency USDCBASE"`
  (L162-170), vía `vi.stubEnv("TRANSFI_USDC_NETWORK", "<red>")`. NO existe hoy un test equivalente
  para `solana`.
- El repo **no tiene** `.env.example` ni `vercel.json` (confirmado por Glob — cero resultados). La
  única documentación de env vars vive en `README.md` (sección "Env vars") y en
  `project-context.md` (tabla env vars, L152-166 para las vars de TransFi payout). `TRANSFI_USDC_NETWORK`
  ya está documentada ahí de forma genérica ("red del USDC del `source`; default `base`") pero sin
  mencionar `solana`/`USDCSOL` como valor soportado explícito.
- Stack: Next.js 14 App Router + TS strict + Vitest (`npm run test` = `vitest run`,
  `npm run typecheck` = `tsc --noEmit`). Sin DB. `project-context.md` está al día (WKH-203, última
  vez tocado 2026-07-17 para WKH-212).

## Acceptance Criteria (EARS)
- AC-1: WHEN `TRANSFI_USDC_NETWORK=solana` está seteada, the system SHALL resolver
  `source.currency` a `"USDCSOL"` en el body de la orden creada por `TransFiPayoutProvider.execute()`.
- AC-2: WHEN la respuesta 2xx de TransFi para una orden `network=solana` incluye una deposit address
  en formato base58 (sin prefijo `0x`, ej. `"7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"`), the
  system SHALL propagarla intacta en `PayoutResult.depositAddress` sin transformarla ni truncarla.
- AC-3: WHILE `TRANSFI_USDC_NETWORK` no está seteada o toma cualquier otro valor ya soportado del
  allowlist (`base`, `polygon`, `ethereum`, `arbitrum`, `bsc`, `celo`, `linea`, `algorand`, `stellar`,
  `fuse`), the system SHALL mantener el comportamiento existente byte-idéntico (cero regresión —
  los tests `payout.test.ts` ya existentes para esas redes SHALL seguir pasando sin modificación).
- AC-4: the system SHALL documentar `TRANSFI_USDC_NETWORK=solana` (→ `USDCSOL`) como valor soportado
  en `README.md` (sección "Env vars") y en `project-context.md` (tabla de env vars TransFi payout),
  dado que este repo no tiene `.env.example` ni `vercel.json`.
- AC-5: IF una orden con red no soportada llega al provider (ej. `avalanche`, ya cubierto por el test
  existente L143-150), THEN the system SHALL seguir lanzando `transfi_unsupported_network_<red>`
  **sin** llamar a `fetch` — comportamiento fail-loud existente, no se debilita al agregar Solana.

## Scope IN
- `src/providers/payout.test.ts` — nuevo `it("AC-6 feliz: solana → source.currency USDCSOL", ...)`
  siguiendo el patrón de los tests `polygon`/`base` (L152-170), + un test que valida que un
  `depositAddress` base58 (fixture, ej. Solana pubkey de ejemplo) atraviesa intacto en el resultado
  (AC-2).
- `README.md` — sección "Env vars" / secciones de deploy: documentar `TRANSFI_USDC_NETWORK=solana`
  como valor válido junto a los existentes.
- `project-context.md` — tabla de env vars TransFi payout (L152-166): agregar la mención explícita
  de `solana → USDCSOL` como ejemplo de valor soportado (ya está la fila genérica de la var).
- `src/providers/payout.ts` — SOLO si al escribir los tests aparece algún gap real (no esperado según
  el grounding F0); si no aparece ningún gap, este archivo queda sin tocar.

## Scope OUT
- Reescribir `TransFiPayoutProvider` / el contrato HTTP TransFi (eso fue WKH-208, ya DONE).
- Integración chaski ↔ agentes (HU-SOL-15).
- FX enforcement / corridor real Solana (HU-SOL-18).
- Compliance `TransFi userId` (HU-SOL-22).
- Deploy a mainnet / uso de plata real.
- Agregar validación de **formato** (regex/librería base58) en runtime — hoy `depositAddress` es
  pass-through opaco por diseño (`readString()`); agregar una validación de formato sería un cambio
  de contrato nuevo, no pedido por esta HU.
- Acceso real al sandbox TransFi para Solana (credenciales, `userId`, deposit address real de
  prueba) — founder-only, ver Missing Inputs.
- Crear `.env.example` o `vercel.json` nuevos — el repo documenta env vars en README/project-context
  por convención existente (WKH-203..212); no se introduce un mecanismo de config nuevo en esta HU.

## Decisiones técnicas (DT-N)
- DT-1: Los tests nuevos siguen el patrón ya establecido en `payout.test.ts` (`vi.stubEnv` +
  `afterEach(vi.unstubAllEnvs)`, `stubFetch` con fixture JSON) — no se introduce un helper ni archivo
  de test nuevo.
- DT-2: `depositAddress` es pass-through opaco (`readString()`, sin narrowing de formato) — el test de
  AC-2 valida que un fixture con address base58 llega intacto al `PayoutResult`, NO que el código
  "reconoce" que es Solana o valida el formato (eso no existe hoy y no lo pide esta HU).
- DT-3: Sin `.env.example`/`vercel.json` en el repo (confirmado F0), la documentación de
  `TRANSFI_USDC_NETWORK=solana` vive en `README.md` + `project-context.md`, consistente con cómo se
  documentaron las demás env vars de TransFi (WKH-208, WKH-203).

## Constraint Directives (CD-N)
- CD-1: PROHIBIDO modificar `resolveSourceCurrency()` / el diccionario `TRANSFI_USDC_CURRENCY` — ya
  soporta `solana → "USDCSOL"` (payout.ts:29); cero cambio de firma ni de comportamiento del mapeo.
- CD-2: OBLIGATORIO que los tests existentes de las demás redes (`base`, `polygon`, `avalanche`
  fail-loud, etc., ya en `payout.test.ts`) sigan pasando **sin modificación** — cero regresión
  (AC-3).
- CD-3: PROHIBIDO ejecutar o apuntar a un sandbox TransFi real (Solana u otra red) desde esta HU —
  todo test usa `stubFetch`/fixtures mockeados, cero llamada de red real, cero plata real (sandbox
  devnet-only, consistente con el resto del repo).
- CD-4: PROHIBIDO tocar `getPayoutProvider()` o cualquier fail-safe money-path
  (`TRANSFI_ADAPTER_READY`, `assertPayoutProviderSafe`, `PAYOUT_ALLOW_MOCK`) — fuera de scope de esta
  HU, regla general del repo (`project-context.md` PROHIBIDO).

## Missing Inputs
- [NEEDS CLARIFICATION] **founder-only**: credenciales/IDs reales del sandbox TransFi para el
  network Solana (`TRANSFI_USER_ID`, `TRANSFI_SOURCE_WALLET_ADDRESS` Solana, un `depositAddress` real
  de prueba devuelto por el sandbox) — no disponibles hoy. No bloquea esta HU (el scope es
  config+tests con mocks); si se necesita un smoke test contra el sandbox real, es follow-up
  (mismo patrón que WKH-208, cuyo AC-4 smoke sandbox quedó pendiente).
- [resuelto en F0] Formato exacto de la deposit address base58 de Solana — no se valida en runtime
  (pass-through opaco, ver DT-2); no bloquea, se usa un fixture representativo en el test.

## Análisis de paralelismo
- Independiente — arranca en paralelo dentro de Sprint 1 (Fundación) del plan Solana LATAM Labs. No
  bloquea ni es bloqueada por otras HUs de S1.
- Es un input útil (no bloqueante) para HU-SOL-15 (integración chaski↔agentes): tener el branch
  Solana cubierto por tests da confianza antes de conectar el flujo real, pero HU-SOL-15 no depende
  estrictamente de que esta HU esté DONE para arrancar su propio trabajo.
