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

/**
 * Resultado de una CONSULTA de estado de una verificación existente (no crea verificación).
 * Deliberadamente MÁS ANGOSTO que KycResult: NO incluye travelRuleData ni ningún campo derivado
 * del legalId/DNI (CD-7). El Travel Rule sigue viajando solo por el canal seguro del provider.
 */
export interface KycStatusResult {
  approved: boolean;
  verificationId: string; // eco del id consultado (canónico = el pedido)
  provenance: Provenance; // "didit" | "local-fallback"
  /**
   * Auditable y VALUE-FREE (ej. "didit_status_declined"); nunca PII.
   * WKH-204 fix-pack — discriminadores del eje IDENTIDAD, para que ops pueda separar una falla de
   * integración de un ataque (R-5); son ETIQUETAS DE RAMA, nunca valores:
   *  · "identity_no_binding" — la fuente autoritativa NO tiene un valor de binding atado a esta
   *    verificación (no lo ecoó / vino vacío / vino de un tipo inesperado) → no hay CONTRA QUÉ
   *    comparar → bloquea (C5/C8). Masivo y parejo = la integración está rota (R-5).
   *  · "identity_mismatch" — SÍ hay binding y NO coincide con el claim (C6). Puntual = ataque.
   * Se CONCATENAN a los reasons de compliance: los dos ejes son independientes.
   */
  reasons: string[];
  /**
   * WKH-204: ¿la identity claim del caller coincide con el `vendor_data` que la fuente autoritativa
   * tiene atado a esta verificación? Booleano DERIVADO: la comparación ocurre DENTRO del provider.
   * CD-7: `vendor_data` en este repo es el DNI (lo setea `DiditKycProvider.verify()`) → PROHIBIDO
   * exponerlo crudo acá. (Se cita el SÍMBOLO y no un nº de línea: las refs numéricas quedan stale al
   * primer insert — lección de WKH-203, repetida acá cuando `normalizeIdentity` corrió el archivo.)
   * ⚠️ Es un booleano, NUNCA `vendorData`: PROHIBIDO agregar a esta interface un `vendorData`,
   * `legalId`, `identity`, `travelRuleData` ni nada derivado del DNI.
   */
  identityMatches: boolean;
}

export interface KycProvider {
  verify(input: KycInput): Promise<KycResult>;
  // Consulta de estado de una verificación ya existente, por su verificationId.
  // Espejo de `PayoutProvider.status(payoutId)` (más abajo en este archivo) — símbolo, no nº de línea.
  // WKH-204: `identityClaim` es REQUERIDO a propósito (no opcional): un param opcional se puede
  // OLVIDAR en un call site nuevo y degradaría en silencio; uno requerido NO COMPILA.
  status(verificationId: string, identityClaim: string): Promise<KycStatusResult>;
}

// ── FX / Corridor quote ──────────────────────────────────────────────────────

/**
 * Taxonomía CERRADA de procedencia de una cotización FX. Cada valor mapea 1:1 a un método
 * auditable de obtención de la tasa:
 *  · `transfi`       — tasa efectiva del corredor, del partner licenciado
 *  · `fx-mid-live`   — mid de mercado traído EN VIVO de una fuente registrada
 *  · `fx-mid-cached` — el mismo mid, servido de la caché en memoria dentro de su ventana de frescura
 *
 * `"local-fallback"` se RETIRÓ del agente FX (era la constante `STATIC_USD_PEN`, +10.2% sobre el
 * mercado real): una constante del código y una tasa de mercado no pueden compartir etiqueta.
 * Sigue vivo en `KycResult`/`PayoutResult`, que están fuera de este eje.
 */
export type FxProvenance = "transfi" | "fx-mid-live" | "fx-mid-cached";

/**
 * Única fuente de "¿esta tasa es de mercado?". Mismo patrón que `REAL_KYC_PROVENANCES`
 * (`src/providers/kyc.ts:13`): allowlist exportada, prohibido duplicar el criterio en un call site.
 */
export const MARKET_FX_PROVENANCES: ReadonlySet<FxProvenance> = new Set<FxProvenance>([
  "transfi",
  "fx-mid-live",
  "fx-mid-cached",
]);

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
  provenance: FxProvenance;
  rateSource: string; // id de la fuente registrada: "er-api" | "currency-api" | "transfi"
  rateAsOf: string; // ISO — fecha del dato SEGÚN LA FUENTE, jamás el momento de servir
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
  // WKH-208 (DT-4): address dedicada por orden que TransFi devuelve en el create-order; el sender
  // manda el USDC on-chain ahí y el settle llega DESPUÉS por webhook (fuera de scope). null en el
  // fallback (mock) y en status() (no devuelve address).
  depositAddress: string | null;
}

export interface PayoutProvider {
  // Ejecuta el desembolso real. El movimiento del principal (USDC del sender → partner)
  // lo hace la capa de value-delivery que llama a esto; el provider entrega PEN al beneficiario.
  execute(input: PayoutInput): Promise<PayoutResult>;
  // Consulta de estado (para reconciliación / webhooks).
  status(payoutId: string): Promise<PayoutResult>;
}
