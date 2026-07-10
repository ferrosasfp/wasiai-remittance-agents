import { describe, it, expect, afterEach, vi } from "vitest";
import { runCashoutPayout } from "./cashout-payout";

const validInput = {
  quoteId: "q1",
  amountUsd: 100,
  kycVerificationId: "v1",
  kycPayoutAllowed: true,
  beneficiary: { name: "Bob", country: "PE", method: "yape", destination: "999999999" },
  idempotencyKey: "idem-1",
};

describe("runCashoutPayout — hard-gate KYC", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("kycPayoutAllowed=false → blocked, no ejecuta", async () => {
    const out = await runCashoutPayout({ ...validInput, kycPayoutAllowed: false });
    expect(out.executed).toBe(false);
    expect(out.status).toBe("blocked");
    expect(out.reason).toBe("kyc_gate_not_passed");
  });
});

describe("runCashoutPayout — fail-safe (nunca payout real con fallback)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("PROD sin provider real → throws payout_refused", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TRANSFI_API_KEY", "");
    await expect(runCashoutPayout(validInput)).rejects.toThrow(/payout_refused/);
  });

  it("dev sin opt-in → throws payout_refused", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("TRANSFI_API_KEY", "");
    vi.stubEnv("ALLOW_FALLBACK_PAYOUT", "");
    await expect(runCashoutPayout(validInput)).rejects.toThrow(/payout_refused/);
  });

  it("dev + opt-in explícito → ejecuta fallback MOCK (no mueve plata)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("TRANSFI_API_KEY", "");
    vi.stubEnv("ALLOW_FALLBACK_PAYOUT", "true");
    const out = await runCashoutPayout(validInput);
    expect(out.executed).toBe(true);
    expect(out.provenance).toBe("local-fallback");
    expect(out.deliveredLocal).toBeNull(); // no hubo entrega real
  });

  it("input inválido → throws", async () => {
    await expect(runCashoutPayout({ nope: true })).rejects.toThrow();
  });
});

describe("runCashoutPayout — flag PAYOUT_ALLOW_MOCK (prod opt-in, etapa 1)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("PROD + PAYOUT_ALLOW_MOCK → ejecuta mock (no mueve plata)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TRANSFI_API_KEY", "");
    vi.stubEnv("PAYOUT_ALLOW_MOCK", "true");
    const out = await runCashoutPayout(validInput);
    expect(out.executed).toBe(true);
    expect(out.provenance).toBe("local-fallback");
    expect(out.deliveredLocal).toBeNull();
    expect(out.txRef).toBeNull();
  });

  it("PROD + PAYOUT_ALLOW_MOCK + TRANSFI_API_KEY sin READY → throws transfi_adapter_not_ready", async () => {
    // El flag NO habilita un real a medias ni un mock silencioso: getPayoutProvider() lanza fail-loud.
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PAYOUT_ALLOW_MOCK", "true");
    vi.stubEnv("TRANSFI_API_KEY", "k");
    vi.stubEnv("TRANSFI_ADAPTER_READY", "");
    await expect(runCashoutPayout(validInput)).rejects.toThrow(/transfi_adapter_not_ready/);
  });

  it("PROD sin PAYOUT_ALLOW_MOCK → throws payout_refused (default intacto)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TRANSFI_API_KEY", "");
    vi.stubEnv("PAYOUT_ALLOW_MOCK", "");
    await expect(runCashoutPayout(validInput)).rejects.toThrow(/payout_refused/);
  });
});
