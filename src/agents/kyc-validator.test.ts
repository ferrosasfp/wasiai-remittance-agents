import { describe, it, expect, afterEach, vi } from "vitest";
import { runKycValidator } from "./kyc-validator";

const validInput = {
  senderName: "Alice",
  senderCountry: "US",
  legalId: "12345678",
  amountUsd: 100,
  receiverName: "Bob",
  receiverCountry: "PE",
  purpose: "family support",
};

describe("runKycValidator — redacción de PII (BLQ-MED-1)", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("el output NO filtra el legalId/DNI ni travelRuleData", async () => {
    vi.stubEnv("DIDIT_API_KEY", "");
    const out = await runKycValidator(validInput);
    expect(JSON.stringify(out)).not.toContain("12345678"); // el DNI no viaja en el result
    expect(Object.keys(out)).not.toContain("travelRuleData");
    expect(out.verificationId).toBeTruthy(); // handle para recuperarlo vía canal seguro
  });
});

describe("runKycValidator — hard-gate FAIL-SAFE (BLQ-ALTO-1)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("fallback + nada seteado → payoutAllowed FALSE (no abre por default)", async () => {
    vi.stubEnv("DIDIT_API_KEY", "");
    vi.stubEnv("NODE_ENV", "");
    vi.stubEnv("ALLOW_FALLBACK_KYC", "");
    const out = await runKycValidator(validInput);
    expect(out.provenance).toBe("local-fallback");
    expect(out.approved).toBe(true);
    expect(out.payoutAllowed).toBe(false);
  });

  it("fallback + opt-in explícito + non-prod → payoutAllowed true (dev/CI)", async () => {
    vi.stubEnv("DIDIT_API_KEY", "");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("ALLOW_FALLBACK_KYC", "true");
    const out = await runKycValidator(validInput);
    expect(out.payoutAllowed).toBe(true);
  });

  it("PROD + fallback → payoutAllowed FALSE aunque ALLOW_FALLBACK_KYC=true", async () => {
    vi.stubEnv("DIDIT_API_KEY", "");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOW_FALLBACK_KYC", "true");
    const out = await runKycValidator(validInput);
    expect(out.payoutAllowed).toBe(false);
  });

  it("input inválido → throws (el handler lo mapea a 400)", async () => {
    await expect(runKycValidator({ nope: true })).rejects.toThrow();
  });
});
