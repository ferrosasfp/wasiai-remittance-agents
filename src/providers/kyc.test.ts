import { describe, it, expect, afterEach, vi } from "vitest";
import {
  FallbackKycProvider,
  DiditKycProvider,
  getKycProvider,
  assertValidKycStatus,
} from "./kyc";
import type { KycInput, KycStatusResult } from "./types";

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

// WKH-203 — status(): consulta de estado server-side (NO crea verificación).
describe("FallbackKycProvider.status (WKH-203)", () => {
  it("tagea local-fallback + eco del id pedido + reason 'no real'", async () => {
    const s = await new FallbackKycProvider().status("x");
    expect(s.provenance).toBe("local-fallback");
    expect(s.verificationId).toBe("x");
    expect(s.reasons).toContain("fallback_no_real_verification");
    // approved:true es INOCUO: la allowlist del gate lo bloquea en prod (B3).
    expect(s.approved).toBe(true);
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("DiditKycProvider.status (WKH-203)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("Approved + sin AML hits → approved true, provenance didit, sin reasons", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ status: "Approved", session_id: "v1" })),
    );
    const s = await new DiditKycProvider("k").status("v1");
    expect(s.approved).toBe(true);
    expect(s.provenance).toBe("didit");
    expect(s.verificationId).toBe("v1");
    expect(s.reasons).toEqual([]);
  });

  it("Declined → approved false + reasons value-free (CD-7: nunca PII)", async () => {
    // El endpoint de decisión de Didit devuelve PII (nombre/DNI): acá se DESCARTA y no se lee.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          status: "Declined",
          session_id: "v1",
          first_name: "Alice",
          document_number: "12345678",
        }),
      ),
    );
    const s = await new DiditKycProvider("k").status("v1");
    expect(s.approved).toBe(false);
    expect(s.reasons).toEqual(["didit_status_declined", "aml_hits_0"]);
    // la PII del partner NUNCA entra al KycStatusResult
    expect(JSON.stringify(s)).not.toContain("12345678");
    expect(JSON.stringify(s)).not.toContain("Alice");
  });

  it("Approved pero con AML hits → approved false (mismo criterio que verify)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ status: "Approved", session_id: "v1", aml: { hits: [{ x: 1 }] } }),
      ),
    );
    const s = await new DiditKycProvider("k").status("v1");
    expect(s.approved).toBe(false);
    expect(s.reasons).toContain("aml_hits_1");
  });

  it("!res.ok → throws didit_status_error_<n> (fail-closed, rama B6)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, 500)));
    await expect(new DiditKycProvider("k").status("v1")).rejects.toThrow(
      /didit_status_error_500/,
    );
  });

  it("B10: el partner eco-a un session_id distinto → throws didit_status_id_mismatch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ status: "Approved", session_id: "otro" })),
    );
    await expect(new DiditKycProvider("k").status("v1")).rejects.toThrow(
      /didit_status_id_mismatch/,
    );
  });
});

// B9 — anti-WKH-198: una señal de compliance no-booleana NUNCA debe llegar al gate.
describe("assertValidKycStatus (WKH-203/CD-8, anti-WKH-198)", () => {
  const valid: KycStatusResult = {
    approved: true,
    verificationId: "v1",
    provenance: "didit",
    reasons: [],
  };

  it("approved no-booleano (undefined) → throws invalid_kyc_status_approved", () => {
    expect(() =>
      assertValidKycStatus({ ...valid, approved: undefined as unknown as boolean }),
    ).toThrow(/invalid_kyc_status_approved/);
  });

  it("approved NaN-ish (truthy pero no booleano) → throws (no se lee como aprobado)", () => {
    expect(() =>
      assertValidKycStatus({ ...valid, approved: NaN as unknown as boolean }),
    ).toThrow(/invalid_kyc_status_approved/);
  });

  it("verificationId vacío → throws invalid_kyc_status_id", () => {
    expect(() => assertValidKycStatus({ ...valid, verificationId: "" })).toThrow(
      /invalid_kyc_status_id/,
    );
  });

  it("provenance vacío → throws invalid_kyc_status_provenance", () => {
    expect(() => assertValidKycStatus({ ...valid, provenance: "" })).toThrow(
      /invalid_kyc_status_provenance/,
    );
  });

  it("status válido → lo devuelve intacto", () => {
    expect(assertValidKycStatus(valid)).toEqual(valid);
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
