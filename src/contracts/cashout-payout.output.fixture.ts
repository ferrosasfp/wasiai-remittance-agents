// FIXTURE DE CONTRATO — ORIGEN (provider). WKH-227 / HU-SOL-24, sync: 2026-07-22.
// Captura el OUTPUT canónico de runCashoutPayout() en fallback determinístico. NO editar a mano:
// regenerar corriendo contracts/contracts.provider.test.ts (ver doc). El consumer (chaski-v3)
// vendorea una COPIA con header "COPIA PINNEADA, NO SE EDITA".

import type { CashoutPayoutOutput } from "../agents/cashout-payout";

// Valores de la salida REAL de runCashoutPayout(cashoutPayoutInput) en la rama determinística
// BLOCKED (fail-closed sin KYC real): ALLOW_FALLBACK_PAYOUT="true" (pasa el fail-safe de payout,
// rama dev/mock), DIDIT_API_KEY="" (KYC fallback), ALLOW_FALLBACK_KYC="" (el gate NO abre). El gate
// KYC server-side no pasa → executed:false, status:"blocked", reason:"kyc_gate_not_passed".
// WKH-212: `depositAddress` presente SIEMPRE (string|null); null en blocked/mock (no hubo payout).
export const cashoutPayoutOutputFixture: CashoutPayoutOutput = {
  slug: "remit-cashout-payout",
  executed: false,
  status: "blocked",
  payoutId: null,
  deliveredLocal: null,
  txRef: null,
  reason: "kyc_gate_not_passed",
  provenance: "n/a",
  depositAddress: null,
};
