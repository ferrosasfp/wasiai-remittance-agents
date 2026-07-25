// FIXTURE DE CONTRATO — ORIGEN (provider). WKH-227 / HU-SOL-24, sync: 2026-07-22.
// INPUTs canónicos de los 3 agentes, reusando el `validInput` de cada *.test.ts (DT-5, no inventados).
// NO editar a mano: los valores salen de los tests existentes. El consumer (chaski-v3) vendorea una
// COPIA con header "COPIA PINNEADA, NO SE EDITA".
// CD-7: PROHIBIDO PII real — `legalId`/`senderIdentity` "12345678" es el sanitizado del test, NO un DNI.

// origen FX: src/agents/corridor-fx.test.ts:18 — runCorridorFx({ amountUsd: 100 })
// (destCountry/destCurrency/payoutMethod tienen defaults Zod → no se envían).
export const corridorFxInput = { amountUsd: 100 };

// origen KYC: src/agents/kyc-validator.test.ts:4-12 (validInput)
export const kycInput = {
  senderName: "Alice",
  senderCountry: "US",
  legalId: "12345678",
  amountUsd: 100,
  receiverName: "Bob",
  receiverCountry: "PE",
  purpose: "family support",
};

// origen payout: src/agents/cashout-payout.test.ts:8-18 (validInput, sin `kycPayoutAllowed`:
// DT-4 lo strippea, no llega al core).
export const cashoutPayoutInput = {
  quoteId: "q1",
  amountUsd: 100,
  kycVerificationId: "v1",
  senderIdentity: "12345678",
  beneficiary: { name: "Bob", country: "PE", method: "yape", destination: "999999999" },
  idempotencyKey: "idem-1",
};
