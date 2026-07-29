// CONTRACT TEST — ORIGEN (provider). WKH-227 / HU-SOL-24 (AC-1).
// Ancla la fuente de verdad de los contratos de los 3 agentes A2A de este repo:
//  · Bloque A: los INPUT canónicos pasan su schema Zod real (`*InputSchema.parse()`).
//  · Bloque B: el OUTPUT fixture shape-matchea lo que `run*()` devuelve HOY (DT-7: keys + typeof,
//    NO `schema.parse()` — los OUTPUT son interfaces TS sin Zod). Si un agente renombra/añade/quita
//    un campo, el set de keys diverge → ROJO, y el fixture debe re-sincronizarse antes de que el
//    consumer (chaski-v3, W3) lo vendoree.
// CERO cambio de comportamiento runtime (CD-1): solo lee outputs, no toca código de producción.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { runCorridorFx, CorridorFxInputSchema } from "../agents/corridor-fx";
import { runKycValidator, KycInputSchema } from "../agents/kyc-validator";
import { runCashoutPayout, CashoutPayoutInputSchema } from "../agents/cashout-payout";

import { corridorFxInput, kycInput, cashoutPayoutInput } from "./inputs.fixture";
import { corridorFxOutputFixture } from "./corridor-fx.output.fixture";
import { kycValidatorOutputFixture } from "./kyc-validator.output.fixture";
import { cashoutPayoutOutputFixture } from "./cashout-payout.output.fixture";

/** Ancla de la verdad (DT-7): mismo set de keys + mismo typeof por campo entre `out` y el fixture. */
function assertSameShape(out: Record<string, unknown>, fixture: Record<string, unknown>): void {
  expect(Object.keys(out).sort()).toEqual(Object.keys(fixture).sort());
  for (const k of Object.keys(fixture)) {
    expect(typeof out[k]).toBe(typeof fixture[k]);
  }
}

// ── Bloque A — los INPUT canónicos pasan su schema Zod real (AC-1) ──────────────
describe("contract INPUTs — parse() contra el schema real", () => {
  it("corridorFxInput pasa CorridorFxInputSchema.parse (no throw)", () => {
    expect(() => CorridorFxInputSchema.parse(corridorFxInput)).not.toThrow();
  });
  it("kycInput pasa KycInputSchema.parse (no throw)", () => {
    expect(() => KycInputSchema.parse(kycInput)).not.toThrow();
  });
  it("cashoutPayoutInput pasa CashoutPayoutInputSchema.parse (no throw)", () => {
    expect(() => CashoutPayoutInputSchema.parse(cashoutPayoutInput)).not.toThrow();
  });
});

// ── Bloque B — cada OUTPUT fixture shape-matchea lo que run*() devuelve HOY ──────

describe("contract OUTPUT — remit-corridor-fx (runCorridorFx)", () => {
  beforeEach(() => {
    vi.stubEnv("TRANSFI_API_KEY", ""); // mid real (mockeado)
    // La caché del mid es estado de módulo: TTL 0 mantiene cada caso independiente.
    vi.stubEnv("FX_RATE_CACHE_TTL_MS", "0");
    vi.stubGlobal(
      "fetch",
      // El feed DEBE declarar la fecha de su dato: sin ella la fuente se descarta (shape inválido).
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          rates: { PEN: 3.8 },
          time_last_update_unix: Math.floor(Date.now() / 1000),
        }),
      })),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("el fixture ancla el shape real (keys + typeof)", async () => {
    const out = await runCorridorFx(corridorFxInput);
    assertSameShape(
      out as unknown as Record<string, unknown>,
      corridorFxOutputFixture as unknown as Record<string, unknown>,
    );
    // AC-5: FIAT queda `number` (no string/bigint). Los campos estables matchean la salida real;
    // quoteId/expiresAt son runtime-generados (Date.now()) → se anclan solo por typeof (arriba).
    expect(out).toMatchObject({
      slug: corridorFxOutputFixture.slug,
      rate: corridorFxOutputFixture.rate,
      feeUsd: corridorFxOutputFixture.feeUsd,
      netDeliveredLocal: corridorFxOutputFixture.netDeliveredLocal,
      localCurrency: corridorFxOutputFixture.localCurrency,
      etaMinutes: corridorFxOutputFixture.etaMinutes,
      provenance: corridorFxOutputFixture.provenance,
    });
  });
});

describe("contract OUTPUT — remit-kyc-validator (runKycValidator)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("el fixture ancla el shape real (keys + typeof) y NO filtra PII (CD-7)", async () => {
    vi.stubEnv("DIDIT_API_KEY", ""); // fallback KYC
    vi.stubEnv("NODE_ENV", "");
    vi.stubEnv("ALLOW_FALLBACK_KYC", ""); // gate FAIL-SAFE: payoutAllowed=false
    const out = await runKycValidator(kycInput);
    assertSameShape(
      out as unknown as Record<string, unknown>,
      kycValidatorOutputFixture as unknown as Record<string, unknown>,
    );
    expect(out).toEqual(kycValidatorOutputFixture);
    // CD-7: el DNI no viaja en el output ni en el fixture; tampoco `travelRuleData`.
    expect(JSON.stringify(out)).not.toContain("12345678");
    expect(JSON.stringify(out)).not.toContain("travelRuleData");
    expect(JSON.stringify(kycValidatorOutputFixture)).not.toContain("12345678");
    expect(JSON.stringify(kycValidatorOutputFixture)).not.toContain("travelRuleData");
  });
});

describe("contract OUTPUT — remit-cashout-payout (runCashoutPayout)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("el fixture ancla el shape real (keys + typeof) en la rama determinística blocked", async () => {
    vi.stubEnv("TRANSFI_API_KEY", "");
    vi.stubEnv("ALLOW_FALLBACK_PAYOUT", "true"); // pasa el fail-safe de payout (rama dev/mock)
    vi.stubEnv("DIDIT_API_KEY", ""); // KYC fallback
    vi.stubEnv("ALLOW_FALLBACK_KYC", ""); // gate NO abre → blocked
    const out = await runCashoutPayout(cashoutPayoutInput);
    assertSameShape(
      out as unknown as Record<string, unknown>,
      cashoutPayoutOutputFixture as unknown as Record<string, unknown>,
    );
    // WKH-212: depositAddress presente SIEMPRE, null en blocked.
    expect(out).toEqual(cashoutPayoutOutputFixture);
  });
});
