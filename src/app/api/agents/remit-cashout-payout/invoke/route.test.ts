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
import { issueQuoteRef } from "@/providers/quote-ref";

const ENDPOINT = "http://localhost/api/agents/remit-cashout-payout/invoke";

// Input válido de referencia con PII real del beneficiario (name + destination Yape) para los asserts NO-PII.
const validInput = {
  // Referencia AUTENTICADA de remit-corridor-fx (lleva el monto cotizado firmado adentro). Con un
  // `quoteId` crudo el core bloquea en `quote_unresolvable` y ningún test HTTP llega a su rama.
  // Solo crece el ARRANGE — los asserts quedan intactos.
  quoteId: issueQuoteRef("fxmid-test", 100),
  amountUsd: 100,
  kycVerificationId: "v1",
  kycPayoutAllowed: true,
  // WKH-204: identity claim del sender (un DNI REAL) — sin esto C3 bloquearía todos los tests HTTP
  // antes de llegar a las ramas que ejercitan. Además es el probe de AC-3: NINGÚN response
  // (200/400/502) puede ecoarlo. Solo crece el ARRANGE — los asserts quedan intactos.
  senderIdentity: "12345678",
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
    vi.stubEnv("TRANSFI_API_KEY", "");        // NO gatea el payout (la lee fx.ts): borrarla no elige
    // el mock. Acá el FallbackPayoutProvider sale de que TRANSFI_USERNAME/PASSWORD/MID no están
    // seteadas en el entorno de test; este stub sólo aísla del ambiente al FX (CD-4).
    vi.stubEnv("ALLOW_FALLBACK_PAYOUT", "true"); // en NODE_ENV=test corre el mock por la rama dev
    // WKH-203: el gate KYC server-side corre en cada invoke. En NODE_ENV="test" (≠ production)
    // el KYC fallback pasa por la rama B5 (opt-in explícito) → los tests del happy-path HTTP siguen
    // ejerciendo el path real. En producción esta env NO abre nada (rama B3).
    vi.stubEnv("ALLOW_FALLBACK_KYC", "true");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  // (1) WKH-203/AC-1-HTTP: el gate KYC server-side no confirma → 200 blocked, NO ejecuta provider.
  // (Reemplaza al viejo test del booleano `kycPayoutAllowed:false`: con DT-4 Zod lo strippea y ya
  // no bloquea nada — el equivalente REAL del gate es que el KYC no se pueda confirmar.)
  it("KYC no confirmable (sin opt-in fallback) → 200 blocked, no ejecuta provider", async () => {
    vi.stubEnv("ALLOW_FALLBACK_KYC", ""); // B4: sin opt-in el fallback no abre
    const res = await invoke(validInput);
    expect(res.status).toBe(200);
    const output = (await res.json()).result;
    expect(output.executed).toBe(false);
    expect(output.status).toBe("blocked");
    expect(output.reason).toBe("kyc_gate_not_passed");
    expect(output.payoutId).toBeNull();
  });

  // (1b) AC-5a: el response `blocked` no filtra PII del beneficiario ni el Travel Rule.
  it("el 200 blocked NO filtra beneficiary.name/destination ni travelRuleData (AC-5a)", async () => {
    vi.stubEnv("ALLOW_FALLBACK_KYC", "");
    const res = await invoke(validInput);
    const body = JSON.stringify(await res.json());
    expect(body).not.toContain("999888777");
    expect(body).not.toContain("Bob");
    expect(body).not.toContain("travelRuleData");
  });

  // (1c) AC-5b / B6: kyc_gate_unavailable → 502 opaco, sin filtrar el motivo interno ni PII.
  it("gate KYC caído → 502 { error: payout_unavailable } sin filtrar kyc_gate_unavailable ni PII", async () => {
    vi.stubEnv("DIDIT_API_KEY", "k");
    vi.stubEnv("DIDIT_ADAPTER_READY", "true");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network_down 999888777");
      }),
    );
    const res = await invoke(validInput);
    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data).toEqual({ error: "payout_unavailable" });
    expect(JSON.stringify(data)).not.toContain("kyc_gate_unavailable");
    expect(JSON.stringify(data)).not.toContain("999888777");
    expect(JSON.stringify(data)).not.toContain("Bob");
  });

  // (2) AC-4 / AC-6 / CD-9: body válido → 200 { result } con EXACTAMENTE los 9 campos, provenance mock.
  // WKH-212: el contrato del wire ahora incluye `depositAddress` (null en el mock/fallback).
  it("body válido → 200 { result } con exactamente los 9 campos, provenance local-fallback", async () => {
    const res = await invoke(validInput);
    expect(res.status).toBe(200);
    const data = await res.json();
    const output = data.result ?? data; // contrato compose.ts (data.result ?? data)
    expect(output.slug).toBe("remit-cashout-payout");
    expect(Object.keys(output).sort()).toEqual([
      "deliveredLocal",
      "depositAddress",
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
    expect(output.depositAddress).toBeNull(); // WKH-212: mock/fallback no devuelve address
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
    // WKH-203 (C1): en PROD el gate KYC exige verificación REAL aprobada (B1) — el fallback jamás
    // abre en prod (B3), ni con ALLOW_FALLBACK_KYC. Solo crece el ARRANGE: asserts originales.
    vi.stubEnv("DIDIT_API_KEY", "k");
    vi.stubEnv("DIDIT_ADAPTER_READY", "true");
    // El adapter de Didit exige que el ambiente se DECLARE (didit-env.ts, fail-closed): sin esto la
    // factory lanza y la ruta devuelve 502. Se declara "mock" + localhost — con NODE_ENV=production
    // stubeado, "live" resolvería el host REAL de Didit desde un test, que es justo lo que no puede
    // pasar. El eje Didit se cubre en didit-env.test.ts.
    vi.stubEnv("DIDIT_ENV", "mock");
    vi.stubEnv("DIDIT_BASE_URL", "http://localhost:9999/didit-mock");
    // WKH-204: el vendor_data debe matchear el senderIdentity del fixture (C7), si no C11 bloquea.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ status: "Approved", session_id: "v1", vendor_data: "12345678" }),
            { status: 200 },
          ),
      ),
    );
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

  // (7b) WKH-204/AC-3/CD-4: el senderIdentity (un DNI real) NUNCA se ecoa en un 200 blocked.
  it("AC-3: el 200 blocked NO ecoa el senderIdentity ni el vendor_data (CD-4)", async () => {
    vi.stubEnv("ALLOW_FALLBACK_KYC", ""); // B4 → blocked
    const res = await invoke(validInput);
    expect(res.status).toBe(200);
    const body = JSON.stringify(await res.json());
    expect(body).not.toContain("12345678"); // el DNI del claim
    expect(body).not.toContain("senderIdentity");
    expect(body).not.toContain("vendor_data");
    expect(body).not.toContain("999888777");
    expect(body).not.toContain("Bob");
    expect(body).not.toContain("travelRuleData");
  });

  // (7c) WKH-204/AC-3 — 🔴 EL PROBE DE CD-11: el 400 devuelve parsed.error.flatten() tal cual.
  // Con z.string() el mensaje es value-free; con un z.enum/discriminado ecoaría el DNI recibido.
  it("AC-3/CD-11: el 400 NO ecoa el senderIdentity recibido (z.string() es value-free)", async () => {
    // senderIdentity no-string + falta idempotencyKey → 400 invalid_input con details=flatten()
    const res = await invoke({
      ...validInput,
      senderIdentity: "DNI-12345678",
      idempotencyKey: undefined,
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("invalid_input");
    const body = JSON.stringify(data);
    expect(body).not.toContain("12345678"); // ← si alguien mete un z.enum, esto se rompe
    expect(body).not.toContain("DNI-");
    expect(body).not.toContain("999888777");
    expect(body).not.toContain("Bob");
  });

  // (7d) WKH-204/AC-3: el 502 sigue siendo un body fijo opaco — tampoco filtra el claim.
  it("AC-3: el 502 NO ecoa el senderIdentity (body fijo opaco)", async () => {
    vi.stubEnv("DIDIT_API_KEY", "k");
    vi.stubEnv("DIDIT_ADAPTER_READY", "true");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network_down 12345678");
      }),
    );
    const res = await invoke(validInput);
    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data).toEqual({ error: "payout_unavailable" });
    expect(JSON.stringify(data)).not.toContain("12345678");
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
