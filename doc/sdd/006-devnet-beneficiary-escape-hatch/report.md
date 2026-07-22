# Report — WKH-232 / HU-SOL-15: Escape-hatch devnet-only para `depositAddress` Solana

**Status**: DONE
**Fecha**: 2026-07-22
**Branch**: `feat/wkh-232-devnet-beneficiary-escape-hatch` @ `b22a2cf`

## Resumen ejecutivo

Escape-hatch **devnet-only, opt-in, fail-safe** dentro de `FallbackPayoutProvider` que habilita el smoke on-chain de M5 (deposit→escrow→release en Solana Explorer) **sin credenciales sandbox de TransFi**. El helper `resolveDevnetStubAddress()` devuelve un `depositAddress` devnet cuando el doble-gate (`TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS` presente + `TRANSFI_USDC_NETWORK==="solana"`) + validación base58 pasan, con `provenance: "devnet-stub"` (nunca `"transfi"`), sin llamar a TransFi. **Devnet, cero plata real.**

## Seguridad — triple gate fail-closed (verificado por AR, 0 findings)
1. **Precedencia estructural** (`getPayoutProvider()`): con TransFi real (3 creds + `TRANSFI_ADAPTER_READY=true`), el `FallbackPayoutProvider` **ni se instancia** → el stub nunca corre cuando el real está activo.
2. **Gate de prod heredado** (`assertPayoutProviderSafe()` / `PAYOUT_ALLOW_MOCK`, sin diff en esta HU): exige `PAYOUT_ALLOW_MOCK=true` explícito para permitir un provider no-real en prod → el stub hereda el gate → **NUNCA dispara en prod**.
3. **Doble-gate + base58** del propio hatch, fail-closed a `null` (nunca throw).

El AR confirmó además que `depositAddress` es un **campo de retorno opaco** — nada en el repo lo usa para mover USDC (el transfer real es Scope OUT/gated). Por eso no hay camino a un desembolso desviado.

## Cadena de gates
- F3: 160 tests (151 base + 9 nuevos), tsc 0.
- AR: APROBADO — 0 findings.
- CR: APROBADO — 0 BLQ, 1 MENOR (MNR-1: test de `status()` con env, **diferido a backlog** — path secundario, no del smoke, no mueve dinero).
- F4 QA: APROBADO PARA DONE — 6/6 ACs PASS, drift NONE.

## Acceptance Criteria (6/6 PASS)
| AC | Evidencia |
|----|-----------|
| AC-1 doble-gate activo sin fetch TransFi | `payout.ts:57-72` + test T-1 |
| AC-2 real siempre precede | `payout.ts:275-286` (`getPayoutProvider`) + T-3 |
| AC-3 byte-idéntico sin la env | `payout.ts:58-59` + T-4 (los 151 base sin cambio) |
| AC-4 malformado / red≠solana → fail-closed | regex `payout.ts:50` + T-5/T-6/T-8/T-9 |
| AC-5 nunca en prod salvo `PAYOUT_ALLOW_MOCK` heredado | `cashout-payout.ts:66-93` (sin diff) + T-7 (`payout_refused`) |
| AC-6 provenance honesto `devnet-stub` | `payout.ts:221,233` + T-2 |

## Diseño clave
- `BASE58_ADDR_RE` regex anclada `^[1-9A-HJ-NP-Za-km-z]{32,44}$` (charset+longitud, sin `@solana/web3.js` — no es dep). Rechaza `0x…` EVM, boundaries 31/45, chars ambiguos `0/O/I/l` (mutation-kill).
- Wiring aditivo: solo 2 campos mutan (`provenance`/`depositAddress`) en `execute()` y `status()`; los otros 5 intactos.
- Path real (`cashout-payout.ts`, `TransFiPayoutProvider`, `getPayoutProvider`, `assertPayoutProviderSafe`) **sin tocar**.

## Follow-ups
1. **MNR-1 (backlog)**: test de `status()` con env activa (path secundario, no del smoke).
2. **Founder-only**: el valor real de la ATA USDC devnet (`TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS`) para correr el smoke M5.
