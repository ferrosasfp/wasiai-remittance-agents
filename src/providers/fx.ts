// FX / Corridor quote provider — TransFi adapter + tasa mid REAL de fuentes registradas.
//
// ⚠️ QUÉ CAMBIÓ Y POR QUÉ (incidente de dinero):
// hasta esta HU, cuando el feed fallaba se cotizaba con una CONSTANTE del código
// (`STATIC_USD_PEN`, default 3.75) y se etiquetaba `"local-fallback"`, IGUAL que una tasa de
// mercado. Medido el 2026-07-29 contra tres fuentes, el mercado estaba en ~3.40: la constante
// estaba +10.2% por encima, así que la cotización PROMETÍA más soles de los que el mercado da
// (~140 PEN en una remesa de $400 que alguien tiene que poner). Peor: de los 3 caminos que
// devolvían la constante, uno era completamente silencioso (un `catch {}`).
//
// Ahora: cascada de fuentes registradas con 5 guards y FAIL-CLOSED. Si ninguna fuente sirve y no
// hay caché fresca, se LANZA (el route lo mapea a 502 `quote_unavailable`). No existe una rama que
// devuelva "algo igual": una cotización que nadie puede respaldar es peor que no cotizar.
//
// 🔴 PROHIBIDO reintroducir cualquier constante de tasa acá. La banda de plausibilidad NO es una
// tasa: es un límite, y vive en `fx-config.ts`.

import { z } from "zod";
import { resolveFxConfig } from "./fx-config";
import { resolveTransFiBaseUrl, type TransFiBaseUrl } from "./transfi-env";
import type { FxProvenance, FxQuote, FxQuoteInput, FxQuoteProvider } from "./types";

// 🔴 NO existe acá ninguna constante de host de TransFi, y este archivo NO lee `TRANSFI_BASE_URL`.
// Antes había un `process.env.TRANSFI_BASE_URL ?? "https://api.transfi.com"` (¡PRODUCCIÓN del
// partner!) que contradecía el default sandbox de `payout.ts`: la misma env, dos ambientes.
// El host llega ahora inyectado como `TransFiBaseUrl` (branded) desde `transfi-env.ts`, que es la
// única fuente de verdad. Volver a poner un default local acá no compila como argumento del
// adapter y además pone en rojo `transfi-env.test.ts` (test estructural).
// spread del fallback (bps) — conservador, declarado. TransFi reemplaza esto con su tasa real.
const FALLBACK_SPREAD_BPS = Number(process.env.FALLBACK_FX_SPREAD_BPS ?? 250); // 2.5%
const FALLBACK_FLAT_FEE_USD = Number(process.env.FALLBACK_FX_FLAT_FEE_USD ?? 0.5);

// ── Shape de las respuestas EXTERNAS ─────────────────────────────────────────
// Reemplazan al cast crudo sin validar que había sobre `res.json()`. Dos reglas:
//  1. Declaran SOLO los campos que ESTE archivo consume, y son `.passthrough()`: un partner que
//     agrega campos NUNCA debe romper una cotización (los schemas no son un contrato de exclusión).
//  2. Son PERMISIVOS a propósito y NO deciden si el quote es usable: esa decisión sigue siendo
//     exclusivamente de `assertValidQuote()` (BLQ-MED-2). El schema solo hace explícito el shape
//     que el código ya asumía; no mueve el guard de dinero de lugar.
// Los nombres de campo siguen siendo sandbox-unverified — los fija el TODO(sandbox) de quote().

/** Monto que el partner puede mandar como number o como string numérico (`Number()` los coerce). */
const NumericLike = z.union([z.number(), z.string()]);
/** Id/fecha que el partner puede mandar como string o number (`String()` lo coerce, como antes). */
const StringLike = z.union([z.string(), z.number()]);

/**
 * Respuesta del quote API de TransFi.
 * TODOS los campos son `.nullish()` A PROPÓSITO: así un campo ausente/null degrada byte-idéntico
 * al comportamiento anterior (`Number(undefined)` → NaN → `invalid_quote_rate` en assertValidQuote)
 * en vez de introducir un throw nuevo en un flujo que ya fallaba de otra forma.
 */
const TransFiQuoteResponseSchema = z
  .object({
    rate: NumericLike.nullish(),
    fee: NumericLike.nullish(),
    destAmount: NumericLike.nullish(),
    etaMinutes: NumericLike.nullish(),
    quoteId: StringLike.nullish(),
    id: StringLike.nullish(),
    expiresAt: StringLike.nullish(),
  })
  .passthrough();

// Los schemas del feed FX se mudaron a `fx-config.ts`: cada fuente registrada trae SU parser
// (`er-api` lee `rates.PEN`, `currency-api` lee `usd.pen`). Tener el parser acá fijo a un solo
// shape es lo que convertía a una URL configurable en un control muerto.

/** Adapter TransFi — activo con TRANSFI_API_KEY. Devuelve la tasa efectiva real del corredor. */
export class TransFiFxProvider implements FxQuoteProvider {
  /** `baseUrl` es OBLIGATORIO y branded: solo `resolveTransFiBaseUrl()` puede producir uno. */
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: TransFiBaseUrl,
  ) {}

  async quote(input: FxQuoteInput): Promise<FxQuote> {
    // TODO(sandbox): confirmar el endpoint/shape exactos del quote API de TransFi.
    const res = await fetch(`${this.baseUrl}/v1/quotes`, {
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
    const parsed = TransFiQuoteResponseSchema.safeParse(await res.json());
    // Shape NO reconocible (body que no es objeto, o un campo escalar que vino como objeto/array):
    // se corta ACÁ con un error tipado. Antes moría igual (`Number({})` → NaN → invalid_quote_rate),
    // pero sin distinguir "el partner cambió el contrato" de "el partner cotizó cualquier cosa".
    // Sigue siendo un throw, como antes: NUNCA emitir un quote a partir de un shape desconocido.
    if (!parsed.success) throw new Error("transfi_quote_bad_shape");
    const d = parsed.data;
    const quote: FxQuote = {
      rate: Number(d.rate),
      feeUsd: Number(d.fee ?? 0),
      netDeliveredLocal: Number(d.destAmount),
      localCurrency: "PEN",
      etaMinutes: Number(d.etaMinutes ?? 30),
      quoteId: String(d.quoteId ?? d.id ?? ""),
      expiresAt: String(d.expiresAt ?? ""),
      provenance: "transfi",
      rateSource: "transfi",
      // El partner cotiza POR REQUEST: la tasa se genera en el momento de responder, así que acá el
      // momento de la respuesta SÍ es la fecha del dato. (Distinto del mid cacheado, donde el dato
      // es más viejo que el momento de servir y por eso conserva su fecha original.)
      rateAsOf: new Date().toISOString(),
    };
    // BLQ-MED-2: si el mapeo (aún sandbox-unverified) produce NaN/invalidos, LANZAR —
    // nunca emitir una cotización con basura numérica que el payout ataría a un monto real.
    return assertValidQuote(quote);
  }
}

/**
 * Proveedor de tasa mid REAL (fuentes registradas) + spread declarado. Corre sin keys.
 *
 * Ya no se llama `FallbackFxProvider`: no es un fallback, es el proveedor de tasa de mercado. La
 * palabra "fallback" es justamente la que hizo que nadie mirara que abajo había una constante.
 */
export class LiveMidFxProvider implements FxQuoteProvider {
  async quote(input: FxQuoteInput): Promise<FxQuote> {
    const mid = await getUsdToPenMid(); // tasa real USD→PEN, o LANZA (fail-closed)
    const effRate = mid.rate * (1 - FALLBACK_SPREAD_BPS / 10000); // spread en contra del cliente
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
      quoteId: `fxmid-${Date.now()}`,
      // quote "vence" en 10 min (consistente con un quote real atable a un payout)
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      // La procedencia la decide de dónde salió el mid: en vivo o de la caché fresca. Nunca colapsan.
      provenance: mid.provenance,
      rateSource: mid.sourceId,
      // La fecha del DATO según la fuente — no el momento de servir (ver getUsdToPenMid).
      rateAsOf: mid.dataAsOf,
    });
  }
}

// ── FX mid real: cascada de fuentes registradas + caché con metadata ─────────────

/** Tasa mid con su procedencia auditable. `dataAsOf` es la fecha del dato SEGÚN LA FUENTE. */
interface MidRate {
  rate: number;
  sourceId: string;
  dataAsOf: string;
  provenance: FxProvenance;
}

/**
 * Caché en memoria. Guarda la METADATA además de la tasa: sin `sourceId`/`dataAsOf` una respuesta
 * cacheada no podría declarar de dónde salió ni de cuándo es el dato.
 */
let cache: { rate: number; sourceId: string; dataAsOf: string; fetchedAt: number } | null = null;

/** Edad del dato en ms, según la fecha que declara la fuente. */
function ageOf(dataAsOf: string): number {
  return Date.now() - Date.parse(dataAsOf);
}

/** Warn value-free: SÓLO id de fuente + código. Nunca el body, la URL completa, ni datos del caller. */
function rejectSource(sourceId: string, code: string): void {
  console.warn("[remit-fx] fx_mid_source_rejected", { sourceId, code });
}

/**
 * Devuelve la tasa mid USD→PEN, o **LANZA**.
 *
 * 🔴 NO EXISTE UNA RAMA 4. No hay caché vencida servida, no hay constante estática, no hay
 * "devolver algo igual". Una caché vencida es la constante estática con mejor pedigrí: un número
 * que nadie puede respaldar en el momento de usarlo. Al vencer se re-fetchea; si el fetch falla,
 * se falla.
 */
async function getUsdToPenMid(): Promise<MidRate> {
  // Config CALL-TIME (AC-9): rotar una env surte efecto en la próxima cotización, sin redeploy.
  // Si la config es inválida esto LANZA — nunca se cotiza con un guard desactivado.
  const config = resolveFxConfig();

  // (1) Caché fresca en los DOS ejes: TTL de la caché y edad del dato. El TTL no revive un dato
  // viejo: una tasa traída hace 1 minuto pero con fecha de hace 5 días sigue siendo vieja.
  if (
    cache !== null &&
    cache.fetchedAt + config.cacheTtlMs > Date.now() &&
    ageOf(cache.dataAsOf) <= config.maxAgeMs
  ) {
    return {
      rate: cache.rate,
      sourceId: cache.sourceId,
      // La fecha ORIGINAL del dato. Poner acá el momento de servir sería mentir sobre la frescura:
      // el mismo pecado que esta HU viene a matar, un nivel más abajo.
      dataAsOf: cache.dataAsOf,
      provenance: "fx-mid-cached",
    };
  }

  // (2) Cascada: cada fuente en el orden configurado. Ninguna tiene camino privilegiado.
  for (const source of config.sources) {
    let json: unknown;
    try {
      const res = await fetch(source.url, { signal: AbortSignal.timeout(4000) });
      // G1 — no-2xx
      if (!res.ok) {
        rejectSource(source.id, `fx_mid_http_${res.status}`);
        continue;
      }
      json = await res.json();
    } catch {
      // G1 — el fetch tiró (red caída, timeout, JSON ilegible). Antes esto era un `catch {}` mudo
      // que devolvía la constante: el camino más caro del bug, y el único sin ninguna traza.
      rejectSource(source.id, "fx_mid_fetch_failed");
      continue;
    }

    // G2 — shape inválido. Incluye el caso SIN FECHA declarada (DT-6).
    const parsed = source.parse(json);
    if (parsed === null) {
      rejectSource(source.id, "fx_mid_bad_shape");
      continue;
    }

    // G3 — tasa usable
    if (!(Number.isFinite(parsed.rate) && parsed.rate > 0)) {
      rejectSource(source.id, "fx_mid_no_usable_pen_rate");
      continue;
    }

    // G4 — banda de plausibilidad. Ataja un cero, un orden de magnitud, o la tasa de OTRA moneda.
    if (parsed.rate < config.minRate || parsed.rate > config.maxRate) {
      rejectSource(source.id, "fx_mid_out_of_band");
      continue;
    }

    // G5 — frescura del DATO (no del HTTP): un 200 reciente con un JSON congelado no es "en vivo".
    if (ageOf(parsed.dataAsOf) > config.maxAgeMs) {
      rejectSource(source.id, "fx_mid_stale_data");
      continue;
    }

    cache = {
      rate: parsed.rate,
      sourceId: source.id,
      dataAsOf: parsed.dataAsOf,
      fetchedAt: Date.now(),
    };
    return {
      rate: parsed.rate,
      sourceId: source.id,
      dataAsOf: parsed.dataAsOf,
      provenance: "fx-mid-live",
    };
  }

  // (3) Fail-closed. El route mapea cualquier throw a 502 `quote_unavailable`.
  throw new Error(`fx_mid_unavailable:${config.sources.length}`);
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
  if (!key) return new LiveMidFxProvider();
  if (process.env.TRANSFI_ADAPTER_READY !== "true") {
    throw new Error(
      "transfi_adapter_not_ready: TRANSFI_API_KEY seteada pero TRANSFI_ADAPTER_READY!=true — " +
        "confirmá el mapeo de campos con el sandbox antes de activar el adapter en el money-path.",
    );
  }
  // El ambiente se resuelve ACÁ (lazy, mismo llamado que usa `getPayoutProvider()`): sin
  // `TRANSFI_ENV` esto lanza `transfi_env_unset` en vez de apuntar a la API productiva del partner.
  return new TransFiFxProvider(key, resolveTransFiBaseUrl());
}
