# SDD (mini) — [WKH-212] Exponer `depositAddress` en la salida HTTP de remit-cashout-payout

> SDD_MODE: **mini** — cambio 100% aditivo, mecánico, 1 archivo de lógica + 1 de tests. Sin lógica
> nueva ni decisiones de negocio. Rigor money-path-adjacente por convención del repo (DT-2 del
> work-item). Verificado contra código real (todas las refs de línea confirmadas con Read).

## 1. Contexto

WKH-208 (DONE, código) agregó `depositAddress: string | null` a `PayoutResult` (el contrato interno
que devuelven los providers de payout) para el modelo create-order ASYNC de TransFi: el sender manda
el USDC on-chain a una address dedicada por orden. Hoy ese campo **se pierde** en el mapeo del agente:
`CashoutPayoutOutput` (el contrato HTTP que consume chaski-v2 / WKH-211) no lo declara ni lo propaga.
Esta HU lo propaga de forma aditiva desde `PayoutResult.depositAddress` hasta `CashoutPayoutOutput`,
en las 3 ramas de retorno de `runCashoutPayout()`, sin tocar la lógica de payout ni el adapter TransFi
ni `route.ts`.

## 2. Context Map (archivos leídos)

| Archivo | Por qué | Qué se extrajo (verificado) |
|---------|---------|------------------------------|
| `src/agents/cashout-payout.ts` | archivo único de edición | `CashoutPayoutOutput` en **50-59** (8 campos, ninguno opcional); 3 ramas de retorno: `kyc_identity_claim_missing` **208-217**, `kyc_gate_not_passed` **225-234**, `executed` real **248-257** |
| `src/providers/types.ts` | fuente del campo | `PayoutResult.depositAddress: string | null` en **122** (WKH-208). Tipo exacto a propagar |
| `src/providers/payout.ts` | confirmar poblado | `TransFiPayoutProvider.execute()` setea `depositAddress` real (**149**); `status()` → `null` (**175**); `FallbackPayoutProvider.execute()` → `null` (**194**), `status()` → `null` (**205**) |
| `src/app/api/agents/remit-cashout-payout/invoke/route.ts` | confirmar NO-tocar | **21-22**: `const result = await runCashoutPayout(...)` → `NextResponse.json({ result })`. Serializa el objeto verbatim: el campo nuevo viaja solo, sin cambio de código |
| `src/agents/cashout-payout.test.ts` | plan de tests | 50 tests. Fixture `validInput` (8-18); helper `stubDiditDecision` (21-26); patrón dev-payout+Didit `stubDevPayoutAndDidit` (152-158); rama executed real usa `FallbackPayoutProvider` (mock → `depositAddress:null`) |

## 3. Decisiones técnicas

- **DT-1**: `depositAddress` se declara **siempre presente** (`string | null`, no `?: string`
  opcional-ausente). Consumidor legado que no lo lea sigue igual (ignora la key); chaski-v2 distingue
  `null` (mock/blocked) de string real, sin ambigüedad "campo viejo" vs "no aplica". (= DT-1 work-item)
- **DT-2**: se propaga `result.depositAddress` **verbatim** (mismo tipo del source). No se transforma,
  valida ni default-ea: `PayoutResult.depositAddress` ya es la fuente de verdad (WKH-208).
- **DT-3**: en las 2 ramas `blocked` (pre-payout) el valor es literal `null`: no hubo llamada al
  provider, no existe address que propagar. Consistente con `payoutId/deliveredLocal/txRef = null`
  en esas mismas ramas.

## 4. Constraint Directives

- **CD-1** (aditivo / no-rompe): `CashoutPayoutOutput` NO puede perder, renombrar ni cambiar el tipo
  de ningún campo existente (`slug`, `executed`, `status`, `payoutId`, `deliveredLocal`, `txRef`,
  `reason`, `provenance`). El resto de las keys debe quedar **byte-idéntico** para cualquier consumidor
  que ignore `depositAddress`. (= CD-1 work-item)
- **CD-2**: PROHIBIDO tocar `src/providers/payout.ts` (adapter TransFi / mock) — lógica de WKH-208.
- **CD-3**: PROHIBIDO tocar `route.ts` — el campo viaja dentro de `{ result }` sin cambio de código.
- **CD-4** (shape consistente entre ramas): las **3** ramas de `runCashoutPayout()` deben incluir
  `depositAddress` explícito (executed → `result.depositAddress`; ambas blocked → `null`). Nunca
  omitirlo en una rama: TS infiere shape inconsistente y el contrato se rompe. (= CD-4 work-item)
- **CD-5** (no-PII): `depositAddress` es una address on-chain, NO PII. NO se loguea de más; el
  response sigue bajo CD-6 de `route.ts` (nunca `beneficiary.name/destination` ni `travelRuleData`).
- **CD-6** (no flags): PROHIBIDO tocar `PAYOUT_ALLOW_MOCK` / `TRANSFI_ADAPTER_READY` /
  `ALLOW_FALLBACK_PAYOUT`. El mock sigue siendo el default en dev/CI y devuelve `null`.
- **CD-7** (gate real — heredado de auto-blindaje WKH-196/WKH-208): el gate es
  `npm run typecheck` (`tsc --noEmit` COMPLETO, incluye `*.test.ts`) **+** `npx vitest run`. NO basta
  `npm run build` (excluye tests). Cuidado con `noUncheckedIndexedAccess` en asserts nuevos.

## 5. El cambio exacto — 4 puntos de retorno

Todos en `src/agents/cashout-payout.ts`:

| # | Punto | Línea (verificada) | Edit |
|---|-------|--------------------|------|
| E1 | tipo `CashoutPayoutOutput` | tras `provenance: string;` (**58**), antes del `}` (**59**) | agregar `depositAddress: string | null;` |
| E2 | rama `kyc_identity_claim_missing` | dentro del `return {` **208-217** | agregar `depositAddress: null,` |
| E3 | rama `kyc_gate_not_passed` | dentro del `return {` **225-234** | agregar `depositAddress: null,` |
| E4 | rama `executed` (mapeo real) | dentro del `return {` **248-257** | agregar `depositAddress: result.depositAddress,` |

`route.ts` y `payout.ts`: **sin edición** (verificación únicamente).

## 6. Plan de tests (`src/agents/cashout-payout.test.ts`)

Baseline actual: **145 tests** (9 files) en verde. Se agregan **3** tests (mínimo 1 por AC-1/2/3);
opcionalmente el AC-1 (byte-idéntico) se puede fusionar en un test existente pero se pide test dedicado.

- **T1 (AC-1)** — executed real, campo presente con valor: en la rama `executed` el mock
  (`FallbackPayoutProvider`) devuelve `depositAddress:null`, así que para probar un **valor no-null**
  se stubea `execute()` con `vi.spyOn(FallbackPayoutProvider.prototype, "execute").mockResolvedValue({..., depositAddress: "0xDEPOSIT"})`
  (patrón de spyOn ya usado en el archivo, líneas 265/285). Arrange dev-payout+Didit aprobado
  (`stubDevPayoutAndDidit` + `stubDiditDecision({status:"Approved", vendor_data:"12345678"})`).
  Assert: `out.executed === true` y `out.depositAddress === "0xDEPOSIT"`.
- **T2 (AC-2/AC-3)** — 2 ramas blocked → `null`:
  - blocked `kyc_identity_claim_missing`: input sin `senderIdentity`/`address` → `out.depositAddress` es `null` (`toBeNull()`), junto a `reason:"kyc_identity_claim_missing"`.
  - blocked `kyc_gate_not_passed`: Didit Declined / claim ajeno → `out.depositAddress` es `null`, junto a `reason:"kyc_gate_not_passed"`.
  (pueden ser 1 test con 2 asserts o 2 tests; cuenta como cobertura de AC-3 shape-consistente.)
- **T3 (AC-2 mock / byte-idéntico)** — path mock por default: dev + `ALLOW_FALLBACK_PAYOUT` +
  Didit aprobado, sin stubear `execute` → `out.executed === true`, `out.provenance === "local-fallback"`,
  `out.depositAddress` es `null`, y **los campos existentes no cambian** (`deliveredLocal`/`txRef` null
  como los tests actuales 507-508). Prueba que el mock refleja `null` sin romper nada (CD-1).

Convención de higiene (auto-blindaje WKH-203): si un test nuevo usa `vi.stubGlobal`/`vi.spyOn`, el
`afterEach` del `describe` ya hace `vi.restoreAllMocks()` + `unstubAllGlobals()` — reusar un `describe`
existente o replicar ese teardown.

## 7. Readiness Check

- [x] Shape de `CashoutPayoutOutput` verificado (50-59, 8 campos, ninguno opcional).
- [x] Las 3 ramas de retorno verificadas con Read (208-217 / 225-234 / 248-257) — coinciden con el work-item.
- [x] `PayoutResult.depositAddress: string | null` confirmado (types.ts:122).
- [x] `route.ts` serializa `{ result }` verbatim — sin edición (21-22).
- [x] Mock (`FallbackPayoutProvider`) devuelve `depositAddress:null` — el output refleja null sin romper.
- [x] Baseline de tests medido: 145 passing (comando `npx vitest run`).
- [x] Gate definido: `npm run typecheck` + `npx vitest run` (NO existe `npm run qa` en este repo).
- [x] Sin `[NEEDS CLARIFICATION]`. Sin Missing Inputs.

**Readiness: VERDE.** Listo para SPEC_APPROVED → Story File.
