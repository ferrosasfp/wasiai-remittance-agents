// remit-cashout-payout — agente de payout. v2 PARALELA de agentshop-cashout-matcher.
// El demo (agentshop-*) queda INTACTO y vivo (jurado Team1); esto es un slug/servicio NUEVO.
//
// ⚠️ Este agente es el LEAF que llama al partner de payout. El movimiento del PRINCIPAL real +
// la máquina de estados (quote-lock → principal-in → payout → reconcile → refund) es la capa de
// VALUE-DELIVERY (WKH-168), gated al sandbox de TransFi. Acá NO se escribe money-code a ciegas:
// el fallback es un mock que NO mueve plata, y hay fail-safes para que no se ejecute payout real
// sin un provider real configurado.

import { z } from "zod";
import { getPayoutProvider } from "../providers/payout";
import type { PayoutResult } from "../providers/types";

export const SLUG = "remit-cashout-payout";
export const PRICE_USDC = 0.03;

export const CashoutPayoutInputSchema = z.object({
  quoteId: z.string().min(1), // del agente FX (tasa fijada)
  amountUsd: z.number().positive(),
  kycVerificationId: z.string().min(1), // handle del KYC (el Travel Rule se recupera por acá, no PII inline)
  kycPayoutAllowed: z.boolean(), // hard-gate del agente KYC
  beneficiary: z.object({
    name: z.string().min(1),
    country: z.string().min(2),
    method: z.enum(["yape", "plin", "bank_cci"]),
    destination: z.string().min(1),
  }),
  idempotencyKey: z.string().min(1),
});

export type CashoutPayoutInput = z.infer<typeof CashoutPayoutInputSchema>;

export interface CashoutPayoutOutput {
  slug: string;
  executed: boolean; // si se intentó el payout (false = gate bloqueó)
  status: PayoutResult["status"] | "blocked";
  payoutId: string | null;
  deliveredLocal: number | null;
  txRef: string | null;
  reason: string | null;
  provenance: string;
}

/**
 * FAIL-SAFE: nunca ejecutar un payout REAL con el fallback (mock). En prod se exige un provider
 * real (TransFi key + readiness); en dev el fallback requiere opt-in explícito y ruidoso.
 */
function assertPayoutProviderSafe(): void {
  const hasReal =
    !!process.env.TRANSFI_API_KEY && process.env.TRANSFI_ADAPTER_READY === "true";
  if (hasReal) return;
  if (process.env.NODE_ENV === "production") {
    // ⚠️ SEGURIDAD MONEY-PATH (WKH-172, etapa 1): PAYOUT_ALLOW_MOCK habilita SOLO el
    // FallbackPayoutProvider (mock, NUNCA mueve plata). NO abre ningún path a desembolso real:
    // el path real sigue 100% gated por TRANSFI_API_KEY + TRANSFI_ADAPTER_READY (chequeado arriba
    // vía hasReal, y de nuevo en getPayoutProvider()). Activar este flag en CUALQUIER deploy que
    // no sea el de etapa 1 (mock) es un INCIDENTE DE SEGURIDAD money-path.
    if (process.env.PAYOUT_ALLOW_MOCK !== "true") {
      throw new Error("payout_refused: se requiere provider de payout REAL en producción (no fallback)");
    }
    console.warn(
      "[remit-payout] PROD + PAYOUT_ALLOW_MOCK: usando payout FALLBACK (mock, NO mueve plata) — SOLO etapa 1",
    );
    return;
  }
  if (process.env.ALLOW_FALLBACK_PAYOUT !== "true") {
    throw new Error(
      "payout_refused: el payout fallback (mock) requiere ALLOW_FALLBACK_PAYOUT=true explícito (solo dev/CI)",
    );
  }
  console.warn("[remit-payout] usando payout FALLBACK (mock, NO mueve plata) — solo dev/CI");
}

/**
 * Core del agente. Devuelve el objeto que va dentro de `{ result }`.
 * Lanza ZodError si el input es inválido; lanza `payout_refused` si el fail-safe bloquea.
 */
export async function runCashoutPayout(raw: unknown): Promise<CashoutPayoutOutput> {
  const input = CashoutPayoutInputSchema.parse(raw);

  // Hard-gate KYC (viene del agente remit-kyc-validator).
  if (!input.kycPayoutAllowed) {
    return {
      slug: SLUG,
      executed: false,
      status: "blocked",
      payoutId: null,
      deliveredLocal: null,
      txRef: null,
      reason: "kyc_gate_not_passed",
      provenance: "n/a",
    };
  }

  assertPayoutProviderSafe();
  const provider = getPayoutProvider();

  // El Travel Rule data se recupera por kycVerificationId vía canal seguro (NO viaja como PII en el input a2a).
  const travelRuleData = await resolveTravelRuleData(input.kycVerificationId);

  const result = await provider.execute({
    quoteId: input.quoteId,
    amountUsd: input.amountUsd,
    beneficiary: input.beneficiary,
    travelRuleData,
    idempotencyKey: input.idempotencyKey,
  });

  return {
    slug: SLUG,
    executed: true,
    status: result.status,
    payoutId: result.payoutId,
    deliveredLocal: result.deliveredLocal,
    txRef: result.txRef,
    reason: result.failureReason,
    provenance: result.provenance,
  };
}

/**
 * Recupera el Travel Rule data por el handle del KYC, desde un canal/almacén seguro
 * (el store del provider / Didit). STUB hasta la Fase A — no expone PII en el pipeline a2a.
 */
async function resolveTravelRuleData(
  verificationId: string,
): Promise<import("../providers/types").PayoutInput["travelRuleData"]> {
  // TODO(WKH-168 / sandbox): fetch real al store seguro por verificationId.
  return {
    originator: { name: "", country: "", legalId: `ref:${verificationId}` },
    beneficiary: { name: "", country: "" },
  };
}
