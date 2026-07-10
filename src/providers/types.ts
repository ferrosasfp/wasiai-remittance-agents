// Provider interfaces — abstraen los partners licenciados (Didit / TransFi) detrás
// de un contrato estable. Cada interface tiene un adapter de partner + un fallback
// determinístico. Los agentes dependen SOLO de estas interfaces (nunca del partner directo),
// así el día que cambia el partner o llega el sandbox no se toca la lógica del agente.

export type Provenance = string; // ej. "didit" | "transfi" | "local-fallback"

// ── KYC / AML ────────────────────────────────────────────────────────────────
export interface KycInput {
  senderName: string;
  senderCountry: string;
  legalId: string; // ej. DNI
  amountUsd: number;
  receiverName: string;
  receiverCountry: string;
  purpose: string;
}

export interface KycResult {
  approved: boolean;
  riskLevel: "low" | "medium" | "high";
  reasons: string[];
  // Datos del Travel Rule (originador/beneficiario) — obligatorio Perú 2026.
  travelRuleData: {
    originator: { name: string; country: string; legalId: string };
    beneficiary: { name: string; country: string };
  };
  verificationId: string; // id del partner para auditoría/monitoreo continuo
  provenance: Provenance;
}

export interface KycProvider {
  verify(input: KycInput): Promise<KycResult>;
}

// ── FX / Corridor quote ──────────────────────────────────────────────────────
export interface FxQuoteInput {
  amountUsd: number; // principal en USDC
  sourceAsset: "USDC";
  destCurrency: "PEN";
  destCountry: string; // "PE"
  payoutMethod: "yape" | "plin" | "bank_cci";
}

export interface FxQuote {
  rate: number; // USDC → PEN efectivo (incluye spread del partner)
  feeUsd: number; // fee del corredor en USD
  netDeliveredLocal: number; // PEN que recibe el beneficiario
  localCurrency: "PEN";
  etaMinutes: number;
  quoteId: string; // referencia para ejecutar el payout con esta tasa
  expiresAt: string; // ISO — la tasa vence
  provenance: Provenance;
}

export interface FxQuoteProvider {
  quote(input: FxQuoteInput): Promise<FxQuote>;
}

// ── Payout / value-delivery ──────────────────────────────────────────────────
export interface PayoutInput {
  quoteId: string; // atar al quote (tasa fijada)
  amountUsd: number;
  beneficiary: {
    name: string;
    country: string;
    method: "yape" | "plin" | "bank_cci";
    // destino: nº de celular (Yape/Plin) o CCI (banco)
    destination: string;
  };
  travelRuleData: KycResult["travelRuleData"];
  idempotencyKey: string; // evitar doble-payout
}

export interface PayoutResult {
  payoutId: string; // id del partner
  status: "submitted" | "settled" | "failed";
  deliveredLocal: number | null; // PEN entregado (cuando settled)
  txRef: string | null; // referencia del partner / on-chain
  failureReason: string | null;
  provenance: Provenance;
}

export interface PayoutProvider {
  // Ejecuta el desembolso real. El movimiento del principal (USDC del sender → partner)
  // lo hace la capa de value-delivery que llama a esto; el provider entrega PEN al beneficiario.
  execute(input: PayoutInput): Promise<PayoutResult>;
  // Consulta de estado (para reconciliación / webhooks).
  status(payoutId: string): Promise<PayoutResult>;
}
