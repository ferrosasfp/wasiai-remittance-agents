import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

// Mock del core con default = implementación real (los demás tests corren el path real).
// El test del 502 usa mockImplementationOnce para forzar un throw sin tocar kyc-validator.ts.
const { runKycValidatorMock } = vi.hoisted(() => ({ runKycValidatorMock: vi.fn() }));
vi.mock("@/agents/kyc-validator", async (importActual) => {
  const actual = await importActual<typeof import("@/agents/kyc-validator")>();
  runKycValidatorMock.mockImplementation(actual.runKycValidator);
  return { ...actual, runKycValidator: runKycValidatorMock };
});

import { POST } from "./route";

const ENDPOINT = "http://localhost/api/agents/remit-kyc-validator/invoke";

// Input válido de referencia con PII real (legalId = DNI) para los asserts NO-PII.
const validInput = {
  senderName: "Alice",
  senderCountry: "US",
  legalId: "12345678",
  amountUsd: 100,
  receiverName: "Bob",
  receiverCountry: "PE",
  purpose: "family support",
};

function invoke(body: unknown) {
  return POST(
    new NextRequest(ENDPOINT, { method: "POST", body: JSON.stringify(body) }),
  );
}

describe("POST /api/agents/remit-kyc-validator/invoke", () => {
  beforeEach(() => {
    vi.stubEnv("DIDIT_API_KEY", ""); // fuerza FallbackKycProvider (Didit OFF)
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // (1) AC-6 / AC-3: body válido → 200 { result } legible por data.result, EXACTAMENTE los 7 campos.
  it("body válido → 200 { result } con exactamente los 7 campos", async () => {
    const res = await invoke(validInput);
    expect(res.status).toBe(200);
    const data = await res.json();
    const output = data.result ?? data; // contrato compose.ts (data.result ?? data)
    expect(output.slug).toBe("remit-kyc-validator");
    expect(Object.keys(output).sort()).toEqual([
      "approved",
      "payoutAllowed",
      "provenance",
      "reasons",
      "riskLevel",
      "slug",
      "verificationId",
    ]);
  });

  // (2) AC-3 / CD-6: el 200 NO filtra legalId/DNI ni travelRuleData (NO-PII a nivel HTTP).
  it("el 200 NO filtra legalId ni travelRuleData (NO-PII HTTP)", async () => {
    const res = await invoke(validInput);
    const body = JSON.stringify(await res.json());
    expect(body).not.toContain("12345678"); // el DNI / legalId nunca viaja
    expect(body).not.toContain("travelRuleData"); // Travel Rule PII nunca viaja
  });

  // (2b) CD-6 / defensa en profundidad: campo extra NO-schema con PII → Zod lo strippea,
  // 200 OK y el body NUNCA contiene la PII inyectada ni el campo extra.
  it("campo extra NO-schema con PII → 200 y el body NO filtra la PII inyectada", async () => {
    const res = await invoke({
      ...validInput,
      extraPii: "SECRET-DNI-55667788",
    });
    expect(res.status).toBe(200); // Zod strippea el campo extra → nunca llega al core
    const body = JSON.stringify(await res.json());
    expect(body).not.toContain("SECRET-DNI-55667788"); // la PII inyectada nunca viaja
    expect(body).not.toContain("extraPii"); // ni el campo no-schema
  });

  // (3) AC-4: Didit OFF → provenance local-fallback (nunca "didit").
  it("Didit OFF → provenance local-fallback", async () => {
    const res = await invoke(validInput);
    const { result } = await res.json();
    expect(result.provenance).toBe("local-fallback");
  });

  // (4) AC-5: PROD + fallback + opt-in → payoutAllowed false (fail-safe, a nivel HTTP).
  it("PROD + fallback → payoutAllowed false (fail-safe)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOW_FALLBACK_KYC", "true"); // aún así el fail-safe lo ignora en prod
    const res = await invoke(validInput);
    const { result } = await res.json();
    expect(result.payoutAllowed).toBe(false);
  });

  // (5) AC-7 / CD-6: input inválido CON legalId real → 400 que NO ecoa el legalId.
  it("input inválido (falta senderCountry) con legalId real → 400 SIN ecoar el legalId", async () => {
    const res = await invoke({ ...validInput, senderCountry: undefined });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("invalid_input");
    expect(data.details).toBeTruthy();
    expect(JSON.stringify(data)).not.toContain("12345678"); // el DNI NO se ecoa en el 400
  });

  // (6) AC-7: body no-JSON → 400 (no 500).
  it("body no-JSON → 400 (no 500)", async () => {
    const res = await POST(
      new NextRequest(ENDPOINT, { method: "POST", body: "not-json{" }),
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("invalid_input");
  });

  // (7) CD-6 / §4.5: runKycValidator lanza → 502 opaco sin filtrar internals/PII.
  it("runKycValidator lanza → 502 { error: verification_unavailable } sin filtrar internals", async () => {
    runKycValidatorMock.mockImplementationOnce(async () => {
      throw new Error("didit_adapter_not_ready leak 99887766");
    });
    const res = await invoke(validInput);
    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data).toEqual({ error: "verification_unavailable" });
    expect(JSON.stringify(data)).not.toContain("99887766");
    expect(JSON.stringify(data)).not.toContain("didit_adapter_not_ready");
    expect(data.stack).toBeUndefined();
  });
});
