// src/manifest/wallet-format.ts
// Port VERBATIM del criterio de formato del consumidor real (repo `wasiai-a2a`):
//   `src/lib/wallet-format.ts:20` (ADDRESS_RE), `:46-71` (isValidSolanaAddress, decode a 32 bytes)
//   `src/lib/downstream-payment.ts:218-231` (zero-address → skip ZERO_PAY_TO)
// Si el manifiesto valida MÁS LAXO que el consumidor, el agente cobra $0 igual pero con un
// documento que dice que todo está bien. PROHIBIDO relajar este criterio (ver CD-9).
//
// PROHIBIDO reusar `BASE58_ADDR_RE` de `src/providers/payout.ts:53` ({32,44} chars) como validador
// del payTo: una base58 de 44 chars que decodifica a 33 bytes pasa esa regex y el settle la rechaza.

import type { ChainFamily } from "./types";

export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function isValidEvmAddress(w: string | null | undefined): w is `0x${string}` {
  return typeof w === "string" && ADDRESS_RE.test(w);
}

export function isZeroAddress(w: string): boolean {
  return w.toLowerCase() === "0x0000000000000000000000000000000000000000";
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const SOLANA_PUBKEY_BYTES = 32;

export function isValidSolanaAddress(w: string): boolean {
  if (typeof w !== "string" || w.length === 0) return false;
  const bytes: number[] = [];
  for (let i = 0; i < w.length; i++) {
    let carry = BASE58_ALPHABET.indexOf(w[i] as string);
    if (carry < 0) return false; // char fuera del charset base58
    for (let j = 0; j < bytes.length; j++) {
      carry += (bytes[j] as number) * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // Cada `1` inicial representa un byte cero de alto orden.
  for (let i = 0; i < w.length && w[i] === "1"; i++) bytes.push(0);
  return bytes.length === SOLANA_PUBKEY_BYTES;
}

export function isValidPayToForFamily(w: string, family: ChainFamily): boolean {
  return family === "solana" ? isValidSolanaAddress(w) : isValidEvmAddress(w);
}
