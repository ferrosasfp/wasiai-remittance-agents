# Story File — [WKH-232 / HU-SOL-15] Escape-hatch devnet-only para `depositAddress` Solana

> Contrato autocontenido para el Dev (F3). Si algo no está acá, no se hace. SDD_MODE: **mini**.
> Cambio **100% ADITIVO** dentro de `FallbackPayoutProvider`. Seguridad-sensible (money-path).
> Fuente: `sdd.md` (SPEC_APPROVED) — este archivo es el guion de implementación wave-por-wave.

---

## Contexto compacto (qué se construye y por qué)

El smoke on-chain de **M5** (deposit→escrow→release en Solana Explorer, **devnet, cero plata real**)
necesita que el payout devuelva un `depositAddress` real, pero hoy no hay creds sandbox de TransFi
para generarlo. Sin `depositAddress`, `/api/payout/prepare` de chaski (otro repo) fail-close-a a 502
y el smoke no corre.

Esta HU agrega un **escape-hatch devnet-only, opt-in, fail-closed** DENTRO de
`FallbackPayoutProvider` (el mock): cuando `TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS` está seteada a un
base58 válido **Y** `TRANSFI_USDC_NETWORK==="solana"` **Y** el provider real NO está activo, el mock
devuelve esa address con `provenance:"devnet-stub"` — **sin llamar a TransFi, sin mover plata**. En
cualquier otro caso el mock se comporta **byte-idéntico a hoy** (`depositAddress:null`,
`provenance:"local-fallback"`).

**El real SIEMPRE gana**: es estructural — `getPayoutProvider()` instancia `TransFiPayoutProvider`
cuando están las 3 creds + readiness, así que el mock (y el stub) **ni se construyen**. El gate de
prod (`assertPayoutProviderSafe()` / `PAYOUT_ALLOW_MOCK`) corre ANTES del mock → el stub lo **hereda
gratis, sin tocarlo**.

---

## Scope IN (lista exhaustiva de archivos a tocar)

| # | Archivo | Qué se hace |
|---|---|---|
| 1 | `src/providers/payout.ts` | W0: helper `resolveDevnetStubAddress()` + const `BASE58_ADDR_RE`. W1: wiring en `FallbackPayoutProvider.execute()` y `.status()` (solo 2 campos c/u). |
| 2 | `src/providers/payout.test.ts` | W2: nuevo `describe(...)` con T-1..T-9. **NO modificar** los describes existentes. |
| 3 | `project-context.md` | W2: 1 fila nueva en la tabla "Env vars TransFi" (tras L166). |
| 4 | `README.md` | W2: 1 línea en el bloque env (L46-52) con advertencia "devnet-only, NUNCA producción". |

### ⛔ NO tocar (solo contexto, ya verificado por el Architect)
- `src/agents/cashout-payout.ts` — el passthrough de `depositAddress`/`provenance` ya existe (WKH-212);
  `assertPayoutProviderSafe()` se hereda, no se modifica.
- `TransFiPayoutProvider`, `resolveSourceCurrency()`, `TRANSFI_USDC_CURRENCY`, `getPayoutProvider()`.
- `src/providers/types.ts` — `Provenance = string` ya admite `"devnet-stub"` sin cambio de tipo.

---

## Constraint Directives (heredadas del SDD — INVIOLABLES)

- **CD-1** — PROHIBIDO que el stub se dispare con `TransFiPayoutProvider` activo. El real SIEMPRE
  precede. **PROHIBIDO tocar `getPayoutProvider()`** (la precedencia es estructural: el mock ni se
  instancia). PROHIBIDO cualquier `||`/rama que deje al stub ganar sobre el real.
- **CD-2** — OBLIGATORIO **doble-gate**: (a) `TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS` seteada **Y**
  (b) `TRANSFI_USDC_NETWORK==="solana"`. Ninguna sola activa el hatch. PROHIBIDO colapsar a una condición.
- **CD-3** — OBLIGATORIO `provenance:"devnet-stub"`. PROHIBIDO reusar `"transfi"` (mentira: no hubo
  off-ramp real) o `"local-fallback"` (pierde trazabilidad). **Provenance honesto.**
- **CD-4** — OBLIGATORIO **byte-idéntico sin la env**: unset/`""` → salida idéntica a hoy
  (`depositAddress:null`, `provenance:"local-fallback"`). Los 2 tests existentes del mock
  (`payout.test.ts:44-58`) DEBEN pasar **sin modificarse**.
- **CD-5** — OBLIGATORIO **fail-closed**: address malformada (no base58) o red≠solana → cae al mock
  estándar (`null`/`local-fallback`). NUNCA `throw`, NUNCA propagar lo que sea que vino.
- **CD-6** — PROHIBIDO crear un camino alrededor de `assertPayoutProviderSafe()`/`PAYOUT_ALLOW_MOCK`.
  El gate de prod del mock DEBE seguir aplicando al stub. **No debilitar el gate.**
- **CD-7** — PROHIBIDO tocar `TransFiPayoutProvider`, `resolveSourceCurrency()`, `TRANSFI_USDC_CURRENCY`
  ni el contrato HTTP real.
- **CD-8** — El warn es **value-free**: NUNCA imprime la address. Mensaje explícito "DEVNET STUB, NO
  real off-ramp" (estilo `normalizeStatus()`/`assertPayoutProviderSafe()`).
- **CD-9** *(anti-recurrente, WKH-208/WKH-196)* — el gate de cierre de cada wave es
  **`npm run typecheck` COMPLETO** (`tsc --noEmit`, incluye `*.test.ts`). NO alcanza `npm run test`.
- **CD-10** *(anti-recurrente, WKH-204)* — la validación base58 exige tests de **boundary de longitud**
  (31/45 → null; 32/44 → válido) **y de charset** (`0/O/I/l` → null). La regex DEBE estar anclada
  `^…$`. Mata mutantes que relajen `{32,44}` o el charset.
- **CD-11** *(anti-recurrente, WKH-212)* — esta HU NO cambia el schema de salida (solo el **valor** de
  2 campos ya expuestos). Si aparece un rojo de contrato (`Object.keys(...).toEqual`) → scope mal
  medido → **escalar, no editar a ciegas**. Cuidar la **indentación** exacta del `old_string` del return.

---

## Anti-Hallucination Checklist (verificado por el Architect con Read — NO reinterpretar)

- [x] `FallbackPayoutProvider.execute()` return → `payout.ts:187-195`. 7 campos:
      `payoutId`, `status:"settled"`, `deliveredLocal:null`, `txRef:null`, `failureReason:null`,
      `provenance:"local-fallback"`, `depositAddress:null`.
- [x] `FallbackPayoutProvider.status()` return → `payout.ts:198-206`. Mismos 7 campos (con `payoutId`
      recibido). **Ambos** métodos reciben el wiring (DT-5).
- [x] Los 2 campos a mutar: `provenance` (L193 / L204) y `depositAddress` (L194 / L205). Los otros 5
      **intactos**.
- [x] Exemplar helper: `resolveSourceCurrency(network)` → `payout.ts:41-45`. Normaliza con
      `network.trim().toLowerCase()`; función **module-scope exportada**. (Acá el fail es **null**, no `throw`.)
- [x] Exemplar narrowing: `readString()` → `payout.ts:68-74` (`typeof v === "string" && v.length > 0`).
- [x] Exemplar warn value-free: `normalizeStatus()` → `payout.ts:228` (`console.warn` solo con etiqueta).
- [x] `getPayoutProvider()` → `payout.ts:246-258`. Devuelve `FallbackPayoutProvider` si falta cualquiera
      de las 3 creds; con las 3 + `TRANSFI_ADAPTER_READY==="true"` → `TransFiPayoutProvider`. **NO tocar.**
- [x] `Provenance = string` → `types.ts:6`. `PayoutResult.depositAddress: string | null` → `types.ts:122`.
      **Cero cambio en `types.ts`** (el literal `"devnet-stub"` no requiere tipo nuevo).
- [x] `assertPayoutProviderSafe()` → `cashout-payout.ts:66-93`, **NO exportada** (`function …`).
      Invocada en `cashout-payout.ts:201`, ANTES de `getPayoutProvider()` (L202). En prod exige
      `PAYOUT_ALLOW_MOCK==="true"` → si no, `throw "payout_refused…"` (L80).
- [x] Patrón de test con env: `describe("getPayoutProvider factory (AC-5)")` → `payout.test.ts:259-288`,
      con `afterEach(() => vi.unstubAllEnvs())` (L260) + `vi.stubEnv(...)`.
- [x] Fixture base58 válido real (44 chars): `"7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"`
      (usado en `payout.test.ts:185/189`).
- [x] Fixture `input: PayoutInput` global → `payout.test.ts:11-20` (reutilizable).
- [x] Tabla env a extender: `project-context.md:152-166` (última fila `TRANSFI_ADAPTER_READY` en L166).
- [x] Bloque env README: `README.md:46-52` (code-fence; `TRANSFI_USDC_NETWORK` en L50).
- [x] `@solana/web3.js` **AUSENTE** de `package.json` → validación por charset/longitud (DT-4), sin dep nueva.
- [x] Baseline esperado: **151 tests / 9 files** (WKH-209). El Dev lo confirma en W-1.

---

## Waves

### W-1 — Pre-gate (obligatorio antes de editar)
```
npm run test        # verde — registrar el nº baseline (esperado 151)
npm run typecheck   # tsc --noEmit limpio
```
Sin verde/limpio previo, NO arranca ninguna wave.

---

### W0 — Helper de resolución (gate + validación base58) — AC-1/AC-4/CD-2/CD-5/CD-8/DT-4/DT-6
**Archivo único: `src/providers/payout.ts`** (aditivo — no se toca nada existente todavía).

**Ubicación**: junto a `resolveSourceCurrency` (module-scope), p.ej. tras L45.

1. Constante module-scope (regex **anclada** — CD-10):
```ts
// DT-4: base58 (alfabeto Bitcoin/Solana, sin 0 O I l) + longitud de pubkey Solana (32-44 chars).
// Anclada ^…$ (CD-10): rechaza EVM 0x…, vacíos/whitespace, chars ambiguos y sufijos basura.
// NO usa @solana/web3.js (ausente del repo; verificación de curva Ed25519 es Scope OUT).
const BASE58_ADDR_RE = /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{32,44}$/;
```

2. Helper **exportado** (fail-closed → `null`, NUNCA `throw` — DT-2):
```ts
/**
 * Escape-hatch DEVNET-ONLY (WKH-232 / HU-SOL-15). Devuelve la deposit address SOLO si el doble-gate
 * (env seteada + red solana) pasa Y el valor es base58 válido; si no, null (fail-closed → mock estándar).
 * NO mueve plata: el mock nunca desembolsa. Se exporta para testear la validación en aislamiento (CD-10).
 */
export function resolveDevnetStubAddress(): string | null {
  const raw = process.env.TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS;
  if (!raw) return null;                                     // CD-4: unset/"" → byte-idéntico
  if (process.env.TRANSFI_USDC_NETWORK !== "solana") return null; // CD-2 (b) / DT-3 guard de red
  const addr = raw.trim();
  if (!BASE58_ADDR_RE.test(addr)) {                          // CD-5 fail-closed
    console.warn(
      "[remit-payout] TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS ignorada: no es base58 válida " +
        "(DEVNET STUB, NO real off-ramp)",                   // CD-8 value-free (sin la address)
    );
    return null;
  }
  console.warn("[remit-payout] DEVNET STUB deposit address ACTIVO — devnet-only, NO real off-ramp"); // CD-8
  return addr;
}
```

**Contrato**: `resolveDevnetStubAddress(): string | null`. Sin params (lee `process.env` directo, como
`getPayoutProvider`). Doble-gate = dos `return null` independientes (CD-2, no colapsar).

**Gate W0**: `npm run typecheck` limpio (CD-9). Sin tests aún (van en W2), pero el archivo compila.

---

### W1 — Wiring en `FallbackPayoutProvider` — AC-1/AC-3/AC-6/CD-3/CD-4/DT-5
**Archivo único: `src/providers/payout.ts`**. ⚠️ Indentación del anchor: el `return` está a nivel de
método (2 niveles), NO top-level (CD-11 — lección WKH-212).

**E1 — `execute()`** (`payout.ts:186-196`). Antes del `return`, resolver el stub una vez; en el objeto
cambiar **solo** `provenance` y `depositAddress`:
```ts
  async execute(input: PayoutInput): Promise<PayoutResult> {
    const stub = resolveDevnetStubAddress(); // WKH-232: null salvo doble-gate + base58 válido
    return {
      payoutId: `fallback-${input.idempotencyKey}`,
      status: "settled",
      deliveredLocal: null,
      txRef: null,
      failureReason: null,
      provenance: stub ? "devnet-stub" : "local-fallback", // CD-3/AC-6
      depositAddress: stub,                                 // CD-4: stub===null → null (byte-idéntico)
    };
  }
```

**E2 — `status()`** (`payout.ts:197-207`). Idéntico tratamiento (DT-5):
```ts
  async status(payoutId: string): Promise<PayoutResult> {
    const stub = resolveDevnetStubAddress();
    return {
      payoutId,
      status: "settled",
      deliveredLocal: null,
      txRef: null,
      failureReason: null,
      provenance: stub ? "devnet-stub" : "local-fallback",
      depositAddress: stub,
    };
  }
```

Los otros 5 campos (`payoutId`, `status`, `deliveredLocal`, `txRef`, `failureReason`) **intactos** en
ambos métodos.

**Gate W1**: `npm run typecheck` limpio + `npm run test` verde. Los tests existentes del mock
(`payout.test.ts:44-58`) NO stubean la env → `stub===null` → salida idéntica → pasan **sin tocarse** (CD-4).

---

### W2 — Tests (≥1 por AC + mutation-kill) + docs — AC-1..6 / CD-10
**Archivos: `src/providers/payout.test.ts`, `project-context.md`, `README.md`.**

Nuevo bloque en `payout.test.ts` (agregar al final, sin tocar lo existente):
```ts
describe("FallbackPayoutProvider — escape-hatch devnet (WKH-232 / HU-SOL-15)", () => {
  afterEach(() => vi.unstubAllEnvs());
  // ... T-1..T-9 (ver tabla)
});
```
Fixture base58 válido: `"7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"` (reusar).
Para boundaries usar strings de charset base58 puro, p.ej. `"1".repeat(n)` (el char `1` es base58 válido).

#### Test Expectations (por AC)

| ID | AC / CD | Arrange | Assert |
|---|---|---|---|
| **T-1** | AC-1 (hatch activo, doble-gate) | `vi.stubEnv("TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS", "7xKXt…AsU")` + `vi.stubEnv("TRANSFI_USDC_NETWORK","solana")` | `await new FallbackPayoutProvider().execute(input)` → `depositAddress === "7xKXt…AsU"` **y** `provenance === "devnet-stub"`. (Sin `fetch` stub → prueba implícita de que NO se llama a TransFi.) |
| **T-2** | AC-6 / CD-3 (provenance distinguible) | igual a T-1 | `provenance !== "transfi"` **y** `!== "local-fallback"` **y** `=== "devnet-stub"`. |
| **T-3** | AC-2 / CD-1 (real precede) | `vi.stubEnv` las 3 creds (`TRANSFI_USERNAME/PASSWORD/MID`) + `TRANSFI_ADAPTER_READY="true"` + la env devnet + `TRANSFI_USDC_NETWORK="solana"` | `getPayoutProvider()` es `instanceof TransFiPayoutProvider` (el mock ni se instancia → stub inalcanzable). |
| **T-4** | AC-3 / CD-4 (byte-idéntico sin env) | **sin** stubear `TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS` | `execute(input)` → `depositAddress === null` **y** `provenance === "local-fallback"`. |
| **T-5** | AC-4a / CD-5 (malformado → fail-closed) | env devnet `"0xNOTbase58INVALID"` (contiene `0`) + red `solana` | `depositAddress === null` **y** `provenance === "local-fallback"`. |
| **T-6** | AC-4b / CD-2 (red≠solana → fail-closed) | env devnet base58 válido + `TRANSFI_USDC_NETWORK="base"` | `depositAddress === null` **y** `provenance === "local-fallback"`. |
| **T-7** | AC-5 / CD-6 (hereda gate prod) | `vi.stubEnv("NODE_ENV","production")`, sin creds reales, sin `PAYOUT_ALLOW_MOCK`, con env devnet + solana | el path del agente `cashout-payout` (que invoca `assertPayoutProviderSafe()` en L201) **throws** `/payout_refused/` → el stub nunca se alcanza. **Ver nota T-7.** |
| **T-8** | CD-10 (boundary longitud, mutation-kill) | llamar `resolveDevnetStubAddress()` directo con `TRANSFI_USDC_NETWORK="solana"` y la env devnet en: `"1".repeat(31)`, `"1".repeat(32)`, `"1".repeat(44)`, `"1".repeat(45)` | 31 → `null`; 32 → la address; 44 → la address; 45 → `null`. |
| **T-9** | CD-10 (charset, mutation-kill) | red `solana`, env devnet = strings de 43 chars que contengan `0`, `O`, `I`, `l` (uno por caso) | cada uno → `null`. |

**Nota T-7**: `assertPayoutProviderSafe()` NO está exportada (`cashout-payout.ts:66`). Dos opciones
válidas (decide el Dev):
- **(a) preferida** — test de integración por el handler del agente que ya la invoca (`runCashoutPayout`
  / el export de `cashout-payout.ts`), verificando que throws `payout_refused` con `NODE_ENV=production`
  y sin `PAYOUT_ALLOW_MOCK`.
- **(b) aceptable** — exportar `assertPayoutProviderSafe` (cambio aditivo, no cambia comportamiento) y
  testearla directa.
- Si ninguna es aislable limpiamente → **escalar, no forzar** (no ampliar superficie sin necesidad).

#### Docs
1. **`project-context.md`** — nueva fila en la tabla "Env vars TransFi" (tras L166):
   ```
   | `TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS` | ATA USDC **devnet** del equipo. Escape-hatch **devnet-only, opt-in** (WKH-232): con esta env seteada **Y** `TRANSFI_USDC_NETWORK=solana` **Y** el provider real inactivo, el mock devuelve esta address con `provenance:devnet-stub`. Fail-closed si no es base58 o red≠solana. **NUNCA en prod real** (hereda el gate `PAYOUT_ALLOW_MOCK`). Enabler del smoke M5, no mueve plata. |
   ```
2. **`README.md`** — agregar en el bloque env (L46-52), junto a `TRANSFI_USDC_NETWORK`:
   ```
   TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS=  # ⚠️ devnet-only — NUNCA setear en un deploy de producción (escape-hatch smoke M5, provenance:devnet-stub, no mueve plata)
   ```

**Gate W2**: `npm run test` verde (esperado **151 + 9 = 160**, los 151 previos byte-idénticos) **y**
`npm run typecheck` limpio (CD-9). Correr también un `grep` por `Object.keys(...).toEqual`/snapshots en
`src/**/*.test.ts` — no debe romperse ninguno (CD-11); si rompe, escalar.

---

## Patrones a seguir (exemplars verificados)

- Helper module-scope exportado + `.trim()`: `resolveSourceCurrency` (`payout.ts:41-45`).
- Narrowing por tipo, nunca coerción: `readString` (`payout.ts:68-74`).
- Warn value-free: `normalizeStatus` (`payout.ts:228`).
- Test con `vi.stubEnv` + `afterEach(vi.unstubAllEnvs)`: factory describe (`payout.test.ts:259-288`).

---

## Done Definition

- [ ] W-1 baseline registrado (test verde + typecheck limpio).
- [ ] W0: `resolveDevnetStubAddress()` exportada + `BASE58_ADDR_RE` anclada; typecheck limpio.
- [ ] W1: `execute()` y `status()` mutan **solo** `provenance` + `depositAddress`; los otros 5 intactos;
      tests existentes del mock pasan sin modificarse (CD-4).
- [ ] W2: T-1..T-9 implementados (≥1 por AC + boundary/charset); docs actualizadas.
- [ ] `npm run test` verde (160 esperado) **y** `npm run typecheck` limpio (CD-9).
- [ ] Sin cambios fuera del Scope IN; `cashout-payout.ts`/`TransFiPayoutProvider`/`getPayoutProvider`
      intactos (salvo export opcional de T-7 opción b).
- [ ] Provenance `"devnet-stub"` nunca es `"transfi"` (CD-3); warns nunca imprimen la address (CD-8).

> **Fuera de F3** (no bloquea el código): valor real de la ATA devnet (founder-only) y renombre del
> folder/ID `WKH-213 → WKH-232 / HU-SOL-15` (cierre F4/DONE).
