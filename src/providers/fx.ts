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
import { type FxConfig, resolveFxConfig } from "./fx-config";
import { resolveTransFiBaseUrl, type TransFiBaseUrl } from "./transfi-env";
import type { FxProvenance, FxQuote, FxQuoteInput, FxQuoteProvider } from "./types";

// 🔴 NO existe acá ninguna constante de host de TransFi, y este archivo NO lee `TRANSFI_BASE_URL`.
// Antes había un `process.env.TRANSFI_BASE_URL ?? "https://api.transfi.com"` (¡PRODUCCIÓN del
// partner!) que contradecía el default sandbox de `payout.ts`: la misma env, dos ambientes.
// El host llega ahora inyectado como `TransFiBaseUrl` (branded) desde `transfi-env.ts`, que es la
// única fuente de verdad. Volver a poner un default local acá no compila como argumento del
// adapter y además pone en rojo `transfi-env.test.ts` (test estructural).
// 🔴 ACÁ VIVÍAN `FALLBACK_SPREAD_BPS` y `FALLBACK_FLAT_FEE_USD`, leídos AL IMPORTAR y SIN validar.
// Se mudaron a `resolveFxConfig()` (call-time + rango), que es donde ya viven los otros cinco guards.
// Por qué importaba: la tasa que se emite es `mid * (1 - spread/10000)`, y la banda de plausibilidad
// valida el MID, no la tasa emitida. Un spread finito pero absurdo se colaba entero: −1000 bps sobre
// un mid de 3.40 emitía 3.74 (+10.0%), que es NUMÉRICAMENTE EL MISMO ERROR que la constante 3.75 que
// esta HU vino a matar — con etiqueta `fx-mid-live` y HTTP 200. Además, leerlas al importar hacía que
// rotarlas no surtiera efecto hasta redeployar, justo lo que AC-9/DT-8 prohíben.

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

/**
 * Adapter TransFi — activo con TRANSFI_API_KEY. Devuelve la tasa efectiva real del corredor.
 *
 * ⚠️ WKH-314: este camino NO aplica el monto mínimo, a propósito y con ticket. Hoy no es
 * alcanzable (exige `TRANSFI_ADAPTER_READY=true`, que además falla ruidoso si falta), y meter
 * acá una segunda llamada a `resolveFxConfig()` duplicaría el guard justo cuando **WKH-312**
 * está por mover TODA la familia de controles de este camino a un punto de salida común. El
 * mínimo viaja con ellos. Si WKH-312 se cierra sin llevárselo, este camino queda sin mínimo:
 * está anotado en su work-item.
 */
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
    // UNA sola lectura de config por cotización (AC-9): el mid y el precio tienen que salir de la
    // MISMA config. Dos lecturas podrían leer una env a medio rotar y mezclar dos configuraciones.
    const config = resolveFxConfig();
    // WKH-314 — el monto mínimo, ANTES de salir a buscar la tasa: un envío que vamos a
    // rechazar no justifica un fetch al feed.
    assertAmountAboveMinimum(input.amountUsd, config);
    const mid = await getUsdToPenMid(config); // tasa real USD→PEN, o LANZA (fail-closed)
    const effRate = mid.rate * (1 - config.spreadBps / 10000); // spread en contra del cliente
    const netUsd = Math.max(0, input.amountUsd - config.flatFeeUsd);
    const netDeliveredLocal = Number((netUsd * effRate).toFixed(2));
    // La tasa EMITIDA pasa por la misma banda que el mid. El mid ya está en banda y el spread está
    // acotado a [0, 10000), así que esto sólo puede dispararse con un spread grande-pero-válido
    // (p.ej. 3000 bps sobre 3.40 ⇒ 2.38, por debajo del piso): lo que sale al usuario se verifica,
    // no sólo lo que entró. La banda es un límite, NUNCA una tasa de reemplazo (no hay clamp acá).
    if (effRate < config.minRate || effRate > config.maxRate) {
      throw new Error(`fx_rate_out_of_band:${effRate.toFixed(6)}`);
    }
    // MNR-1 (re-AR): el fallback también pasa por el guard — un env misconfig
    // NO debe emitir una cotización con NaN.
    return assertValidQuote({
      rate: Number(effRate.toFixed(6)),
      feeUsd: config.flatFeeUsd,
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

/**
 * Edad del dato en ms, según la fecha que declara la fuente. `null` si la fecha no es parseable.
 *
 * Devolver `NaN` era peor que devolver un error: `NaN > maxAgeMs` es `false` (el guard de frescura
 * ACEPTABA) y `NaN <= maxAgeMs` también es `false` (la caché RECHAZABA). El mismo dato roto movía
 * los dos controles en direcciones opuestas, y el que fallaba abierto era el que emite la tasa.
 * Con `null` el caller está OBLIGADO a decidir explícitamente, y las dos decisiones son rechazar.
 */
function ageOf(dataAsOf: string): number | null {
  const parsed = Date.parse(dataAsOf);
  if (!Number.isFinite(parsed)) return null;
  return Date.now() - parsed;
}

/**
 * Tolerancia de desfasaje de reloj entre nuestro server y la fuente. Una fecha levemente futura es
 * skew normal; una fecha MUY futura desactiva el guard de frescura para siempre (edad negativa nunca
 * supera el máximo), que es justo lo que el guard existe para atajar.
 */
const MAX_CLOCK_SKEW_MS = 120_000; // 2 min

/**
 * Veredicto de frescura del dato. Existe para que la caché y el guard G5 usen EXACTAMENTE el mismo
 * criterio: antes cada uno escribía su propia comparación y con una fecha rota se movían en
 * direcciones opuestas (la caché rechazaba, el guard aceptaba).
 */
export type FreshnessVerdict = "ok" | "unparseable" | "stale" | "future";

/**
 * Exportada para poder testearla DIRECTO, igual que `assertValidQuote` (mismo criterio en este
 * archivo: los guards de dinero se testean como unidad, no sólo por su efecto). La rama
 * `unparseable` es hoy inalcanzable desde afuera —los parsers de las fuentes validan la fecha antes
 * de llegar acá— y precisamente por eso necesita un test directo: es la que fallaba ABIERTA.
 */
export function checkFreshness(dataAsOf: string, maxAgeMs: number): FreshnessVerdict {
  const age = ageOf(dataAsOf);
  if (age === null) return "unparseable";
  if (age > maxAgeMs) return "stale";
  // Fecha por delante de nuestro reloj más allá del skew tolerable: una fuente que sella hacia
  // adelante tendría edad negativa PARA SIEMPRE, y una edad negativa nunca supera el máximo — el
  // guard de frescura quedaría permanentemente desactivado para ella.
  if (age < -MAX_CLOCK_SKEW_MS) return "future";
  return "ok";
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
async function getUsdToPenMid(config: FxConfig): Promise<MidRate> {
  // La config llega YA resuelta por el caller (call-time, AC-9): rotar una env surte efecto en la
  // próxima cotización, sin redeploy. Si es inválida, `resolveFxConfig()` ya lanzó antes de llegar
  // acá — nunca se cotiza con un guard desactivado.

  // (1) Caché servible en los TRES ejes vigentes AHORA: TTL de la caché, edad del dato y BANDA.
  // El TTL no revive un dato viejo: una tasa traída hace 1 minuto pero con fecha de hace 5 días
  // sigue siendo vieja. Y la banda se re-evalúa contra la config ACTUAL, no contra la que regía
  // cuando se cacheó: estrechar la banda es la única maniobra de tiempo real que tiene un operador
  // frente a un incidente de tasa (AC-9, sin redeploy), y si la caché la ignorara seguiría sirviendo
  // hasta 5 minutos una tasa que el operador acaba de declarar inaceptable. Simétrico con la edad,
  // donde esto ya se hacía (T16).
  if (
    cache !== null &&
    cache.fetchedAt + config.cacheTtlMs > Date.now() &&
    checkFreshness(cache.dataAsOf, config.maxAgeMs) === "ok" &&
    cache.rate >= config.minRate &&
    cache.rate <= config.maxRate
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
    // Mira en las DOS direcciones: un dato viejo no sirve, y uno fechado en el futuro tampoco —
    // ese desactivaría el guard de forma permanente para esa fuente (edad negativa < máximo).
    const freshness = checkFreshness(parsed.dataAsOf, config.maxAgeMs);
    if (freshness !== "ok") {
      rejectSource(
        source.id,
        freshness === "stale"
          ? "fx_mid_stale_data"
          : freshness === "future"
            ? "fx_mid_future_data"
            : "fx_mid_bad_date",
      );
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

/**
 * Prefijo del error de monto por debajo del mínimo. Exportado para que la ruta HTTP pueda
 * distinguirlo SIN parsear prosa: es un error del CALLER (mandó poco), no una indisponibilidad
 * del servicio, y esa diferencia decide si reintentar sirve de algo. El valor del mínimo viaja
 * después de los dos puntos, en el mismo formato que el resto de los códigos del módulo.
 */
export const AMOUNT_BELOW_MINIMUM_CODE = "fx_amount_below_minimum";

/**
 * WKH-314 — guard de POLÍTICA sobre el monto enviado. Lanza si el envío no llega al mínimo.
 *
 * ⚠️ ES DELIBERADAMENTE INDEPENDIENTE DE LA FÓRMULA DE LA COTIZACIÓN, y ésa es toda la
 * idea. El invariante de Chaski (`assertReceiveConsistent`) NO puede atajar este caso, no por
 * estar mal escrito sino por su forma: recalcula `max(0, enviado − comisión) × tasa` y lo
 * compara contra lo entregado, así que para 40 centavos su esperado también da cero y
 * COINCIDE. Un control que reimplementa la operación que vigila sólo detecta discrepancias de
 * transporte, nunca un error que está DENTRO de la fórmula.
 *
 * Por eso acá no se recalcula nada: se compara el monto contra un límite de política. Si en
 * vez de esto se "arreglara" el invariante para que atrape el cero, el número quedaría escrito
 * en dos lados y divergiría en el primer cambio.
 *
 * Exportada para testearla directo, mismo criterio que `assertValidQuote` y `checkFreshness`.
 */
export function assertAmountAboveMinimum(amountUsd: number, config: FxConfig): void {
  if (!(amountUsd >= config.minSendUsd)) {
    // `!(a >= b)` y no `a < b`: con `amountUsd = NaN` la primera forma RECHAZA y la segunda
    // ACEPTA. Es la misma trampa que este módulo ya documentó para la banda y la frescura.
    throw new Error(`${AMOUNT_BELOW_MINIMUM_CODE}:${config.minSendUsd}`);
  }
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
