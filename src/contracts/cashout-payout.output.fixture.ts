// FIXTURE DE CONTRATO — ORIGEN (provider). WKH-227 / HU-SOL-24, sync: 2026-07-22.
// Captura el OUTPUT canónico de runCashoutPayout() en fallback determinístico. NO editar a mano:
// regenerar corriendo contracts/contracts.provider.test.ts (ver doc). El consumer (chaski-v3)
// vendorea una COPIA con header "COPIA PINNEADA, NO SE EDITA".

import type { CashoutPayoutOutput } from "../agents/cashout-payout";

// Valores de la salida REAL de runCashoutPayout(cashoutPayoutInput) en la rama determinística
// BLOCKED: ALLOW_FALLBACK_PAYOUT="true" (pasa el fail-safe de payout, rama dev/mock),
// DIDIT_API_KEY="" (KYC fallback), ALLOW_FALLBACK_KYC="" (el gate KYC tampoco abriría).
// WKH-212: `depositAddress` presente SIEMPRE (string|null); null en blocked/mock (no hubo payout).
//
// 🔴 EL `reason` CAMBIÓ de "kyc_gate_not_passed" a "quote_unresolvable", y NO es un renombre: cambió
// QUIÉN bloquea. Desde el binding quote↔monto, el `quoteId:"q1"` del input canónico no lo puede
// resolver nadie, y ese guard corre ANTES del gate KYC (es cero-I/O y ya determina el rechazo, así
// que no se gasta una llamada a Didit). Las keys y los tipos del contrato del wire NO se movieron —
// lo que este fixture ancla— pero un consumer que espere el reason viejo tiene que enterarse.
// El gate KYC sigue igual de vivo: lo cubren los ~20 casos de `agents/cashout-payout.test.ts`.
export const cashoutPayoutOutputFixture: CashoutPayoutOutput = {
  slug: "remit-cashout-payout",
  executed: false,
  status: "blocked",
  payoutId: null,
  deliveredLocal: null,
  txRef: null,
  reason: "quote_unresolvable",
  provenance: "n/a",
  depositAddress: null,
};
