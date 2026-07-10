// KYC/AML provider — Didit adapter + fallback determinístico.
// Didit: verificación DNI + liveness + screening OFAC/PEP/sanciones + monitoreo continuo,
// SBS-compliant Perú. Docs: https://docs.didit.me  (endpoints exactos a confirmar en sandbox).

import type { KycInput, KycProvider, KycResult } from "./types";

const DIDIT_BASE = process.env.DIDIT_BASE_URL ?? "https://verification.didit.me";

/** Adapter Didit — activo cuando DIDIT_API_KEY está seteada. */
export class DiditKycProvider implements KycProvider {
  constructor(private readonly apiKey: string) {}

  async verify(input: KycInput): Promise<KycResult> {
    // Didit expone verificación por "session"; acá se crea/consulta la verificación
    // del legalId (DNI) + screening AML. La forma exacta de request/response se fija
    // con el sandbox (Fase A) — TODO: mapear campos reales.
    const res = await fetch(`${DIDIT_BASE}/v2/session/`, {
      method: "POST",
      signal: AbortSignal.timeout(8000), // MNR-3: no colgar el money-path si el partner stallea
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
      },
      body: JSON.stringify({
        // TODO(sandbox): confirmar el payload exacto de Didit (features: id-verification,
        // liveness, aml). Enviar legalId + país + datos para el screening.
        vendor_data: input.legalId,
        features: ["ID_VERIFICATION", "LIVENESS", "AML"],
        metadata: { senderCountry: input.senderCountry, purpose: input.purpose },
      }),
    });
    if (!res.ok) {
      throw new Error(`didit_error_${res.status}`);
    }
    const data = (await res.json()) as Record<string, unknown>;
    // TODO(sandbox): mapear la decisión real de Didit (status/aml.hits/risk).
    const decision = String((data as any).status ?? "").toLowerCase();
    const amlHits = Array.isArray((data as any).aml?.hits)
      ? (data as any).aml.hits.length
      : 0;
    const approved = decision === "approved" && amlHits === 0;
    return {
      approved,
      riskLevel: amlHits > 0 ? "high" : approved ? "low" : "medium",
      reasons: approved ? [] : [`didit_status_${decision}`, `aml_hits_${amlHits}`],
      travelRuleData: buildTravelRule(input),
      verificationId: String((data as any).session_id ?? (data as any).id ?? "unknown"),
      provenance: "didit",
    };
  }
}

/**
 * Fallback determinístico — corre SIN keys de partner (dev/demo/CI).
 * NO es verificación real: aplica reglas conservadoras y SIEMPRE se tagea
 * `provenance:"local-fallback"`. En producción, un payout REAL debe exigir
 * KYC con provenance !== "local-fallback" (ver el hard-gate del orquestador).
 */
export class FallbackKycProvider implements KycProvider {
  async verify(input: KycInput): Promise<KycResult> {
    const reasons: string[] = ["fallback_no_real_verification"]; // MNR-1: siempre explicitar que NO es real
    const hasLegalId = input.legalId.trim().length >= 6;
    if (!hasLegalId) reasons.push("missing_or_short_legal_id");
    // regla demo: montos altos → medium/high (proxy de "requiere KYC reforzado")
    const highAmount = input.amountUsd >= 1000;
    if (highAmount) reasons.push("high_amount_requires_enhanced_kyc"); // MNR-1: reason auditable
    const approved = hasLegalId; // determinístico, no verifica identidad real
    return {
      approved,
      riskLevel: !approved ? "high" : highAmount ? "medium" : "low",
      reasons,
      travelRuleData: buildTravelRule(input),
      verificationId: `fallback-${hashLite(input.legalId)}`,
      provenance: "local-fallback",
    };
  }
}

function buildTravelRule(input: KycInput): KycResult["travelRuleData"] {
  return {
    originator: {
      name: input.senderName,
      country: input.senderCountry,
      legalId: input.legalId,
    },
    beneficiary: { name: input.receiverName, country: input.receiverCountry },
  };
}

// hash liviano determinístico (no cripto) solo para un id estable en fallback
function hashLite(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

/**
 * Factory: adapter Didit si hay key + readiness confirmado, si no el fallback.
 * MNR-2 (AR): el mapeo de campos del adapter es sandbox-unverified hasta la Fase A. Setear solo
 * la key NO debe activar el adapter en el money-path a ciegas → se exige `DIDIT_ADAPTER_READY=true`
 * (opt-in explícito tras confirmar el mapeo). Key sin readiness = fail-loud, NO downgrade silencioso.
 */
export function getKycProvider(): KycProvider {
  const key = process.env.DIDIT_API_KEY;
  if (!key) return new FallbackKycProvider();
  if (process.env.DIDIT_ADAPTER_READY !== "true") {
    throw new Error(
      "didit_adapter_not_ready: DIDIT_API_KEY seteada pero DIDIT_ADAPTER_READY!=true — " +
        "confirmá el mapeo de campos con el sandbox antes de activar el adapter en el money-path.",
    );
  }
  return new DiditKycProvider(key);
}
