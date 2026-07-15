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
import { getKycProvider, REAL_KYC_PROVENANCES } from "../providers/kyc";
import type { KycStatusResult, PayoutResult } from "../providers/types";

export const SLUG = "remit-cashout-payout";
export const PRICE_USDC = 0.03;

export const CashoutPayoutInputSchema = z.object({
  quoteId: z.string().min(1), // del agente FX (tasa fijada)
  amountUsd: z.number().positive(),
  kycVerificationId: z.string().min(1), // handle del KYC (el Travel Rule se recupera por acá, no PII inline)
  // WKH-203/DT-4: `kycPayoutAllowed` FUE ELIMINADO a propósito. El input NO decide compliance:
  // la decisión se re-deriva server-side en isKycGatePassed(). z.object sin .strict() strippea
  // la key en silencio → los callers que la sigan mandando NO se rompen (compat), pero
  // `input.kycPayoutAllowed` ya NO compila: la confianza en el caller es estructuralmente imposible.
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
 * WKH-203: el input NO decide compliance. Se consulta la fuente autoritativa por verificationId.
 * Misma allowlist (REAL_KYC_PROVENANCES) y mismo default `false` que isPayoutAllowed()
 * (kyc-validator.ts). NO es un espejo byte-a-byte: la comparación de `approved` es MÁS ESTRICTA
 * A PROPÓSITO (`!== true` acá vs. la truthiness `!kyc.approved` de kyc-validator.ts) — CD-8 /
 * anti-WKH-198: un `approved` no-booleano NUNCA debe leerse como señal de compliance.
 * ⚠️ NO "alinear" este gate con la truthiness de kyc-validator.ts: la divergencia es el fix.
 * Default = BLOQUEAR: no existe ninguna rama "else → allow".
 *
 * NOTA(WKH-204): este gate confirma que la verificación está APROBADA, no que sea DEL que pide el
 * payout (binding verificationId ↔ sender). Ese riesgo residual es WKH-204, fuera de scope acá.
 */
async function isKycGatePassed(verificationId: string): Promise<boolean> {
  // B7: FUERA del try — su throw (didit_adapter_not_ready) DEBE propagar fail-loud (CD-12).
  // Si esto se mete adentro del try se convierte en kyc_gate_unavailable y se rompe la rama B7:
  // key sin readiness sería un downgrade silencioso al fallback.
  const kycProvider = getKycProvider();
  let s: KycStatusResult;
  try {
    s = await kycProvider.status(verificationId);
  } catch (err) {
    // B6: partner caído/timeout ≠ aprobado. Nunca "asumir true".
    console.warn("[remit-payout] kyc gate unavailable:", {
      errorName: err instanceof Error ? err.name : "unknown", // nunca err.message/input (CD-4)
    });
    throw new Error("kyc_gate_unavailable");
  }
  if (s.approved !== true) return false; // B2 + B9: estricto, NUNCA truthy (CD-8, anti-WKH-198)
  if (REAL_KYC_PROVENANCES.has(s.provenance)) return true; // B1: única rama que abre en prod
  // B3: en prod el fallback JAMÁS abre — ninguna env puede abrirlo. El orden (isProd primero)
  // es deliberado: no lo inviertas.
  const isProd = process.env.NODE_ENV === "production";
  if (!isProd && process.env.ALLOW_FALLBACK_KYC === "true") {
    // B5
    console.warn(
      "[remit-payout] gate KYC pasado con provenance FALLBACK (no verificación real) — solo dev/CI",
    );
    return true;
  }
  return false; // B3/B4/B8: default = BLOQUEAR
}

/**
 * Core del agente. Devuelve el objeto que va dentro de `{ result }`.
 * Lanza ZodError si el input es inválido; lanza `payout_refused` si el fail-safe bloquea;
 * lanza `kyc_gate_unavailable` si el gate KYC no se puede resolver (B6 → 502, fail-closed).
 */
export async function runCashoutPayout(raw: unknown): Promise<CashoutPayoutOutput> {
  const input = CashoutPayoutInputSchema.parse(raw); // 1. (ya sin kycPayoutAllowed — DT-4)

  assertPayoutProviderSafe(); // 2. INTACTO (CD-1) — throws primero, como hoy
  const provider = getPayoutProvider(); // 3. INTACTO — throws adapter_not_ready, como hoy

  // 4. GATE NUEVO (WKH-203): la decisión de compliance se re-deriva server-side contra la fuente
  // autoritativa. Va DESPUÉS de 2 y 3 a propósito (CD-1: preservar el error de payout cuando hay
  // dos problemas a la vez). getPayoutProvider() es cero-I/O y cero side-effects → inerte y seguro.
  if (!(await isKycGatePassed(input.kycVerificationId))) {
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
