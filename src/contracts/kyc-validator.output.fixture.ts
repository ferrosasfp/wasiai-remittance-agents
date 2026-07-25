// FIXTURE DE CONTRATO — ORIGEN (provider). WKH-227 / HU-SOL-24, sync: 2026-07-22.
// Captura el OUTPUT canónico de runKycValidator() en fallback determinístico. NO editar a mano:
// regenerar corriendo contracts/contracts.provider.test.ts (ver doc). El consumer (chaski-v3)
// vendorea una COPIA con header "COPIA PINNEADA, NO SE EDITA".

import type { KycAgentOutput } from "../agents/kyc-validator";

// Valores de la salida REAL de runKycValidator(kycInput) con el fallback KYC (DIDIT_API_KEY="",
// NODE_ENV="", ALLOW_FALLBACK_KYC=""). CD-7: PROHIBIDO PII — el output NO lleva `travelRuleData`
// ni `legalId`; `verificationId` es un handle opaco (hashLite del legalId), NO el DNI.
// El gate money-path es FAIL-SAFE: fallback + nada seteado → `payoutAllowed:false`.
export const kycValidatorOutputFixture: KycAgentOutput = {
  slug: "remit-kyc-validator",
  approved: true,
  riskLevel: "low",
  reasons: ["fallback_no_real_verification"],
  verificationId: "fallback-910e0084",
  provenance: "local-fallback",
  payoutAllowed: false,
};
