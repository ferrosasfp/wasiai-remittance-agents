import { describe, it, expect, afterEach, vi } from "vitest";
import { FallbackKycProvider, DiditKycProvider, getKycProvider } from "./kyc";
import type { KycInput } from "./types";

const base: KycInput = {
  senderName: "Alice",
  senderCountry: "US",
  legalId: "12345678",
  amountUsd: 100,
  receiverName: "Bob",
  receiverCountry: "PE",
  purpose: "family support",
};

describe("FallbackKycProvider", () => {
  it("aprueba con legalId válido, tagea local-fallback, reason 'no real'", async () => {
    const r = await new FallbackKycProvider().verify(base);
    expect(r.approved).toBe(true);
    expect(r.provenance).toBe("local-fallback");
    expect(r.reasons).toContain("fallback_no_real_verification");
    expect(r.verificationId).toMatch(/^fallback-/);
  });

  it("rechaza legalId corto (high risk)", async () => {
    const r = await new FallbackKycProvider().verify({ ...base, legalId: "123" });
    expect(r.approved).toBe(false);
    expect(r.riskLevel).toBe("high");
    expect(r.reasons).toContain("missing_or_short_legal_id");
  });

  it("monto alto → reason auditable + medium (MNR-1)", async () => {
    const r = await new FallbackKycProvider().verify({ ...base, amountUsd: 5000 });
    expect(r.reasons).toContain("high_amount_requires_enhanced_kyc");
    expect(r.riskLevel).toBe("medium");
  });
});

describe("getKycProvider factory (MNR-2: readiness fail-loud)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("sin key → fallback", () => {
    vi.stubEnv("DIDIT_API_KEY", "");
    expect(getKycProvider()).toBeInstanceOf(FallbackKycProvider);
  });

  it("key SIN readiness → throws (no activa mapeo sandbox-unverified)", () => {
    vi.stubEnv("DIDIT_API_KEY", "k");
    vi.stubEnv("DIDIT_ADAPTER_READY", "");
    expect(() => getKycProvider()).toThrow(/didit_adapter_not_ready/);
  });

  it("key + readiness → adapter Didit", () => {
    vi.stubEnv("DIDIT_API_KEY", "k");
    vi.stubEnv("DIDIT_ADAPTER_READY", "true");
    expect(getKycProvider()).toBeInstanceOf(DiditKycProvider);
  });
});
