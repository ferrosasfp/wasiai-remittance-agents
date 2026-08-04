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
//
// ⚠️ DÓNDE VIVEN LOS GUARDS DE LA TASA (WKH-312, 2026-08-04) — LEER ANTES DE AGREGAR UNO:
// esos cinco guards protegían UN camino. `TransFiFxProvider` no atravesaba ninguno: su único
// control sobre el número era "finito y > 0", así que un socio que respondiera `rate: 37.5` —diez
// veces el mercado, con la banda en 2.5–5.0— emitía la cotización con HTTP 200 y con la etiqueta
// `transfi`, que está DENTRO de `MARKET_FX_PROVENANCES` (el camino sin verificar era, además, el
// que recibía el sello de "tasa de mercado"). Medido el 2026-08-04 sobre el código de `main`.
// La respuesta NO fue copiar la banda al otro proveedor —dos copias divergen en el primer ajuste
// de límites, y la que se olvida es siempre la del camino que nadie mira— sino repartir así:
//   · `isRateWithinBand(rate, config)` — ÚNICO criterio de banda. Lo consultan la cascada por
//     fuente (G4), el hit de caché, y la invariante de salida.
//   · `checkFreshness(dataAsOf, maxAgeMs)` — ÚNICO criterio de frescura (ya lo era desde WKH-301).
//   · `assertValidQuote(quote, config)` — LA PUERTA COMÚN: montos usables + banda + frescura. Los
//     dos proveedores salen por acá, y `config` es un parámetro REQUERIDO para que un proveedor
//     nuevo no compile sin verificar nada.
// Los límites son LOS MISMOS para los dos caminos (`FX_MID_MIN_USD_PEN` / `FX_MID_MAX_USD_PEN` /
// `FX_MID_MAX_AGE_MS`): es el mismo par de monedas y el mismo mercado, y dos bandas serían dos
// verdades sobre el mismo precio. No se agregó ninguna env nueva.

import { z } from "zod";
import { type FxConfig, resolveFxConfig } from "./fx-config";
import { resolveTransFiBaseUrl, type TransFiBaseUrl } from "./transfi-env";
import { assertTransFiCapabilityReady } from "./transfi-readiness";
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
 * ⚠️ WKH-314: el monto mínimo YA CUBRE este camino, aunque no aparezca en esta clase: se valida
 * en `runCorridorFx` (`agents/corridor-fx.ts`) antes de elegir proveedor. La primera versión lo
 * puso dentro de `LiveMidFxProvider` y dejó a este camino descubierto para el día que alguien
 * active `TRANSFI_FX_ADAPTER_READY`; el AR lo marcó y se movió al núcleo.
 *
 * ⚠️ WKH-312 — LA BANDA Y LA FRESCURA YA CUBREN ESTE CAMINO, y tampoco aparecen en esta clase:
 * viven en `assertValidQuote()`, la invariante de SALIDA por la que pasan LOS DOS proveedores.
 * Medido el 2026-08-04 antes del arreglo, con el adapter instanciado a mano: un socio que
 * respondía `rate: 37.5` (diez veces el mercado, con la banda por defecto en 2.5–5.0) emitía la
 * cotización tal cual, etiquetada `transfi` —que está dentro de `MARKET_FX_PROVENANCES`— y con
 * HTTP 200. Su único control sobre el número era "finito y > 0".
 * 🔴 NO re-agregues acá una copia de la banda: quedaría escrita en dos lados y divergiría en el
 * primer ajuste de límites, exactamente como pasó con el monto mínimo.
 *
 * QUÉ SIGUE SIN SER UN CONTROL REAL EN ESTE CAMINO, y por qué está escrito y no olvidado:
 * la FRESCURA. `rateAsOf` lo sella ESTE adapter al recibir la respuesta (ver abajo), así que el
 * guard de frescura de la salida se cumple siempre por construcción mientras el mapeo sea éste.
 * No es un guard apagado: es un guard cuyo insumo hoy lo produce el propio código. Se aplica en
 * el punto común igual —para que el día que el socio declare la fecha de SU tasa el control ya
 * esté cableado y no haya que acordarse— y está pinneado en dos tests (T-312-F1/T-312-F2).
 */
export class TransFiFxProvider implements FxQuoteProvider {
  /** `baseUrl` es OBLIGATORIO y branded: solo `resolveTransFiBaseUrl()` puede producir uno. */
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: TransFiBaseUrl,
  ) {}

  async quote(input: FxQuoteInput): Promise<FxQuote> {
    // UNA sola lectura de config por cotización, igual que `LiveMidFxProvider`: los límites con los
    // que se verifica la tasa emitida salen de la MISMA foto de la configuración.
    const config = resolveFxConfig();
    let res: Response;
    let body: unknown;
    try {
      // TODO(sandbox): confirmar el endpoint/shape exactos del quote API de TransFi.
      res = await fetch(`${this.baseUrl}/v1/quotes`, {
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
      // El `!res.ok` NO va acá adentro: un 4xx/5xx del socio ES una respuesta (tiene status, y el
      // status es la información con la que ops decide) y ya tiene su propio código estable.
      if (res.ok) body = await res.json();
    } catch {
      // 🔴 "NO PUDE PREGUNTAR" ≠ "LA TASA ES MALA". Red caída, timeout de los 8 s, TLS, o un cuerpo
      // que no es JSON: en todos esos casos NO SABEMOS la tasa, y eso se rechaza igual pero NO con
      // el código de la banda. Antes esta rama no existía y el error crudo (`TypeError: fetch
      // failed`, `TimeoutError`) subía sin clasificar hasta el route, que sólo logea `err.name`:
      // una caída de red y una tasa fuera de mercado llegaban al log indistinguibles, y alguien
      // iba a depurar un problema de precios que era un cable. Es el bug que este ecosistema ya
      // pagó caro ("no pude preguntar no es no").
      rejectQuote("transfi", TRANSFI_QUOTE_UNREACHABLE_CODE);
      throw new Error(TRANSFI_QUOTE_UNREACHABLE_CODE);
    }
    if (!res.ok) {
      // El socio SÍ contestó, y contestó que no. También es "no sé la tasa" (no hay número que
      // verificar), por eso comparte el warn con la rama de arriba y NO el código de la banda.
      rejectQuote("transfi", `transfi_quote_error_${res.status}`);
      throw new Error(`transfi_quote_error_${res.status}`);
    }
    const parsed = TransFiQuoteResponseSchema.safeParse(body);
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
      // ⚠️ EL `?? ""` YA NO ES INOCUO (2026-08-04). Este `expiresAt` entra al material FIRMADO de la
      // referencia de cotización (`quote-ref.ts`) y es la vigencia que el agente de payout hace
      // cumplir. Si el partner no lo manda, el vacío llega a `issueQuoteRef`, que LANZA
      // `quote_ref_unusable_expiry` y el route corta con 502: se prefiere no cotizar antes que
      // emitir una referencia que no vence nunca. Se conserva el `?? ""` a propósito —degradar acá
      // sigue siendo byte-idéntico a antes— porque la decisión de money-path vive en un solo lugar,
      // el emisor de la referencia, y no repartida entre los dos proveedores. Pinneado en
      // `fx.test.ts` (T-EXP-1).
      expiresAt: String(d.expiresAt ?? ""),
      provenance: "transfi",
      rateSource: "transfi",
      // El partner cotiza POR REQUEST: la tasa se genera en el momento de responder, así que acá el
      // momento de la respuesta SÍ es la fecha del dato. (Distinto del mid cacheado, donde el dato
      // es más viejo que el momento de servir y por eso conserva su fecha original.)
      rateAsOf: new Date().toISOString(),
    };
    // BLQ-MED-2 + WKH-312: la MISMA invariante de salida que el camino del mid. Acá se verifica
    // que el número que el socio mandó sea usable (finito y > 0), esté DENTRO DE LA BANDA y no sea
    // viejo. No hay un chequeo propio de este adapter: si lo hubiera, sería la segunda copia.
    return assertValidQuote(quote, config);
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
    // WKH-314 (AR): el guard del monto mínimo NO vive acá. Se mudó a `runCorridorFx`
    // (`agents/corridor-fx.ts`), antes de elegir proveedor, para que cubra también el camino
    // de TransFi en vez de proteger sólo a éste. NO lo re-agregues acá: quedaría escrito en
    // dos lados y divergiría al primer cambio del mínimo.
    const mid = await getUsdToPenMid(config); // tasa real USD→PEN, o LANZA (fail-closed)
    const effRate = mid.rate * (1 - config.spreadBps / 10000); // spread en contra del cliente
    const netUsd = Math.max(0, input.amountUsd - config.flatFeeUsd);
    const netDeliveredLocal = Number((netUsd * effRate).toFixed(2));
    // 🔴 ACÁ VIVÍA LA BANDA SOBRE LA TASA EMITIDA (WKH-301 fix-pack), inline y sólo en este
    // proveedor. Se mudó a `assertValidQuote()` (WKH-312) porque el camino del socio no pasaba por
    // ella: un guard que cada proveedor tiene que ACORDARSE de ejecutar ya se olvidó una vez.
    // NO la re-agregues acá. Dos efectos secundarios del movimiento, los dos deseables:
    //  · lo que se verifica ahora es el número REDONDEADO que efectivamente sale (`toFixed(6)`),
    //    no el intermedio de precisión completa — la banda mira lo que recibe el usuario (AC-2);
    //  · el rechazo pasa a nombrar su origen (`fx_rate_out_of_band:fx-mid-live:…`), que es lo que
    //    durante un incidente separa "nuestro margen dejó la tasa fuera de banda" de "el socio
    //    cotizó fuera de banda" — dos acciones opuestas (corregir una env vs. llamar al partner).
    // MNR-1 (re-AR): el mid también pasa por el guard — un env misconfig NO debe emitir NaN.
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
    }, config);
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

/**
 * ÚNICO criterio de banda de plausibilidad del repo (WKH-312). Antes la misma comparación estaba
 * escrita TRES veces —la cascada por fuente, el hit de caché, y la tasa emitida del mid— y ninguna
 * de las tres cubría al socio. Ahora los cuatro call sites (esos tres + la invariante de salida por
 * la que pasan los dos proveedores) preguntan acá: cambiar la forma de evaluar la banda es cambiar
 * esta función, y alcanza a todos los caminos sin edición por proveedor (AC-3).
 *
 * 🔴 La banda es un LÍMITE, jamás una tasa de reemplazo: esta función responde sí o no, y no existe
 * ninguna variante que "acomode" la tasa al borde. Fuera de banda se rechaza, no se ajusta.
 *
 * `!(a && b)` sobre las dos comparaciones y no `rate < min || rate > max`: con `rate = NaN` las dos
 * formas dan lo mismo hoy, pero la afirmativa deja el fail-closed explícito — un `NaN` NO está
 * dentro de la banda. Es la trampa que este módulo ya documentó en `assertAmountAboveMinimum`.
 */
export function isRateWithinBand(rate: number, config: FxConfig): boolean {
  return rate >= config.minRate && rate <= config.maxRate;
}

/** Warn value-free: SÓLO id de fuente + código. Nunca el body, la URL completa, ni datos del caller. */
function rejectSource(sourceId: string, code: string): void {
  console.warn("[remit-fx] fx_mid_source_rejected", { sourceId, code });
}

/**
 * Warn value-free del guard de SALIDA y del camino del socio. Va aparte de `rejectSource` a
 * propósito: aquél habla de una FUENTE que se descartó y la cascada sigue; éste habla de una
 * COTIZACIÓN que no se emite. Sólo el id de la fuente/procedencia y el código de rama; nunca el
 * body del partner, ni la URL, ni nada del caller.
 */
function rejectQuote(rateSource: string, code: string): void {
  console.warn("[remit-fx] fx_quote_rejected", { rateSource, code });
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
    isRateWithinBand(cache.rate, config)
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
    // El CRITERIO es el mismo que usa la invariante de salida (`isRateWithinBand`); lo que cambia
    // es la consecuencia: acá se descarta la fuente y la cascada sigue, allá no se emite nada.
    if (!isRateWithinBand(parsed.rate, config)) {
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

/**
 * Código del rechazo por monto POR ENCIMA del techo. Deliberadamente DISTINTO de
 * `AMOUNT_BELOW_MINIMUM_CODE`: "mandaste muy poco" y "pediste demasiado" se corrigen en
 * direcciones opuestas, y un código único dejaría al que integra sin saber para dónde mover el
 * monto. Los dos son 4xx (error del caller, reintentar igual no sirve), pero no son el mismo error.
 */
export const AMOUNT_ABOVE_MAXIMUM_CODE = "fx_amount_above_maximum";

/**
 * Guard de POLÍTICA del techo cotizable. La otra punta de `assertAmountAboveMinimum`: mismo
 * campo, misma fuente de config, mismo formato de error, y se aplican juntos en el núcleo del
 * agente para que no exista un camino que valide una punta y no la otra.
 *
 * QUÉ CIERRA, y qué NO. No cierra un desbordamiento numérico: eso ya estaba cubierto aguas abajo
 * por `assertValidQuote` (un `Infinity` corta fail-closed). Lo que cierra es el hueco ENTRE la
 * política y el desbordamiento, que era enorme: medido el 2026-07-31, un pedido por 1e6, por 1e15
 * y hasta por 1e300 devolvía 200 con una cotización perfectamente formada, en banda y fresca, que
 * el agente se comprometía a honrar por diez minutos. El sistema no se rompía; prometía.
 *
 * Por eso el techo NO puede vivir dentro del proveedor, por el mismo motivo que el mínimo se mudó
 * de `LiveMidFxProvider` al núcleo: ahí cubriría un solo camino y desaparecería el día que se
 * active el adapter del socio.
 */
export function assertAmountBelowMaximum(amountUsd: number, config: FxConfig): void {
  if (!(amountUsd <= config.maxSendUsd)) {
    // `!(a <= b)` y no `a > b`, por la misma razón que el mínimo: con `NaN` la primera forma
    // RECHAZA y la segunda ACEPTA. Acá el mínimo ya filtró el `NaN` en el núcleo, pero el guard
    // no puede depender de en qué orden lo llamen: es correcto por sí solo o no lo es.
    throw new Error(`${AMOUNT_ABOVE_MAXIMUM_CODE}:${config.maxSendUsd}`);
  }
}

/**
 * Código del rechazo por tasa FUERA DE BANDA. Lleva la PROCEDENCIA adentro (`…:transfi:37.500000`,
 * `…:fx-mid-live:2.380000`) y ésa es la parte que importa durante un incidente: "el socio cotizó
 * fuera de banda" se corrige llamando al partner y "nuestro margen dejó la tasa fuera de banda" se
 * corrige tocando una env. Un código único mandaría a la mitad de la gente al lugar equivocado.
 * El prefijo NO cambió (era el de WKH-301) para no romper nada que ya lo reconozca.
 */
export const RATE_OUT_OF_BAND_CODE = "fx_rate_out_of_band";

/**
 * Código del rechazo por tasa VIEJA (o fechada en el futuro, o con una fecha impresentable). Lleva
 * la procedencia y el veredicto de `checkFreshness` adentro: `stale`, `future` y `unparseable` no
 * son el mismo problema —los dos primeros son un dato malo, el tercero es "no sé de cuándo es"— y
 * quien mire el log tiene que poder separarlos sin adivinar.
 */
export const RATE_NOT_FRESH_CODE = "fx_rate_not_fresh";

/**
 * Código de "NO PUDE PREGUNTARLE AL SOCIO": red caída, timeout, TLS, o un cuerpo que ni siquiera
 * es JSON. Deliberadamente distinto de `RATE_OUT_OF_BAND_CODE` y de `RATE_NOT_FRESH_CODE`, que
 * afirman algo SOBRE UNA TASA QUE SÍ CONOCEMOS. Los dos rechazan la cotización, pero uno dice "el
 * precio está mal" y el otro dice "no hay precio": colapsarlos hace que mañana alguien depure una
 * caída de red buscando un problema de precios.
 */
export const TRANSFI_QUOTE_UNREACHABLE_CODE = "transfi_quote_unreachable";

/**
 * Guard de SALIDA — la ÚNICA puerta por la que pasan las cotizaciones de los DOS proveedores
 * (`TransFiFxProvider` y `LiveMidFxProvider`) antes de emitirse. Lanza si no la pasa.
 *
 * Verifica, en este orden:
 *  1. **BLQ-MED-2 — montos usables**: finitos, la tasa y lo entregado > 0, el fee >= 0, id no vacío.
 *  2. **WKH-312 — banda de plausibilidad sobre la tasa EMITIDA** (`isRateWithinBand`).
 *  3. **WKH-312 — frescura del dato** (`checkFreshness`, el mismo criterio que usan la cascada y
 *     el hit de caché).
 *
 * 🔴 EL ORDEN DE 1 ANTES DE 2 NO ES COSMÉTICO: con `rate = NaN` la banda también rechaza, pero
 * diría "fuera de banda" sobre un número que no existe. El diagnóstico correcto de un `NaN` es
 * `invalid_quote_rate` (mapeo roto), no un problema de precio de mercado. Preservar ese orden
 * mantiene además byte-idénticos los códigos que el camino del mid ya devolvía (AC-6).
 *
 * 🔴 POR QUÉ `config` ES UN PARÁMETRO REQUERIDO Y NO SE RESUELVE ACÁ ADENTRO (DT-1): resolverla
 * acá sería una SEGUNDA lectura de `process.env` por cotización, y una env a medio rotar dejaría a
 * la tasa verificada contra límites de una configuración distinta de la que la produjo. Que sea
 * requerido es además el candado: un proveedor nuevo NO COMPILA sin pasar la config, así que no
 * existe la variante "se olvidó de verificar la banda" — que es exactamente lo que pasó con el
 * camino del socio mientras la banda vivía inline en el otro proveedor.
 */
export function assertValidQuote(q: FxQuote, config: FxConfig): FxQuote {
  const finitePos = (n: number) => Number.isFinite(n) && n > 0;
  const finiteNonNeg = (n: number) => Number.isFinite(n) && n >= 0;
  if (!finitePos(q.rate)) throw new Error(`invalid_quote_rate:${q.rate}`);
  // WKH-314 (AR) — LO QUE RECIBE EL BENEFICIARIO TAMBIÉN TIENE QUE SER > 0, igual que la tasa.
  //
  // Esta línea pedía `>= 0` mientras la de arriba pedía `> 0`: se exigía que el tipo de cambio
  // fuera positivo y NO que llegara algo a destino. El mínimo enviable y su atadura con la
  // comisión acotan la PROPORCIÓN, no el monto entregado, así que un par de configuración
  // válido seguía produciendo un cero:
  //
  //     FX_MIN_SEND_USD=0.001 · FALLBACK_FX_FLAT_FEE_USD=0.0002   (exactamente el 20%: la
  //     atadura ACEPTA) · envío 0.001 (≥ el mínimo: el guard ACEPTA) ⇒ entregado 0.
  //
  // Con `finitePos` acá, "una cotización que entrega cero no es válida" pasa a ser cierto SEA
  // CUAL SEA la configuración, que es lo que el docstring de `MAX_FEE_SHARE_AT_MINIMUM` afirma.
  // Este guard es además el único punto por el que pasan LOS DOS proveedores.
  if (!finitePos(q.netDeliveredLocal)) throw new Error(`invalid_quote_net:${q.netDeliveredLocal}`);
  // El fee SÍ puede ser 0 (una remesa sin comisión es legítima); `finiteNonNeg` es correcto acá.
  if (!finiteNonNeg(q.feeUsd)) throw new Error(`invalid_quote_fee:${q.feeUsd}`);
  if (!q.quoteId) throw new Error("invalid_quote_id");

  // WKH-312 — LA BANDA, para los dos proveedores. Es la tasa que sale, no un intermedio.
  if (!isRateWithinBand(q.rate, config)) {
    rejectQuote(q.rateSource, RATE_OUT_OF_BAND_CODE);
    throw new Error(`${RATE_OUT_OF_BAND_CODE}:${q.provenance}:${q.rate.toFixed(6)}`);
  }

  // WKH-312 — LA FRESCURA, con el MISMO criterio y el MISMO límite (`FX_MID_MAX_AGE_MS`) que la
  // cascada y el hit de caché: una tasa vieja es plata mal calculada venga de donde venga.
  //
  // ⚠️ HONESTIDAD SOBRE QUÉ ATAJA HOY EN CADA CAMINO, para que nadie lea de más:
  //  · mid (en vivo o cacheado): `rateAsOf` es la fecha que declaró la FUENTE, y ya pasó por G5 /
  //    por el chequeo del hit de caché. Acá vuelve a pasar como red de seguridad del punto de
  //    salida, y no puede cambiar ningún veredicto existente (mismo criterio, mismo límite).
  //  · socio: `rateAsOf` lo sella el adapter al recibir la respuesta, porque el socio cotiza POR
  //    REQUEST y no declara la fecha de su tasa en el mapeo que hoy tenemos (sandbox-unverified).
  //    O sea que hoy este chequeo se satisface por construcción en ese camino. Está igual, y en el
  //    punto común, por dos razones: para que el día que el socio declare la fecha de su tasa el
  //    control YA esté cableado en vez de depender de que alguien se acuerde, y porque un guard que
  //    vive en un solo proveedor es precisamente lo que produjo este agujero.
  const freshness = checkFreshness(q.rateAsOf, config.maxAgeMs);
  if (freshness !== "ok") {
    rejectQuote(q.rateSource, `${RATE_NOT_FRESH_CODE}_${freshness}`);
    throw new Error(`${RATE_NOT_FRESH_CODE}:${q.provenance}:${freshness}`);
  }
  return q;
}

/**
 * Factory: adapter TransFi si hay key + readiness confirmado, si no el fallback (FX mid real).
 * MNR-2 (AR): el mapeo del adapter es sandbox-unverified hasta la Fase A → se exige el readiness
 * para activarlo (key sin readiness = fail-loud, no downgrade silencioso).
 *
 * El readiness que se exige acá es el de la capacidad `"fx"` (`TRANSFI_FX_ADAPTER_READY`), NO el
 * del desembolso. Hasta este fix las dos capacidades compartían `TRANSFI_ADAPTER_READY`, así que
 * habilitar el desembolso cambiaba de paso la FUENTE DE LA TASA en el mismo redeploy. La legada
 * sigue valiendo como paraguas mientras la específica no esté definida (ver `transfi-readiness.ts`).
 */
export function getFxQuoteProvider(): FxQuoteProvider {
  const key = process.env.TRANSFI_API_KEY;
  if (!key) return new LiveMidFxProvider();
  assertTransFiCapabilityReady("fx");
  // El ambiente se resuelve ACÁ (lazy, mismo llamado que usa `getPayoutProvider()`): sin
  // `TRANSFI_ENV` esto lanza `transfi_env_unset` en vez de apuntar a la API productiva del partner.
  return new TransFiFxProvider(key, resolveTransFiBaseUrl());
}
