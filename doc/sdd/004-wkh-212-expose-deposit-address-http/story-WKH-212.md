# Story File — [WKH-212] Exponer `depositAddress` en la salida HTTP de remit-cashout-payout

> Contrato autocontenido para el Dev. Si algo no está acá, no se hace. SDD_MODE: **mini**.
> Cambio 100% ADITIVO. NO tocar lógica de payout, adapter TransFi ni `route.ts`.

## Contexto compacto

`PayoutResult` ya tiene `depositAddress: string | null` (WKH-208) pero se pierde en el mapeo del
agente: `CashoutPayoutOutput` (el contrato HTTP que consume chaski-v2) no lo declara ni lo propaga.
Esta HU lo propaga de forma aditiva en las 3 ramas de retorno de `runCashoutPayout()`. El campo viaja
solo por el wire (`route.ts` serializa `{ result }` verbatim). El mock devuelve `null` → no rompe.

## Scope IN (archivos a tocar)

- `src/agents/cashout-payout.ts` — 4 edits (E1..E4).
- `src/agents/cashout-payout.test.ts` — 3 tests nuevos (T1..T3).

**NO tocar** (solo son contexto, ya verificados): `src/providers/payout.ts`, `src/providers/types.ts`,
`src/app/api/agents/remit-cashout-payout/invoke/route.ts`.

## Anti-Hallucination Checklist (verificado por el Architect con Read)

- [x] `CashoutPayoutOutput` está en `cashout-payout.ts:50-59`, 8 campos, último es `provenance: string;`.
- [x] Rama `kyc_identity_claim_missing` → `return {` en `208-217`, `reason:"kyc_identity_claim_missing"`.
- [x] Rama `kyc_gate_not_passed` → `return {` en `225-234`, `reason:"kyc_gate_not_passed"`.
- [x] Rama `executed` → `return {` en `248-257`, mapea `result.*`.
- [x] `PayoutResult.depositAddress: string | null` existe (`types.ts:122`) — NO inventar el tipo.
- [x] `FallbackPayoutProvider.execute()` devuelve `depositAddress:null` (`payout.ts:194`).
- [x] `route.ts:22` → `NextResponse.json({ result })` — NO editar.
- [x] Baseline: 145 tests passing.

## Waves

### W0 — no aplica (sin contratos/tipos nuevos separados; E1 es el único cambio de tipo y va inline)

### W1 — Edits de propagación (serial, 1 archivo)

**E1** — `cashout-payout.ts`, tipo `CashoutPayoutOutput` (línea ~58, tras `provenance: string;`):
```ts
  provenance: string;
  depositAddress: string | null; // WKH-212: address dedicada del create-order (null en mock/blocked)
}
```

**E2** — rama `kyc_identity_claim_missing` (return de líneas 208-217), agregar la key:
```ts
      reason: "kyc_identity_claim_missing",
      provenance: "n/a",
      depositAddress: null, // WKH-212: no hubo payout, no hay address
    };
```

**E3** — rama `kyc_gate_not_passed` (return de líneas 225-234), agregar la key:
```ts
      reason: "kyc_gate_not_passed",
      provenance: "n/a",
      depositAddress: null, // WKH-212: no hubo payout, no hay address
    };
```

**E4** — rama `executed` (return de líneas 248-257), agregar la key mapeando el `result`:
```ts
      reason: result.failureReason,
      provenance: result.provenance,
      depositAddress: result.depositAddress, // WKH-212: propaga la address del provider (real o null)
    };
```

> CD-4: las 3 ramas DEBEN tener `depositAddress` explícito. Si olvidás una, `tsc` va a fallar
> (el tipo E1 lo exige no-opcional). Ese rojo es la red de seguridad — resolvelo agregando la key,
> nunca haciendo el campo opcional.

### W2 — Tests (mismo archivo `cashout-payout.test.ts`)

Agregá un `describe("runCashoutPayout — depositAddress (WKH-212)", ...)` con `beforeEach`/`afterEach`
que espeje el patrón existente (spy sobre `FallbackPayoutProvider.prototype.execute`, y
`vi.restoreAllMocks()` + `vi.unstubAllEnvs()` + `vi.unstubAllGlobals()` en `afterEach` — copiá el
teardown de los describes existentes, ej. líneas 38-42 / 146-150).

Reusá helpers ya presentes: `validInput` (fixture), `stubDevPayoutAndDidit()` (arrange dev-payout +
Didit ready), `stubDiditDecision(body)`.

**T1 (AC-1)** — executed real, `depositAddress` no-null propagado:
```ts
it("AC-1: executed real → depositAddress del provider llega al output", async () => {
  stubDevPayoutAndDidit();
  stubDiditDecision({ status: "Approved", session_id: "v1", vendor_data: "12345678" });
  vi.spyOn(FallbackPayoutProvider.prototype, "execute").mockResolvedValue({
    payoutId: "p1", status: "submitted", deliveredLocal: null, txRef: null,
    failureReason: null, provenance: "transfi", depositAddress: "0xDEPOSIT",
  });
  const out = await runCashoutPayout(validInput);
  expect(out.executed).toBe(true);
  expect(out.depositAddress).toBe("0xDEPOSIT");
});
```

**T2 (AC-3)** — las 2 ramas blocked → `null`:
```ts
it("AC-3: blocked kyc_identity_claim_missing → depositAddress null", async () => {
  stubDevPayoutAndDidit();
  const { senderIdentity: _omit, ...noClaim } = validInput;
  const out = await runCashoutPayout(noClaim);
  expect(out.reason).toBe("kyc_identity_claim_missing");
  expect(out.depositAddress).toBeNull();
});

it("AC-3: blocked kyc_gate_not_passed → depositAddress null", async () => {
  stubDevPayoutAndDidit();
  stubDiditDecision({ status: "Declined", session_id: "v1" });
  const out = await runCashoutPayout(validInput);
  expect(out.reason).toBe("kyc_gate_not_passed");
  expect(out.depositAddress).toBeNull();
});
```

**T3 (AC-2 mock / byte-idéntico)** — el mock por default refleja `null` sin alterar otros campos:
```ts
it("AC-2: mock (FallbackPayoutProvider) → depositAddress null, resto de campos intacto", async () => {
  stubDevPayoutAndDidit();
  stubDiditDecision({ status: "Approved", session_id: "v1", vendor_data: "12345678" });
  const out = await runCashoutPayout(validInput); // sin stubear execute → mock real
  expect(out.executed).toBe(true);
  expect(out.provenance).toBe("local-fallback");
  expect(out.depositAddress).toBeNull();
  expect(out.deliveredLocal).toBeNull(); // campos existentes sin cambio (CD-1)
  expect(out.txRef).toBeNull();
});
```

> Nota: los valores exactos de `vendor_data`/`senderIdentity` (`"12345678"`) deben matchear el fixture
> `validInput` (senderIdentity `"12345678"`), si no C11 bloquea el path executed. Ver tests existentes.

## Patrones a seguir (exemplars verificados)

- Mapeo del `result` en la rama executed: `cashout-payout.ts:248-257` (mismo estilo `result.<campo>`).
- Ramas blocked con literales: `cashout-payout.ts:208-217` / `225-234`.
- `vi.spyOn(FallbackPayoutProvider.prototype, "execute")`: ya usado (test 36); `spyOn(...).mockResolvedValue`: tests 265/285.
- Teardown correcto: `cashout-payout.test.ts:38-42`.

## Tests requeridos

- [ ] T1 executed real → `depositAddress` no-null propagado (AC-1).
- [ ] T2 blocked `kyc_identity_claim_missing` → `null` (AC-3).
- [ ] T2 blocked `kyc_gate_not_passed` → `null` (AC-3).
- [ ] T3 mock default → `null` + campos existentes intactos (AC-2 / CD-1).

## Gate / Done Definition

- [ ] E1..E4 aplicados; `depositAddress` presente en las 3 ramas de retorno (CD-4).
- [ ] `route.ts` y `payout.ts` **sin cambios** (verificar con `git diff --name-only`).
- [ ] `npm run typecheck` en verde (`tsc --noEmit` COMPLETO, incluye `*.test.ts` — NO basta `npm run build`).
- [ ] `npx vitest run` en verde. Baseline 145 → esperado **148** (145 + 3 nuevos; +4 si separás T2 en 2).
- [ ] Ningún campo existente de `CashoutPayoutOutput` renombrado/removido/retipado (CD-1).
- [ ] NO tocaste flags de prod (`PAYOUT_ALLOW_MOCK`/`TRANSFI_ADAPTER_READY`/`ALLOW_FALLBACK_PAYOUT`) — CD-6.
- [ ] `depositAddress` no se loguea de más (CD-5); NO es PII pero mantené el response bajo CD-6 de route.ts.

> NO existe `npm run qa` en este repo. El gate es exactamente `npm run typecheck` + `npx vitest run`.
