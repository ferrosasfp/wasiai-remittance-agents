import { describe, it, expect, afterEach, vi } from "vitest";
import {
  FallbackPayoutProvider,
  TransFiPayoutProvider,
  assertValidPayout,
  getPayoutProvider,
} from "./payout";
import type { PayoutInput, PayoutResult } from "./types";

const input: PayoutInput = {
  quoteId: "q1",
  amountUsd: 100,
  beneficiary: { name: "Bob", country: "PE", method: "yape", destination: "999999999" },
  travelRuleData: {
    originator: { name: "Alice", country: "US", legalId: "ref:v1" },
    beneficiary: { name: "Bob", country: "PE" },
  },
  idempotencyKey: "idem-1",
};

describe("FallbackPayoutProvider (mock — NO mueve plata)", () => {
  it("no entrega real: deliveredLocal null + provenance local-fallback", async () => {
    const r = await new FallbackPayoutProvider().execute(input);
    expect(r.provenance).toBe("local-fallback");
    expect(r.deliveredLocal).toBeNull();
    expect(r.txRef).toBeNull();
    expect(r.payoutId).toContain("fallback-");
  });
});

describe("assertValidPayout", () => {
  const ok: PayoutResult = {
    payoutId: "p1",
    status: "settled",
    deliveredLocal: 368,
    txRef: "0xabc",
    failureReason: null,
    provenance: "transfi",
  };
  it("pasa uno válido", () => expect(assertValidPayout(ok)).toBe(ok));
  it("lanza si payoutId vacío", () =>
    expect(() => assertValidPayout({ ...ok, payoutId: "" })).toThrow(/invalid_payout_id/));
  it("lanza si deliveredLocal NaN", () =>
    expect(() => assertValidPayout({ ...ok, deliveredLocal: NaN })).toThrow(
      /invalid_payout_delivered/,
    ));
});

describe("getPayoutProvider factory", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("sin key → fallback", () => {
    vi.stubEnv("TRANSFI_API_KEY", "");
    expect(getPayoutProvider()).toBeInstanceOf(FallbackPayoutProvider);
  });
  it("key sin readiness → throws", () => {
    vi.stubEnv("TRANSFI_API_KEY", "k");
    vi.stubEnv("TRANSFI_ADAPTER_READY", "");
    expect(() => getPayoutProvider()).toThrow(/transfi_adapter_not_ready/);
  });
  it("key + readiness → adapter TransFi", () => {
    vi.stubEnv("TRANSFI_API_KEY", "k");
    vi.stubEnv("TRANSFI_ADAPTER_READY", "true");
    expect(getPayoutProvider()).toBeInstanceOf(TransFiPayoutProvider);
  });
});
