# SDD — [WKH-232 / HU-SOL-15] Escape-hatch devnet-only para `depositAddress` Solana (enabler smoke M5)

> ⚠️ **Corrección de numeración**: el `work-item.md` usó `WKH-213` como *placeholder* (Missing Inputs, L157-160). El ticket real es **WKH-232 / HU-SOL-15** (backlog Solana LATAM Labs). Este SDD ya adopta el ID correcto. El folder `006-devnet-beneficiary-escape-hatch/` y el título del `_INDEX.md` deben renombrarse en el cierre (F4/DONE) — no bloquea F2.

- **SDD_MODE**: mini (1 archivo de lógica: `src/providers/payout.ts` + tests + docs; sin cambio de contrato HTTP ni de schema — `depositAddress`/`provenance` ya existen desde WKH-212/WKH-208).
- **Input**: `work-item.md` (aprobado, HU_APPROVED). 6 ACs EARS, DT-1..4, CD-1..8, 2 Missing Inputs + 1 TBD para F2.
- **Baseline a verificar antes de tocar nada (W-1)**: `npm run test` verde (WKH-209 cerró en **151 tests / 9 files**) **y** `npm run typecheck` (`tsc --noEmit`) limpio. Sin verde previo no arranca ninguna wave.
- **Veredicto de grounding**: el escape-hatch es **aditivo dentro de `FallbackPayoutProvider`** (`payout.ts:185-208`). La precedencia del real y el gate de prod se obtienen **gratis, estructuralmente** (ver §5) — cero cambio en `getPayoutProvider()`, `TransFiPayoutProvider`, `assertPayoutProviderSafe()` ni `src/agents/cashout-payout.ts`.
- **TBD resuelto (validación base58)**: **charset + longitud (regex anclada), SIN `@solana/web3.js`** — ver DT-4. Confirmado por Grounding: `@solana/web3.js` **NO** es dependencia del repo (`package.json`: deps = `next/react/react-dom/zod`). Agregar una lib de curva Ed25519 a una app Next.js para un stub devnet es over-engineering (CD-7 del work-item, Scope OUT L100-102).

---

## 1. Context Map (archivos leídos + patrón extraído)

| Archivo | Símbolos foco (no nº de línea — lección WKH-203/204) | Qué confirmé / extraje |
|---|---|---|
| `src/providers/payout.ts` | `FallbackPayoutProvider.execute()`/`.status()`, `getPayoutProvider()`, `resolveSourceCurrency()`, `TRANSFI_USDC_CURRENCY` | El mock devuelve HOY **siempre** `depositAddress: null`, `provenance: "local-fallback"` en ambos métodos. `getPayoutProvider()` instancia `FallbackPayoutProvider` **solo** si falta alguna de las 3 creds (`TRANSFI_USERNAME/PASSWORD/MID`); con las 3 + `TRANSFI_ADAPTER_READY==="true"` devuelve `TransFiPayoutProvider` → **el mock ni se construye** (precedencia estructural, DT-1). `resolveSourceCurrency` hace `network.trim().toLowerCase()` — patrón de normalización a espejar. `readString` usa narrowing por `typeof` (nunca `String()` coercitivo) — patrón anti-fabricación a espejar. |
| `src/agents/cashout-payout.ts` | `assertPayoutProviderSafe()` | El gate de money-path ya existe: en `NODE_ENV==="production"` exige `PAYOUT_ALLOW_MOCK==="true"`, en dev/CI exige `ALLOW_FALLBACK_PAYOUT==="true"`; corre **ANTES** de `getPayoutProvider()`/del mock. El stub vive DENTRO del mock → **hereda este gate sin tocarlo** (CD-6, AC-5). El passthrough opaco de `result.depositAddress`/`result.provenance` a la salida HTTP ya existe (WKH-212) → **NO se toca este archivo**. |
| `src/providers/types.ts` | `Provenance = string`, `PayoutResult.depositAddress: string \| null` | Agregar el literal `"devnet-stub"` **no** requiere cambio de tipo (es `type Provenance = string`). El shape de `PayoutResult` no cambia. Cero cambio en `types.ts`. |
| `src/providers/payout.test.ts` | `stubFetch`, `describe("FallbackPayoutProvider …")`, `describe("getPayoutProvider factory (AC-5)")`, `afterEach(vi.unstubAllGlobals/unstubAllEnvs)` | **Patrón exacto a replicar**: `vi.stubEnv("KEY","val")` + `afterEach(vi.unstubAllEnvs)`. Los tests actuales del mock (`describe("FallbackPayoutProvider…")`) **NO stubean env** → sin `TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS` seteada corren byte-idénticos (CD-4/AC-3). El factory ya tiene el test "creds + readiness → TransFiPayoutProvider" — se extiende con el caso de precedencia + env devnet (AC-2). |
| `project-context.md` | Tabla "Env vars TransFi (WKH-208 — payout off-ramp real)" | Se agrega **1 fila**: `TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS`. Fila `TRANSFI_USDC_NETWORK` ya documenta `solana → USDCSOL` (guard de red reutilizado). |
| `README.md` | §Env vars (`TRANSFI_USDC_NETWORK=…`), nota `PAYOUT_ALLOW_MOCK` | Se agrega la env con advertencia explícita **"devnet-only, NUNCA producción"**, consistente con la nota `PAYOUT_ALLOW_MOCK` existente. |
| `package.json` | scripts `typecheck`/`test` | `typecheck = tsc --noEmit` (incluye `*.test.ts` — gate real, lección WKH-196/208), `test = vitest run`. `@solana/web3.js` **ausente** → TBD resuelto por charset (DT-4). |
| `doc/sdd/00{2,3,4}/auto-blindaje.md` | — | 3 patrones recurrentes → CD-9, CD-10, CD-11 (§3). |

---

## 2. Decisiones técnicas

**Heredadas del work-item (vigentes, verbatim):**
- **DT-1**: El escape-hatch vive **DENTRO de `FallbackPayoutProvider`** (no en `getPayoutProvider()` ni en `cashout-payout.ts`). "El real gana" es una propiedad **estructural**: la factory devuelve `TransFiPayoutProvider` cada vez que están las 3 creds + readiness, así que el stub **ni se evalúa** cuando el real está activo (imposible de romper por accidente, no es un `if` manual).
- **DT-2**: Fail-closed (AC-4) = **caer al comportamiento del mock estándar** (`depositAddress: null`, `provenance: "local-fallback"`), **NO** lanzar excepción. Preserva el contrato del mock (nunca lanza) y no introduce un modo de fallo nuevo en un path 100% estable.
- **DT-3**: Guard de red = reutilizar `TRANSFI_USDC_NETWORK==="solana"` (la env que ya usa `resolveSourceCurrency`, WKH-209) — un solo lugar de verdad para "contexto Solana", sin env nueva.

**Resuelta por el Architect en F2 (cerraba el TBD del work-item):**
- **DT-4 (validación base58)**: **charset + longitud vía regex anclada**, sin dependencia nueva.
  - Charset base58 (alfabeto Bitcoin/Solana, excluye `0 O I l`): `123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz`.
  - Rango de longitud de pubkey Solana (32 bytes ⇒ base58): **32–44** chars.
  - Regex: `` /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{32,44}$/ ``, aplicada sobre el valor **trimeado** (`raw.trim()`, mismo patrón que `resolveSourceCurrency`).
  - **Por qué alcanza y por qué NO `@solana/web3.js`**: el fail-closed pedido (AC-4) es "no propagar una address malformada". El charset ancorado + rango de longitud rechaza EVM (`0x…` → contiene `0`, fuera del charset), strings vacíos/whitespace, chars ambiguos (`0OIl`) y longitudes fuera de rango. La verificación de curva Ed25519 es **Scope OUT** explícito (work-item L100-102). Agregar `@solana/web3.js` (dep pesada, ecosistema web3 completo) a una app Next.js/Zod para un stub devnet es over-engineering. El `trim()` es una normalización que **no debilita** el gate: la regex anclada `^…$` sigue rechazando cualquier whitespace/char interno.

- **DT-5 (alcance del stub: execute + status)**: el stub se aplica a **ambos** `execute()` y `status()` del mock (Scope IN L82-84 los nombra a los dos), vía un único helper `resolveDevnetStubAddress()`. Motivo: mantiene el mock internamente consistente (hoy ambos métodos devuelven el mismo shape) y permite que el smoke de M5 pueda **pollear `status()`** y seguir viendo el `depositAddress`. Nota honesta: el `TransFiPayoutProvider` real es asimétrico (`execute` devuelve address, `status` null) — el mock **no** replica esa asimetría porque es un stand-in, no el partner; la simetría del mock es preferible para el enabler.

- **DT-6 (helper local, no exportado por defecto)**: `resolveDevnetStubAddress(): string | null` es una función **module-scope** en `payout.ts` (junto a `resolveSourceCurrency`). Devuelve la address válida o `null`. Se **exporta** para poder testearla en aislamiento (mutation-resistance de la validación base58, CD-10) — mismo criterio que `resolveSourceCurrency`/`normalizeStatus` ya exportados.

---

## 3. Constraint Directives

**Heredados del work-item (vigentes, verbatim — CD-1..8):**
- **CD-1**: PROHIBIDO que el stub se dispare cuando `TransFiPayoutProvider` está activo — el real SIEMPRE tiene precedencia (AC-2). PROHIBIDO cualquier `||`/rama que permita que el stub gane sobre el real.
- **CD-2**: OBLIGATORIO doble-gate mínimo: (a) `TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS` seteada Y (b) `TRANSFI_USDC_NETWORK==="solana"`. Ninguna sola activa el hatch. PROHIBIDO colapsar el gate a una condición.
- **CD-3**: OBLIGATORIO `provenance: "devnet-stub"` — PROHIBIDO reusar `"transfi"` (mentira: no hubo off-ramp real) o `"local-fallback"` (pierde trazabilidad).
- **CD-4**: OBLIGATORIO que la env NO seteada produzca comportamiento **byte-idéntico** al `FallbackPayoutProvider` actual (AC-3) — cero regresión, cero cambio en el output de los tests existentes del mock.
- **CD-5**: OBLIGATORIO fail-closed (nunca fail-open) ante address malformada o red≠solana (AC-4) — default ante ambigüedad = "no hay depositAddress".
- **CD-6**: PROHIBIDO crear un camino nuevo alrededor de `assertPayoutProviderSafe()` / `PAYOUT_ALLOW_MOCK` — el gate de prod del mock DEBE seguir aplicando al stub (AC-5).
- **CD-7**: PROHIBIDO tocar `TransFiPayoutProvider`, `resolveSourceCurrency()`, `TRANSFI_USDC_CURRENCY` o el contrato HTTP real de TransFi.
- **CD-8**: PROHIBIDO loguear el valor completo de `TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS` sugiriendo que es address de producción. Si se loguea al activarse, el mensaje debe ser explícito "DEVNET STUB, NO real off-ramp". **Refinamiento del Architect**: el warn es **value-free** (no imprime la address en absoluto), espejando el estilo de los warns de `assertPayoutProviderSafe()` y `normalizeStatus()`.

**Agregados por el SDD (Auto-Blindaje histórico — previenen errores recurrentes; NO opcionales):**
- **CD-9** *(anti-recurrente, ref: WKH-208 auto-blindaje#2 + WKH-196)*: el gate de cierre de cada wave es **`npm run typecheck` COMPLETO** (`tsc --noEmit`, incluye `*.test.ts`), NO alcanza `npm run test`. Bajo `noUncheckedIndexedAccess`, destructurar `fetchMock.mock.calls[0]` sin `!` **pasa los tests pero rompe `tsc`**. Usar `mock.calls[0]![1]?.body` (patrón vigente en el archivo). Los tests de este SDD casi no tocan `fetch` (el stub no hace fetch), pero el gate `typecheck` completo es innegociable.
- **CD-10** *(anti-recurrente, ref: WKH-204 auto-blindaje — mutation `===`→`.startsWith`/`.includes`)*: la validación base58 (DT-4) es susceptible a mutación de límites. OBLIGATORIO test explícito de **boundary de longitud** (31 y 45 chars → fail-closed; 32 y 44 → válido) y de **charset** (chars `0/O/I/l` → fail-closed) para que ningún mutante que relaje `{32,44}` a `{0,}` o el charset sobreviva. La regex debe estar **anclada** `^…$` (un mutante que quite `$` dejaría pasar sufijos basura).
- **CD-11** *(anti-recurrente, ref: WKH-212 auto-blindaje — `Object.keys(output).sort()` de contrato)*: antes de dar la wave por cerrada, `grep` por aserciones de contrato de wire (`Object.keys(...).toEqual([...])`/snapshots) en `src/**/route.test.ts`. Esta HU **NO** cambia el schema de salida (solo el **valor** de `depositAddress`/`provenance`, ya expuestos por WKH-212) → **no se espera romper** ningún `Object.keys`. Si aparece un rojo de contrato, es scope mal medido → **escalar, no editar a ciegas**. También: cuidar la **indentación** exacta del `old_string` del return del mock (top-level de la función, no anidado) — error de anchor de WKH-212.

---

## 4. Exemplars verificados (paths confirmados por Read/Glob)

| Patrón a seguir | Exemplar verificado | Qué copiar |
|---|---|---|
| Helper de resolución por env + normalización + fail-loud/closed | `resolveSourceCurrency(network)` en `src/providers/payout.ts` | `network.trim().toLowerCase()` como normalización; función module-scope exportada. (Acá el fail es **closed → null**, no `throw`, por DT-2.) |
| Narrowing por tipo, nunca coerción | `readString(obj, keys)` en `src/providers/payout.ts` | `typeof v === "string" && v.length > 0` antes de aceptar un valor. |
| Warn value-free (sin PII/sin valor sensible) | `normalizeStatus()` (`console.warn` solo con la etiqueta) + `assertPayoutProviderSafe()` (warns ruidosos del mock) | Mensaje explícito "DEVNET STUB, NO real off-ramp", **sin** la address (CD-8). |
| Shape del return del mock | `FallbackPayoutProvider.execute()`/`.status()` | Mismos 7 campos; solo cambian `provenance` y `depositAddress` cuando el gate pasa. |
| Test con env + limpieza | `describe("getPayoutProvider factory (AC-5)")` + `afterEach(vi.unstubAllEnvs)` | `vi.stubEnv(...)` + `afterEach` que desestubea; fixture `input` global (top del archivo). |
| Fixture base58 Solana real (para el caso feliz) | test "AC-2: solana → depositAddress base58 pass-through" (`7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU`) | Reusar esa address como fixture válido (44 chars, base58 legítima). |

---

## 5. Análisis de seguridad — "¿puede dispararse en prod?" (para el AR)

Tres capas independientes impiden que el escape-hatch mueva plata o se filtre a prod. Ninguna es tocada por esta HU:

1. **Precedencia estructural del real (DT-1, CD-1)**: `getPayoutProvider()` devuelve `TransFiPayoutProvider` siempre que estén las 3 creds + `TRANSFI_ADAPTER_READY==="true"`. Cuando el real está configurado, `FallbackPayoutProvider` **ni se instancia** → `resolveDevnetStubAddress()` nunca corre. No es un `if` que alguien pueda desordenar: es la topología de la factory (sin cambios).
2. **Gate de prod heredado (CD-6, AC-5)**: `assertPayoutProviderSafe()` corre ANTES del mock y, en `NODE_ENV==="production"`, exige `PAYOUT_ALLOW_MOCK==="true"` explícito para permitir cualquier provider no-real. El stub vive dentro del mock → **si el mock no puede correr en prod, el stub tampoco**. No se agrega ni debilita ninguna rama de ese gate.
3. **Doble-gate + fail-closed del propio hatch (CD-2, CD-5)**: aún dentro del mock, el stub solo produce address si `TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS` está seteada **Y** `TRANSFI_USDC_NETWORK==="solana"` **Y** el valor es base58 válido. Cualquier falla → `null` (comportamiento actual). No mueve plata en ningún caso: el mock nunca desembolsa (`deliveredLocal: null`, es un stand-in).

**Superficie de riesgo neta**: para que el stub emita una address hacen falta, simultáneamente: (a) mock activo (real ausente), (b) en prod además `PAYOUT_ALLOW_MOCK=true` explícito, (c) `TRANSFI_USDC_NETWORK=solana`, (d) `TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS` seteada a un base58 válido. Es exactamente el estado del smoke de M5 (devnet), y aún ahí el mock **no desembolsa**. El único efecto es un `depositAddress` devnet en la respuesta, taggeado `provenance:"devnet-stub"` (trazable).

---

## 6. Waves de implementación (mini — serial: W0 gate/validación → W1 wiring → W2 tests+doc)

> **W-1 (pre-gate)**: correr `npm run test` + `npm run typecheck` y confirmar verde/limpio ANTES de editar. Registrar el nº de tests baseline (esperado 151).

### W0 — Helper de resolución (gate + validación base58) — AC-1/AC-4/CD-2/CD-5/DT-4/DT-6
Archivo único: **`src/providers/payout.ts`** (aditivo — se agrega el helper, no se toca nada existente aún).

1. Agregar constante module-scope `BASE58_ADDR_RE` (regex anclada de DT-4).
2. Agregar y **exportar** `resolveDevnetStubAddress(): string | null`:
   - `const raw = process.env.TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS;` → si falsy (unset/`""`) → `return null` (CD-4: byte-idéntico).
   - `if (process.env.TRANSFI_USDC_NETWORK !== "solana") return null;` (CD-2 guard de red; DT-3).
   - `const addr = raw.trim(); if (!BASE58_ADDR_RE.test(addr)) { console.warn("[remit-payout] TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS ignorada: no es base58 válida (DEVNET STUB, NO real off-ramp)"); return null; }` (CD-5 fail-closed; CD-8 value-free).
   - `console.warn("[remit-payout] DEVNET STUB deposit address ACTIVO — devnet-only, NO real off-ramp");` (CD-8, value-free, sin la address). `return addr;`

**Gate W0**: `npm run typecheck` limpio (CD-9). Sin tests aún (van en W2), pero el archivo debe compilar.

### W1 — Wiring en `FallbackPayoutProvider` — AC-1/AC-3/AC-6/CD-3/CD-4/DT-5
Archivo único: **`src/providers/payout.ts`**.

1. En `execute()`: antes del `return`, `const stub = resolveDevnetStubAddress();` y en el objeto retornado cambiar **solo** dos campos:
   - `provenance: stub ? "devnet-stub" : "local-fallback"` (CD-3/AC-6),
   - `depositAddress: stub` (era `null`; con `stub===null` queda `null` → CD-4/AC-3 byte-idéntico).
   - Los otros 5 campos (`payoutId`, `status`, `deliveredLocal`, `txRef`, `failureReason`) **intactos**.
2. En `status()`: idéntico tratamiento (DT-5) — `const stub = resolveDevnetStubAddress();`, `provenance` y `depositAddress` condicionales, resto intacto.
3. ⚠️ Indentación del `old_string`/anchor: el `return` del mock está a nivel de método (lección WKH-212, CD-11).

**Gate W1**: `npm run typecheck` limpio + `npm run test` verde (los tests actuales del mock siguen pasando **sin modificarse** porque no stubean la env → `stub===null` → salida idéntica; CD-4).

### W2 — Tests (≥1 por AC) + documentación — AC-1..6 + CD-10
Archivos: **`src/providers/payout.test.ts`** (tests), **`project-context.md`** + **`README.md`** (docs).

**Tests** — nuevo `describe("FallbackPayoutProvider — escape-hatch devnet (WKH-232)")` con `afterEach(() => vi.unstubAllEnvs())` (patrón del factory). Un `it` por AC + los boundary de CD-10:

| ID | AC/CD | Arrange | Assert |
|---|---|---|---|
| T-1 | **AC-1** (hatch activo, doble-gate) | `vi.stubEnv("TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS","7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU")` + `vi.stubEnv("TRANSFI_USDC_NETWORK","solana")` | `execute(input)` → `depositAddress === "7xKXt…"` **y** `provenance === "devnet-stub"`. (No hay `fetch` stub → prueba implícita de que **no** se llama a TransFi.) |
| T-2 | **AC-6/CD-3** (provenance distinguible) | igual a T-1 | `provenance` ≠ `"transfi"` **y** ≠ `"local-fallback"`; `=== "devnet-stub"`. |
| T-3 | **AC-2** (precedencia del real) | `vi.stubEnv` las 3 creds + `TRANSFI_ADAPTER_READY="true"` + la env devnet + `TRANSFI_USDC_NETWORK="solana"` | `getPayoutProvider()` es `instanceof TransFiPayoutProvider` (el mock ni se instancia → stub inalcanzable). |
| T-4 | **AC-3/CD-4** (byte-idéntico sin env) | **sin** stubear `TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS` | `execute(input)` → `depositAddress === null` **y** `provenance === "local-fallback"` (idéntico a hoy). |
| T-5 | **AC-4a/CD-5** (malformado → fail-closed) | env devnet = `"0xNOTbase58INVALID"` (contiene `0`) + red solana | `depositAddress === null` **y** `provenance === "local-fallback"`. |
| T-6 | **AC-4b/CD-2** (red≠solana → fail-closed) | env devnet = address base58 válida + `TRANSFI_USDC_NETWORK="base"` | `depositAddress === null` **y** `provenance === "local-fallback"`. |
| T-7 | **AC-5/CD-6** (hereda gate prod) | `NODE_ENV="production"`, sin creds reales, sin `PAYOUT_ALLOW_MOCK`, con env devnet+solana | `assertPayoutProviderSafe()` **throws** `payout_refused` (importar la función o llamar el path del agente) → el stub nunca se alcanza; documenta que el gate no se bypassea. *(Si `assertPayoutProviderSafe` no está exportada, testear vía el path del agente `cashout-payout` que ya lo invoca; ver nota abajo.)* |
| T-8 | **CD-10** (boundary longitud, mutation-kill) | `resolveDevnetStubAddress` directo con `TRANSFI_USDC_NETWORK="solana"`: 31 chars → null; 32 chars → address; 44 chars → address; 45 chars → null | mata mutantes que relajen `{32,44}`. |
| T-9 | **CD-10** (charset, mutation-kill) | direcciones de 43 chars con `0`, `O`, `I`, `l` respectivamente | cada una → `null` (mata mutantes que amplíen el charset). |

**Nota T-7**: `assertPayoutProviderSafe()` es hoy `function` no-exportada en `cashout-payout.ts`. Opciones (decide el Dev en F3, ambas válidas): (a) test de integración por el handler del agente que ya la invoca; (b) exportarla (cambio aditivo mínimo). **Preferencia del SDD**: (a) — no ampliar superficie exportada solo para el test; si el Dev encuentra que el path del agente no es aislable en test, (b) es aceptable y NO viola Scope OUT (no cambia comportamiento). Si ninguna es limpia → escalar (no forzar).

**Docs**:
1. `project-context.md` — nueva fila en la tabla "Env vars TransFi": `TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS` | *"ATA USDC **devnet** del equipo. Escape-hatch **devnet-only, opt-in**: cuando está seteada Y `TRANSFI_USDC_NETWORK=solana` Y el provider real NO está activo, el mock devuelve esta address con `provenance:devnet-stub`. Fail-closed si no es base58 o red≠solana. **NUNCA en prod real** (hereda el gate `PAYOUT_ALLOW_MOCK`). Enabler del smoke M5, no mueve plata."*
2. `README.md` — documentar la env junto a `TRANSFI_USDC_NETWORK`, con la advertencia **"⚠️ devnet-only — NUNCA setear en un deploy de producción"**, consistente con la nota `PAYOUT_ALLOW_MOCK` existente.

**Gate W2**: `npm run test` verde (`151 + 9` esperado, los 151 previos byte-idénticos — CD-4/CD-11) **y** `npm run typecheck` limpio (CD-9).

---

## 7. Plan de tests (cobertura AC × test)

| AC | Cubierto por | Tipo |
|---|---|---|
| AC-1 (activo, doble-gate, sin fetch a TransFi) | T-1 | unit `FallbackPayoutProvider.execute` |
| AC-2 (real tiene precedencia) | T-3 | unit factory `getPayoutProvider` |
| AC-3 (byte-idéntico sin env) | T-4 + suite existente del mock (sin modificar) | unit / no-regresión |
| AC-4a (malformado → fail-closed) | T-5, T-8, T-9 | unit |
| AC-4b (red≠solana → fail-closed) | T-6 | unit |
| AC-5 (hereda gate prod) | T-7 | integración / guard |
| AC-6 (provenance distinguible) | T-2 | unit |
| CD-10 (mutation-kill base58) | T-8, T-9 | unit sobre `resolveDevnetStubAddress` |

Cobertura: **6/6 ACs** con ≥1 test cada uno; validación base58 blindada contra mutación de límites y charset.

---

## 8. Readiness Check

- [x] Work-item leído completo (6 ACs, DT-1..4, CD-1..8, Missing Inputs, TBD).
- [x] `project-context.md` (tabla env TransFi) leído — fuente de verdad del stack confirmada; sin drift.
- [x] Exemplars verificados por Read (no inventados): `resolveSourceCurrency`, `readString`, `FallbackPayoutProvider`, `getPayoutProvider`, `assertPayoutProviderSafe`, patrón de test `vi.stubEnv`+`afterEach`, fixture base58 real.
- [x] Stack confirmado: `@solana/web3.js` **ausente** de `package.json` → TBD resuelto por charset/longitud (DT-4), sin dep nueva.
- [x] Precedencia del real (AC-2/CD-1) y gate de prod (AC-5/CD-6) confirmados **estructurales**, sin cambio en factory/gate (§5).
- [x] CD del work-item (1..8) heredados verbatim + 3 CD anti-recurrentes del Auto-Blindaje (CD-9 typecheck completo, CD-10 mutation base58, CD-11 contrato wire/indentación).
- [x] Waves con archivo exacto por wave; W0/W1/W2 con gate de tooling explícito.
- [x] Plan de tests ≥1 por AC + boundary/charset para mutation-resistance.
- [ ] **[NEEDS CLARIFICATION — no bloqueante para F3]** valor real de la ATA USDC devnet del equipo (Missing Input founder-only): **NO bloquea el código** (los tests usan fixtures); bloquea la **ejecución** del smoke M5. A proveer por founder/dev-ops fuera de esta HU.
- [ ] **[Renombre de folder/ID — cierre F4/DONE]** `006-devnet-beneficiary-escape-hatch` + fila `_INDEX.md`: reemplazar el placeholder `WKH-213` por `WKH-232 / HU-SOL-15`.

**Veredicto**: SDD **listo para SPEC_APPROVED**. Los 2 items abiertos son operativos (valor de env real) y de housekeeping (renombre de ID), ninguno bloquea la implementación del código en F3.
