// src/manifest/wallet-format.test.ts
// Tests del port VERBATIM del criterio de formato del consumidor real (`wasiai-a2a`).
// El caso central es T12-a: una base58 de 44 chars del charset correcto que decodifica a 33 bytes.
// La regex laxa de `src/providers/payout.ts:53` ({32,44} chars) la deja pasar; el settle del gateway
// la rechaza. Si este validador fuera igual de laxo, el agente cobraría $0 con un manifiesto "OK".
import { describe, it, expect } from "vitest";
import {
  ADDRESS_RE,
  isValidEvmAddress,
  isValidSolanaAddress,
  isZeroAddress,
  isValidPayToForFamily,
} from "./wallet-format";

// Fixtures de FORMATO (no son wallets reales — no usar en ningún runbook).
const EVM_OK = "0x1111111111111111111111111111111111111111";
const EVM_ZERO = "0x0000000000000000000000000000000000000000";
const EVM_SHORT = "0x111111111111111111111111111111111111111"; // 39 hex
const SOL_OK = "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr"; // 44 chars → 32 bytes
const SOL_33B = "z".repeat(44); // 44 chars del charset → 33 bytes

// La regex laxa que NO se debe usar como validador de payTo (vive en providers/payout.ts:53).
const LAX_BASE58_RE = /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{32,44}$/;

describe("wallet-format — criterio EVM", () => {
  it("ADDRESS_RE acepta 0x + 40 hex y está anclada", () => {
    expect(ADDRESS_RE.test(EVM_OK)).toBe(true);
    expect(ADDRESS_RE.test(`${EVM_OK}extra`)).toBe(false);
    expect(ADDRESS_RE.test(` ${EVM_OK}`)).toBe(false);
  });

  it("isValidEvmAddress acepta la address válida", () => {
    expect(isValidEvmAddress(EVM_OK)).toBe(true);
  });

  it("isValidEvmAddress rechaza 39 hex, sin prefijo 0x, char no-hex y espacio interno", () => {
    expect(isValidEvmAddress(EVM_SHORT)).toBe(false);
    expect(isValidEvmAddress("1111111111111111111111111111111111111111")).toBe(false);
    expect(isValidEvmAddress("0x111111111111111111111111111111111111111g")).toBe(false);
    expect(isValidEvmAddress("0x11 111111111111111111111111111111111111")).toBe(false);
  });

  it("isValidEvmAddress rechaza null, undefined y no-strings sin lanzar", () => {
    expect(isValidEvmAddress(null)).toBe(false);
    expect(isValidEvmAddress(undefined)).toBe(false);
    expect(isValidEvmAddress("")).toBe(false);
  });

  it("isZeroAddress detecta la zero-address en cualquier casing", () => {
    expect(isZeroAddress(EVM_ZERO)).toBe(true);
    expect(isZeroAddress(EVM_ZERO.toUpperCase().replace("0X", "0x"))).toBe(true);
    expect(isZeroAddress(EVM_OK)).toBe(false);
  });
});

describe("wallet-format — criterio Solana (decode a 32 bytes, no longitud de chars)", () => {
  it("isValidSolanaAddress acepta una base58 que decodifica a 32 bytes", () => {
    expect(isValidSolanaAddress(SOL_OK)).toBe(true);
  });

  // T12-a: EL test del port. Este es el valor que separa este criterio del criterio laxo.
  it("base58 de 44 chars que decodifica a 33 bytes: el settle la rechazaría, el manifiesto también", () => {
    // Premisa del test: el criterio laxo SÍ la deja pasar (si no, el test no probaría nada).
    expect(LAX_BASE58_RE.test(SOL_33B)).toBe(true);
    expect(SOL_33B.length).toBe(44);
    // El criterio real del consumidor la rechaza.
    expect(isValidSolanaAddress(SOL_33B)).toBe(false);
  });

  it("rechaza chars fuera del charset base58 (0, O, I, l) y strings vacíos", () => {
    expect(isValidSolanaAddress("0h9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr")).toBe(false);
    expect(isValidSolanaAddress("Oh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr")).toBe(false);
    expect(isValidSolanaAddress("Ih9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr")).toBe(false);
    expect(isValidSolanaAddress("lh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr")).toBe(false);
    expect(isValidSolanaAddress("")).toBe(false);
  });

  it("rechaza una base58 corta (decodifica a menos de 32 bytes)", () => {
    expect(isValidSolanaAddress("111")).toBe(false);
    expect(isValidSolanaAddress("Gh9ZwEmdLJ8DscKNTkTq")).toBe(false);
  });

  it("rechaza una address EVM (el 0 y la x no están en el charset base58)", () => {
    expect(isValidSolanaAddress(EVM_OK)).toBe(false);
  });
});

describe("wallet-format — despacho por familia (cruce de familias, los dos sentidos)", () => {
  it("acepta cada address en el slot de SU familia", () => {
    expect(isValidPayToForFamily(EVM_OK, "evm")).toBe(true);
    expect(isValidPayToForFamily(SOL_OK, "solana")).toBe(true);
  });

  it("una EVM en un slot solana se rechaza", () => {
    expect(isValidPayToForFamily(EVM_OK, "solana")).toBe(false);
  });

  it("una base58 en un slot evm se rechaza", () => {
    expect(isValidPayToForFamily(SOL_OK, "evm")).toBe(false);
  });
});
