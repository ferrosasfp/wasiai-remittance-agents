// src/manifest/settle-preconditions.ts
// ORÁCULO DE TEST — NO es código de producción. PROHIBIDO importarlo desde `src/app/**`.
// Port de las guardas REALES que deciden si un leg downstream paga o se saltea, en `wasiai-a2a`:
//   `src/lib/downstream-payment.ts:506-514` (agent.payment ausente → NO_PAYMENT_FIELD)
//   `src/lib/downstream-payment.ts:518-528` (method !== 'x402' exacto → METHOD_NOT_SUPPORTED)
//   `src/lib/downstream-payment.ts:532-546` (chain no resuelta/no inicializada → CHAIN_NOT_SUPPORTED)
//   `src/lib/downstream-payment.ts:218-231` (EVM: formato → INVALID_PAY_TO_FORMAT; 0x0 → ZERO_PAY_TO)
//   `src/lib/downstream-payment.ts:255-262` (Solana: isValidSolanaAddress → INVALID_PAY_TO_FORMAT)
//   `src/lib/payment-spec-reader.ts:129-179` (qué specs sobreviven a la lectura)
// Existe para poder afirmar EFECTO ("este agente cobraría / no cobraría") sin cadena ni fondos.

import { isValidEvmAddress, isValidSolanaAddress, isZeroAddress } from "./wallet-format";
import type { ChainFamily } from "./types";

export type SettleVerdict =
  | "WOULD_SETTLE"
  | "NO_PAYMENT_FIELD"
  | "METHOD_NOT_SUPPORTED"
  | "CHAIN_NOT_SUPPORTED"
  | "INVALID_PAY_TO_FORMAT"
  | "ZERO_PAY_TO";

/** Familias de las chains que el rail downstream conoce y este repo puede declarar. */
const ORACLE_CHAINS: Readonly<Record<string, ChainFamily>> = Object.freeze({
  "avalanche-fuji": "evm",
  "solana-devnet": "solana",
});

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Reproduce, EN ESTE ORDEN, la secuencia de guardas del gateway. El orden ES el contrato: un
 * `payment` puede violar dos reglas a la vez y el skip-code que se emite es el de la primera.
 */
export function evaluateSettle(payment: unknown): SettleVerdict {
  // (1) El lector de specs devolvería `undefined` y el leg vería `agent.payment` ausente.
  const spec = asRecord(payment);
  if (spec === undefined) return "NO_PAYMENT_FIELD";
  const { method, chain, contract } = spec;
  if (typeof method !== "string" || typeof chain !== "string" || typeof contract !== "string") {
    return "NO_PAYMENT_FIELD";
  }

  // (2) Comparación EXACTA: sin trim ni lowercase ("x402 " con espacio NO es x402).
  if (method !== "x402") return "METHOD_NOT_SUPPORTED";

  // (3) Chain que el rail no conoce / no tiene adapter inicializado.
  const family = ORACLE_CHAINS[chain];
  if (family === undefined) return "CHAIN_NOT_SUPPORTED";

  // (4) EVM: formato primero, zero-address después.
  if (family === "evm") {
    if (!isValidEvmAddress(contract)) return "INVALID_PAY_TO_FORMAT";
    if (isZeroAddress(contract)) return "ZERO_PAY_TO";
    return "WOULD_SETTLE";
  }

  // (5) Solana: base58 que decodifica a 32 bytes.
  if (!isValidSolanaAddress(contract)) return "INVALID_PAY_TO_FORMAT";
  return "WOULD_SETTLE";
}

/**
 * Port del lector de specs del gateway: ¿este objeto sobrevive a la lectura del consumidor?
 * `method` puede venir como `protocol`, y `chain` puede venir en el nivel de arriba (`raw.chain`).
 */
export function readPaymentSpecAccepts(raw: Record<string, unknown>): boolean {
  const spec = asRecord(raw.payment);
  if (spec === undefined) return false;

  const method = typeof spec.method === "string" ? spec.method : spec.protocol;
  if (typeof method !== "string") return false;

  const chain = typeof spec.chain === "string" ? spec.chain : raw.chain;
  if (typeof chain !== "string") return false;

  if (typeof spec.contract !== "string") return false;

  return ORACLE_CHAINS[chain] !== undefined;
}
