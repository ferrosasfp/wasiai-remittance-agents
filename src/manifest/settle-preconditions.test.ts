// src/manifest/settle-preconditions.test.ts
// TESTS DE DINERO. No afirman "se llamó a tal función" ni "el objeto tiene tal key": pasan el
// `payment` REALMENTE EMITIDO por el manifiesto por el oráculo que portea las guardas del gateway,
// y afirman el EFECTO. Un rojo acá se lee, sin abrir el código: "este agente cobraría cero, y por qué".
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildManifest } from "./build";
import {
  evaluateSettle,
  readPaymentSpecAccepts,
  PROD_INITIALIZED_CHAINS,
} from "./settle-preconditions";
import type { AgentPaymentSpec } from "./types";

// Fixtures de FORMATO (no son wallets reales — no usar en ningún runbook).
const EVM_OK = "0x1111111111111111111111111111111111111111";
const EVM_ZERO = "0x0000000000000000000000000000000000000000";
const SOL_OK = "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr";

// Config de gateway que asumen los tests de guardas NO relacionadas con la chain: las 2 chains
// declarables, prendidas. Es explícita a propósito (fix-pack AR MNR-6): `evaluateSettle` ya no tiene
// default, así que cada aserción NOMBRA el rail bajo el que vale.
const AMBAS_PRENDIDAS: readonly string[] = ["avalanche-fuji", "solana-devnet"];

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
// TODA afirmación de "cobra" de este bloque está CONDICIONADA al set de chains inicializadas que
// se le pasa al oráculo. Sin esa condición explícita el título mentiría en cualquier entorno con
// `SOLANA_ADAPTER_ENABLED` apagado (BLQ-1 del AR).
describe("¿cobra cada agente? — el payment emitido pasado por las guardas reales del gateway", () => {
  beforeEach(() => {
    vi.stubEnv(KYC_ENV, EVM_OK);
    vi.stubEnv(FX_ENV, SOL_OK);
    vi.stubEnv(PAYOUT_ENV, SOL_OK);
  });

  it("remit-kyc-validator COBRARÍA (WOULD_SETTLE) con su payTo Fuji y avalanche-fuji inicializada", () => {
    expect(evaluateSettle(emittedPayment("remit-kyc-validator"), ["avalanche-fuji"])).toBe(
      "WOULD_SETTLE",
    );
  });

  // T4 — AC-2, AC-5
  it("remit-corridor-fx-solana COBRARÍA (WOULD_SETTLE) SÓLO si el gateway tiene solana-devnet inicializada", () => {
    expect(evaluateSettle(emittedPayment("remit-corridor-fx"), ["solana-devnet"])).toBe(
      "WOULD_SETTLE",
    );
  });

  it("remit-cashout-payout-solana COBRARÍA (WOULD_SETTLE) SÓLO si el gateway tiene solana-devnet inicializada", () => {
    expect(evaluateSettle(emittedPayment("remit-cashout-payout"), ["solana-devnet"])).toBe(
      "WOULD_SETTLE",
    );
  });

  // T9 — AC-5
  it("el payment emitido sobrevive a la lectura de specs del consumidor (los 3 agentes)", () => {
    for (const pathSlug of ["remit-kyc-validator", "remit-corridor-fx", "remit-cashout-payout"]) {
      expect(readPaymentSpecAccepts({ payment: emittedPayment(pathSlug) })).toBe(true);
    }
  });

  it("con el rail que prod tiene prendido HOY, ninguno de los 3 dispara un skip-code", () => {
    const verdicts = ["remit-kyc-validator", "remit-corridor-fx", "remit-cashout-payout"].map(
      (pathSlug) => evaluateSettle(emittedPayment(pathSlug), PROD_INITIALIZED_CHAINS),
    );
    expect(verdicts).toEqual(["WOULD_SETTLE", "WOULD_SETTLE", "WOULD_SETTLE"]);
  });
});

// FIX-PACK AR BLQ-1 — la segunda mitad de la guarda `if (!chainKey || !bundle)`.
// El rail Solana está flag-gated y default OFF en el gateway (`SOLANA_ADAPTER_ENABLED`), así que
// "el manifiesto está bien" y "el agente cobra" son afirmaciones DISTINTAS.
describe("el rail tiene que estar PRENDIDO: chain no inicializada ⇒ el agente no cobra", () => {
  beforeEach(() => {
    vi.stubEnv(KYC_ENV, EVM_OK);
    vi.stubEnv(FX_ENV, SOL_OK);
    vi.stubEnv(PAYOUT_ENV, SOL_OK);
  });

  it("gateway SIN solana-devnet inicializada: los 2 agentes Solana cobran $0 (CHAIN_NOT_SUPPORTED)", () => {
    const sinSolana = ["avalanche-fuji"]; // entorno con SOLANA_ADAPTER_ENABLED != 'true'
    expect(evaluateSettle(emittedPayment("remit-corridor-fx"), sinSolana)).toBe(
      "CHAIN_NOT_SUPPORTED",
    );
    expect(evaluateSettle(emittedPayment("remit-cashout-payout"), sinSolana)).toBe(
      "CHAIN_NOT_SUPPORTED",
    );
    // …y el corte es POR CHAIN, no un apagón global: el de Fuji sigue cobrando.
    expect(evaluateSettle(emittedPayment("remit-kyc-validator"), sinSolana)).toBe("WOULD_SETTLE");
  });

  it("el manifiesto se emite igual: un 200 NO prueba que el rail de cobro esté prendido", () => {
    // El mismo `payment`, byte por byte, cobra o no cobra según la config del gateway.
    const fx = emittedPayment("remit-corridor-fx");
    expect(evaluateSettle(fx, ["avalanche-fuji", "solana-devnet"])).toBe("WOULD_SETTLE");
    expect(evaluateSettle(fx, ["avalanche-fuji"])).toBe("CHAIN_NOT_SUPPORTED");
    expect(evaluateSettle(fx, [])).toBe("CHAIN_NOT_SUPPORTED");
  });

  it("chain conocida por el resolver pero sin bundle ⇒ CHAIN_NOT_SUPPORTED (las 2 familias)", () => {
    expect(
      evaluateSettle({ method: "x402", chain: "avalanche-fuji", contract: EVM_OK, asset: "USDC" }, [
        "solana-devnet",
      ]),
    ).toBe("CHAIN_NOT_SUPPORTED");
    expect(
      evaluateSettle({ method: "x402", chain: "solana-devnet", contract: SOL_OK, asset: "USDC" }, [
        "avalanche-fuji",
      ]),
    ).toBe("CHAIN_NOT_SUPPORTED");
  });

  it("la constante de rail medido declara EXACTAMENTE lo que prod tenía prendido al medirlo", () => {
    // Medición: GET /capabilities del gateway de prod, 2026-07-29 → chains[].key incluye
    // avalanche-fuji y solana-devnet (más kite-ozone-testnet y base-sepolia, que este repo no
    // declara). Si alguien la cambia sin volver a medir, este test se pone rojo.
    expect([...PROD_INITIALIZED_CHAINS].sort()).toEqual(["avalanche-fuji", "solana-devnet"]);
  });

  // FIX-PACK AR MNR-6 — el test de arriba fija el CONTENIDO de la constante, no que sea el valor
  // por defecto de nadie. Con un default, cambiarlo (dejando la constante intacta) dejaba todo en
  // verde: la misma forma del bloqueante BLQ-1, en la firma. Se eliminó la clase entera sacando el
  // default; esta aserción existe para que REPONERLO se ponga rojo (un parámetro con default no
  // cuenta en `Function.length`).
  it("evaluateSettle NO tiene valor por defecto: la config del gateway se nombra en cada llamada", () => {
    expect(evaluateSettle.length).toBe(2);
  });

  // FIX-PACK AR MNR-7 — el módulo declara que "el orden ES el contrato" (settle-preconditions.ts:58);
  // sin esta aserción esa declaración es prosa: mover la guarda de inicialización debajo de los
  // chequeos de formato dejaba los 158 en verde. No cambia la plata (no cobra en ninguno de los dos
  // casos), cambia el DIAGNÓSTICO: el operador iría a arreglar la address en vez de prender el rail.
  it("chain no inicializada gana sobre payTo malformado: el skip-code es el de CHAIN, no el de formato", () => {
    // Solana apagada + contract vacío (dos violaciones a la vez) ⇒ manda la chain.
    expect(
      evaluateSettle({ method: "x402", chain: "solana-devnet", contract: "", asset: "USDC" }, [
        "avalanche-fuji",
      ]),
    ).toBe("CHAIN_NOT_SUPPORTED");
    // Misma prueba en la familia EVM, donde además está el chequeo de zero-address.
    expect(
      evaluateSettle({ method: "x402", chain: "avalanche-fuji", contract: "", asset: "USDC" }, [
        "solana-devnet",
      ]),
    ).toBe("CHAIN_NOT_SUPPORTED");
    expect(
      evaluateSettle({ method: "x402", chain: "avalanche-fuji", contract: EVM_ZERO, asset: "USDC" }, [
        "solana-devnet",
      ]),
    ).toBe("CHAIN_NOT_SUPPORTED");
    // Control: con la chain PRENDIDA, esos mismos payments sí reportan el problema de formato.
    expect(
      evaluateSettle({ method: "x402", chain: "solana-devnet", contract: "", asset: "USDC" }, [
        "solana-devnet",
      ]),
    ).toBe("INVALID_PAY_TO_FORMAT");
    expect(
      evaluateSettle({ method: "x402", chain: "avalanche-fuji", contract: EVM_ZERO, asset: "USDC" }, [
        "avalanche-fuji",
      ]),
    ).toBe("ZERO_PAY_TO");
  });
});

// T11b — AC-6
describe("los valores que el manifiesto se niega a publicar son EXACTAMENTE los que no cobran", () => {
  it("la zero-address no se publica: cobraría $0 (ZERO_PAY_TO) para siempre", () => {
    // (a) el settle la rechazaría…
    expect(
      evaluateSettle(
        {
          method: "x402",
          chain: "avalanche-fuji",
          contract: EVM_ZERO,
          asset: "USDC",
        },
        AMBAS_PRENDIDAS,
      ),
    ).toBe("ZERO_PAY_TO");
    // (b) …por eso el manifiesto no la emite.
    vi.stubEnv(KYC_ENV, EVM_ZERO);
    const result = buildManifest("remit-kyc-validator");
    expect(result.ok).toBe(false);
  });

  it("payTo de la familia equivocada: el agente cobraría $0 (INVALID_PAY_TO_FORMAT) — se rechaza en origen", () => {
    // EVM en un slot Solana
    expect(
      evaluateSettle(
        { method: "x402", chain: "solana-devnet", contract: EVM_OK, asset: "USDC" },
        AMBAS_PRENDIDAS,
      ),
    ).toBe("INVALID_PAY_TO_FORMAT");
    vi.stubEnv(FX_ENV, EVM_OK);
    expect(buildManifest("remit-corridor-fx").ok).toBe(false);

    // base58 en un slot EVM
    expect(
      evaluateSettle(
        { method: "x402", chain: "avalanche-fuji", contract: SOL_OK, asset: "USDC" },
        AMBAS_PRENDIDAS,
      ),
    ).toBe("INVALID_PAY_TO_FORMAT");
    vi.stubEnv(KYC_ENV, SOL_OK);
    expect(buildManifest("remit-kyc-validator").ok).toBe(false);
  });

  it("sin payTo no hay manifiesto, y un registro sin payment nunca paga (NO_PAYMENT_FIELD)", () => {
    vi.stubEnv(KYC_ENV, "");
    expect(buildManifest("remit-kyc-validator").ok).toBe(false);
    expect(evaluateSettle(undefined, AMBAS_PRENDIDAS)).toBe("NO_PAYMENT_FIELD");
  });
});

// T17 — auto-test del ORÁCULO (valida el instrumento antes de creerle)
describe("auto-test del oráculo: cada guarda del gateway, en su orden exacto", () => {
  it("payment ausente ⇒ NO_PAYMENT_FIELD", () => {
    expect(evaluateSettle(undefined, AMBAS_PRENDIDAS)).toBe("NO_PAYMENT_FIELD");
    expect(evaluateSettle(null, AMBAS_PRENDIDAS)).toBe("NO_PAYMENT_FIELD");
    expect(evaluateSettle("x402", AMBAS_PRENDIDAS)).toBe("NO_PAYMENT_FIELD");
    expect(evaluateSettle([], AMBAS_PRENDIDAS)).toBe("NO_PAYMENT_FIELD");
    expect(evaluateSettle({}, AMBAS_PRENDIDAS)).toBe("NO_PAYMENT_FIELD");
  });

  it("campos presentes pero no-string ⇒ NO_PAYMENT_FIELD", () => {
    expect(
      evaluateSettle(
        { method: "x402", chain: "avalanche-fuji", contract: 123, asset: "USDC" },
        AMBAS_PRENDIDAS,
      ),
    ).toBe("NO_PAYMENT_FIELD");
    expect(evaluateSettle({ method: "x402", chain: null, contract: EVM_OK }, AMBAS_PRENDIDAS)).toBe(
      "NO_PAYMENT_FIELD",
    );
  });

  it("method con un espacio ('x402 ') ⇒ METHOD_NOT_SUPPORTED (comparación exacta, sin trim)", () => {
    expect(
      evaluateSettle(
        { method: "x402 ", chain: "avalanche-fuji", contract: EVM_OK, asset: "USDC" },
        AMBAS_PRENDIDAS,
      ),
    ).toBe("METHOD_NOT_SUPPORTED");
    expect(
      evaluateSettle(
        { method: "X402", chain: "avalanche-fuji", contract: EVM_OK, asset: "USDC" },
        AMBAS_PRENDIDAS,
      ),
    ).toBe("METHOD_NOT_SUPPORTED");
  });

  it("chain desconocida por el rail ⇒ CHAIN_NOT_SUPPORTED", () => {
    expect(
      evaluateSettle(
        { method: "x402", chain: "polygon", contract: EVM_OK, asset: "USDC" },
        AMBAS_PRENDIDAS,
      ),
    ).toBe("CHAIN_NOT_SUPPORTED");
  });

  it("contract vacío en una chain EVM ⇒ INVALID_PAY_TO_FORMAT", () => {
    expect(
      evaluateSettle(
        { method: "x402", chain: "avalanche-fuji", contract: "", asset: "USDC" },
        AMBAS_PRENDIDAS,
      ),
    ).toBe("INVALID_PAY_TO_FORMAT");
  });

  it("zero-address ⇒ ZERO_PAY_TO", () => {
    expect(
      evaluateSettle(
        {
          method: "x402",
          chain: "avalanche-fuji",
          contract: EVM_ZERO,
          asset: "USDC",
        },
        AMBAS_PRENDIDAS,
      ),
    ).toBe("ZERO_PAY_TO");
  });

  it("caso completo válido (EVM y Solana) ⇒ WOULD_SETTLE", () => {
    expect(
      evaluateSettle(
        { method: "x402", chain: "avalanche-fuji", contract: EVM_OK, asset: "USDC" },
        AMBAS_PRENDIDAS,
      ),
    ).toBe("WOULD_SETTLE");
    expect(
      evaluateSettle(
        { method: "x402", chain: "solana-devnet", contract: SOL_OK, asset: "USDC" },
        AMBAS_PRENDIDAS,
      ),
    ).toBe("WOULD_SETTLE");
  });

  it("el orden de las guardas es el del gateway: method gana sobre chain, chain sobre contract", () => {
    // method malo + chain mala + contract malo ⇒ el primero que corta es METHOD_NOT_SUPPORTED
    expect(evaluateSettle({ method: "nope", chain: "polygon", contract: "" }, AMBAS_PRENDIDAS)).toBe(
      "METHOD_NOT_SUPPORTED",
    );
    // chain mala + contract malo ⇒ CHAIN_NOT_SUPPORTED
    expect(evaluateSettle({ method: "x402", chain: "polygon", contract: "" }, AMBAS_PRENDIDAS)).toBe(
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

  // FIX-PACK CR-MNR-4 — las 2 guardas del lector que ningún test ejercitaba. Si el oráculo se
  // vuelve MÁS PERMISIVO que el lector real, afirma que un registro cobra cuando el consumidor
  // ni siquiera produciría un spec.
  it("readPaymentSpecAccepts: sin method NI protocol ⇒ false, aunque chain y contract sean válidos", () => {
    expect(readPaymentSpecAccepts({ payment: { chain: "avalanche-fuji", contract: EVM_OK } })).toBe(
      false,
    );
    // `protocol` presente pero no-string tampoco alcanza (el lector exige typeof string)
    expect(
      readPaymentSpecAccepts({ payment: { protocol: 402, chain: "solana-devnet", contract: SOL_OK } }),
    ).toBe(false);
  });

  it("readPaymentSpecAccepts: chain no-string ⇒ false, incluso si se COACCIONA a un slug conocido", () => {
    expect(
      readPaymentSpecAccepts({ payment: { method: "x402", chain: 43113, contract: EVM_OK } }),
    ).toBe(false);
    // El caso que separa "typeof string" de "indexar el mapa": este objeto se coacciona a
    // "avalanche-fuji" al usarlo como clave, pero el lector real lo descarta antes.
    expect(
      readPaymentSpecAccepts({
        payment: { method: "x402", chain: { toString: () => "avalanche-fuji" }, contract: EVM_OK },
      }),
    ).toBe(false);
    // …y lo mismo por el fallback de nivel superior (`raw.chain`).
    expect(
      readPaymentSpecAccepts({
        chain: { toString: () => "solana-devnet" },
        payment: { method: "x402", contract: SOL_OK },
      }),
    ).toBe(false);
  });
});
