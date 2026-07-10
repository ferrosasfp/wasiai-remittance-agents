// Payout provider — TransFi adapter + fallback MOCK (no mueve plata).
// ⚠️ El movimiento REAL del principal + la máquina de estados (quote-lock → principal-in →
// payout → reconcile → refund) vive en la capa de value-delivery (WKH-168, gated sandbox TransFi).
// Este provider es solo el LEAF que llama al partner; el fallback NUNCA desembolsa de verdad.

import type { PayoutInput, PayoutProvider, PayoutResult } from "./types";

const TRANSFI_BASE = process.env.TRANSFI_BASE_URL ?? "https://api.transfi.com";

/** Adapter TransFi — activo con key + readiness. Ejecuta el desembolso real a Yape/Plin/banco. */
export class TransFiPayoutProvider implements PayoutProvider {
  constructor(private readonly apiKey: string) {}

  async execute(input: PayoutInput): Promise<PayoutResult> {
    // TODO(sandbox): confirmar endpoint/shape + el flujo de depósito del principal.
    const res = await fetch(`${TRANSFI_BASE}/v1/payouts`, {
      method: "POST",
      signal: AbortSignal.timeout(15000), // payout puede tardar; igual acotado
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
        "idempotency-key": input.idempotencyKey, // evita doble-desembolso
      },
      body: JSON.stringify({
        quoteId: input.quoteId,
        amount: input.amountUsd,
        beneficiary: input.beneficiary,
        // travelRuleData se envía al partner por este canal seguro (NO por el result a2a).
        travelRule: input.travelRuleData,
      }),
    });
    if (!res.ok) throw new Error(`transfi_payout_error_${res.status}`);
    const d = (await res.json()) as any;
    return assertValidPayout({
      payoutId: String(d.payoutId ?? d.id ?? ""),
      status: normalizeStatus(d.status),
      deliveredLocal: d.destAmount != null ? Number(d.destAmount) : null,
      txRef: d.txRef ?? d.reference ?? null,
      failureReason: d.failureReason ?? null,
      provenance: "transfi",
    });
  }

  async status(payoutId: string): Promise<PayoutResult> {
    const res = await fetch(`${TRANSFI_BASE}/v1/payouts/${encodeURIComponent(payoutId)}`, {
      method: "GET",
      signal: AbortSignal.timeout(8000),
      headers: { authorization: `Bearer ${this.apiKey}` },
    });
    if (!res.ok) throw new Error(`transfi_payout_status_error_${res.status}`);
    const d = (await res.json()) as any;
    return assertValidPayout({
      payoutId,
      status: normalizeStatus(d.status),
      deliveredLocal: d.destAmount != null ? Number(d.destAmount) : null,
      txRef: d.txRef ?? d.reference ?? null,
      failureReason: d.failureReason ?? null,
      provenance: "transfi",
    });
  }
}

/**
 * Fallback MOCK — dev/demo. NO desembolsa plata real. Devuelve un resultado simulado
 * SIEMPRE tageado `provenance:"local-fallback"` + `deliveredLocal:null` (no hubo entrega real).
 * El gate del agente/orquestador NUNCA debe ejecutar un payout real con este provider (fail-safe).
 */
export class FallbackPayoutProvider implements PayoutProvider {
  async execute(input: PayoutInput): Promise<PayoutResult> {
    return {
      payoutId: `fallback-${input.idempotencyKey}`,
      status: "settled",
      deliveredLocal: null, // NO hubo entrega real
      txRef: null,
      failureReason: null,
      provenance: "local-fallback",
    };
  }
  async status(payoutId: string): Promise<PayoutResult> {
    return {
      payoutId,
      status: "settled",
      deliveredLocal: null,
      txRef: null,
      failureReason: null,
      provenance: "local-fallback",
    };
  }
}

function normalizeStatus(s: unknown): PayoutResult["status"] {
  const v = String(s ?? "").toLowerCase();
  if (v === "settled" || v === "completed" || v === "success") return "settled";
  if (v === "failed" || v === "error" || v === "rejected") return "failed";
  return "submitted";
}

// guard de salida — no dejar pasar un payout con payoutId vacío o deliveredLocal NaN.
export function assertValidPayout(p: PayoutResult): PayoutResult {
  if (!p.payoutId) throw new Error("invalid_payout_id");
  if (p.deliveredLocal != null && !Number.isFinite(p.deliveredLocal)) {
    throw new Error(`invalid_payout_delivered:${p.deliveredLocal}`);
  }
  return p;
}

/** Factory: adapter TransFi si hay key + readiness, si no el fallback (mock, no mueve plata). */
export function getPayoutProvider(): PayoutProvider {
  const key = process.env.TRANSFI_API_KEY;
  if (!key) return new FallbackPayoutProvider();
  if (process.env.TRANSFI_ADAPTER_READY !== "true") {
    throw new Error(
      "transfi_adapter_not_ready: TRANSFI_API_KEY seteada pero TRANSFI_ADAPTER_READY!=true — " +
        "confirmá el mapeo + el flujo de depósito con el sandbox antes de mover plata real.",
    );
  }
  return new TransFiPayoutProvider(key);
}
