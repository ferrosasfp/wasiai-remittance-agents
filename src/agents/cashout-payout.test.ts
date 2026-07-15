import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest";
import { runCashoutPayout, CashoutPayoutInputSchema } from "./cashout-payout";
import { FallbackPayoutProvider } from "../providers/payout";
import { FallbackKycProvider } from "../providers/kyc";

// NOTA: `kycPayoutAllowed: true` sigue en el fixture A PROPÓSITO (WKH-203/DT-4): prueba que el
// caller lo puede seguir mandando (compat, Zod lo strippea) y que YA NO abre nada.
const validInput = {
  quoteId: "q1",
  amountUsd: 100,
  kycVerificationId: "v1",
  kycPayoutAllowed: true,
  // WKH-204: la identity claim del sender. Sin esto C3 bloquearía TODOS los tests del gate antes
  // de llegar a las ramas B — solo crece el ARRANGE, los asserts quedan intactos.
  senderIdentity: "12345678",
  beneficiary: { name: "Bob", country: "PE", method: "yape", destination: "999999999" },
  idempotencyKey: "idem-1",
};

/** fetch mockeado con la decisión de Didit (el gate consulta GET /v3/session/{id}/decision/). */
function stubDiditDecision(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
  );
}

// WKH-203 — el input NO decide compliance: la decisión se re-deriva server-side.
// Reemplaza al viejo describe "hard-gate KYC" (que testeaba el booleano del caller, hoy strippeado).
describe("runCashoutPayout — gate KYC server-side (WKH-203)", () => {
  let executeSpy: MockInstance;

  beforeEach(() => {
    // Spy sobre el provider REAL (no lo reemplaza): permite assertear que execute() es
    // INALCANZABLE salvo en B1/B5, sin alterar el comportamiento del path feliz.
    executeSpy = vi.spyOn(FallbackPayoutProvider.prototype, "execute");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  // AC-1 / B3: en prod el KYC fallback (no confirmable) NUNCA abre — ninguna env puede abrirlo.
  it("AC-1/B3: PROD + KYC no confirmable → blocked y NUNCA ejecuta el payout", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TRANSFI_API_KEY", "");
    vi.stubEnv("PAYOUT_ALLOW_MOCK", "true"); // el fail-safe de payout NO es lo que bloquea acá
    vi.stubEnv("DIDIT_API_KEY", ""); // → FallbackKycProvider → provenance local-fallback
    vi.stubEnv("ALLOW_FALLBACK_KYC", "true"); // B3: ni siquiera el opt-in abre en producción
    const out = await runCashoutPayout(validInput);
    expect(out.executed).toBe(false);
    expect(out.status).toBe("blocked");
    expect(out.reason).toBe("kyc_gate_not_passed");
    expect(out.provenance).toBe("n/a");
    expect(executeSpy).not.toHaveBeenCalled();
  });

  // AC-2: el bypass original de la HU — mandar el booleano en true ya no alcanza.
  it("AC-2: kycPayoutAllowed:true del caller NO abre el gate (bypass trust-the-caller cerrado)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TRANSFI_API_KEY", "");
    vi.stubEnv("PAYOUT_ALLOW_MOCK", "true");
    vi.stubEnv("DIDIT_API_KEY", "");
    // el `kycPayoutAllowed: true` que ejercita este AC ya viene en el fixture `validInput`.
    const out = await runCashoutPayout(validInput);
    expect(out.executed).toBe(false);
    expect(out.status).toBe("blocked");
    expect(out.reason).toBe("kyc_gate_not_passed");
    expect(executeSpy).not.toHaveBeenCalled();
  });

  // AC-3a: la fuente autoritativa manda SOBRE el input (input false + Didit Approved → ejecuta).
  it("AC-3a: Didit Approved + input kycPayoutAllowed:false → EJECUTA (manda el server, no el input)", async () => {
    vi.stubEnv("TRANSFI_API_KEY", "");
    vi.stubEnv("ALLOW_FALLBACK_PAYOUT", "true"); // NODE_ENV="test" → rama dev del fail-safe de payout
    vi.stubEnv("DIDIT_API_KEY", "k");
    vi.stubEnv("DIDIT_ADAPTER_READY", "true");
    // WKH-204: el vendor_data debe matchear el senderIdentity del fixture (C7), si no C11 bloquea.
    stubDiditDecision({ status: "Approved", session_id: "v1", vendor_data: "12345678" });
    const out = await runCashoutPayout({ ...validInput, kycPayoutAllowed: false });
    expect(out.executed).toBe(true);
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });

  // AC-3b / B2: idem al revés (input true + Didit Declined → bloquea).
  it("AC-3b/B2: Didit Declined + input kycPayoutAllowed:true → blocked, sin ejecutar", async () => {
    vi.stubEnv("TRANSFI_API_KEY", "");
    vi.stubEnv("ALLOW_FALLBACK_PAYOUT", "true");
    vi.stubEnv("DIDIT_API_KEY", "k");
    vi.stubEnv("DIDIT_ADAPTER_READY", "true");
    stubDiditDecision({ status: "Declined", session_id: "v1" });
    const out = await runCashoutPayout({ ...validInput, kycPayoutAllowed: true });
    expect(out.executed).toBe(false);
    expect(out.status).toBe("blocked");
    expect(out.reason).toBe("kyc_gate_not_passed");
    expect(executeSpy).not.toHaveBeenCalled();
  });

  // B4: sin opt-in explícito el fallback tampoco abre en dev.
  it("B4: dev + KYC fallback SIN ALLOW_FALLBACK_KYC → blocked (default = bloquear)", async () => {
    vi.stubEnv("TRANSFI_API_KEY", "");
    vi.stubEnv("ALLOW_FALLBACK_PAYOUT", "true");
    vi.stubEnv("DIDIT_API_KEY", "");
    vi.stubEnv("ALLOW_FALLBACK_KYC", "");
    const out = await runCashoutPayout(validInput);
    expect(out.executed).toBe(false);
    expect(out.status).toBe("blocked");
    expect(executeSpy).not.toHaveBeenCalled();
  });

  // B6 — el anti-fail-open explícito: "no sé" ≠ "aprobado".
  it("B6: partner KYC caído → kyc_gate_unavailable (NO se asume aprobado), sin ejecutar", async () => {
    vi.stubEnv("TRANSFI_API_KEY", "");
    vi.stubEnv("ALLOW_FALLBACK_PAYOUT", "true");
    vi.stubEnv("DIDIT_API_KEY", "k");
    vi.stubEnv("DIDIT_ADAPTER_READY", "true");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network_down");
      }),
    );
    await expect(runCashoutPayout(validInput)).rejects.toThrow(/kyc_gate_unavailable/);
    expect(executeSpy).not.toHaveBeenCalled();
  });

  // B7 (CD-12): key sin readiness = fail-loud, NUNCA downgrade silencioso al fallback.
  it("B7: DIDIT key sin readiness → propaga didit_adapter_not_ready, sin ejecutar", async () => {
    vi.stubEnv("TRANSFI_API_KEY", "");
    vi.stubEnv("ALLOW_FALLBACK_PAYOUT", "true");
    vi.stubEnv("DIDIT_API_KEY", "k");
    vi.stubEnv("DIDIT_ADAPTER_READY", "");
    await expect(runCashoutPayout(validInput)).rejects.toThrow(/didit_adapter_not_ready/);
    expect(executeSpy).not.toHaveBeenCalled();
  });
});

// WKH-204 — el binding de identidad a nivel agente: la verificación debe ser DEL que pide el payout.
describe("runCashoutPayout — identity binding (WKH-204/C1-C4, C11, C12)", () => {
  let executeSpy: MockInstance;

  beforeEach(() => {
    executeSpy = vi.spyOn(FallbackPayoutProvider.prototype, "execute");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  /** arrange: payout fail-safe en rama dev + KYC Didit real activo (NODE_ENV="test" en vitest). */
  function stubDevPayoutAndDidit() {
    vi.stubEnv("TRANSFI_API_KEY", "");
    vi.stubEnv("ALLOW_FALLBACK_PAYOUT", "true");
    vi.stubEnv("DIDIT_API_KEY", "k");
    vi.stubEnv("DIDIT_ADAPTER_READY", "true");
  }

  // AC-1: EL ATAQUE DE LA HU — un kycVerificationId APROBADO pero de OTRA persona.
  it("AC-1/C6/C11: verificación aprobada AJENA (claim ≠ vendor_data) → blocked, NUNCA ejecuta", async () => {
    stubDevPayoutAndDidit();
    stubDiditDecision({ status: "Approved", session_id: "v1", vendor_data: "12345678" });
    const out = await runCashoutPayout({ ...validInput, senderIdentity: "99999999" });
    expect(out.executed).toBe(false);
    expect(out.status).toBe("blocked");
    // DT-3: colapsa al mismo reason que "no aprobado" — no-oracle (no confirma DNIs de a uno).
    expect(out.reason).toBe("kyc_gate_not_passed");
    expect(executeSpy).not.toHaveBeenCalled();
  });

  // 🔴 AC-1 — el mismo ataque pero con un claim PREFIJO de un DNI ajeno. Es la variante que el C6
  // "99999999" NO cubre (misma longitud, sin relación de prefijo): si la comparación del provider se
  // "flexibilizara" a startsWith/includes, un claim "1234" cobraría la verificación de "12345678".
  // Este test lo mata a nivel agente, no solo a nivel provider (defensa en profundidad).
  it("AC-1/C6/C11: claim PREFIJO de un vendor_data ajeno ('1234' de '12345678') → blocked, NUNCA ejecuta", async () => {
    stubDevPayoutAndDidit();
    stubDiditDecision({ status: "Approved", session_id: "v1", vendor_data: "12345678" });
    const out = await runCashoutPayout({ ...validInput, senderIdentity: "1234" });
    expect(out.executed).toBe(false);
    expect(out.status).toBe("blocked");
    expect(out.reason).toBe("kyc_gate_not_passed");
    expect(executeSpy).not.toHaveBeenCalled();
  });

  // AC-1 (el reverso): el gate NO bloquea de más — el dueño legítimo pasa.
  it("AC-1/C7/B1: el claim SÍ matchea + provenance didit → EJECUTA (no bloquea de más)", async () => {
    stubDevPayoutAndDidit();
    stubDiditDecision({ status: "Approved", session_id: "v1", vendor_data: "12345678" });
    const out = await runCashoutPayout(validInput);
    expect(out.executed).toBe(true);
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });

  // C3: sin claim no se llama al provider — no se gasta Didit ni se le da señal al caller.
  it("AC-2/C3: sin senderIdentity ni address → blocked kyc_identity_claim_missing, fetch NUNCA llamado", async () => {
    stubDevPayoutAndDidit();
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ status: "Approved", session_id: "v1", vendor_data: "12345678" }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const { senderIdentity: _omit, ...noClaim } = validInput;
    const out = await runCashoutPayout(noClaim);
    expect(out.executed).toBe(false);
    expect(out.status).toBe("blocked");
    expect(out.reason).toBe("kyc_identity_claim_missing");
    expect(out.provenance).toBe("n/a");
    expect(fetchSpy).not.toHaveBeenCalled(); // C3 bloquea ANTES del provider
    expect(executeSpy).not.toHaveBeenCalled();
  });

  // 🔴 C4: el caso que min(1) DEJA PASAR (zod no trimea) — sin esta rama, "" === "" sería fail-open.
  it("AC-2/C4: senderIdentity '   ' (whitespace, atraviesa min(1)) → blocked kyc_identity_claim_missing", async () => {
    stubDevPayoutAndDidit();
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ status: "Approved", session_id: "v1", vendor_data: "" }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const out = await runCashoutPayout({ ...validInput, senderIdentity: "   " });
    expect(out.executed).toBe(false);
    expect(out.reason).toBe("kyc_identity_claim_missing");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(executeSpy).not.toHaveBeenCalled();
  });

  // C5 a nivel agente: Didit aprueba pero no hay vendor_data contra qué comparar → bloquear.
  it("AC-2/C5: Approved SIN vendor_data → blocked (no hay contra qué comparar), sin ejecutar", async () => {
    stubDevPayoutAndDidit();
    stubDiditDecision({ status: "Approved", session_id: "v1" });
    const out = await runCashoutPayout(validInput);
    expect(out.executed).toBe(false);
    expect(out.status).toBe("blocked");
    expect(out.reason).toBe("kyc_gate_not_passed");
    expect(executeSpy).not.toHaveBeenCalled();
  });

  // C12/B6: el provider lanza al resolver → "no sé" ≠ "es tuyo".
  it("AC-2/C12: status() lanza → kyc_gate_unavailable (no allow), sin ejecutar", async () => {
    stubDevPayoutAndDidit();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network_down");
      }),
    );
    await expect(runCashoutPayout(validInput)).rejects.toThrow(/kyc_gate_unavailable/);
    expect(executeSpy).not.toHaveBeenCalled();
  });

  // 🔴 CD-8 / anti-WKH-198: C11 es `!== true` ESTRICTO, no truthiness. Este test es el que mata al
  // mutante `!s.identityMatches`. Es alcanzable de verdad: FallbackKycProvider.status() devuelve un
  // object literal que NO pasa por assertValidKycStatus (kyc.ts), así que el guard C10 no lo cubre y
  // el `!== true` del gate es la ÚLTIMA línea de defensa. Un identityMatches truthy-no-booleano
  // (1, "yes", {}) NUNCA puede leerse como "la identidad matchea".
  it("CD-8/C11: identityMatches truthy pero NO booleano (1) → blocked (estricto, no truthiness)", async () => {
    vi.stubEnv("TRANSFI_API_KEY", "");
    vi.stubEnv("ALLOW_FALLBACK_PAYOUT", "true");
    vi.stubEnv("DIDIT_API_KEY", ""); // → FallbackKycProvider
    vi.stubEnv("ALLOW_FALLBACK_KYC", "true");
    // spyOn(prototype) — NO vi.mock (hoisted → falso verde; auto-blindaje WKH-203).
    vi.spyOn(FallbackKycProvider.prototype, "status").mockResolvedValue({
      approved: true,
      verificationId: "v1",
      provenance: "didit", // en la allowlist → B1 abriría si C11 no bloquea
      identityMatches: 1 as unknown as boolean, // truthy, NO booleano
      reasons: [],
    });
    const out = await runCashoutPayout(validInput);
    expect(out.executed).toBe(false);
    expect(out.status).toBe("blocked");
    expect(out.reason).toBe("kyc_gate_not_passed");
    expect(executeSpy).not.toHaveBeenCalled();
  });

  // Espejo del anterior sobre el eje `approved` (WKH-203/CD-8) — la misma clase de bug.
  it("CD-8/B2: approved truthy pero NO booleano (1) → blocked (no baja el nº de mutantes muertos)", async () => {
    vi.stubEnv("TRANSFI_API_KEY", "");
    vi.stubEnv("ALLOW_FALLBACK_PAYOUT", "true");
    vi.stubEnv("DIDIT_API_KEY", "");
    vi.stubEnv("ALLOW_FALLBACK_KYC", "true");
    vi.spyOn(FallbackKycProvider.prototype, "status").mockResolvedValue({
      approved: 1 as unknown as boolean, // truthy, NO booleano
      verificationId: "v1",
      provenance: "didit",
      identityMatches: true,
      reasons: [],
    });
    const out = await runCashoutPayout(validInput);
    expect(out.executed).toBe(false);
    expect(out.reason).toBe("kyc_gate_not_passed");
    expect(executeSpy).not.toHaveBeenCalled();
  });

  // fix-pack / R-5 — el warn de C11 tiene que DISCRIMINAR. Antes emitía `identityClaimPresent:true`
  // (tautología: C11 es inalcanzable sin claim resuelto) igual para C5 que para C6, dejando a ops
  // ciego ante el riesgo top de la HU: si Didit NO ecoa vendor_data, el binding bloquea TODO en prod
  // y la avalancha de warns es indistinguible de un ataque real.
  describe("C11 — warn value-free y discriminante (R-5 / CD-4 / CD-13)", () => {
    /** captura el objeto que C11 le pasa a console.warn. */
    function captureC11Warn() {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      return () =>
        warn.mock.calls.find((c) => String(c[0]).includes("identity binding mismatch"))?.[1] as
          | Record<string, unknown>
          | undefined;
    }

    it("C5 (Didit NO ecoa vendor_data) → warn con identity_no_binding = falla de INTEGRACIÓN (R-5)", async () => {
      stubDevPayoutAndDidit();
      const getWarn = captureC11Warn();
      stubDiditDecision({ status: "Approved", session_id: "v1" }); // sin vendor_data
      await runCashoutPayout(validInput);
      expect(getWarn()).toMatchObject({
        branch: "C11",
        claimSource: "senderIdentity",
        reasons: ["identity_no_binding"],
      });
    });

    it("C6 (claim ajeno) → warn con identity_mismatch = ATAQUE (distinguible de C5)", async () => {
      stubDevPayoutAndDidit();
      const getWarn = captureC11Warn();
      stubDiditDecision({ status: "Approved", session_id: "v1", vendor_data: "12345678" });
      await runCashoutPayout({ ...validInput, senderIdentity: "99999999" });
      expect(getWarn()).toMatchObject({
        branch: "C11",
        claimSource: "senderIdentity",
        reasons: ["identity_mismatch"],
      });
    });

    // claimSource SÍ es dinámico (a diferencia del tautológico identityClaimPresent:true): permite
    // diagnosticar cuánto tráfico sigue entrando por el puente legado de chaski-v2 (CD-16).
    it("caller legado (`address`) → claimSource:'address' (el campo discrimina de verdad)", async () => {
      stubDevPayoutAndDidit();
      const getWarn = captureC11Warn();
      stubDiditDecision({ status: "Approved", session_id: "v1", vendor_data: "12345678" });
      const { senderIdentity: _omit, ...legacy } = validInput;
      await runCashoutPayout({ ...legacy, address: "99999999" });
      expect(getWarn()).toMatchObject({ claimSource: "address", reasons: ["identity_mismatch"] });
    });

    // 🔴 CD-4/CD-7 — el warn es la superficie MÁS riesgosa del fix-pack: es lo único que ve el
    // vendor_data y el claim en el mismo scope. Ni el DNI de la verificación ni el claim del caller
    // pueden aparecer en el log, ni siquiera parcialmente.
    it("CD-4/CD-7: el warn NUNCA contiene el claim, el vendor_data ni el verificationId", async () => {
      stubDevPayoutAndDidit();
      const getWarn = captureC11Warn();
      stubDiditDecision({ status: "Approved", session_id: "v1", vendor_data: "12345678" });
      await runCashoutPayout({ ...validInput, senderIdentity: "99999999" });
      const dump = JSON.stringify(getWarn());
      expect(dump).not.toContain("12345678"); // vendor_data (DNI real de la verificación)
      expect(dump).not.toContain("99999999"); // el claim que mandó el caller
      expect(dump).not.toContain("vendor_data");
      // MNR-2 (re-AR): este assert FALTABA — el nombre del test prometía cubrir el verificationId
      // y no lo cubría (agregar `verificationId` al warn dejaba la suite en verde). Hoy el handle
      // de sesión no es PII, pero en un log es ruido innecesario del lado equivocado del borde.
      expect(dump).not.toContain("v1"); // el verificationId de la verificación
    });

    // DT-3 / no-oracle: el discriminador es SOLO para ops (log). El caller sigue viendo el reason
    // colapsado `kyc_gate_not_passed`: si `reasons` se filtrara al response, el agente se volvería un
    // oráculo que confirma DNIs de a uno ("¿este DNI es el de esta verificación?").
    it("DT-3: los reasons NO llegan al response (el caller no distingue C5 de C6 — no-oracle)", async () => {
      stubDevPayoutAndDidit();
      vi.spyOn(console, "warn").mockImplementation(() => {});
      stubDiditDecision({ status: "Approved", session_id: "v1", vendor_data: "12345678" });
      const out = await runCashoutPayout({ ...validInput, senderIdentity: "99999999" });
      expect(out.reason).toBe("kyc_gate_not_passed");
      const dump = JSON.stringify(out);
      expect(dump).not.toContain("identity_mismatch");
      expect(dump).not.toContain("identity_no_binding");
      expect(dump).not.toContain("12345678");
    });
  });

  // AC-5 / C2 / CD-16: el puente legado — chaski-v2 manda `address`, no `senderIdentity`.
  it("AC-5/C2: caller legado con `address` y sin senderIdentity → usa address y ejecuta (NO 400)", async () => {
    stubDevPayoutAndDidit();
    stubDiditDecision({ status: "Approved", session_id: "v1", vendor_data: "12345678" });
    const { senderIdentity: _omit, ...legacy } = validInput;
    const out = await runCashoutPayout({ ...legacy, address: "12345678" });
    expect(out.executed).toBe(true);
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });

  // AC-5 / CD-15: precedencia determinística — gana el explícito, sin rama "ambiguo".
  it("AC-5/CD-15: senderIdentity y address distintos → GANA senderIdentity", async () => {
    stubDevPayoutAndDidit();
    stubDiditDecision({ status: "Approved", session_id: "v1", vendor_data: "12345678" });
    const out = await runCashoutPayout({
      ...validInput,
      senderIdentity: "12345678",
      address: "99999999",
    });
    expect(out.executed).toBe(true); // matcheó por senderIdentity, no por address
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });

  it("AC-5/CD-15: gana senderIdentity aunque el address SÍ matchee el vendor_data", async () => {
    stubDevPayoutAndDidit();
    stubDiditDecision({ status: "Approved", session_id: "v1", vendor_data: "99999999" });
    const out = await runCashoutPayout({
      ...validInput,
      senderIdentity: "12345678", // no matchea
      address: "99999999", // matchea, pero NO se usa: gana el explícito
    });
    expect(out.executed).toBe(false);
    expect(out.reason).toBe("kyc_gate_not_passed");
    expect(executeSpy).not.toHaveBeenCalled();
  });
});

// AC-5: el schema acepta el campo legado sin romperse (compat chaski-v2).
describe("CashoutPayoutInputSchema — senderIdentity / address (WKH-204)", () => {
  it("AC-5: `address` en el raw → parsea OK (compat chaski-v2, no rompe el schema)", () => {
    const { senderIdentity: _omit, ...legacy } = validInput;
    const parsed = CashoutPayoutInputSchema.safeParse({ ...legacy, address: "0xAbC" });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.address).toBe("0xAbC");
  });

  it("CD-11: senderIdentity es string opaco — el 400 de un no-string NO ecoa el valor (anti-PII)", () => {
    const parsed = CashoutPayoutInputSchema.safeParse({
      ...validInput,
      senderIdentity: 12345678, // un DNI como number
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    // z.string() es value-free ("Expected string, received number"); z.enum ecoaría el valor.
    expect(JSON.stringify(parsed.error.flatten())).not.toContain("12345678");
  });
});

// AC-6 (DT-4): compat con los callers que siguen mandando el booleano (ej. chaski-v2).
describe("CashoutPayoutInputSchema — kycPayoutAllowed eliminado (WKH-203/DT-4)", () => {
  it("AC-6: kycPayoutAllowed en el raw → parsea OK (no-400) pero se STRIPPEA (no llega al core)", () => {
    const parsed = CashoutPayoutInputSchema.safeParse({ ...validInput, kycPayoutAllowed: true });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect("kycPayoutAllowed" in parsed.data).toBe(false);
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
    // WKH-203: el gate KYC nuevo corre acá; en dev el fallback exige opt-in explícito (rama B5).
    // Solo crece el ARRANGE — los asserts de abajo son los originales, intactos.
    vi.stubEnv("ALLOW_FALLBACK_KYC", "true");
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
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("PROD + PAYOUT_ALLOW_MOCK → ejecuta mock (no mueve plata)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TRANSFI_API_KEY", "");
    vi.stubEnv("PAYOUT_ALLOW_MOCK", "true");
    // WKH-203: en PROD el gate KYC solo abre con una verificación REAL aprobada (rama B1) — el
    // fallback jamás abre en prod (B3). Solo crece el ARRANGE: los asserts son los originales.
    vi.stubEnv("DIDIT_API_KEY", "k");
    vi.stubEnv("DIDIT_ADAPTER_READY", "true");
    // WKH-204: el vendor_data debe matchear el senderIdentity del fixture (C7), si no C11 bloquea.
    stubDiditDecision({ status: "Approved", session_id: "v1", vendor_data: "12345678" });
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
