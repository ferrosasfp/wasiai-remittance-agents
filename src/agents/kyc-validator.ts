// remit-kyc-validator — agente KYC/AML real. v2 PARALELA de agentshop-kyc-validator.
// El demo (agentshop-*) queda INTACTO y vivo (jurado Team1); esto es un slug/servicio NUEVO.
// Patrón cobraya-credit-scorer: zod input → provider (Didit || fallback) → { result }.
// Honra el contrato HTTP del gateway a2a: POST /invoke → 200 { result: {...} }.
//
// El HTTP handler (Next route / Vercel fn) es un wrapper fino sobre runKycValidator();
// se mantiene la lógica framework-agnostic para testear como cobraya.

import { z } from "zod";
import { getKycProvider } from "../providers/kyc";
import type { KycResult } from "../providers/types";

export const SLUG = "remit-kyc-validator";
export const PRICE_USDC = 0.02;

export const KycInputSchema = z.object({
  senderName: z.string().min(1),
  senderCountry: z.string().min(2),
  legalId: z.string().min(1),
  amountUsd: z.number().positive(),
  receiverName: z.string().min(1),
  receiverCountry: z.string().min(2),
  purpose: z.string().min(1),
});

export type KycAgentInput = z.infer<typeof KycInputSchema>;

/**
 * Salida del agente — lo que va DENTRO de `{ result }` y viaja/loguea por el gateway a2a.
 * BLQ-MED-1 (AR): NO incluye `travelRuleData`/`legalId` en claro (PII/DNI). El payout recupera
 * el Travel Rule data por `verificationId` vía canal seguro (store del provider), NUNCA por el
 * envelope de result que se persiste en telemetría (precedente WKH-155).
 */
export interface KycAgentOutput {
  slug: string;
  approved: boolean;
  riskLevel: KycResult["riskLevel"];
  reasons: string[];
  verificationId: string; // handle para recuperar el Travel Rule data del store seguro
  provenance: KycResult["provenance"];
  // Hard-gate para el orquestador/payout: si false, NO se procede al payout.
  payoutAllowed: boolean;
}

/**
 * BLQ-ALTO-1 (AR): el gate money-path es FAIL-SAFE por default.
 * - En producción (`NODE_ENV==='production'`): SIEMPRE exige KYC REAL (adapter, no fallback).
 *   Un env olvidado NUNCA abre la puerta.
 * - En no-producción: se permite KYC fallback SOLO con opt-in explícito y ruidoso
 *   (`ALLOW_FALLBACK_KYC==='true'`), para dev/CI.
 */
// MNR-3 (re-AR): allowlist explícita de proveniencias REALES (fail-safe en el eje provenance).
// Un typo futuro en un provider NO debe leerse como "real" y abrir el money-path.
const REAL_KYC_PROVENANCES = new Set<string>(["didit"]);

function isPayoutAllowed(kyc: KycResult): boolean {
  if (!kyc.approved) return false;
  const isReal = REAL_KYC_PROVENANCES.has(kyc.provenance);
  if (isReal) return true;
  const isProd = process.env.NODE_ENV === "production";
  const allowFallback = process.env.ALLOW_FALLBACK_KYC === "true";
  if (!isProd && allowFallback) {
    console.warn(
      "[remit-kyc] payout habilitado con KYC FALLBACK (no verificación real) — solo dev/CI",
    );
    return true;
  }
  return false; // fail-safe: fallback NO habilita payout por default ni jamás en prod
}

/**
 * Core del agente (testeable, sin HTTP). Devuelve el objeto que va dentro de `{ result }`.
 * Lanza ZodError si el input es inválido (el handler lo mapea a 400).
 */
export async function runKycValidator(raw: unknown): Promise<KycAgentOutput> {
  const input = KycInputSchema.parse(raw);
  const provider = getKycProvider();
  const kyc = await provider.verify({
    senderName: input.senderName,
    senderCountry: input.senderCountry,
    legalId: input.legalId,
    amountUsd: input.amountUsd,
    receiverName: input.receiverName,
    receiverCountry: input.receiverCountry,
    purpose: input.purpose,
  });
  // NOTA: `kyc.travelRuleData` (incl. el DNI) queda del lado del provider/store seguro,
  // recuperable por `verificationId`. NO se propaga al output (BLQ-MED-1).
  return {
    slug: SLUG,
    approved: kyc.approved,
    riskLevel: kyc.riskLevel,
    reasons: kyc.reasons,
    verificationId: kyc.verificationId,
    provenance: kyc.provenance,
    payoutAllowed: isPayoutAllowed(kyc),
  };
}
