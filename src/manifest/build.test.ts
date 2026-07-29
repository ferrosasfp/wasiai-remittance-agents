// src/manifest/build.test.ts
// Fail-closed de `buildManifest`: cada test de acá describe una forma concreta en la que un agente
// terminaría cobrando $0 si el manifiesto se publicara igual. La regla que anclan todos:
// NO EXISTE una rama que produzca `ok:true` sin un `payment.contract` que el settle aceptaría.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildManifest } from "./build";

// Fixtures de FORMATO (no son wallets reales — no usar en ningún runbook).
const EVM_OK = "0x1111111111111111111111111111111111111111";
const EVM_ZERO = "0x0000000000000000000000000000000000000000";
const EVM_SHORT = "0x111111111111111111111111111111111111111"; // 39 hex
const SOL_OK = "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr"; // 44 chars → 32 bytes
const SOL_33B = "z".repeat(44); // 44 chars del charset → 33 bytes

const KYC_ENV = "REMIT_KYC_VALIDATOR_PAYTO";
const FX_ENV = "REMIT_CORRIDOR_FX_PAYTO";
const PAYOUT_ENV = "REMIT_CASHOUT_PAYOUT_PAYTO";

beforeEach(() => {
  // Punto de partida: las 3 envs ausentes (es el estado real de un deploy sin configurar).
  vi.stubEnv(KYC_ENV, "");
  vi.stubEnv(FX_ENV, "");
  vi.stubEnv(PAYOUT_ENV, "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("buildManifest — happy path (el único camino a ok:true)", () => {
  it("con un payTo válido de su familia arma el manifiesto completo", () => {
    vi.stubEnv(KYC_ENV, EVM_OK);
    const result = buildManifest("remit-kyc-validator");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.manifest.payment).toEqual({
      method: "x402",
      chain: "avalanche-fuji",
      contract: EVM_OK,
      asset: "USDC",
    });
    expect(result.manifest.slug).toBe("remit-kyc-validator");
    expect(result.manifest.priceUsdc).toBe(0.02);
  });

  it("trimea los espacios alrededor de un payTo por lo demás válido", () => {
    vi.stubEnv(FX_ENV, `  ${SOL_OK}  `);
    const result = buildManifest("remit-corridor-fx");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.manifest.payment.contract).toBe(SOL_OK);
  });
});

// T6 — AC-3
describe("buildManifest — payTo ausente: nadie puede registrar un agente que cobra $0", () => {
  it("env ausente del entorno ⇒ missing:['payment.contract'], sin manifiesto", () => {
    vi.unstubAllEnvs(); // ni siquiera definida
    const result = buildManifest("remit-kyc-validator");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("missing");
    expect(result.missing).toEqual(["payment.contract"]);
    expect(result.invalid).toEqual([]);
  });

  it("env vacía ('') ⇒ missing, no invalid", () => {
    vi.stubEnv(KYC_ENV, "");
    const result = buildManifest("remit-kyc-validator");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("missing");
    expect(result.missing).toEqual(["payment.contract"]);
    expect(result.invalid).toEqual([]);
  });

  it("env sólo whitespace ('   ') es AUSENTE, no un valor ⇒ missing", () => {
    vi.stubEnv(KYC_ENV, "   ");
    const result = buildManifest("remit-kyc-validator");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("missing");
    expect(result.missing).toEqual(["payment.contract"]);
    expect(result.invalid).toEqual([]);
  });

  it("whitespace variado (tabs, newline) también es ausente", () => {
    vi.stubEnv(FX_ENV, "\t\n  ");
    const result = buildManifest("remit-corridor-fx");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("missing");
  });

  it("un valor NO-string nunca se convierte en un payTo plausible: sin typeof-narrowing el agente publicaría una address que nadie escribió", () => {
    // Bug histórico WKH-204 (`String(x ?? "")`). El caso que DUELE no es `123` → "123" (que igual
    // sería invalid_format): es un array de un elemento, porque `String(["0x11…"])` devuelve la
    // address DESNUDA y VÁLIDA → el manifiesto publicaría ok:true con un contract que nunca fue
    // un valor de env legítimo.
    //
    // El `process.env` de Node coerce a string en la ASIGNACIÓN (incluso vía defineProperty), así
    // que la única forma de inyectar el valor no-string que distingue las dos implementaciones es
    // reemplazar el bag entero. Por eso este test no usa vi.stubEnv.
    expect(String([EVM_OK])).toBe(EVM_OK); // premisa: el valor raro se disfraza de address válida

    const realEnv = process.env;
    const bag: Record<string, unknown> = { ...realEnv };
    bag[KYC_ENV] = [EVM_OK]; // no-string
    Object.defineProperty(process, "env", { value: bag, configurable: true, writable: true });
    try {
      const result = buildManifest("remit-kyc-validator");
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe("missing");
    } finally {
      Object.defineProperty(process, "env", {
        value: realEnv,
        configurable: true,
        writable: true,
      });
    }
  });
});

// T10 — AC-6
describe("buildManifest — formato EVM inválido: el settle lo rechazaría, el manifiesto también", () => {
  const badEvm: ReadonlyArray<readonly [string, string]> = [
    ["39 hex (una corta)", EVM_SHORT],
    ["sin prefijo 0x", "1111111111111111111111111111111111111111"],
    ["char no-hex", "0x111111111111111111111111111111111111111g"],
    ["espacio interno", "0x11 111111111111111111111111111111111111"],
    ["41 hex (una larga)", "0x11111111111111111111111111111111111111111"],
  ];

  for (const [label, value] of badEvm) {
    it(`${label} ⇒ invalid:['payment.contract'], sin manifiesto`, () => {
      vi.stubEnv(KYC_ENV, value);
      const result = buildManifest("remit-kyc-validator");
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe("invalid_format");
      expect(result.invalid).toEqual(["payment.contract"]);
      expect(result.missing).toEqual([]);
    });
  }

  it("el resultado fail-closed NO ecoa el valor recibido", () => {
    vi.stubEnv(KYC_ENV, "0xDEADBEEF-not-an-address");
    const result = buildManifest("remit-kyc-validator");
    expect(JSON.stringify(result)).not.toContain("DEADBEEF");
  });
});

// T11a — AC-6
describe("buildManifest — zero-address", () => {
  it("la zero-address no se publica: cobraría $0 (ZERO_PAY_TO) para siempre", () => {
    vi.stubEnv(KYC_ENV, EVM_ZERO);
    const result = buildManifest("remit-kyc-validator");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("zero_address");
    expect(result.invalid).toEqual(["payment.contract"]);
    expect(result.missing).toEqual([]);
  });
});

// T12b — AC-6
describe("buildManifest — base58 de 44 chars que decodifica a 33 bytes", () => {
  it("base58 de 44 chars que decodifica a 33 bytes: el settle la rechazaría, el manifiesto también", () => {
    vi.stubEnv(FX_ENV, SOL_33B);
    const result = buildManifest("remit-corridor-fx");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("invalid_format");
    expect(result.invalid).toEqual(["payment.contract"]);
  });
});

// T13 — AC-6, los DOS sentidos
describe("buildManifest — cruce de familias", () => {
  it("payTo de la familia equivocada: el agente cobraría $0 (INVALID_PAY_TO_FORMAT) — se rechaza en origen [EVM en slot solana]", () => {
    vi.stubEnv(FX_ENV, EVM_OK); // slot solana-devnet
    const result = buildManifest("remit-corridor-fx");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("invalid_format");
    expect(result.invalid).toEqual(["payment.contract"]);
  });

  it("payTo de la familia equivocada: el agente cobraría $0 (INVALID_PAY_TO_FORMAT) — se rechaza en origen [base58 en slot evm]", () => {
    vi.stubEnv(KYC_ENV, SOL_OK); // slot avalanche-fuji
    const result = buildManifest("remit-kyc-validator");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("invalid_format");
    expect(result.invalid).toEqual(["payment.contract"]);
  });

  it("el payout Solana tampoco acepta una EVM", () => {
    vi.stubEnv(PAYOUT_ENV, EVM_OK);
    const result = buildManifest("remit-cashout-payout");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("invalid_format");
  });
});

// T19 — fail-closed total
describe("buildManifest — función total", () => {
  it("un pathSlug desconocido devuelve ok:false reason:'unknown_agent' y NO lanza", () => {
    expect(() => buildManifest("no-existe")).not.toThrow();
    const result = buildManifest("no-existe");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("unknown_agent");
    expect(result.missing).toEqual(["agent"]);
    expect(result.invalid).toEqual([]);
  });

  it("el slug canónico *-solana no es un pathSlug válido", () => {
    vi.stubEnv(FX_ENV, SOL_OK);
    const result = buildManifest("remit-corridor-fx-solana");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("unknown_agent");
  });

  it("nunca lanza con ninguna combinación de env basura", () => {
    for (const junk of ["", "   ", "0x", "null", "undefined", "{}", "0".repeat(200)]) {
      vi.stubEnv(KYC_ENV, junk);
      expect(() => buildManifest("remit-kyc-validator")).not.toThrow();
      expect(buildManifest("remit-kyc-validator").ok).toBe(false);
    }
  });
});
