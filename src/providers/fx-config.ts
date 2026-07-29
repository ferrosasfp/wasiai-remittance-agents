// FX mid — registro de fuentes y resolución de configuración.
//
// ⚠️ POR QUÉ EXISTE ESTE MÓDULO (incidente de dinero, no de etiquetas):
// el agente FX cotizaba con una CONSTANTE del código (`STATIC_USD_PEN`, default 3.75) cada vez que
// el feed fallaba, y la etiquetaba igual que una tasa de mercado. Medido el 2026-07-29 contra tres
// fuentes independientes, el mercado estaba en ~3.40: la constante estaba +10.2% por encima, así que
// la cotización PROMETÍA más soles de los que el mercado da (~140 PEN en una remesa de $400, que
// alguien tiene que poner). Este módulo provee las fuentes reales y los límites; `fx.ts` implementa
// la cascada y el fail-closed.
//
// Las 3 reglas de este módulo (en orden de importancia):
//  1. FUENTES REGISTRADAS, NO URLs LIBRES (DT-4): `FX_MID_SOURCES` nombra **ids** de un registro en
//     código, y cada fuente trae SU PROPIO parser (`er-api` lee `rates.PEN`, `currency-api` lee
//     `usd.pen`). Una env que aceptara cualquier URL *parecería* un punto de extensión y no lo es:
//     apuntarla a otra fuente daría "shape inválido" para siempre. Es el patrón del CONTROL MUERTO
//     que este ecosistema ya sufrió. Sólo el HOST es sobrescribible; el parser no.
//  2. FAIL-LOUD (AC-8): config inválida LANZA. `Number("abc")` es `NaN` y `3.75 > NaN` es `false`,
//     así que un `FX_MID_MAX_USD_PEN=abc` DESACTIVARÍA LA BANDA EN SILENCIO. Es la 5ª ocurrencia de
//     esta familia de bug en el repo: nunca cotizar con un guard apagado.
//  3. CALL-TIME, SIEMPRE (AC-9 / DT-8): se lee `process.env` en CADA cotización, nunca al importar.
//     Config leída al importar significa que rotar una env no surte efecto hasta redeploy.
//
// Exemplar: `src/providers/transfi-env.ts` (constante canónica + override por env + código de error
// estable + fail-closed sin default).

import { z } from "zod";

export interface FxSourceParsed {
  rate: number;
  /** ISO — fecha del dato SEGÚN LA FUENTE. */
  dataAsOf: string;
}

export interface FxSource {
  readonly id: string;
  readonly canonicalUrl: string;
  /** Env de override del host (mock de CI o mirror). El parser NO es sobrescribible. */
  readonly urlEnv: string;
  /** `null` = shape inválido. Incluye el caso SIN FECHA (DT-6). */
  parse(json: unknown): FxSourceParsed | null;
}

export interface FxConfig {
  readonly sources: readonly { id: string; url: string; parse: FxSource["parse"] }[];
  readonly cacheTtlMs: number;
  readonly maxAgeMs: number;
  readonly minRate: number;
  readonly maxRate: number;
  /** Spread en bps contra el cliente. Validado: la tasa emitida se deriva de él. */
  readonly spreadBps: number;
  /** Fee fijo en USD que se descuenta del monto antes de convertir. */
  readonly flatFeeUsd: number;
}

/** Monto que la fuente puede mandar como number o como string numérico. */
const NumericLike = z.union([z.number(), z.string()]);

// Los schemas son `.passthrough()` a propósito (patrón ya vigente en `fx.ts`): declaran SÓLO los
// campos que consumimos, y una fuente que agrega campos NUNCA debe romper una cotización.

/** `open.er-api.com` — tasa en `rates.PEN`, fecha en `time_last_update_unix` (segundos). */
const ErApiSchema = z
  .object({
    rates: z.object({ PEN: NumericLike.nullish() }).passthrough().nullish(),
    time_last_update_unix: NumericLike.nullish(),
  })
  .passthrough();

/** `latest.currency-api.pages.dev` — tasa en `usd.pen`, fecha en `date` (`YYYY-MM-DD`). */
const CurrencyApiSchema = z
  .object({
    usd: z.object({ pen: NumericLike.nullish() }).passthrough().nullish(),
    date: z.string().nullish(),
  })
  .passthrough();

/**
 * DT-6: una fuente que no declara la fecha de su dato se trata como SHAPE INVÁLIDO.
 * "No sé de cuándo es" no puede colapsar a "es de ahora": es justo el caso del CDN que sirve un JSON
 * congelado con un HTTP 200 reciente.
 */
function toIsoFromUnixSeconds(value: unknown): string | null {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function toIsoFromYmd(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function parseRate(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const rate = Number(value);
  return Number.isFinite(rate) ? rate : null;
}

/**
 * Registro de fuentes. Constante del MÓDULO, no env: agregar una fuente es una entrada acá
 * (+ su parser + su test), elegirla o reordenarla es configuración pura.
 */
export const FX_SOURCE_REGISTRY: readonly FxSource[] = Object.freeze([
  Object.freeze({
    id: "er-api",
    canonicalUrl: "https://open.er-api.com/v6/latest/USD",
    urlEnv: "FX_MID_ER_API_URL",
    parse(json: unknown): FxSourceParsed | null {
      const parsed = ErApiSchema.safeParse(json);
      if (!parsed.success) return null;
      const rate = parseRate(parsed.data.rates?.PEN);
      const dataAsOf = toIsoFromUnixSeconds(parsed.data.time_last_update_unix);
      if (rate === null || dataAsOf === null) return null;
      return { rate, dataAsOf };
    },
  }),
  Object.freeze({
    id: "currency-api",
    canonicalUrl: "https://latest.currency-api.pages.dev/v1/currencies/usd.json",
    urlEnv: "FX_MID_CURRENCY_API_URL",
    parse(json: unknown): FxSourceParsed | null {
      const parsed = CurrencyApiSchema.safeParse(json);
      if (!parsed.success) return null;
      const rate = parseRate(parsed.data.usd?.pen);
      const dataAsOf = toIsoFromYmd(parsed.data.date);
      if (rate === null || dataAsOf === null) return null;
      return { rate, dataAsOf };
    },
  }),
]);

/** Defaults — cada uno AFIRMA algo sobre el mundo externo (evidencia en el SDD §4.3, 2026-07-29). */
const DEFAULT_SOURCES = "er-api,currency-api";
const DEFAULT_CACHE_TTL_MS = 300000; // 5 min — preserva el CACHE_MS actual (cero cambio en ese eje)
const DEFAULT_MAX_AGE_MS = 172800000; // 48 h — el feed promete ciclo ~24 h: tolera UN ciclo perdido
const DEFAULT_MIN_USD_PEN = 2.5; // mercado 3.40 → banda ≈ −27%
const DEFAULT_MAX_USD_PEN = 5.0; // mercado 3.40 → banda ≈ +47%; ataja un cero, un orden de magnitud
//                                  o la tasa de OTRA moneda (PYG ≈ 7300, EUR ≈ 0.92)
const DEFAULT_SPREAD_BPS = 250; // 2.5% — conservador y declarado
const DEFAULT_FLAT_FEE_USD = 0.5;

function invalid(field: string): Error {
  return new Error(`fx_mid_config_invalid:${field}`);
}

/**
 * Lee un numérico de env con default. FAIL-LOUD: nunca devuelve `NaN`.
 * 🔴 PROHIBIDO cambiar esto por `Number(env) || default`: `Number("abc")` es `NaN`, y comparar
 * contra `NaN` da `false` SIEMPRE — el guard desaparecería sin que nadie se entere (AC-8).
 */
function readNumericEnv(field: string, fallback: number): number {
  const raw = process.env[field];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw invalid(field);
  return value;
}

/**
 * Resuelve la configuración FX. **Lee `process.env` EN CADA LLAMADA** (AC-9): nunca en el scope del
 * módulo, porque eso significaría que rotar una env no surte efecto hasta redeploy.
 *
 * Lanza `fx_mid_config_invalid:<campo>` ante cualquier config inválida. Cotizar con un guard
 * desactivado no es una opción.
 */
export function resolveFxConfig(): FxConfig {
  const cacheTtlMs = readNumericEnv("FX_RATE_CACHE_TTL_MS", DEFAULT_CACHE_TTL_MS);
  if (cacheTtlMs < 0) throw invalid("FX_RATE_CACHE_TTL_MS");

  const maxAgeMs = readNumericEnv("FX_MID_MAX_AGE_MS", DEFAULT_MAX_AGE_MS);
  if (maxAgeMs <= 0) throw invalid("FX_MID_MAX_AGE_MS");

  const minRate = readNumericEnv("FX_MID_MIN_USD_PEN", DEFAULT_MIN_USD_PEN);
  if (minRate <= 0) throw invalid("FX_MID_MIN_USD_PEN");

  const maxRate = readNumericEnv("FX_MID_MAX_USD_PEN", DEFAULT_MAX_USD_PEN);
  // `max <= min` es una banda vacía: ninguna tasa la satisface y toda cotización fallaría.
  if (maxRate <= minRate) throw invalid("FX_MID_MAX_USD_PEN");

  // El spread y el fee fijo son los DOS números que multiplican y restan la plata prometida:
  // `effRate = mid * (1 - spreadBps/10000)`. La banda de plausibilidad valida el MID, no la tasa
  // EMITIDA, y `assertValidQuote` sólo exige finito y > 0 — así que sin esta validación un valor
  // finito pero absurdo produce una tasa que nadie verificó, con etiqueta `fx-mid-live` y HTTP 200.
  // Medido contra un mid de mercado de 3.40 antes de este arreglo: −1000 bps emitía 3.74 (+10.0%,
  // NUMÉRICAMENTE EL MISMO INCIDENTE que originó la HU, por otra puerta), −10000 emitía 6.8 (el
  // doble), y 9999 emitía 0.00034 (0.14 PEN por 400 dólares). Sólo el no-numérico se atajaba.
  const spreadBps = readNumericEnv("FALLBACK_FX_SPREAD_BPS", DEFAULT_SPREAD_BPS);
  // Negativo = pagar MÁS que el mercado (regalar plata que alguien tiene que poner).
  // >= 10000 = anular la tasa (o invertirla): el cliente recibe ~nada.
  if (!(spreadBps >= 0 && spreadBps < 10000)) throw invalid("FALLBACK_FX_SPREAD_BPS");

  // Un fee negativo le SUMA al monto convertido (entrega de más); no tiene lectura legítima.
  const flatFeeUsd = readNumericEnv("FALLBACK_FX_FLAT_FEE_USD", DEFAULT_FLAT_FEE_USD);
  if (flatFeeUsd < 0) throw invalid("FALLBACK_FX_FLAT_FEE_USD");

  const rawSources = process.env.FX_MID_SOURCES;
  const idList = (rawSources === undefined || rawSources.trim() === "" ? DEFAULT_SOURCES : rawSources)
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");
  // Una lista vacía dejaría la cascada sin fuentes EN SILENCIO: es config inválida, no "cero fuentes".
  if (idList.length === 0) throw invalid("FX_MID_SOURCES");

  const sources = idList.map((id) => {
    const source = FX_SOURCE_REGISTRY.find((candidate) => candidate.id === id);
    // Un id no registrado NO puede degradar a "lo salteo": sería quedarse sin fuentes sin avisar.
    if (source === undefined) throw invalid("FX_MID_SOURCES");
    const override = process.env[source.urlEnv];
    const url = override !== undefined && override.trim() !== "" ? override.trim() : source.canonicalUrl;
    return { id: source.id, url, parse: source.parse };
  });

  return { sources, cacheTtlMs, maxAgeMs, minRate, maxRate, spreadBps, flatFeeUsd };
}
