// Payout provider — TransFi off-ramp adapter + fallback MOCK (no mueve plata).
// ⚠️ El movimiento REAL del principal + la máquina de estados (quote-lock → principal-in →
// payout → reconcile → refund) vive en la capa de value-delivery (WKH-168, gated sandbox TransFi).
// Este provider es solo el LEAF que llama al partner; el fallback NUNCA desembolsa de verdad.
//
// WKH-208: contrato HTTP REAL de TransFi off-ramp (sandbox-only, cero plata real):
//  · POST /v3/orders con orderType:"offramp"  (NO /v1/payouts)
//  · Auth Basic base64(user:pass) + header `mid`  (NUNCA Bearer / x-api-key)
//  · Idempotencia por campo `partnerId` = input.idempotencyKey  (NO header idempotency-key)
//  · Modelo create-order ASYNC: el POST devuelve una `depositAddress` dedicada; el `settled` llega
//    DESPUÉS por webhook (fuera de scope, CD-4). El POST NUNCA se asume `settled`.

import { resolveTransFiBaseUrl, type TransFiBaseUrl } from "./transfi-env";
import type { PayoutInput, PayoutProvider, PayoutResult } from "./types";

// CD-1 (evolucionado): este archivo YA NO define un default de host ni lee `TRANSFI_BASE_URL`.
// El default sandbox local cumplía CD-1 acá pero NO alcanzaba: `fx.ts` leía la MISMA env con default
// productivo, así que el repo entero podía quedar "sandbox a medias". El ambiente ahora es explícito
// y único (`transfi-env.ts`, fail-closed sin `TRANSFI_ENV`) y llega inyectado al adapter.

// DT-2 (revertida 2026-07-30): la red del USDC YA NO tiene default. Hasta este fix esta constante
// valía `"base"` y `execute()` la usaba cuando `TRANSFI_USDC_NETWORK` estaba ausente, mientras que
// `resolveDevnetStubAddress()` (abajo) lee la MISMA env con el criterio opuesto: ausente ≠ "solana"
// → stub apagado. Con la env sin setear el resultado medible era: stub devnet apagado y orden REAL
// armada como `USDCBASE`. De los dos criterios, el permisivo era el del camino de la plata.
// El repo ya había pagado este mismo bug con `TRANSFI_BASE_URL` (ver el bloque CD-1 de arriba).

/**
 * ÚNICA lectura de `TRANSFI_USDC_NETWORK` en el repo: devuelve el valor CRUDO (sin trim ni
 * lowercase), o `undefined` si la env no está seteada. Tener un solo call site del `process.env`
 * es lo que impide que un rename o un default nuevo vuelva a separar a los dos consumidores.
 *
 * Los dos consumidores tratan "env no declarada" igual (fail-closed), pero NO comparten
 * normalización, a propósito:
 *  · `resolveDevnetStubAddress()` exige la igualdad estricta `=== "solana"`: un escape-hatch de
 *    devnet se activa solo con el valor exacto.
 *  · `execute()` delega en `resolveSourceCurrency()`, que hace `trim().toLowerCase()` antes de
 *    buscar en el allowlist y lanza si la red no está.
 * Consecuencia verificable con un input concreto: con `TRANSFI_USDC_NETWORK="Solana"` (mayúscula)
 * la orden real sale con `USDCSOL` y el stub devnet queda en `null`.
 */
function readUsdcNetworkEnv(): string | undefined {
  return process.env.TRANSFI_USDC_NETWORK;
}

// Códigos `source.currency` publicados por TransFi (doc/transfi-offramp-api-spec.md L38).
// ⚠️ Avalanche (`USDCAVAX`) NO está en la lista → cae en fail-loud (AC-6), a propósito.
const TRANSFI_USDC_CURRENCY: Record<string, string> = {
  ethereum: "USDC",
  polygon: "USDCPOLYGON",
  base: "USDCBASE",
  arbitrum: "USDCARB",
  bsc: "USDCBSC",
  solana: "USDCSOL",
  celo: "USDCCELO",
  linea: "USDCLINEA",
  algorand: "USDCALGO",
  stellar: "USDCXLM",
  fuse: "USDCFUSE",
};

/**
 * Resuelve el `source.currency` para la red pedida. Fail-loud ANTES de armar/enviar el body (AC-6):
 * una red no soportada NUNCA debe mandar una orden con una currency inventada.
 */
export function resolveSourceCurrency(network: string): string {
  const code = TRANSFI_USDC_CURRENCY[network.trim().toLowerCase()];
  if (!code) throw new Error(`transfi_unsupported_network_${network}`);
  return code;
}

// DT-4: base58 (alfabeto Bitcoin/Solana, sin 0 O I l) + longitud de pubkey Solana (32-44 chars).
// Anclada ^…$ (CD-10): rechaza EVM 0x…, vacíos/whitespace, chars ambiguos y sufijos basura.
// NO usa @solana/web3.js (ausente del repo; verificación de curva Ed25519 es Scope OUT).
const BASE58_ADDR_RE = /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{32,44}$/;

/**
 * Escape-hatch DEVNET-ONLY (WKH-232 / HU-SOL-15). Devuelve la deposit address SOLO si el doble-gate
 * (env seteada + red solana) pasa Y el valor es base58 válido; si no, null (fail-closed → mock estándar).
 * NO mueve plata: el mock nunca desembolsa. Se exporta para testear la validación en aislamiento (CD-10).
 */
export function resolveDevnetStubAddress(): string | null {
  const raw = process.env.TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS;
  if (!raw) return null; // CD-4: unset/"" → byte-idéntico
  if (readUsdcNetworkEnv() !== "solana") return null; // CD-2 (b) / DT-3 guard de red
  const addr = raw.trim();
  if (!BASE58_ADDR_RE.test(addr)) {
    // CD-5 fail-closed
    console.warn(
      "[remit-payout] TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS ignorada: no es base58 válida " +
        "(DEVNET STUB, NO real off-ramp)", // CD-8 value-free (sin la address)
    );
    return null;
  }
  console.warn("[remit-payout] DEVNET STUB deposit address ACTIVO — devnet-only, NO real off-ramp"); // CD-8
  return addr;
}

interface TransFiCreds {
  username: string;
  password: string;
  mid: string;
}

// CD-8: Basic base64(user:pass) + header `mid`. NUNCA Bearer / x-api-key / idempotency-key.
function transfiHeaders(c: TransFiCreds): HeadersInit {
  const basic = Buffer.from(`${c.username}:${c.password}`).toString("base64");
  return {
    "content-type": "application/json",
    authorization: `Basic ${basic}`,
    mid: c.mid,
  };
}

/**
 * Lee un string NO vacío de la respuesta, probando los nombres candidatos por orden.
 * Narrowing por `typeof` (NUNCA `String()` coercitivo — WKH-204/C8): un campo ausente o no-string
 * colapsa a null y NO produce un valor fabricado.
 */
function readString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

/** Adapter TransFi — activo con las 3 creds + readiness. Crea la orden off-ramp real. */
export class TransFiPayoutProvider implements PayoutProvider {
  /** `baseUrl` es OBLIGATORIO y branded: solo `resolveTransFiBaseUrl()` puede producir uno. */
  constructor(
    private readonly creds: TransFiCreds,
    private readonly baseUrl: TransFiBaseUrl,
  ) {}

  async execute(input: PayoutInput): Promise<PayoutResult> {
    // AC-6: resolver la red PRIMERO (fail-loud antes de tocar la red). Una red no soportada
    // NO debe llegar al fetch. Una red NO DECLARADA tampoco: sin `TRANSFI_USDC_NETWORK` no se
    // adivina ninguna (env ausente, `""` y sólo-espacios son el mismo caso que "no soportada").
    const network = readUsdcNetworkEnv()?.trim();
    if (!network) {
      // Value-free (CD-8): solo el nombre de la variable, nunca su contenido.
      throw new Error(
        "transfi_usdc_network_unset: seteá TRANSFI_USDC_NETWORK antes de crear una orden off-ramp.",
      );
    }
    const sourceCurrency = resolveSourceCurrency(network);

    const res = await fetch(`${this.baseUrl}/v3/orders`, {
      method: "POST",
      signal: AbortSignal.timeout(15000), // payout puede tardar; igual acotado (espejo kyc.ts)
      headers: transfiHeaders(this.creds),
      body: JSON.stringify({
        orderType: "offramp", // fijo (AC-2)
        partnerId: input.idempotencyKey, // CD-6/AC-2: byte-idéntico, sin regenerar/derivar
        // TODO(F3-sandbox): flujo del `userId` (usuario TransFi KYC'd, "UX-..."). Probable HU de
        // seguimiento — hoy no viaja en PayoutInput. Se toma de config hasta confirmarlo en sandbox.
        userId: process.env.TRANSFI_USER_ID ?? "",
        // TODO(F3-sandbox): `purposeCode` válido para remesas a Perú.
        purposeCode: process.env.TRANSFI_PURPOSE_CODE ?? "",
        // TODO(F3-sandbox): confirmar si `sourceUrl` es requerido y qué valor espera TransFi
        // (URL del merchant). Server-only, solo de env — nunca hardcode. Default "" → si el sandbox
        // lo exige produce un 4xx thrown (fail-loud, consistente con los otros campos inciertos).
        sourceUrl: process.env.TRANSFI_SOURCE_URL ?? "",
        source: {
          currency: sourceCurrency,
          // TODO(F3-sandbox): confirmar la forma de `source.walletAddress` con el sandbox.
          walletAddress: process.env.TRANSFI_SOURCE_WALLET_ADDRESS ?? "",
          amount: input.amountUsd, // fijo
        },
        destination: {
          currency: "PEN", // fijo
          paymentType: "bank_transfer", // fijo (spec L48)
          // TODO(F3-sandbox): `paymentCode` de GET /v3/payment-methods (PEN/withdraw).
          paymentCode: process.env.TRANSFI_PAYMENT_CODE ?? "",
          // TODO(F3-sandbox): `destination.amount` = monto PEN. HOY no viaja en PayoutInput; si el
          // sandbox confirma que TransFi lo exige, extender PayoutInput es HU de seguimiento (Scope OUT).
          // TODO(F3-sandbox): forma exacta de `additionalPaymentDetails` (beneficiario PE: CCI/banco/doc)
          // via GET /v3/payment-methods. Los nombres de estos sub-campos NO están confirmados en docs.
          additionalPaymentDetails: {
            name: input.beneficiary.name,
            method: input.beneficiary.method,
            destination: input.beneficiary.destination,
            country: input.beneficiary.country,
          },
        },
      }),
    });
    // CD-5/AC-7: error HTTP → throw tipado por status. NUNCA éxito silencioso ni downgrade al mock.
    if (!res.ok) throw new Error(`transfi_payout_error_${res.status}`);
    // Un 2xx con body vacío/no-JSON NO debe filtrar un SyntaxError crudo (ni asumir settled ni
    // caer al mock): se tipa como error del adapter, consistente con el resto de errores.
    let d: Record<string, unknown>;
    try {
      d = (await res.json()) as Record<string, unknown>;
    } catch {
      throw new Error("transfi_payout_bad_response");
    }
    // TODO(F3-sandbox): nombres JSON exactos de `orderId` / `depositAddress` en la respuesta del POST.
    // Parseo defensivo (narrowing por tipo, NO String()); W3/sandbox confirma los nombres reales.
    const orderId = readString(d, ["orderId", "id"]);
    if (!orderId) throw new Error("transfi_payout_missing_order_id");
    const depositAddress = readString(d, ["depositAddress", "walletAddress"]);
    return assertValidPayout({
      payoutId: orderId,
      status: "submitted", // CD-5: FORZADO — el POST crea la orden, NUNCA es `settled` sincrónico.
      deliveredLocal: null, // el settle (PEN entregado) llega por webhook, no en el create-order.
      txRef: null,
      failureReason: null,
      provenance: "transfi",
      depositAddress, // el sender manda el USDC on-chain a esta address dedicada por orden.
    });
  }

  async status(payoutId: string): Promise<PayoutResult> {
    const res = await fetch(`${this.baseUrl}/v3/orders/${encodeURIComponent(payoutId)}`, {
      method: "GET",
      signal: AbortSignal.timeout(8000),
      headers: transfiHeaders(this.creds),
    });
    if (!res.ok) throw new Error(`transfi_payout_status_error_${res.status}`);
    // Ídem execute(): un 2xx con body no-JSON → error tipado, no un SyntaxError crudo.
    let d: Record<string, unknown>;
    try {
      d = (await res.json()) as Record<string, unknown>;
    } catch {
      throw new Error("transfi_payout_status_bad_response");
    }
    return assertValidPayout({
      payoutId, // canónico = el id PEDIDO
      status: normalizeStatus(d.status),
      // TODO(F3-sandbox): nombre del monto PEN entregado en el estado; hasta confirmarlo → null.
      deliveredLocal: null,
      txRef: null,
      failureReason: null,
      provenance: "transfi",
      depositAddress: null, // status() no devuelve la address dedicada.
    });
  }
}

/**
 * Fallback MOCK — dev/demo. NO desembolsa plata real. Devuelve un resultado simulado
 * SIEMPRE tageado `provenance:"local-fallback"` + `deliveredLocal:null` (no hubo entrega real).
 * El gate del agente/orquestador NUNCA debe ejecutar un payout real con este provider (fail-safe).
 *
 * 🔴 EL MOCK NO PUEDE AFIRMAR MÁS QUE EL ADAPTER REAL EN EL MISMO PUNTO. Hasta este fix los dos
 * métodos devolvían `"settled"`, un estado que `TransFiPayoutProvider.execute()` NO PUEDE EMITIR
 * NUNCA (fuerza `"submitted"`: el POST solo crea la orden) y que `status()` solo emite cuando el
 * partner lo afirma. O sea que el simulado se reportaba MÁS TERMINAL que la realidad, y hay
 * consumidores que leen `"settled"` como "entregado" y lo muestran (chaski-v3
 * `track-remittance.ts` → `markSettled`). El mock no habló con ningún partner: lo máximo que puede
 * decir es lo que dice el adapter real cuando el partner no afirma ningún desenlace, que es
 * `"submitted"` (`normalizeStatus` más abajo). Lo hace cumplir `payout-mock-ceiling.test.ts`,
 * que mide el techo EJECUTANDO el adapter real en vez de comparar contra un literal.
 */
export class FallbackPayoutProvider implements PayoutProvider {
  async execute(input: PayoutInput): Promise<PayoutResult> {
    const stub = resolveDevnetStubAddress(); // WKH-232: null salvo doble-gate + base58 válido
    return {
      payoutId: `fallback-${input.idempotencyKey}`,
      status: "submitted", // techo del mock (ver el bloque de arriba) — NUNCA un estado terminal
      deliveredLocal: null, // NO hubo entrega real
      txRef: null,
      failureReason: null,
      provenance: stub ? "devnet-stub" : "local-fallback", // CD-3/AC-6
      depositAddress: stub, // CD-4: stub===null → null (byte-idéntico); el mock no crea orden real.
    };
  }
  async status(payoutId: string): Promise<PayoutResult> {
    const stub = resolveDevnetStubAddress(); // WKH-232: null salvo doble-gate + base58 válido
    return {
      payoutId,
      status: "submitted", // ídem execute(): sin partner al que consultarle, no hay estado terminal
      deliveredLocal: null,
      txRef: null,
      failureReason: null,
      provenance: stub ? "devnet-stub" : "local-fallback", // CD-3/AC-6
      depositAddress: stub, // CD-4: stub===null → null (byte-idéntico)
    };
  }
}

/**
 * Mapea el `status` de una orden TransFi off-ramp → `PayoutResult.status`.
 * CD-7: SOLO estados documentados (spec L43). Un estado desconocido → `"submitted"` + warn value-free,
 * NUNCA un `"settled"` fabricado (eso abriría el money-path sin entrega confirmada).
 */
export function normalizeStatus(s: unknown): PayoutResult["status"] {
  const v = String(s ?? "").toLowerCase();
  switch (v) {
    case "initiated":
    case "asset_deposited":
      return "submitted";
    case "fund_settled":
      return "settled";
    case "fund_failed":
    case "expired":
      return "failed";
    default:
      // value-free: solo la etiqueta de estado, nunca PII ni el body crudo (CD-11).
      console.warn(`[remit-payout] transfi_unknown_status:${v || "empty"} → submitted`);
      return "submitted";
  }
}

// guard de salida — no dejar pasar un payout con payoutId vacío o deliveredLocal NaN.
export function assertValidPayout(p: PayoutResult): PayoutResult {
  if (!p.payoutId) throw new Error("invalid_payout_id");
  if (p.deliveredLocal != null && !Number.isFinite(p.deliveredLocal)) {
    throw new Error(`invalid_payout_delivered:${p.deliveredLocal}`);
  }
  return p;
}

/**
 * Factory: adapter TransFi si están las 3 creds (user+pass+mid) + readiness, si no el fallback
 * (mock, no mueve plata). CD-9: NO lee `TRANSFI_API_KEY` (esa la usa fx.ts, se preserva).
 */
export function getPayoutProvider(): PayoutProvider {
  const username = process.env.TRANSFI_USERNAME;
  const password = process.env.TRANSFI_PASSWORD;
  const mid = process.env.TRANSFI_MID;
  if (!username || !password || !mid) return new FallbackPayoutProvider(); // falta cualquiera → mock
  if (process.env.TRANSFI_ADAPTER_READY !== "true") {
    throw new Error(
      "transfi_adapter_not_ready: credenciales TransFi seteadas pero TRANSFI_ADAPTER_READY!=true — " +
        "confirmá el mapeo + el flujo de depósito con el sandbox antes de mover plata.",
    );
  }
  // Mismo llamado que `getFxQuoteProvider()`: un solo resolvedor para los dos providers, así no
  // pueden hablarle a ambientes distintos. Sin `TRANSFI_ENV` lanza `transfi_env_unset` (fail-closed);
  // el modo mock/devnet ni llega acá (retorna antes, en el `if` de las creds).
  return new TransFiPayoutProvider({ username, password, mid }, resolveTransFiBaseUrl());
}
