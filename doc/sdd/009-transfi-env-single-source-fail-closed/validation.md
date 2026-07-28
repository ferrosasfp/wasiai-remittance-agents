# Validación 009 · ambiente de TransFi (fail-closed + fuente única)

**Cero requests reales**: `fetch` mockeado en todos los tests. Ninguna llamada a `api.transfi.com`
(ni a `sandbox-api.transfi.com`) en ningún momento de la validación.

## Gates

| Gate | Antes | Después |
|---|---|---|
| `npm run typecheck` (`tsc --noEmit`) | OK | OK |
| `npm test` (`vitest run`) | **195 passed** / 10 archivos | **224 passed** / 11 archivos |
| `npm run build` (`next build`) | OK | OK |

No hay script de linter en `package.json` (solo `dev`, `build`, `start`, `typecheck`, `test`,
`test:watch`), así que los gates del repo son typecheck + tests (+ build).

Ningún test bajó ni se borró: los 195 previos siguen verdes, +29 nuevos (`transfi-env.test.ts`).

## Mutaciones (12/12 cazadas)

Método: romper **un** guard por vez en el código de producción, correr `tsc --noEmit` + la suite
completa, y restaurar desde una copia en el scratchpad (nunca `git checkout`/`reset`). Al final la
suite vuelve a 224 verdes y `tsc` rc=0 (verificado por el harness).

| # | Guard mutado | Mutación | Resultado |
|---|---|---|---|
| M1 | fail-closed sin `TRANSFI_ENV` (`transfi-env.ts:62-68`) | el throw pasa a `return "sandbox"` | **RED** 5 failed / 219 passed |
| M2 | conjunto cerrado del env (`:69-72`) | valor inválido pasa a `return "sandbox"` | **RED** 1 failed / 223 |
| M3 | `production` exige `NODE_ENV=production` (`:73-79`) | condición a `false` | **RED** 1 failed / 223 |
| M4 | override no puede contradecir el ambiente (`:117-122`) | condición a `false` | **RED** 2 failed / 222 |
| M5 | host `*.transfi.com` no clasificable (`:123-129`) | condición a `false` | **RED** 1 failed / 223 |
| M6 | host no-partner en production (`:130-136`) | condición a `false` | **RED** 1 failed / 223 |
| M7 | `http` a host remoto (`:108-113`) | condición a `false` | **RED** 1 failed / 223 |
| M8 | normalización de la barra final (`:139`) | se devuelve el override crudo | **RED** 2 failed / 222 |
| M9 | URL inválida → error tipado (`:103`) | cae al canónico en vez de lanzar | **RED** 1 failed / 223 |
| M10 | fuente única (test estructural G-17) | `payout.ts` vuelve a leer `TRANSFI_BASE_URL` | **RED** 1 failed / 223 |
| M11 | resolución LAZY (`payout.ts:293-296`) | resolver el ambiente ANTES del check de creds | **RED** 43 failed / 181 |
| M12 | brand del tipo (`fx.ts:189`) | `new TransFiFxProvider(key, "https://api.transfi.com")` | **TSC-ERROR** + 5 tests RED |

### Detalle por mutación (tests que se pusieron rojos)

**M1** (el bug original, al revés: volver a adivinar el ambiente)
- `G-1: TRANSFI_ENV ausente → throw transfi_env_unset (NUNCA un host adivinado)`
- `G-1: TRANSFI_ENV ausente → el error NO contiene el host productivo del partner`
- `G-1: TRANSFI_ENV="" (seteada vacía) también es fail-closed`
- `G-13: getFxQuoteProvider con key+readiness y SIN TRANSFI_ENV → throw, y CERO fetch`
- `G-13: getPayoutProvider con creds+readiness y SIN TRANSFI_ENV → throw, y CERO fetch`

**M2** → `G-2: TRANSFI_ENV con un valor fuera del conjunto cerrado → transfi_env_invalid`

**M3** → `G-4: production fuera de NODE_ENV=production → throw (dev/CI no le habla al partner real)`

**M4** → `G-6: sandbox + override al host PRODUCTIVO → transfi_base_url_env_conflict` y
`G-6: production + override al host de SANDBOX → transfi_base_url_env_conflict`

**M5** → `G-7: sandbox + host *.transfi.com no clasificable → fail-closed (podría ser productivo)`

**M6** → `G-8: production + host que no es del partner (mock) → refuse`

**M7** → `G-10: http a un host remoto → refuse (las creds Basic viajarían en claro)`

**M8** → `G-9: sandbox + mock local en http → permitido (CI), y normaliza la barra final` y
`G-12: override igual al canónico del ambiente declarado → pasa (idempotente)`

**M9** → `G-11: override que no es una URL absoluta → transfi_base_url_invalid`

**M10** → `G-17: payout.ts no lee TRANSFI_BASE_URL ni hardcodea un host de TransFi`

**M11** (prueba que los tests de no-regresión de devnet NO son vacuos): 43 rojos, entre ellos
- `G-18: sin creds y sin TRANSFI_ENV → las dos factories devuelven el fallback, sin throw`
- `G-18: devnet e2e (mock + devnet-stub) ejecuta sin TRANSFI_ENV`
- `G-18: PROD + PAYOUT_ALLOW_MOCK sin TRANSFI_ENV → el gate KYC bloquea, NO transfi_env_unset`
- `getPayoutProvider factory (AC-5) > sin las 3 creds → fallback` (+ los 2 hermanos)
- `POST /api/agents/remit-cashout-payout/invoke > PROD + PAYOUT_ALLOW_MOCK → 200 mock (local-fallback, no mueve plata)`
- `runCashoutPayout — depositAddress (WKH-212) > AC-2: mock → depositAddress null, resto intacto`

**M12** (doble red: tipos + tests). El typechecker lo rechaza:
`src/providers/fx.ts(189,37): error TS2345: Argument of type 'string' is not assignable to parameter of type 'TransFiBaseUrl'.`
Y como vitest transpila sin typecheck, además reproduce el bug original y lo cazan:
- `G-15: mismo TRANSFI_ENV → mismo origin en las dos requests reales` ← el "sandbox a medias"
- `G-16: un override único mueve a los DOS providers a la vez (una sola fuente de verdad)`
- `G-13: getFxQuoteProvider con key+readiness y SIN TRANSFI_ENV → throw, y CERO fetch`
- `G-17: fx.ts no lee TRANSFI_BASE_URL ni hardcodea un host de TransFi`
- `G-17: fx.ts obtiene el host SOLO vía resolveTransFiBaseUrl()`

## No-regresión del modo devnet actual (sin creds TransFi + `PAYOUT_ALLOW_MOCK`)

| Verificación | Evidencia |
|---|---|
| Sin creds y sin `TRANSFI_ENV` las dos factories devuelven el fallback, sin throw | G-18 (`transfi-env.test.ts`) |
| El flujo devnet e2e (mock + `devnet-stub`) ejecuta y devuelve la deposit address, sin `TRANSFI_ENV` | G-18 (`executed:true`, `provenance:"devnet-stub"`) |
| En ese flujo el único fetch es el de Didit: ninguna URL contiene `transfi.com` | G-18 (assert por cada URL capturada) |
| `NODE_ENV=production` + `PAYOUT_ALLOW_MOCK=true` sin `TRANSFI_ENV`: bloquea el gate KYC, **no** `transfi_env_unset` | G-18 |
| Los 9 tests del escape-hatch devnet (WKH-232, T-1..T-9) siguen verdes sin cambios | `payout.test.ts` |
| `next build` no evalúa el ambiente (resolución lazy) | `npm run build` OK |
