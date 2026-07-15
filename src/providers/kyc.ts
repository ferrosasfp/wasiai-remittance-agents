// KYC/AML provider — Didit adapter + fallback determinístico.
// Didit: verificación DNI + liveness + screening OFAC/PEP/sanciones + monitoreo continuo,
// SBS-compliant Perú. Docs: https://docs.didit.me  (endpoints exactos a confirmar en sandbox).

import type { KycInput, KycProvider, KycResult, KycStatusResult } from "./types";

const DIDIT_BASE = process.env.DIDIT_BASE_URL ?? "https://verification.didit.me";

// MNR-3 (re-AR): allowlist explícita de proveniencias REALES (fail-safe en el eje provenance).
// Un typo futuro en un provider NO debe leerse como "real" y abrir el money-path.
// WKH-203/CD-9: vive ACÁ (junto a los providers que PRODUCEN estos valores) y es la ÚNICA;
// la consumen kyc-validator.ts (isPayoutAllowed) y cashout-payout.ts (isKycGatePassed).
export const REAL_KYC_PROVENANCES = new Set<string>(["didit"]);

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

  async status(verificationId: string): Promise<KycStatusResult> {
    // TODO(sandbox / DIDIT_ADAPTER_READY — R-1): checklist OBLIGATORIO antes de activar
    // DIDIT_ADAPTER_READY=true. Ambos items son bloqueantes:
    //
    // 1. COMPAT v2↔v3: confirmar que un session_id creado con POST /v2/session/ (ver verify())
    //    es consultable por GET /v3/session/{id}/decision/. Si v3 no acepta ids de v2 → cae en
    //    la rama B6 (kyc_gate_unavailable → 502), NUNCA fail-open. Este item es fail-SAFE.
    //
    // 2. ⚠️ FORMA DE `aml.hits` — FAIL-OPEN LATENTE (AR/MNR-1): confirmar contra el sandbox la
    //    forma EXACTA que devuelve Didit. ¿Es un array? ¿Un número (`aml: { hits: 3 }`)? ¿Otro
    //    nombre (`aml: { total_hits: [...] }`)? ¿Puede venir `aml: null`?
    //    El `Array.isArray(amlHitsRaw) ? ... : 0` de abajo asume ARRAY: si NO es un array,
    //    `amlHits` cae a 0 en silencio y un KYC con hits de AML REALES pasaría como
    //    `approved: true` con `riskLevel:"low"`. A diferencia del item 1, este NO es fail-safe:
    //    es un fail-OPEN de compliance en el money-path. Hoy es inocuo SOLO porque el adapter
    //    entero está tras DIDIT_ADAPTER_READY — activarlo sin confirmar esto lo vuelve real.
    // CD-7: de este JSON se leen SOLO status, aml.hits y session_id. PROHIBIDO leer/loguear
    // id_verifications[], first_name, last_name, document_number, date_of_birth.
    const res = await fetch(`${DIDIT_BASE}/v3/session/${encodeURIComponent(verificationId)}/decision/`, {
      method: "GET",
      signal: AbortSignal.timeout(8000), // igual que payout.ts:47 — no colgar el money-path
      headers: { "x-api-key": this.apiKey },
    });
    if (!res.ok) throw new Error(`didit_status_error_${res.status}`); // fail-closed (rama B6)
    const d = (await res.json()) as Record<string, unknown>;
    const decision = String(d.status ?? "").toLowerCase(); // Didit manda "Approved"
    const amlHitsRaw = (d.aml as { hits?: unknown } | undefined)?.hits;
    const amlHits = Array.isArray(amlHitsRaw) ? amlHitsRaw.length : 0;
    const approved = decision === "approved" && amlHits === 0; // mismo criterio que verify()
    const echoed = String(d.session_id ?? "");
    if (echoed !== "" && echoed !== verificationId) {
      throw new Error("didit_status_id_mismatch"); // rama B10, fail-closed
    }
    return assertValidKycStatus({
      approved,
      verificationId, // canónico = el PEDIDO (igual que payout.ts:53)
      provenance: "didit",
      reasons: approved ? [] : [`didit_status_${decision}`, `aml_hits_${amlHits}`],
    });
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

  async status(verificationId: string): Promise<KycStatusResult> {
    // NO es verificación real y NO hay store: determinístico y SIEMPRE tageado local-fallback.
    // Es INOCUO por construcción: REAL_KYC_PROVENANCES lo bloquea en prod SIEMPRE (rama B3).
    // El `approved: true` NO abre nada — la seguridad vive en la allowlist del gate (B3/B4),
    // igual que en FallbackKycProvider.verify() (approved = hasLegalId).
    return {
      approved: true,
      verificationId,
      provenance: "local-fallback",
      reasons: ["fallback_no_real_verification"], // mismo reason que FallbackKycProvider.verify()
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

// guard de salida — fail-loud. WKH-203/CD-8 (anti WKH-198): `approved` DEBE ser booleano real;
// nunca dejar que un undefined/NaN-ish se lea como señal de compliance.
export function assertValidKycStatus(s: KycStatusResult): KycStatusResult {
  if (typeof s.approved !== "boolean") throw new Error("invalid_kyc_status_approved");
  if (!s.verificationId) throw new Error("invalid_kyc_status_id");
  if (!s.provenance) throw new Error("invalid_kyc_status_provenance");
  return s;
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
