// src/manifest/settle-preconditions.test.ts
// TESTS DE DINERO. No afirman "se llamó a tal función" ni "el objeto tiene tal key": pasan el
// `payment` REALMENTE EMITIDO por el manifiesto por el oráculo que portea las guardas del gateway,
// y afirman el EFECTO. Un rojo acá se lee, sin abrir el código: "este agente cobraría cero, y por qué".
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildManifest } from "./build";
import { evaluateSettle, readPaymentSpecAccepts } from "./settle-preconditions";
import type { AgentPaymentSpec } from "./types";

// Fixtures de FORMATO (no son wallets reales — no usar en ningún runbook).
const EVM_OK = "0x1111111111111111111111111111111111111111";
const EVM_ZERO = "0x0000000000000000000000000000000000000000";
const SOL_OK = "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr";

const KYC_ENV = "REMIT_KYC_VALIDATOR_PAYTO";
const FX_ENV = "REMIT_CORRIDOR_FX_PAYTO";
const PAYOUT_ENV = "REMIT_CASHOUT_PAYOUT_PAYTO";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** Devuelve el `payment` realmente emitido por el manifiesto, o falla el test si no se emitió. */
function emittedPayment(pathSlug: string): AgentPaymentSpec {
  const result = buildManifest(pathSlug);
  if (!result.ok) {
    throw new Error(
      `el manifiesto de ${pathSlug} no se emitió (reason=${result.reason}): no hay payment que evaluar`,
    );
  }
  return result.manifest.payment;
}

// T2 — AC-1, AC-5
describe("¿cobra cada agente? — el payment emitido pasado por las guardas reales del gateway", () => {
  beforeEach(() => {
    vi.stubEnv(KYC_ENV, EVM_OK);
    vi.stubEnv(FX_ENV, SOL_OK);
    vi.stubEnv(PAYOUT_ENV, SOL_OK);
  });

  it("remit-kyc-validator COBRARÍA (WOULD_SETTLE) con su payTo Fuji configurado", () => {
    expect(evaluateSettle(emittedPayment("remit-kyc-validator"))).toBe("WOULD_SETTLE");
  });

  // T4 — AC-2, AC-5
  it("remit-corridor-fx-solana COBRARÍA (WOULD_SETTLE) con su payTo Solana configurado", () => {
    expect(evaluateSettle(emittedPayment("remit-corridor-fx"))).toBe("WOULD_SETTLE");
  });

  it("remit-cashout-payout-solana COBRARÍA (WOULD_SETTLE) con su payTo Solana configurado", () => {
    expect(evaluateSettle(emittedPayment("remit-cashout-payout"))).toBe("WOULD_SETTLE");
  });

  // T9 — AC-5
  it("el payment emitido sobrevive a la lectura de specs del consumidor (los 3 agentes)", () => {
    for (const pathSlug of ["remit-kyc-validator", "remit-corridor-fx", "remit-cashout-payout"]) {
      expect(readPaymentSpecAccepts({ payment: emittedPayment(pathSlug) })).toBe(true);
    }
  });

  it("ninguno de los 3 dispara un skip-code del leg downstream", () => {
    const verdicts = ["remit-kyc-validator", "remit-corridor-fx", "remit-cashout-payout"].map(
      (pathSlug) => evaluateSettle(emittedPayment(pathSlug)),
    );
    expect(verdicts).toEqual(["WOULD_SETTLE", "WOULD_SETTLE", "WOULD_SETTLE"]);
  });
});

// T11b — AC-6
describe("los valores que el manifiesto se niega a publicar son EXACTAMENTE los que no cobran", () => {
  it("la zero-address no se publica: cobraría $0 (ZERO_PAY_TO) para siempre", () => {
    // (a) el settle la rechazaría…
    expect(
      evaluateSettle({
        method: "x402",
        chain: "avalanche-fuji",
        contract: EVM_ZERO,
        asset: "USDC",
      }),
    ).toBe("ZERO_PAY_TO");
    // (b) …por eso el manifiesto no la emite.
    vi.stubEnv(KYC_ENV, EVM_ZERO);
    const result = buildManifest("remit-kyc-validator");
    expect(result.ok).toBe(false);
  });

  it("payTo de la familia equivocada: el agente cobraría $0 (INVALID_PAY_TO_FORMAT) — se rechaza en origen", () => {
    // EVM en un slot Solana
    expect(
      evaluateSettle({ method: "x402", chain: "solana-devnet", contract: EVM_OK, asset: "USDC" }),
    ).toBe("INVALID_PAY_TO_FORMAT");
    vi.stubEnv(FX_ENV, EVM_OK);
    expect(buildManifest("remit-corridor-fx").ok).toBe(false);

    // base58 en un slot EVM
    expect(
      evaluateSettle({ method: "x402", chain: "avalanche-fuji", contract: SOL_OK, asset: "USDC" }),
    ).toBe("INVALID_PAY_TO_FORMAT");
    vi.stubEnv(KYC_ENV, SOL_OK);
    expect(buildManifest("remit-kyc-validator").ok).toBe(false);
  });

  it("sin payTo no hay manifiesto, y un registro sin payment nunca paga (NO_PAYMENT_FIELD)", () => {
    vi.stubEnv(KYC_ENV, "");
    expect(buildManifest("remit-kyc-validator").ok).toBe(false);
    expect(evaluateSettle(undefined)).toBe("NO_PAYMENT_FIELD");
  });
});

// T17 — auto-test del ORÁCULO (valida el instrumento antes de creerle)
describe("auto-test del oráculo: cada guarda del gateway, en su orden exacto", () => {
  it("payment ausente ⇒ NO_PAYMENT_FIELD", () => {
    expect(evaluateSettle(undefined)).toBe("NO_PAYMENT_FIELD");
    expect(evaluateSettle(null)).toBe("NO_PAYMENT_FIELD");
    expect(evaluateSettle("x402")).toBe("NO_PAYMENT_FIELD");
    expect(evaluateSettle([])).toBe("NO_PAYMENT_FIELD");
    expect(evaluateSettle({})).toBe("NO_PAYMENT_FIELD");
  });

  it("campos presentes pero no-string ⇒ NO_PAYMENT_FIELD", () => {
    expect(
      evaluateSettle({ method: "x402", chain: "avalanche-fuji", contract: 123, asset: "USDC" }),
    ).toBe("NO_PAYMENT_FIELD");
    expect(evaluateSettle({ method: "x402", chain: null, contract: EVM_OK })).toBe(
      "NO_PAYMENT_FIELD",
    );
  });

  it("method con un espacio ('x402 ') ⇒ METHOD_NOT_SUPPORTED (comparación exacta, sin trim)", () => {
    expect(
      evaluateSettle({ method: "x402 ", chain: "avalanche-fuji", contract: EVM_OK, asset: "USDC" }),
    ).toBe("METHOD_NOT_SUPPORTED");
    expect(
      evaluateSettle({ method: "X402", chain: "avalanche-fuji", contract: EVM_OK, asset: "USDC" }),
    ).toBe("METHOD_NOT_SUPPORTED");
  });

  it("chain desconocida por el rail ⇒ CHAIN_NOT_SUPPORTED", () => {
    expect(
      evaluateSettle({ method: "x402", chain: "polygon", contract: EVM_OK, asset: "USDC" }),
    ).toBe("CHAIN_NOT_SUPPORTED");
  });

  it("contract vacío en una chain EVM ⇒ INVALID_PAY_TO_FORMAT", () => {
    expect(
      evaluateSettle({ method: "x402", chain: "avalanche-fuji", contract: "", asset: "USDC" }),
    ).toBe("INVALID_PAY_TO_FORMAT");
  });

  it("zero-address ⇒ ZERO_PAY_TO", () => {
    expect(
      evaluateSettle({
        method: "x402",
        chain: "avalanche-fuji",
        contract: EVM_ZERO,
        asset: "USDC",
      }),
    ).toBe("ZERO_PAY_TO");
  });

  it("caso completo válido (EVM y Solana) ⇒ WOULD_SETTLE", () => {
    expect(
      evaluateSettle({ method: "x402", chain: "avalanche-fuji", contract: EVM_OK, asset: "USDC" }),
    ).toBe("WOULD_SETTLE");
    expect(
      evaluateSettle({ method: "x402", chain: "solana-devnet", contract: SOL_OK, asset: "USDC" }),
    ).toBe("WOULD_SETTLE");
  });

  it("el orden de las guardas es el del gateway: method gana sobre chain, chain sobre contract", () => {
    // method malo + chain mala + contract malo ⇒ el primero que corta es METHOD_NOT_SUPPORTED
    expect(evaluateSettle({ method: "nope", chain: "polygon", contract: "" })).toBe(
      "METHOD_NOT_SUPPORTED",
    );
    // chain mala + contract malo ⇒ CHAIN_NOT_SUPPORTED
    expect(evaluateSettle({ method: "x402", chain: "polygon", contract: "" })).toBe(
      "CHAIN_NOT_SUPPORTED",
    );
  });

  it("readPaymentSpecAccepts: acepta protocol/chain de arriba, rechaza lo que el lector descarta", () => {
    expect(
      readPaymentSpecAccepts({
        payment: { method: "x402", chain: "avalanche-fuji", contract: EVM_OK },
      }),
    ).toBe(true);
    // `protocol` en vez de `method`
    expect(
      readPaymentSpecAccepts({
        payment: { protocol: "x402", chain: "solana-devnet", contract: SOL_OK },
      }),
    ).toBe(true);
    // chain en el nivel de arriba
    expect(
      readPaymentSpecAccepts({
        chain: "solana-devnet",
        payment: { method: "x402", contract: SOL_OK },
      }),
    ).toBe(true);
    // sin payment / sin contract / chain desconocida
    expect(readPaymentSpecAccepts({})).toBe(false);
    expect(readPaymentSpecAccepts({ payment: { method: "x402", chain: "avalanche-fuji" } })).toBe(
      false,
    );
    expect(
      readPaymentSpecAccepts({ payment: { method: "x402", chain: "polygon", contract: EVM_OK } }),
    ).toBe(false);
  });
});
