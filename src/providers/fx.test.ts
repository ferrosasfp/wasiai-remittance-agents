import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  FallbackFxProvider,
  TransFiFxProvider,
  assertValidQuote,
  getFxQuoteProvider,
} from "./fx";
import type { FxQuote } from "./types";

const goodQuote: FxQuote = {
  rate: 3.7,
  feeUsd: 0.5,
  netDeliveredLocal: 368,
  localCurrency: "PEN",
  etaMinutes: 30,
  quoteId: "q1",
  expiresAt: new Date().toISOString(),
  provenance: "transfi",
};

describe("assertValidQuote (BLQ-MED-2: no NaN en montos)", () => {
  it("pasa un quote válido", () => {
    expect(assertValidQuote(goodQuote)).toBe(goodQuote);
  });
  it("lanza si rate = NaN", () => {
    expect(() => assertValidQuote({ ...goodQuote, rate: NaN })).toThrow(/invalid_quote_rate/);
  });
  it("lanza si netDeliveredLocal = NaN", () => {
    expect(() => assertValidQuote({ ...goodQuote, netDeliveredLocal: NaN })).toThrow(
      /invalid_quote_net/,
    );
  });
  it("lanza si quoteId vacío", () => {
    expect(() => assertValidQuote({ ...goodQuote, quoteId: "" })).toThrow(/invalid_quote_id/);
  });
});

describe("FallbackFxProvider (FX mid real + spread en contra del cliente)", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ rates: { PEN: 3.8 } }) })),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("aplica spread en contra del cliente + devuelve quote válido", async () => {
    const q = await new FallbackFxProvider().quote({
      amountUsd: 100,
      sourceAsset: "USDC",
      destCurrency: "PEN",
      destCountry: "PE",
      payoutMethod: "yape",
    });
    expect(q.provenance).toBe("local-fallback");
    expect(q.rate).toBeGreaterThan(3.6);
    expect(q.rate).toBeLessThan(3.8); // spread reduce lo que recibe el cliente
    expect(Number.isFinite(q.netDeliveredLocal)).toBe(true);
    expect(q.netDeliveredLocal).toBeGreaterThan(0);
  });
});

describe("getFxQuoteProvider factory (MNR-2: readiness fail-loud)", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("sin key → fallback", () => {
    vi.stubEnv("TRANSFI_API_KEY", "");
    expect(getFxQuoteProvider()).toBeInstanceOf(FallbackFxProvider);
  });
  it("key SIN readiness → throws", () => {
    vi.stubEnv("TRANSFI_API_KEY", "k");
    vi.stubEnv("TRANSFI_ADAPTER_READY", "");
    expect(() => getFxQuoteProvider()).toThrow(/transfi_adapter_not_ready/);
  });
  it("key + readiness → adapter TransFi", () => {
    vi.stubEnv("TRANSFI_API_KEY", "k");
    vi.stubEnv("TRANSFI_ADAPTER_READY", "true");
    expect(getFxQuoteProvider()).toBeInstanceOf(TransFiFxProvider);
  });
});
