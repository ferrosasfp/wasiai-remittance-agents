// src/manifest/manifest.contract.test.ts
// ANCLA DEL WIRE: el shape exacto que el operador copia al registro. Si alguien agrega, saca o
// renombra una clave, este test se pone rojo antes de que el cambio llegue a un registro.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildManifest } from "./build";

// Fixtures de FORMATO (no son wallets reales — no usar en ningún runbook).
const EVM_OK = "0x1111111111111111111111111111111111111111";
const SOL_OK = "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr";

const KYC_ENV = "REMIT_KYC_VALIDATOR_PAYTO";
const FX_ENV = "REMIT_CORRIDOR_FX_PAYTO";
const PAYOUT_ENV = "REMIT_CASHOUT_PAYOUT_PAYTO";

const MANIFEST_KEYS = [
  "capabilities",
  "description",
  "manifestVersion",
  "name",
  "payment",
  "priceUsdc",
  "slug",
];
const PAYMENT_KEYS = ["asset", "chain", "contract", "method"];

const PATH_SLUGS = ["remit-kyc-validator", "remit-corridor-fx", "remit-cashout-payout"];

function manifestOf(pathSlug: string) {
  const result = buildManifest(pathSlug);
  if (!result.ok) throw new Error(`manifiesto no emitido para ${pathSlug}: ${result.reason}`);
  return result.manifest;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// T18 — AC-1..AC-3
describe("ancla del wire — 7 claves de primer nivel, ni una más", () => {
  beforeEach(() => {
    vi.stubEnv(KYC_ENV, EVM_OK);
    vi.stubEnv(FX_ENV, SOL_OK);
    vi.stubEnv(PAYOUT_ENV, SOL_OK);
  });

  for (const pathSlug of PATH_SLUGS) {
    it(`${pathSlug}: Object.keys son exactamente las 7 claves del contrato`, () => {
      expect(Object.keys(manifestOf(pathSlug)).sort()).toEqual(MANIFEST_KEYS);
    });

    it(`${pathSlug}: typeof por campo`, () => {
      const m = manifestOf(pathSlug);
      expect(m.manifestVersion).toBe("1");
      expect(typeof m.slug).toBe("string");
      expect(typeof m.name).toBe("string");
      expect(typeof m.description).toBe("string");
      expect(Array.isArray(m.capabilities)).toBe(true);
      expect(m.capabilities.every((c) => typeof c === "string")).toBe(true);
      expect(typeof m.priceUsdc).toBe("number");
      expect(Number.isFinite(m.priceUsdc)).toBe(true);
      expect(typeof m.payment).toBe("object");
    });

    it(`${pathSlug}: payment tiene exactamente 4 claves y se copia tal cual al registro`, () => {
      const payment = manifestOf(pathSlug).payment;
      expect(Object.keys(payment).sort()).toEqual(PAYMENT_KEYS);
      expect(payment.method).toBe("x402");
      expect(payment.asset).toBe("USDC");
      expect(typeof payment.chain).toBe("string");
    });

    // T7 — AC-3, CD-5
    it(`${pathSlug}: payment.contract es un string NO vacío (nunca una ficha a medias)`, () => {
      const contract = manifestOf(pathSlug).payment.contract;
      expect(typeof contract).toBe("string");
      expect(contract.length).toBeGreaterThan(0);
      expect(contract.trim()).toBe(contract);
    });

    it(`${pathSlug}: name deriva al slug declarado`, () => {
      const m = manifestOf(pathSlug);
      expect(m.name.toLowerCase().replace(/\s+/g, "-")).toBe(m.slug);
    });

    it(`${pathSlug}: la description es estática y no contiene PII ni el payTo`, () => {
      const m = manifestOf(pathSlug);
      expect(m.description.length).toBeGreaterThan(0);
      expect(m.description).not.toContain(EVM_OK);
      expect(m.description).not.toContain(SOL_OK);
    });
  }
});

// T7 — AC-3: sin env, NO hay clave payment en ninguna parte del resultado
describe("ancla del wire — sin payTo no existe la clave payment", () => {
  for (const pathSlug of PATH_SLUGS) {
    it(`${pathSlug}: el resultado fail-closed no tiene la clave payment`, () => {
      // sin stubear ninguna env: las 3 ausentes
      const result = buildManifest(pathSlug);
      expect(result.ok).toBe(false);
      expect("payment" in result).toBe(false);
      expect("manifest" in result).toBe(false);
      expect(JSON.stringify(result)).not.toContain("payment\":{");
    });
  }
});
