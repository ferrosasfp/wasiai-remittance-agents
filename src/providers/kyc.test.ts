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
    const s = await new FallbackKycProvider().status("x", "12345678");
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
    // fix-pack: el `vendor_data` matcheando el claim crece el ARRANGE (assert byte-idéntico, AC-4).
    // "sin reasons" = ningún reason en NINGUNO de los dos ejes → la verificación tiene que estar
    // aprobada Y bindeada. Sin vendor_data sería una verificación NO bindeada → identity_no_binding.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ status: "Approved", session_id: "v1", vendor_data: "12345678" }),
      ),
    );
    const s = await new DiditKycProvider("k").status("v1", "12345678");
    expect(s.approved).toBe(true);
    expect(s.provenance).toBe("didit");
    expect(s.verificationId).toBe("v1");
    expect(s.reasons).toEqual([]);
  });

  it("Declined → approved false + reasons value-free (CD-7: nunca PII)", async () => {
    // El endpoint de decisión de Didit devuelve PII (nombre/DNI): acá se DESCARTA y no se lee.
    // fix-pack: `vendor_data` matcheando crece el ARRANGE (assert byte-idéntico, AC-4) y ADEMÁS
    // endurece el canario: ahora el DNI llega por DOS campos (document_number y vendor_data, este
    // último efectivamente LEÍDO y comparado) y el `not.toContain` de abajo sigue exigiendo que
    // ninguno cruce el borde.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          status: "Declined",
          session_id: "v1",
          first_name: "Alice",
          document_number: "12345678",
          vendor_data: "12345678",
        }),
      ),
    );
    const s = await new DiditKycProvider("k").status("v1", "12345678");
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
    const s = await new DiditKycProvider("k").status("v1", "12345678");
    expect(s.approved).toBe(false);
    expect(s.reasons).toContain("aml_hits_1");
  });

  it("!res.ok → throws didit_status_error_<n> (fail-closed, rama B6)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, 500)));
    await expect(new DiditKycProvider("k").status("v1", "12345678")).rejects.toThrow(
      /didit_status_error_500/,
    );
  });

  it("B10: el partner eco-a un session_id distinto → throws didit_status_id_mismatch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ status: "Approved", session_id: "otro" })),
    );
    await expect(new DiditKycProvider("k").status("v1", "12345678")).rejects.toThrow(
      /didit_status_id_mismatch/,
    );
  });
});

// WKH-204 — binding de identidad (C5-C8). La comparación vive DENTRO del provider (CD-7):
// vendor_data es el DNI → solo cruza el borde un booleano derivado, nunca el valor crudo.
describe("DiditKycProvider.status — identity binding (WKH-204/C5-C8)", () => {
  afterEach(() => vi.unstubAllGlobals());

  // C5 — la divergencia DELIBERADA de chaski-v2 (authority.ts:83 omite el check si viene vacío
  // → fail-OPEN). Acá "no hay contra qué comparar" = BLOQUEAR. La divergencia ES el fix (CD-12).
  it("C5: Approved SIN vendor_data → identityMatches:false (approved:true → ejes independientes)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ status: "Approved", session_id: "v1" })),
    );
    const s = await new DiditKycProvider("k").status("v1", "12345678");
    expect(s.identityMatches).toBe(false);
    expect(s.approved).toBe(true); // el binding NO contamina el eje de compliance
  });

  it("C5: vendor_data vacío ('') → identityMatches:false (NUNCA '' === '' → allow)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ status: "Approved", session_id: "v1", vendor_data: "" })),
    );
    const s = await new DiditKycProvider("k").status("v1", "");
    expect(s.identityMatches).toBe(false);
  });

  it("C6: vendor_data distinto del claim → identityMatches:false (verificación ajena)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ status: "Approved", session_id: "v1", vendor_data: "12345678" }),
      ),
    );
    const s = await new DiditKycProvider("k").status("v1", "99999999");
    expect(s.identityMatches).toBe(false);
    expect(s.approved).toBe(true);
  });

  // 🔴 C6 — los tests que MATAN a `===`→`.startsWith(...)` y `===`→`.includes(...)`.
  // El C6 de arriba ("12345678" vs "99999999") pasa por la RAZÓN EQUIVOCADA: misma longitud y sin
  // relación de prefijo/substring → startsWith e includes dan false igual que ===, y los dos mutantes
  // SOBREVIVEN (verificado ejecutando: 108/108 verde con ambas mutaciones). La igualdad ESTRICTA
  // quedaba documentada pero NO defendida. Si alguien "flexibiliza" a includes, un claim "1"
  // matchearía CUALQUIER DNI que contenga un 1 → bypass total del binding, en silencio.
  it("C6: claim PREFIJO del vendor_data ('1234' de '12345678') → identityMatches:false (mata startsWith e includes)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ status: "Approved", session_id: "v1", vendor_data: "12345678" }),
      ),
    );
    const s = await new DiditKycProvider("k").status("v1", "1234");
    expect(s.identityMatches).toBe(false); // con .startsWith() o .includes() esto sería true
    expect(s.approved).toBe(true); // el binding NO contamina el eje de compliance
  });

  it("C6: claim SUBSTRING del vendor_data ('2345' de '12345678') → identityMatches:false (mata includes)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ status: "Approved", session_id: "v1", vendor_data: "12345678" }),
      ),
    );
    const s = await new DiditKycProvider("k").status("v1", "2345");
    expect(s.identityMatches).toBe(false); // con .includes() esto sería true
  });

  it("C7: vendor_data === claim → identityMatches:true (única rama que abre)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ status: "Approved", session_id: "v1", vendor_data: "12345678" }),
      ),
    );
    const s = await new DiditKycProvider("k").status("v1", "12345678");
    expect(s.identityMatches).toBe(true);
  });

  // 🔴 C8 — el test que MATA al String()-guard del SDD: String(123) === "123" (NO "") → un
  // vendor_data:123 con claim "123" MATCHEARÍA = fail-open. El typeof-narrowing lo colapsa a "".
  it("C8: vendor_data:123 (number) con claim '123' → identityMatches:false (mata el String()-guard)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ status: "Approved", session_id: "v1", vendor_data: 123 })),
    );
    const s = await new DiditKycProvider("k").status("v1", "123");
    expect(s.identityMatches).toBe(false);
  });

  it("C8: vendor_data:{} con claim '[object Object]' → identityMatches:false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ status: "Approved", session_id: "v1", vendor_data: {} })),
    );
    const s = await new DiditKycProvider("k").status("v1", "[object Object]");
    expect(s.identityMatches).toBe(false);
  });

  it("C8: vendor_data null / array → identityMatches:false (no-string → '' → C5)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ status: "Approved", session_id: "v1", vendor_data: null })),
    );
    expect((await new DiditKycProvider("k").status("v1", "12345678")).identityMatches).toBe(false);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ status: "Approved", session_id: "v1", vendor_data: ["12345678"] }),
      ),
    );
    expect((await new DiditKycProvider("k").status("v1", "12345678")).identityMatches).toBe(false);
  });

  it("normalización: vendor_data '  12345678  ' vs claim '12345678' → identityMatches:true", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ status: "Approved", session_id: "v1", vendor_data: "  12345678  " }),
      ),
    );
    const s = await new DiditKycProvider("k").status("v1", "12345678");
    expect(s.identityMatches).toBe(true);
  });

  it("normalización: address EVM case-insensitive (sirve a las 2 convenciones)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ status: "Approved", session_id: "v1", vendor_data: "0xAbCd" }),
      ),
    );
    const s = await new DiditKycProvider("k").status("v1", "0xabcd");
    expect(s.identityMatches).toBe(true);
  });

  // fix-pack / R-5 — el discriminador value-free que le permite a ops separar "la integración con
  // Didit está rota" (identity_no_binding masivo) de "nos están atacando" (identity_mismatch puntual).
  // Sin esto los dos casos emiten el MISMO warn y son indistinguibles.
  it("R-5: SIN vendor_data → reasons incluye identity_no_binding (falla de integración, no ataque)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ status: "Approved", session_id: "v1" })),
    );
    const s = await new DiditKycProvider("k").status("v1", "12345678");
    expect(s.reasons).toContain("identity_no_binding");
    expect(s.reasons).not.toContain("identity_mismatch");
  });

  it("R-5: vendor_data presente pero distinto → reasons incluye identity_mismatch (ataque, no integración)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ status: "Approved", session_id: "v1", vendor_data: "12345678" }),
      ),
    );
    const s = await new DiditKycProvider("k").status("v1", "99999999");
    expect(s.reasons).toContain("identity_mismatch");
    expect(s.reasons).not.toContain("identity_no_binding");
  });

  it("C8: vendor_data de tipo inesperado → identity_no_binding (colapsa a '' → no hay binding)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ status: "Approved", session_id: "v1", vendor_data: 123 })),
    );
    const s = await new DiditKycProvider("k").status("v1", "123");
    expect(s.reasons).toContain("identity_no_binding");
  });

  it("match → NINGÚN reason de identidad (los ejes no se contaminan)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ status: "Approved", session_id: "v1", vendor_data: "12345678" }),
      ),
    );
    const s = await new DiditKycProvider("k").status("v1", "12345678");
    expect(s.reasons).toEqual([]);
  });

  // Los dos ejes son independientes: Declined Y no-bindeada → reasons de AMBOS ejes, concatenados.
  it("ejes independientes: Declined + sin binding → reasons de compliance Y de identidad", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ status: "Declined", session_id: "v1" })),
    );
    const s = await new DiditKycProvider("k").status("v1", "12345678");
    expect(s.reasons).toEqual(["didit_status_declined", "aml_hits_0", "identity_no_binding"]);
  });

  // 🔴 CD-4/CD-7 — el discriminador es una ETIQUETA DE RAMA, jamás un valor. Este test es el que
  // detectaría que alguien "mejore" el reason interpolando el vendor_data o el claim para debuggear.
  it("CD-4/CD-7: los reasons de identidad NUNCA contienen el vendor_data ni el claim", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ status: "Approved", session_id: "v1", vendor_data: "12345678" }),
      ),
    );
    const s = await new DiditKycProvider("k").status("v1", "99999999");
    const dump = JSON.stringify(s.reasons);
    expect(dump).not.toContain("12345678"); // el vendor_data (DNI de la verificación)
    expect(dump).not.toContain("99999999"); // el claim que mandó el caller
    expect(dump).not.toContain("vendor_data"); // ni el nombre del campo del partner
  });

  // CD-7: el vendor_data (DNI) se usa para comparar y se DESCARTA — nunca cruza el borde.
  it("CD-7: el vendor_data NUNCA sale en el KycStatusResult (ni siquiera al matchear)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ status: "Declined", session_id: "v1", vendor_data: "12345678" }),
      ),
    );
    const s = await new DiditKycProvider("k").status("v1", "12345678");
    expect(JSON.stringify(s)).not.toContain("12345678");
    expect(JSON.stringify(s)).not.toContain("vendor_data");
  });

  // 🔴 CD-7 / rama C5 — el canario que FALTABA (MNR-1 del re-AR). Los dos canarios de arriba
  // stubbean un `vendor_data` PRESENTE (ramas C7 match y C6 mismatch): ninguno ejercitaba C5,
  // así que el literal "vendor_data" jamás se defendía en la rama que emite `identity_no_binding`
  // — justo la etiqueta que se tentó de llamar `identity_no_binding`. Sin este test, ese
  // rename metía el literal del campo del partner en un reason y NADA se ponía rojo.
  it("CD-7/C5: sin vendor_data → identity_no_binding, y el literal 'vendor_data' NO cruza el borde", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ status: "Approved", session_id: "v1" })), // C5: Didit NO lo ecoa
    );
    const s = await new DiditKycProvider("k").status("v1", "12345678");
    expect(s.reasons).toContain("identity_no_binding");
    const dump = JSON.stringify(s);
    expect(dump).not.toContain("vendor_data"); // ni el nombre del campo del partner
    expect(dump).not.toContain("12345678"); // ni el claim que mandó el caller
  });
});

// C9 — el fallback no tiene store y no finge tenerlo; es inocuo por la allowlist (B3/B5).
describe("FallbackKycProvider.status — identity binding (WKH-204/C9)", () => {
  it("C9: identityMatches:true + provenance local-fallback (inocuo por construcción)", async () => {
    const s = await new FallbackKycProvider().status("x", "lo-que-sea");
    expect(s.identityMatches).toBe(true);
    expect(s.provenance).toBe("local-fallback");
  });
});

// B9 — anti-WKH-198: una señal de compliance no-booleana NUNCA debe llegar al gate.
describe("assertValidKycStatus (WKH-203/CD-8, anti-WKH-198)", () => {
  const valid: KycStatusResult = {
    approved: true,
    verificationId: "v1",
    provenance: "didit",
    identityMatches: true, // WKH-204: propiedad requerida del contrato (solo crece el ARRANGE)
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

  // C10 (WKH-204): espejo exacto del guard de `approved` — una señal de binding no-booleana
  // NUNCA debe llegar al gate (anti-WKH-198).
  it("C10: identityMatches no-booleano (undefined) → throws invalid_kyc_status_identity", () => {
    expect(() =>
      assertValidKycStatus({ ...valid, identityMatches: undefined as unknown as boolean }),
    ).toThrow(/invalid_kyc_status_identity/);
  });

  it("C10: identityMatches NaN-ish (truthy pero no booleano) → throws (no se lee como match)", () => {
    expect(() =>
      assertValidKycStatus({ ...valid, identityMatches: NaN as unknown as boolean }),
    ).toThrow(/invalid_kyc_status_identity/);
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
