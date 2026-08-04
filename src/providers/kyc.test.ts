import { describe, it, expect, afterEach, vi } from "vitest";
import {
  FallbackKycProvider,
  DiditKycProvider,
  getKycProvider,
  assertValidKycStatus,
} from "./kyc";
import { resolveDiditBaseUrl, type DiditBaseUrl } from "./didit-env";
import type { KycInput, KycStatusResult } from "./types";

/**
 * Host de MOCK para construir el adapter en los tests. Mismo patrón que `mintSandboxBaseUrl()` de
 * fx.test.ts: `DiditBaseUrl` es branded, así que este helper es la PRUEBA de que el único camino a
 * un host de Didit pasa por `resolveDiditBaseUrl()`, incluso desde los tests. Nadie puede inventar
 * un host acá (ni un literal, ni un cast) sin que el compilador lo rechace.
 *
 * Apunta a localhost A PROPÓSITO: si algún día un test dejara de mockear `fetch`, el request moriría
 * en un puerto local en vez de crear una verificación REAL con PII en Didit.
 */
function mintMockBaseUrl(): DiditBaseUrl {
  const prevEnv = process.env.DIDIT_ENV;
  const prevUrl = process.env.DIDIT_BASE_URL;
  process.env.DIDIT_ENV = "mock";
  process.env.DIDIT_BASE_URL = "http://localhost:9999/didit-mock";
  try {
    return resolveDiditBaseUrl();
  } finally {
    if (prevEnv === undefined) delete process.env.DIDIT_ENV;
    else process.env.DIDIT_ENV = prevEnv;
    if (prevUrl === undefined) delete process.env.DIDIT_BASE_URL;
    else process.env.DIDIT_BASE_URL = prevUrl;
  }
}

const MOCK_BASE_URL = mintMockBaseUrl();

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
    const s = await new DiditKycProvider("k", MOCK_BASE_URL, "live").status("v1", "12345678");
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
    const s = await new DiditKycProvider("k", MOCK_BASE_URL, "live").status("v1", "12345678");
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
    const s = await new DiditKycProvider("k", MOCK_BASE_URL, "live").status("v1", "12345678");
    expect(s.approved).toBe(false);
    expect(s.reasons).toContain("aml_hits_1");
  });

  it("!res.ok → throws didit_status_error_<n> (fail-closed, rama B6)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, 500)));
    await expect(new DiditKycProvider("k", MOCK_BASE_URL, "live").status("v1", "12345678")).rejects.toThrow(
      /didit_status_error_500/,
    );
  });

  it("B10: el partner eco-a un session_id distinto → throws didit_status_id_mismatch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ status: "Approved", session_id: "otro" })),
    );
    await expect(new DiditKycProvider("k", MOCK_BASE_URL, "live").status("v1", "12345678")).rejects.toThrow(
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
    const s = await new DiditKycProvider("k", MOCK_BASE_URL, "live").status("v1", "12345678");
    expect(s.identityMatches).toBe(false);
    expect(s.approved).toBe(true); // el binding NO contamina el eje de compliance
  });

  it("C5: vendor_data vacío ('') → identityMatches:false (NUNCA '' === '' → allow)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ status: "Approved", session_id: "v1", vendor_data: "" })),
    );
    const s = await new DiditKycProvider("k", MOCK_BASE_URL, "live").status("v1", "");
    expect(s.identityMatches).toBe(false);
  });

  it("C6: vendor_data distinto del claim → identityMatches:false (verificación ajena)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ status: "Approved", session_id: "v1", vendor_data: "12345678" }),
      ),
    );
    const s = await new DiditKycProvider("k", MOCK_BASE_URL, "live").status("v1", "99999999");
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
    const s = await new DiditKycProvider("k", MOCK_BASE_URL, "live").status("v1", "1234");
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
    const s = await new DiditKycProvider("k", MOCK_BASE_URL, "live").status("v1", "2345");
    expect(s.identityMatches).toBe(false); // con .includes() esto sería true
  });

  it("C7: vendor_data === claim → identityMatches:true (única rama que abre)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ status: "Approved", session_id: "v1", vendor_data: "12345678" }),
      ),
    );
    const s = await new DiditKycProvider("k", MOCK_BASE_URL, "live").status("v1", "12345678");
    expect(s.identityMatches).toBe(true);
  });

  // 🔴 C8 — el test que MATA al String()-guard del SDD: String(123) === "123" (NO "") → un
  // vendor_data:123 con claim "123" MATCHEARÍA = fail-open. El typeof-narrowing lo colapsa a "".
  it("C8: vendor_data:123 (number) con claim '123' → identityMatches:false (mata el String()-guard)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ status: "Approved", session_id: "v1", vendor_data: 123 })),
    );
    const s = await new DiditKycProvider("k", MOCK_BASE_URL, "live").status("v1", "123");
    expect(s.identityMatches).toBe(false);
  });

  it("C8: vendor_data:{} con claim '[object Object]' → identityMatches:false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ status: "Approved", session_id: "v1", vendor_data: {} })),
    );
    const s = await new DiditKycProvider("k", MOCK_BASE_URL, "live").status("v1", "[object Object]");
    expect(s.identityMatches).toBe(false);
  });

  it("C8: vendor_data null / array → identityMatches:false (no-string → '' → C5)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ status: "Approved", session_id: "v1", vendor_data: null })),
    );
    expect((await new DiditKycProvider("k", MOCK_BASE_URL, "live").status("v1", "12345678")).identityMatches).toBe(false);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ status: "Approved", session_id: "v1", vendor_data: ["12345678"] }),
      ),
    );
    expect((await new DiditKycProvider("k", MOCK_BASE_URL, "live").status("v1", "12345678")).identityMatches).toBe(false);
  });

  it("normalización: vendor_data '  12345678  ' vs claim '12345678' → identityMatches:true", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ status: "Approved", session_id: "v1", vendor_data: "  12345678  " }),
      ),
    );
    const s = await new DiditKycProvider("k", MOCK_BASE_URL, "live").status("v1", "12345678");
    expect(s.identityMatches).toBe(true);
  });

  it("normalización: address EVM case-insensitive (sirve a las 2 convenciones)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ status: "Approved", session_id: "v1", vendor_data: "0xAbCd" }),
      ),
    );
    const s = await new DiditKycProvider("k", MOCK_BASE_URL, "live").status("v1", "0xabcd");
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
    const s = await new DiditKycProvider("k", MOCK_BASE_URL, "live").status("v1", "12345678");
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
    const s = await new DiditKycProvider("k", MOCK_BASE_URL, "live").status("v1", "99999999");
    expect(s.reasons).toContain("identity_mismatch");
    expect(s.reasons).not.toContain("identity_no_binding");
  });

  it("C8: vendor_data de tipo inesperado → identity_no_binding (colapsa a '' → no hay binding)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ status: "Approved", session_id: "v1", vendor_data: 123 })),
    );
    const s = await new DiditKycProvider("k", MOCK_BASE_URL, "live").status("v1", "123");
    expect(s.reasons).toContain("identity_no_binding");
  });

  it("match → NINGÚN reason de identidad (los ejes no se contaminan)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ status: "Approved", session_id: "v1", vendor_data: "12345678" }),
      ),
    );
    const s = await new DiditKycProvider("k", MOCK_BASE_URL, "live").status("v1", "12345678");
    expect(s.reasons).toEqual([]);
  });

  // Los dos ejes son independientes: Declined Y no-bindeada → reasons de AMBOS ejes, concatenados.
  it("ejes independientes: Declined + sin binding → reasons de compliance Y de identidad", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ status: "Declined", session_id: "v1" })),
    );
    const s = await new DiditKycProvider("k", MOCK_BASE_URL, "live").status("v1", "12345678");
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
    const s = await new DiditKycProvider("k", MOCK_BASE_URL, "live").status("v1", "99999999");
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
    const s = await new DiditKycProvider("k", MOCK_BASE_URL, "live").status("v1", "12345678");
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
    const s = await new DiditKycProvider("k", MOCK_BASE_URL, "live").status("v1", "12345678");
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

// ── Shape de la respuesta EXTERNA de Didit en verify() (schema zod, ex-cast crudo) ─────────────
// (a) shape válido → mismo mapeo que antes; (b) campos extra del partner → sigue funcionando y la
// PII extra NO cruza el borde (el canario cubre el BORDE; el strip del schema agrega la garantía
// estructural de que el objeto parseado ni siquiera carga esos campos — CD-7); (c) shape inválido
// → degradación fail-closed EXPLÍCITA (warn + reason) en vez de silenciosa, y SIN throws nuevos.
describe("DiditKycProvider.verify — validación de shape de la respuesta del partner", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const stub = (body: unknown, status = 200) =>
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(body, status)));

  it("(a) Approved sin AML hits → approved true, riskLevel low, provenance didit, id del partner", async () => {
    stub({ status: "Approved", session_id: "s-1" });
    const r = await new DiditKycProvider("k", MOCK_BASE_URL, "live").verify(base);
    expect(r.approved).toBe(true);
    expect(r.riskLevel).toBe("low");
    expect(r.provenance).toBe("didit");
    expect(r.verificationId).toBe("s-1");
    expect(r.reasons).toEqual([]);
  });

  it("(a) Declined → approved false + reasons históricos INTACTOS", async () => {
    stub({ status: "Declined", session_id: "s-2" });
    const r = await new DiditKycProvider("k", MOCK_BASE_URL, "live").verify(base);
    expect(r.approved).toBe(false);
    expect(r.riskLevel).toBe("medium");
    expect(r.reasons).toEqual(["didit_status_declined", "aml_hits_0"]);
  });

  it("(a) AML hits (array) → approved false + riskLevel high + conteo en reasons", async () => {
    stub({ status: "Approved", session_id: "s-3", aml: { hits: [{ x: 1 }, { x: 2 }] } });
    const r = await new DiditKycProvider("k", MOCK_BASE_URL, "live").verify(base);
    expect(r.approved).toBe(false);
    expect(r.riskLevel).toBe("high");
    expect(r.reasons).toEqual(["didit_status_approved", "aml_hits_2"]);
  });

  it("(b) campos EXTRA del partner → sigue aprobando Y la PII del partner NO cruza el borde (CD-7)", async () => {
    stub({
      status: "Approved",
      session_id: "s-4",
      // PII que el endpoint de decisión de Didit devuelve y este repo tiene PROHIBIDO leer.
      // Los valores son distintos de los del input a propósito: lo único que puede aparecer en el
      // resultado es el Travel Rule armado con el INPUT, nunca el payload del partner.
      first_name: "PartnerGivenName",
      last_name: "PartnerFamilyName",
      document_number: "87654321",
      date_of_birth: "1990-01-01",
      id_verifications: [{ document_number: "87654321", portrait_image: "https://x/y.jpg" }],
      warnings: [{ risk: "OCR_MISMATCH" }],
    });
    const r = await new DiditKycProvider("k", MOCK_BASE_URL, "live").verify(base);
    expect(r.approved).toBe(true);
    expect(r.verificationId).toBe("s-4");
    const dump = JSON.stringify(r);
    expect(dump).not.toContain("87654321");
    expect(dump).not.toContain("PartnerGivenName");
    expect(dump).not.toContain("PartnerFamilyName");
    expect(dump).not.toContain("1990-01-01");
    expect(dump).not.toContain("portrait_image");
  });

  it("(b) session_id numérico → String() preservado", async () => {
    stub({ status: "Approved", session_id: 12345 });
    expect((await new DiditKycProvider("k", MOCK_BASE_URL, "live").verify(base)).verificationId).toBe("12345");
  });

  it("(b) sin session_id pero con id → usa id (cadena de nombres preservada)", async () => {
    stub({ status: "Approved", id: "alt-id" });
    expect((await new DiditKycProvider("k", MOCK_BASE_URL, "live").verify(base)).verificationId).toBe("alt-id");
  });

  it("(b) sin ningún id → 'unknown' (default histórico)", async () => {
    stub({ status: "Approved" });
    expect((await new DiditKycProvider("k", MOCK_BASE_URL, "live").verify(base)).verificationId).toBe("unknown");
  });

  it("(c) body null → NO lanza: approved false + didit_response_bad_shape (antes: TypeError crudo)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stub(null);
    const r = await new DiditKycProvider("k", MOCK_BASE_URL, "live").verify(base);
    expect(r.approved).toBe(false);
    expect(r.provenance).toBe("didit");
    expect(r.reasons).toContain("didit_response_bad_shape");
    expect(r.verificationId).toBe("unknown");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("didit_verify_bad_shape"));
  });

  it("(c) status de tipo inesperado (objeto) → fail-closed + reason de shape, sin throw", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stub({ status: { code: "approved" }, session_id: "s-5" });
    const r = await new DiditKycProvider("k", MOCK_BASE_URL, "live").verify(base);
    expect(r.approved).toBe(false); // NUNCA se lee un objeto como "approved"
    expect(r.reasons).toContain("didit_response_bad_shape");
    // los reasons históricos se AGREGAN, no se reemplazan (no se rompen consumidores)
    expect(r.reasons).toContain("aml_hits_0");
  });

  it("(c) body array → fail-closed + reason de shape", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stub([{ status: "Approved" }]);
    const r = await new DiditKycProvider("k", MOCK_BASE_URL, "live").verify(base);
    expect(r.approved).toBe(false);
    expect(r.reasons).toContain("didit_response_bad_shape");
  });

  it("(c) el reason de shape es una ETIQUETA value-free (CD-7: nunca el body del partner)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stub({ status: { nested: "Approved" }, document_number: "87654321", vendor_data: "12345678" });
    const r = await new DiditKycProvider("k", MOCK_BASE_URL, "live").verify(base);
    const dump = JSON.stringify(r.reasons);
    expect(dump).not.toContain("87654321");
    expect(dump).not.toContain("vendor_data");
    expect(dump).not.toContain("nested");
  });

  it("(c) shape válido → NO se emite el reason de shape (el discriminador no es ruido)", async () => {
    stub({ status: "Declined", session_id: "s-6" });
    const r = await new DiditKycProvider("k", MOCK_BASE_URL, "live").verify(base);
    expect(r.reasons).not.toContain("didit_response_bad_shape");
  });

  it("!res.ok → sigue lanzando didit_error_<n> (fail-closed intacto, nada cambió antes del parseo)", async () => {
    stub({}, 500);
    await expect(new DiditKycProvider("k", MOCK_BASE_URL, "live").verify(base)).rejects.toThrow(/didit_error_500/);
  });

  // 🔴 Guard de REGRESIÓN, no de deseo: `aml.hits` NO-array sigue contando 0 hits. Es el fail-open
  // latente que documenta el item 2 del TODO(sandbox) de status() — confirmar la forma real contra
  // el sandbox es founder-gated, así que este cambio (solo tipado) lo PRESERVA a propósito. Si
  // alguien lo endurece, este test se pone rojo y hay que ir a leer ese TODO.
  it("aml.hits no-array (number) → amlHits 0: comportamiento PRESERVADO (TODO(sandbox) item 2)", async () => {
    stub({ status: "Approved", session_id: "s-7", aml: { hits: 3 } });
    const r = await new DiditKycProvider("k", MOCK_BASE_URL, "live").verify(base);
    expect(r.approved).toBe(true); // fail-open latente, hoy inocuo tras DIDIT_ADAPTER_READY
    expect(r.reasons).toEqual([]);
  });

  it("aml null → amlHits 0 sin romper (nullish preservado)", async () => {
    stub({ status: "Approved", session_id: "s-8", aml: null });
    expect((await new DiditKycProvider("k", MOCK_BASE_URL, "live").verify(base)).approved).toBe(true);
  });
});

// ── Versión del endpoint que llama el adapter ──────────────────────────────────────────────────
// Fija 2026-08-04, después de que el agente publicado devolviera 502 en TODAS sus invocaciones:
// `verify()` creaba la sesión en `/v2/session/` (404 en el host configurado) mientras `status()`
// consultaba `/v3/session/{id}/decision/`. Ningún test miraba la URL, así que la suite entera
// pasaba con el agente caído en producción: los stubs de `fetch` responden igual a cualquier path.
// Estos dos tests son lo único que ata el código al host.
describe("DiditKycProvider — versión del endpoint (regresión 502 del 2026-08-04)", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** Devuelve la URL (string) del último `fetch` + el spy, para assertear el path exacto. */
  function stubFetch(body: unknown) {
    const spy = vi.fn(async () => jsonResponse(body));
    vi.stubGlobal("fetch", spy);
    return spy;
  }
  const urlOf = (spy: ReturnType<typeof stubFetch>, i = 0): string =>
    String((spy.mock.calls[i] as unknown[])[0]);

  it("verify() crea la sesión en POST {base}/v3/session/ (NO v2: el host responde 404)", async () => {
    const spy = stubFetch({ status: "Approved", session_id: "s-1" });
    await new DiditKycProvider("k", MOCK_BASE_URL, "live").verify(base);
    expect(urlOf(spy)).toBe(`${MOCK_BASE_URL}/v3/session/`);
    expect((spy.mock.calls[0] as unknown[])[1]).toMatchObject({ method: "POST" });
  });

  it("status() consulta GET {base}/v3/session/{id}/decision/", async () => {
    const spy = stubFetch({ status: "Approved", session_id: "v1", vendor_data: "12345678" });
    await new DiditKycProvider("k", MOCK_BASE_URL, "live").status("v1", "12345678");
    expect(urlOf(spy)).toBe(`${MOCK_BASE_URL}/v3/session/v1/decision/`);
  });

  // El invariante que el bug violaba: crear y consultar en la MISMA versión. Se compara una URL
  // contra la OTRA (no contra un literal repetido), así que mover cualquiera de las dos sola lo
  // pone rojo, en las dos direcciones.
  it("verify() y status() hablan la MISMA versión de la API (v2 en una sola era el bug)", async () => {
    const version = (u: string) => new URL(u).pathname.split("/").find((s) => /^v\d+$/.test(s));
    const spyV = stubFetch({ status: "Approved", session_id: "s-1" });
    await new DiditKycProvider("k", MOCK_BASE_URL, "live").verify(base);
    const verifyVersion = version(urlOf(spyV));
    vi.unstubAllGlobals();
    const spyS = stubFetch({ status: "Approved", session_id: "v1", vendor_data: "12345678" });
    await new DiditKycProvider("k", MOCK_BASE_URL, "live").status("v1", "12345678");
    expect(verifyVersion).toBeDefined();
    expect(verifyVersion).toBe(version(urlOf(spyS)));
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

  it("key + readiness + DIDIT_ENV → adapter Didit", () => {
    vi.stubEnv("DIDIT_API_KEY", "k");
    vi.stubEnv("DIDIT_ADAPTER_READY", "true");
    // El ambiente ahora se DECLARA (antes se adivinaba, y se adivinaba producción). Sin esto la
    // factory lanza didit_env_unset — ese caso lo cubre didit-env.test.ts.
    vi.stubEnv("DIDIT_ENV", "mock");
    vi.stubEnv("DIDIT_BASE_URL", "http://localhost:9999/didit-mock");
    expect(getKycProvider()).toBeInstanceOf(DiditKycProvider);
  });
});
