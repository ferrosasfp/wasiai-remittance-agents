// src/manifest/registry.test.ts
// T16 — invariantes de la tabla de declaración. Ancla CD-3 (ninguna chain de mainnet es declarable)
// y la coherencia slug↔name, que es la derivación real de slug del registro consumidor.
import { describe, it, expect } from "vitest";
import { MANIFEST_ENTRIES, findEntry } from "./registry";
import { PRICE_USDC as KYC_PRICE_USDC } from "@/agents/kyc-validator";
import { PRICE_USDC as FX_PRICE_USDC } from "@/agents/corridor-fx";
import { PRICE_USDC as PAYOUT_PRICE_USDC } from "@/agents/cashout-payout";

const TESTNET_CHAINS = ["avalanche-fuji", "solana-devnet"];

describe("registry — invariantes de la tabla (T16)", () => {
  it("declara exactamente 3 agentes", () => {
    expect(MANIFEST_ENTRIES).toHaveLength(3);
  });

  it("name deriva al slug canónico: name.toLowerCase().replace(/\\s+/g,'-') === slug", () => {
    for (const entry of MANIFEST_ENTRIES) {
      expect(entry.name.toLowerCase().replace(/\s+/g, "-")).toBe(entry.slug);
    }
  });

  it("CD-3: ninguna chain de mainnet — toda chain está en la allowlist testnet", () => {
    for (const entry of MANIFEST_ENTRIES) {
      expect(TESTNET_CHAINS).toContain(entry.chain);
      expect(entry.chain).not.toMatch(/mainnet|avalanche-c|solana-mainnet/i);
    }
  });

  it("family es coherente con chain", () => {
    for (const entry of MANIFEST_ENTRIES) {
      expect(entry.family).toBe(entry.chain === "solana-devnet" ? "solana" : "evm");
    }
  });

  it("asset es USDC en las 3 entradas", () => {
    for (const entry of MANIFEST_ENTRIES) {
      expect(entry.asset).toBe("USDC");
    }
  });

  it("priceUsdc es la constante PRICE_USDC importada del agente (sin segunda verdad del precio)", () => {
    expect(findEntry("remit-kyc-validator")?.priceUsdc).toBe(KYC_PRICE_USDC);
    expect(findEntry("remit-corridor-fx")?.priceUsdc).toBe(FX_PRICE_USDC);
    expect(findEntry("remit-cashout-payout")?.priceUsdc).toBe(PAYOUT_PRICE_USDC);
  });

  it("capabilities son los arrays exactos de la tabla de declaración", () => {
    expect(findEntry("remit-kyc-validator")?.capabilities).toEqual([
      "kyc-verification",
      "aml-screening",
      "travel-rule",
      "remittance-compliance",
    ]);
    expect(findEntry("remit-corridor-fx")?.capabilities).toEqual([
      "remittance-fx-quote",
      "usdc-to-pen",
      "corridor-pricing",
    ]);
    expect(findEntry("remit-cashout-payout")?.capabilities).toEqual([
      "remittance-payout",
      "cashout",
      "value-delivery",
      "fiat-disbursement",
      "disbursement-simulated",
    ]);
  });

  // La ficha del payout es la única que hace una afirmación sobre PLATA REAL, y el deploy de etapa 1
  // sólo puede simular. Republicar `value-delivery` + `fiat-disbursement` sin marca habría hecho que
  // el catálogo dejara de estar desactualizado para pasar a mentir. Este test fija las dos mitades de
  // la marca: la capability y la frase de la descripción. Las dos se borran juntas en la etapa 2.
  it("la ficha del payout declara la etapa: capability marcada + la descripcion dice SIMULADO", () => {
    const payout = findEntry("remit-cashout-payout");
    expect(payout?.capabilities).toContain("disbursement-simulated");
    expect(payout?.description).toContain("ETAPA 1");
    expect(payout?.description).toContain("SIMULADO");
    // Y ningún otro agente se cuelga de la marca: es una afirmación sobre el que desembolsa.
    expect(findEntry("remit-kyc-validator")?.capabilities).not.toContain("disbursement-simulated");
    expect(findEntry("remit-corridor-fx")?.capabilities).not.toContain("disbursement-simulated");
  });

  // El pedido del mentor de la incubadora: el pipeline de Chaski cobra en Solana y "no debe
  // intervenir Avalanche". Es una afirmación sobre LOS 3, no sobre dos: si alguien devuelve
  // cualquier entrada a una chain EVM, este test se pone rojo con ese nombre.
  it("ningún agente cobra en una chain EVM: los 3 declaran solana-devnet / family solana", () => {
    for (const entry of MANIFEST_ENTRIES) {
      expect(entry.chain).toBe("solana-devnet");
      expect(entry.family).toBe("solana");
    }
  });

  it("chain y slug por agente son los canónicos de cobro", () => {
    expect(findEntry("remit-kyc-validator")?.chain).toBe("solana-devnet");
    expect(findEntry("remit-corridor-fx")?.chain).toBe("solana-devnet");
    expect(findEntry("remit-cashout-payout")?.chain).toBe("solana-devnet");
    expect(findEntry("remit-corridor-fx")?.slug).toBe("remit-corridor-fx-solana");
    expect(findEntry("remit-cashout-payout")?.slug).toBe("remit-cashout-payout-solana");
  });

  it("sin slugs, pathSlugs ni payToEnv duplicados", () => {
    const slugs = MANIFEST_ENTRIES.map((e) => e.slug);
    const pathSlugs = MANIFEST_ENTRIES.map((e) => e.pathSlug);
    const envs = MANIFEST_ENTRIES.map((e) => e.payToEnv);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(new Set(pathSlugs).size).toBe(pathSlugs.length);
    expect(new Set(envs).size).toBe(envs.length);
  });

  it("findEntry resuelve por pathSlug y devuelve undefined para un desconocido", () => {
    expect(findEntry("remit-corridor-fx")?.pathSlug).toBe("remit-corridor-fx");
    expect(findEntry("no-existe")).toBeUndefined();
    // el slug canónico NO es una clave de ruta (pathSlug !== slug es deliberado)
    expect(findEntry("remit-corridor-fx-solana")).toBeUndefined();
  });
});
