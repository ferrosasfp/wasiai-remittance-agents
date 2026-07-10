import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

// Mock del core con default = implementación real (los demás tests corren el path real).
// El test del 502 usa mockImplementationOnce para forzar un throw sin tocar cashout-payout.ts.
const { runCashoutPayoutMock } = vi.hoisted(() => ({ runCashoutPayoutMock: vi.fn() }));
vi.mock("@/agents/cashout-payout", async (importActual) => {
  const actual = await importActual<typeof import("@/agents/cashout-payout")>();
  runCashoutPayoutMock.mockImplementation(actual.runCashoutPayout);
  return { ...actual, runCashoutPayout: runCashoutPayoutMock };
});

import { POST } from "./route";

const ENDPOINT = "http://localhost/api/agents/remit-cashout-payout/invoke";

// Input válido de referencia con PII real del beneficiario (name + destination Yape) para los asserts NO-PII.
const validInput = {
  quoteId: "q1",
  amountUsd: 100,
  kycVerificationId: "v1",
  kycPayoutAllowed: true,
  beneficiary: { name: "Bob", country: "PE", method: "yape", destination: "999888777" },
  idempotencyKey: "idem-1",
};

function invoke(body: unknown) {
  return POST(
    new NextRequest(ENDPOINT, { method: "POST", body: JSON.stringify(body) }),
  );
}

describe("POST /api/agents/remit-cashout-payout/invoke", () => {
  beforeEach(() => {
    vi.stubEnv("TRANSFI_API_KEY", "");        // TransFi OFF → FallbackPayoutProvider (CD-4)
    vi.stubEnv("ALLOW_FALLBACK_PAYOUT", "true"); // en NODE_ENV=test corre el mock por la rama dev
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // (1) AC-3: hard-gate KYC → 200 blocked, NO ejecuta provider.
  it("kycPayoutAllowed:false → 200 blocked, no ejecuta provider", async () => {
    const res = await invoke({ ...validInput, kycPayoutAllowed: false });
    expect(res.status).toBe(200);
    const output = (await res.json()).result;
    expect(output.executed).toBe(false);
    expect(output.status).toBe("blocked");
    expect(output.reason).toBe("kyc_gate_not_passed");
    expect(output.payoutId).toBeNull();
  });

  // (2) AC-4 / AC-6 / CD-9: body válido → 200 { result } con EXACTAMENTE los 8 campos, provenance mock.
  it("body válido → 200 { result } con exactamente los 8 campos, provenance local-fallback", async () => {
    const res = await invoke(validInput);
    expect(res.status).toBe(200);
    const data = await res.json();
    const output = data.result ?? data; // contrato compose.ts (data.result ?? data)
    expect(output.slug).toBe("remit-cashout-payout");
    expect(Object.keys(output).sort()).toEqual([
      "deliveredLocal",
      "executed",
      "payoutId",
      "provenance",
      "reason",
      "slug",
      "status",
      "txRef",
    ]);
    expect(output.provenance).toBe("local-fallback");
    expect(output.deliveredLocal).toBeNull();
    expect(output.txRef).toBeNull();
  });

  // (3) AC-4 / CD-6: el 200 NO filtra beneficiary.name/destination ni travelRuleData (NO-PII HTTP).
  it("el 200 NO filtra beneficiary.name/destination ni travelRuleData (NO-PII HTTP)", async () => {
    const res = await invoke(validInput);
    const body = JSON.stringify(await res.json());
    expect(body).not.toContain("999888777"); // el CCI/Yape (destination) nunca viaja
    expect(body).not.toContain("Bob");        // el nombre del beneficiario nunca viaja
    expect(body).not.toContain("travelRuleData");
  });

  // (4) AC-5: idempotencia — mismo idempotencyKey → mismo payoutId determinístico.
  it("idempotencia: mismo idempotencyKey → mismo payoutId", async () => {
    const a = (await (await invoke(validInput)).json()).result;
    const b = (await (await invoke(validInput)).json()).result;
    expect(a.payoutId).toBe("fallback-idem-1");
    expect(b.payoutId).toBe(a.payoutId);
  });

  // (5) AC-6: PROD sin PAYOUT_ALLOW_MOCK → 502 payout_unavailable (fail-safe default intacto).
  it("PROD sin PAYOUT_ALLOW_MOCK → 502 payout_unavailable", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PAYOUT_ALLOW_MOCK", "");
    vi.stubEnv("TRANSFI_API_KEY", "");
    const res = await invoke(validInput);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "payout_unavailable" });
  });

  // (6) AC-6 / §4.3: PROD + PAYOUT_ALLOW_MOCK → 200 mock a nivel HTTP.
  it("PROD + PAYOUT_ALLOW_MOCK → 200 mock (local-fallback, no mueve plata)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PAYOUT_ALLOW_MOCK", "true");
    vi.stubEnv("TRANSFI_API_KEY", "");
    const res = await invoke(validInput);
    expect(res.status).toBe(200);
    const output = (await res.json()).result;
    expect(output.provenance).toBe("local-fallback");
    expect(output.deliveredLocal).toBeNull();
  });

  // (7) AC-8 / CD-6: input inválido CON beneficiary PII → 400 que NO ecoa destination/name.
  it("input inválido (falta idempotencyKey) con beneficiary PII → 400 SIN ecoar destination", async () => {
    const res = await invoke({ ...validInput, idempotencyKey: undefined });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("invalid_input");
    expect(data.details).toBeTruthy();
    expect(JSON.stringify(data)).not.toContain("999888777");
    expect(JSON.stringify(data)).not.toContain("Bob");
  });

  // (8) AC-8: body no-JSON → 400 (no 500).
  it("body no-JSON → 400 (no 500)", async () => {
    const res = await POST(
      new NextRequest(ENDPOINT, { method: "POST", body: "not-json{" }),
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("invalid_input");
  });

  // (9) CD-6 / §4.6: runCashoutPayout lanza → 502 opaco sin filtrar internals/PII.
  it("runCashoutPayout lanza → 502 { error: payout_unavailable } sin filtrar internals", async () => {
    runCashoutPayoutMock.mockImplementationOnce(async () => {
      throw new Error("payout_refused leak 999888777");
    });
    const res = await invoke(validInput);
    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data).toEqual({ error: "payout_unavailable" });
    expect(JSON.stringify(data)).not.toContain("999888777");
    expect(JSON.stringify(data)).not.toContain("payout_refused");
    expect(data.stack).toBeUndefined();
  });
});
