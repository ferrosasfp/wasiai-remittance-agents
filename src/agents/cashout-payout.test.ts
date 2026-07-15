import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest";
import { runCashoutPayout, CashoutPayoutInputSchema } from "./cashout-payout";
import { FallbackPayoutProvider } from "../providers/payout";

// NOTA: `kycPayoutAllowed: true` sigue en el fixture A PROPÓSITO (WKH-203/DT-4): prueba que el
// caller lo puede seguir mandando (compat, Zod lo strippea) y que YA NO abre nada.
const validInput = {
  quoteId: "q1",
  amountUsd: 100,
  kycVerificationId: "v1",
  kycPayoutAllowed: true,
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
    stubDiditDecision({ status: "Approved", session_id: "v1" });
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
    stubDiditDecision({ status: "Approved", session_id: "v1" });
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
