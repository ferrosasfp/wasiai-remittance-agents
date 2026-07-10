// FX / Corridor quote provider — TransFi adapter + fallback con FX mid REAL.
// A diferencia del KYC, el fallback acá NO es inventado: toma el mid-rate real de
// open.er-api.com (como hacía la demo) y le aplica un spread documentado → cotización
// genuina. TransFi da la tasa efectiva real del corredor cuando su key está seteada.

import type { FxQuote, FxQuoteInput, FxQuoteProvider } from "./types";

const TRANSFI_BASE = process.env.TRANSFI_BASE_URL ?? "https://api.transfi.com";
// spread del fallback (bps) — conservador, declarado. TransFi reemplaza esto con su tasa real.
const FALLBACK_SPREAD_BPS = Number(process.env.FALLBACK_FX_SPREAD_BPS ?? 250); // 2.5%
const FALLBACK_FLAT_FEE_USD = Number(process.env.FALLBACK_FX_FLAT_FEE_USD ?? 0.5);

/** Adapter TransFi — activo con TRANSFI_API_KEY. Devuelve la tasa efectiva real del corredor. */
export class TransFiFxProvider implements FxQuoteProvider {
  constructor(private readonly apiKey: string) {}

  async quote(input: FxQuoteInput): Promise<FxQuote> {
    // TODO(sandbox): confirmar el endpoint/shape exactos del quote API de TransFi.
    const res = await fetch(`${TRANSFI_BASE}/v1/quotes`, {
      method: "POST",
      signal: AbortSignal.timeout(8000), // MNR-3: no colgar el money-path
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        sourceAsset: input.sourceAsset,
        sourceAmount: input.amountUsd,
        destCurrency: input.destCurrency,
        destCountry: input.destCountry,
        payoutMethod: input.payoutMethod,
      }),
    });
    if (!res.ok) throw new Error(`transfi_quote_error_${res.status}`);
    const d = (await res.json()) as any;
    const quote: FxQuote = {
      rate: Number(d.rate),
      feeUsd: Number(d.fee ?? 0),
      netDeliveredLocal: Number(d.destAmount),
      localCurrency: "PEN",
      etaMinutes: Number(d.etaMinutes ?? 30),
      quoteId: String(d.quoteId ?? d.id ?? ""),
      expiresAt: String(d.expiresAt ?? ""),
      provenance: "transfi",
    };
    // BLQ-MED-2: si el mapeo (aún sandbox-unverified) produce NaN/invalidos, LANZAR —
    // nunca emitir una cotización con basura numérica que el payout ataría a un monto real.
    return assertValidQuote(quote);
  }
}

/** Fallback con FX mid REAL (open.er-api.com) + spread declarado. Corre sin keys. */
export class FallbackFxProvider implements FxQuoteProvider {
  async quote(input: FxQuoteInput): Promise<FxQuote> {
    const mid = await getUsdToPenMid(); // tasa real USD→PEN
    const effRate = mid * (1 - FALLBACK_SPREAD_BPS / 10000); // spread en contra del cliente
    const netUsd = Math.max(0, input.amountUsd - FALLBACK_FLAT_FEE_USD);
    const netDeliveredLocal = Number((netUsd * effRate).toFixed(2));
    // MNR-1 (re-AR): el fallback también pasa por el guard — un env misconfig
    // (FALLBACK_FX_* no numérico) NO debe emitir una cotización con NaN.
    return assertValidQuote({
      rate: Number(effRate.toFixed(6)),
      feeUsd: FALLBACK_FLAT_FEE_USD,
      netDeliveredLocal,
      localCurrency: "PEN",
      etaMinutes: 30,
      quoteId: `fallback-${Date.now()}`,
      // quote "vence" en 10 min (consistente con un quote real atable a un payout)
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      provenance: "local-fallback",
    });
  }
}

// ── FX mid real (open.er-api.com) con cache en memoria + fallback estático ──────
let cache: { rate: number; at: number } | null = null;
const CACHE_MS = 5 * 60_000;
const STATIC_USD_PEN = Number(process.env.STATIC_USD_PEN ?? 3.75); // fallback si la API falla

async function getUsdToPenMid(): Promise<number> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.rate;
  try {
    const res = await fetch("https://open.er-api.com/v6/latest/USD", {
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      const d = (await res.json()) as any;
      const pen = Number(d?.rates?.PEN);
      if (pen > 0) {
        cache = { rate: pen, at: Date.now() };
        return pen;
      }
    }
  } catch {
    // cae al estático
  }
  return STATIC_USD_PEN;
}

// BLQ-MED-2: guard de salida — un quote solo es válido si los montos de dinero son finitos y
// coherentes. Lanza si no (mejor fallar que atar un NaN a un desembolso real).
export function assertValidQuote(q: FxQuote): FxQuote {
  const finitePos = (n: number) => Number.isFinite(n) && n > 0;
  const finiteNonNeg = (n: number) => Number.isFinite(n) && n >= 0;
  if (!finitePos(q.rate)) throw new Error(`invalid_quote_rate:${q.rate}`);
  if (!finiteNonNeg(q.netDeliveredLocal)) throw new Error(`invalid_quote_net:${q.netDeliveredLocal}`);
  if (!finiteNonNeg(q.feeUsd)) throw new Error(`invalid_quote_fee:${q.feeUsd}`);
  if (!q.quoteId) throw new Error("invalid_quote_id");
  return q;
}

/**
 * Factory: adapter TransFi si hay key + readiness confirmado, si no el fallback (FX mid real).
 * MNR-2 (AR): el mapeo del adapter es sandbox-unverified hasta la Fase A → se exige
 * `TRANSFI_ADAPTER_READY=true` para activarlo (key sin readiness = fail-loud, no downgrade silencioso).
 */
export function getFxQuoteProvider(): FxQuoteProvider {
  const key = process.env.TRANSFI_API_KEY;
  if (!key) return new FallbackFxProvider();
  if (process.env.TRANSFI_ADAPTER_READY !== "true") {
    throw new Error(
      "transfi_adapter_not_ready: TRANSFI_API_KEY seteada pero TRANSFI_ADAPTER_READY!=true — " +
        "confirmá el mapeo de campos con el sandbox antes de activar el adapter en el money-path.",
    );
  }
  return new TransFiFxProvider(key);
}
