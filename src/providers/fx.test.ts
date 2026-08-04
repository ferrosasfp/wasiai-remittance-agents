import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  LiveMidFxProvider,
  TransFiFxProvider,
  assertValidQuote,
  checkFreshness,
  getFxQuoteProvider,
  isRateWithinBand,
} from "./fx";
import type { FxConfig } from "./fx-config";
import { resolveTransFiBaseUrl, type TransFiBaseUrl } from "./transfi-env";
import { MARKET_FX_PROVENANCES, type FxQuote, type FxQuoteInput } from "./types";

/**
 * Config EXPLÍCITA para los tests del guard de salida (WKH-312).
 *
 * ⚠️ LOS NÚMEROS SON LITERALES ESCRITOS ACÁ, a propósito: si el test resolviera la config con
 * `resolveFxConfig()` estaría comparando la salida del código contra los mismos límites que el
 * código usó, y aplaudiría cualquier banda —incluida una vacía o una desactivada. El valor
 * esperado tiene que venir de AFUERA. Cada caso además dice qué número está probando contra qué
 * límite, para que se lea sin reconstruir la aritmética.
 */
function testFxConfig(overrides: Partial<FxConfig> = {}): FxConfig {
  return {
    sources: [],
    cacheTtlMs: 0,
    maxAgeMs: 48 * 3600_000, // 48 h
    minRate: 2.5,
    maxRate: 5,
    spreadBps: 250,
    flatFeeUsd: 0.5,
    minSendUsd: 5,
    maxSendUsd: 10000,
    ...overrides,
  };
}

// ── Cuerpos de feed con FECHA DECLARADA ──────────────────────────────────────
// Toda fuente registrada DEBE declarar la fecha de su dato: un feed sin fecha es shape inválido
// (no se puede afirmar frescura de un dato que no dice cuándo se produjo). Por eso todos los
// stubs de este archivo la traen.

/** `er-api`: tasa en `rates.PEN`, fecha en `time_last_update_unix` (segundos). */
function erBody(pen: number, ageMs = 0): unknown {
  return {
    rates: { PEN: pen },
    time_last_update_unix: Math.floor((Date.now() - ageMs) / 1000),
  };
}

/** `currency-api`: tasa en `usd.pen`, fecha en `date` (`YYYY-MM-DD`). */
function currencyBody(pen: number, ageMs = 0): unknown {
  const d = new Date(Date.now() - ageMs);
  return { usd: { pen }, date: d.toISOString().slice(0, 10) };
}

/**
 * Mint del host de sandbox para los tests. Usa el resolvedor REAL (no un cast) a propósito: el tipo
 * `TransFiBaseUrl` es branded, así que este helper es la prueba de que el ÚNICO camino a un host de
 * TransFi pasa por `resolveTransFiBaseUrl()`, incluso desde los tests.
 */
function mintSandboxBaseUrl(): TransFiBaseUrl {
  const previous = process.env.TRANSFI_ENV;
  process.env.TRANSFI_ENV = "sandbox";
  try {
    return resolveTransFiBaseUrl();
  } finally {
    if (previous === undefined) delete process.env.TRANSFI_ENV;
    else process.env.TRANSFI_ENV = previous;
  }
}
const SANDBOX_BASE = mintSandboxBaseUrl();

const goodQuote: FxQuote = {
  rate: 3.7,
  feeUsd: 0.5,
  netDeliveredLocal: 368,
  localCurrency: "PEN",
  etaMinutes: 30,
  quoteId: "q1",
  expiresAt: new Date().toISOString(),
  provenance: "transfi",
  rateSource: "transfi",
  rateAsOf: new Date().toISOString(),
};

describe("assertValidQuote (BLQ-MED-2: no NaN en montos)", () => {
  it("pasa un quote válido", () => {
    expect(assertValidQuote(goodQuote, testFxConfig())).toBe(goodQuote);
  });
  it("lanza si rate = NaN", () => {
    expect(() => assertValidQuote({ ...goodQuote, rate: NaN }, testFxConfig())).toThrow(
      /invalid_quote_rate/,
    );
  });
  it("lanza si netDeliveredLocal = NaN", () => {
    expect(() => assertValidQuote({ ...goodQuote, netDeliveredLocal: NaN }, testFxConfig())).toThrow(
      /invalid_quote_net/,
    );
  });
  it("lanza si quoteId vacío", () => {
    expect(() => assertValidQuote({ ...goodQuote, quoteId: "" }, testFxConfig())).toThrow(
      /invalid_quote_id/,
    );
  });

  // WKH-314 (AR) — la asimetría que quedaba: se exigía tasa > 0 pero entregado >= 0.
  it("T-314-FP1-a: lanza si netDeliveredLocal = 0 (una cotización que no entrega nada no es válida)", () => {
    expect(() => assertValidQuote({ ...goodQuote, netDeliveredLocal: 0 }, testFxConfig())).toThrow(
      /invalid_quote_net/,
    );
  });

  it("T-314-FP1-b: el fee SÍ puede ser 0 — una remesa sin comisión es legítima", () => {
    expect(assertValidQuote({ ...goodQuote, feeUsd: 0 }, testFxConfig())).toBeTruthy();
  });

  // WKH-312 — el ORDEN de los guards dentro de la puerta común. Una tasa `NaN` también está fuera
  // de la banda, así que si la banda corriera primero el diagnóstico de un mapeo roto sería "el
  // precio está fuera de mercado". Este test fija que el `NaN` sigue saliendo por su propia puerta.
  it("T-312-ORD: una tasa NaN sigue siendo invalid_quote_rate, NO fuera de banda", () => {
    expect(() => assertValidQuote({ ...goodQuote, rate: NaN }, testFxConfig())).toThrow(
      /invalid_quote_rate/,
    );
    expect(() => assertValidQuote({ ...goodQuote, rate: NaN }, testFxConfig())).not.toThrow(
      /fx_rate_out_of_band/,
    );
  });
});

describe("LiveMidFxProvider (FX mid real + spread en contra del cliente)", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => erBody(3.8) })),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("aplica spread en contra del cliente + devuelve quote válido", async () => {
    const q = await new LiveMidFxProvider().quote({
      amountUsd: 100,
      sourceAsset: "USDC",
      destCurrency: "PEN",
      destCountry: "PE",
      payoutMethod: "yape",
    });
    expect(MARKET_FX_PROVENANCES.has(q.provenance)).toBe(true);
    expect(q.rate).toBeGreaterThan(3.6);
    expect(q.rate).toBeLessThan(3.8); // spread reduce lo que recibe el cliente
    expect(Number.isFinite(q.netDeliveredLocal)).toBe(true);
    expect(q.netDeliveredLocal).toBeGreaterThan(0);
  });

  // CD-5: `MARKET_FX_PROVENANCES` es la ÚNICA fuente de "¿esta tasa es de mercado?". Todo lo demás
  // la consulta con `.has(...)`, que prueba el CABLEADO pero no el CONTENIDO: agregando
  // "local-fallback" al set, el tipo se amplía, compila limpio y la suite entera queda verde — la
  // etiqueta que esta HU existe para retirar vuelve a la lista sin que nada se entere. Este assert
  // fija el contenido exacto, que es la parte que ningún `.has()` puede defender.
  it("CD-5: el contenido de MARKET_FX_PROVENANCES es exactamente el declarado (no sólo 'algo tiene')", () => {
    expect([...MARKET_FX_PROVENANCES].sort()).toEqual([
      "fx-mid-cached",
      "fx-mid-live",
      "transfi",
    ]);
    // La etiqueta retirada NO puede volver por acá: era la constante 3.75, +10.2% sobre el mercado.
    expect([...MARKET_FX_PROVENANCES]).not.toContain("local-fallback");
  });
});

describe("getFxQuoteProvider factory (MNR-2: readiness fail-loud)", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("sin key → proveedor de mid real", () => {
    vi.stubEnv("TRANSFI_API_KEY", "");
    expect(getFxQuoteProvider()).toBeInstanceOf(LiveMidFxProvider);
  });
  it("key SIN readiness → throws", () => {
    vi.stubEnv("TRANSFI_API_KEY", "k");
    vi.stubEnv("TRANSFI_ADAPTER_READY", "");
    expect(() => getFxQuoteProvider()).toThrow(/transfi_adapter_not_ready/);
  });
  it("key + readiness + TRANSFI_ENV → adapter TransFi", () => {
    vi.stubEnv("TRANSFI_API_KEY", "k");
    vi.stubEnv("TRANSFI_ADAPTER_READY", "true");
    vi.stubEnv("TRANSFI_ENV", "sandbox"); // ahora el ambiente se DECLARA (antes se adivinaba)
    expect(getFxQuoteProvider()).toBeInstanceOf(TransFiFxProvider);
  });
});

// ── Shape de las respuestas EXTERNAS (schemas zod que reemplazaron los casts crudos) ──────────
// Lo que estos tests defienden: (a) un shape válido se mapea IGUAL que antes, (b) campos extra del
// partner NO rompen nada (passthrough) y las coerciones históricas se preservan, (c) un shape
// inválido degrada del MISMO modo que antes (acá: throw), pero nombrando al contrato como culpable.

const fxInput: FxQuoteInput = {
  amountUsd: 100,
  sourceAsset: "USDC",
  destCurrency: "PEN",
  destCountry: "PE",
  payoutMethod: "yape",
};

describe("TransFiFxProvider.quote — validación de shape de la respuesta del partner", () => {
  const stubQuoteResponse = (body: unknown) =>
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => body })));
  afterEach(() => vi.unstubAllGlobals());

  it("(a) respuesta válida → mapea exactamente los mismos campos que antes", async () => {
    stubQuoteResponse({
      rate: 3.6,
      fee: 0.4,
      destAmount: 358.4,
      etaMinutes: 15,
      quoteId: "tq-1",
      expiresAt: "2026-07-25T00:00:00.000Z",
    });
    const q = await new TransFiFxProvider("k", SANDBOX_BASE).quote(fxInput);
    // T10 — AC-4: mismo mapeo de campos que siempre + los 2 aditivos. `rateAsOf` se compara aparte
    // porque es el momento de la respuesta del partner (que cotiza por request).
    expect({ ...q, rateAsOf: undefined }).toEqual({
      rate: 3.6,
      feeUsd: 0.4,
      netDeliveredLocal: 358.4,
      localCurrency: "PEN",
      etaMinutes: 15,
      quoteId: "tq-1",
      expiresAt: "2026-07-25T00:00:00.000Z",
      provenance: "transfi",
      rateSource: "transfi",
      rateAsOf: undefined,
    });
    expect(Date.parse(q.rateAsOf)).not.toBeNaN();
  });

  it("(b) campos EXTRA del partner → sigue cotizando (passthrough: el schema no es exclusión)", async () => {
    stubQuoteResponse({
      rate: 3.6,
      destAmount: 358.4,
      quoteId: "tq-2",
      expiresAt: "2026-07-25T00:00:00.000Z",
      // campos que TransFi puede agregar mañana sin avisar
      corridorId: "US-PE",
      breakdown: { spreadBps: 120, partnerFee: { amount: 0.4, currency: "USD" } },
      _links: [{ rel: "self", href: "/v1/quotes/tq-2" }],
    });
    const q = await new TransFiFxProvider("k", SANDBOX_BASE).quote(fxInput);
    expect(q.quoteId).toBe("tq-2");
    expect(q.rate).toBe(3.6);
    expect(q.provenance).toBe("transfi");
  });

  it("(b) montos como STRING numérico → se coercen igual que antes (NumericLike)", async () => {
    stubQuoteResponse({
      rate: "3.65",
      fee: "0.5",
      destAmount: "365.00",
      etaMinutes: "20",
      quoteId: "tq-3",
      expiresAt: "2026-07-25T00:00:00.000Z",
    });
    const q = await new TransFiFxProvider("k", SANDBOX_BASE).quote(fxInput);
    expect(q.rate).toBe(3.65);
    expect(q.feeUsd).toBe(0.5);
    expect(q.netDeliveredLocal).toBe(365);
    expect(q.etaMinutes).toBe(20);
  });

  it("(b) id numérico + fee null + fallback quoteId→id → coerciones históricas preservadas", async () => {
    stubQuoteResponse({ rate: 3.6, fee: null, destAmount: 358.4, id: 99, expiresAt: null });
    const q = await new TransFiFxProvider("k", SANDBOX_BASE).quote(fxInput);
    expect(q.quoteId).toBe("99"); // String(d.quoteId ?? d.id)
    expect(q.feeUsd).toBe(0); // fee null → ?? 0
    expect(q.expiresAt).toBe(""); // expiresAt null → ?? ""
    expect(q.etaMinutes).toBe(30); // default histórico
  });

  it("(c) shape inválido (rate como objeto) → throws transfi_quote_bad_shape", async () => {
    stubQuoteResponse({ rate: { value: 3.6 }, destAmount: 358.4, quoteId: "tq-4" });
    await expect(new TransFiFxProvider("k", SANDBOX_BASE).quote(fxInput)).rejects.toThrow(
      /transfi_quote_bad_shape/,
    );
  });

  it("(c) body que no es objeto (array) → throws transfi_quote_bad_shape", async () => {
    stubQuoteResponse([{ rate: 3.6 }]);
    await expect(new TransFiFxProvider("k", SANDBOX_BASE).quote(fxInput)).rejects.toThrow(
      /transfi_quote_bad_shape/,
    );
  });

  it("(c) campo AUSENTE (rate) → degradación byte-idéntica: muere en assertValidQuote", async () => {
    // el schema es .nullish() a propósito: un campo faltante NO inventa un error nuevo, sigue
    // cayendo en el guard de dinero de siempre (BLQ-MED-2).
    stubQuoteResponse({ destAmount: 358.4, quoteId: "tq-5" });
    await expect(new TransFiFxProvider("k", SANDBOX_BASE).quote(fxInput)).rejects.toThrow(/invalid_quote_rate/);
  });

  it("(c) quoteId/id ausentes → degradación byte-idéntica: invalid_quote_id", async () => {
    stubQuoteResponse({ rate: 3.6, destAmount: 358.4 });
    await expect(new TransFiFxProvider("k", SANDBOX_BASE).quote(fxInput)).rejects.toThrow(/invalid_quote_id/);
  });

  it("!res.ok → sigue lanzando transfi_quote_error_<n> (nada cambió antes del parseo)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
    await expect(new TransFiFxProvider("k", SANDBOX_BASE).quote(fxInput)).rejects.toThrow(
      /transfi_quote_error_503/,
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// WKH-312 · LA BANDA Y LA FRESCURA TAMBIÉN CUBREN EL CAMINO DEL SOCIO
//
// MEDIDO EL 2026-08-04 sobre `main`, con el adapter instanciado a mano (la bandera compartida
// `TRANSFI_ADAPTER_READY` sigue apagada): un socio que respondía `rate: 37.5` —diez veces el
// mercado, con la banda por defecto en 2.5–5.0— emitía
//   {"rate":37.5,…,"provenance":"transfi","rateSource":"transfi"}
// tal cual, sin ningún rechazo. Su único control sobre el número era "finito y > 0"
// (`assertValidQuote`), y `"transfi"` está DENTRO de `MARKET_FX_PROVENANCES`: el camino que nadie
// verificaba era además el que llevaba el sello de "tasa de mercado".
//
// Los guards NO se duplicaron: se movieron al punto por el que pasan los DOS proveedores
// (`assertValidQuote(quote, config)`) y el criterio de banda quedó en UNA función
// (`isRateWithinBand`) que consultan los cuatro call sites. Ver la mutación M2 del reporte: con
// `isRateWithinBand` devolviendo `true` mueren tests de los dos caminos a la vez.
// ════════════════════════════════════════════════════════════════════════════════════════════

describe("WKH-312 — banda de plausibilidad en el camino del socio", () => {
  /** Cuerpo mínimo y bien formado del socio; sólo la tasa cambia entre casos. */
  const partnerBody = (rate: number) => ({
    rate,
    fee: 0.5,
    destAmount: 350,
    quoteId: "tq-band",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  });

  const stubPartner = (rate: number) =>
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => partnerBody(rate) })));

  const quoteFromPartner = () => new TransFiFxProvider("k", SANDBOX_BASE).quote(fxInput);

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  // EL test del hallazgo. 37.5 es el número que salía con 200 antes de este cambio, y 2.5–5.0 son
  // los límites POR DEFECTO (`fx-config.ts`) — acá no se stubea ninguna env justamente para fijar
  // que la protección existe con la configuración que corre hoy, sin ayuda del test.
  it("T-312-B0 (EL test): tasa 37.5 del socio, diez veces el mercado ⇒ NO se emite cotización", async () => {
    stubPartner(37.5);
    const error = await quoteFromPartner().then(
      (q) => q as unknown,
      (e: unknown) => e,
    );
    // El efecto de dinero primero: lo que importa no es cómo se llama el error, es que NO salió
    // una cotización que promete diez veces el mercado.
    expect(error, "no puede emitirse una cotización con la tasa fuera de banda").toBeInstanceOf(
      Error,
    );
    const message = (error as Error).message;
    expect(message).toMatch(/^fx_rate_out_of_band:/);
    // DT-5: el rechazo nombra su origen. "el socio cotizó fuera de banda" y "nuestro margen dejó
    // la tasa fuera de banda" se corrigen en direcciones opuestas.
    expect(message).toContain("transfi");
  });

  // Los tres casos de borde se miden contra una banda ESCRITA EN EL TEST (3.0–4.0), distinta de la
  // de producción a propósito: si el código ignorara la config y usara sus propios números, estos
  // casos se caerían. El valor esperado viene de afuera, no de recalcular la fórmula.
  it("T-312-B1: dentro de banda [3.0, 4.0] ⇒ la tasa del socio sale tal cual", async () => {
    vi.stubEnv("FX_MID_MIN_USD_PEN", "3");
    vi.stubEnv("FX_MID_MAX_USD_PEN", "4");
    stubPartner(3.5);
    const q = await quoteFromPartner();
    expect(q.rate).toBe(3.5);
    expect(q.provenance).toBe("transfi");
    expect(MARKET_FX_PROVENANCES.has(q.provenance)).toBe(true);
  });

  it("T-312-B2: fuera de banda POR ARRIBA (4.01 con techo 4.0) ⇒ rechaza; el techo exacto pasa", async () => {
    vi.stubEnv("FX_MID_MIN_USD_PEN", "3");
    vi.stubEnv("FX_MID_MAX_USD_PEN", "4");
    stubPartner(4.01);
    await expect(quoteFromPartner()).rejects.toThrow(/fx_rate_out_of_band:transfi:4\.010000/);
    // el borde inclusive: 4.0 EXACTO todavía es banda, no "casi"
    stubPartner(4);
    expect((await quoteFromPartner()).rate).toBe(4);
  });

  it("T-312-B3: fuera de banda POR ABAJO (2.99 con piso 3.0) ⇒ rechaza; el piso exacto pasa", async () => {
    vi.stubEnv("FX_MID_MIN_USD_PEN", "3");
    vi.stubEnv("FX_MID_MAX_USD_PEN", "4");
    stubPartner(2.99);
    await expect(quoteFromPartner()).rejects.toThrow(/fx_rate_out_of_band:transfi:2\.990000/);
    stubPartner(3);
    expect((await quoteFromPartner()).rate).toBe(3);
  });

  // AC-3 — el criterio es UNO SOLO y se lee de la config VIGENTE en cada cotización: estrechar la
  // banda sin redeploy tiene que alcanzar también al socio. Es la única maniobra en tiempo real que
  // tiene un operador frente a un incidente de tasa.
  it("T-312-B4: estrechar la banda por env alcanza al socio en la cotización siguiente", async () => {
    vi.stubEnv("FX_MID_MIN_USD_PEN", "3");
    vi.stubEnv("FX_MID_MAX_USD_PEN", "4");
    stubPartner(3.9);
    expect((await quoteFromPartner()).rate).toBe(3.9); // la MISMA tasa, antes de tocar nada

    vi.stubEnv("FX_MID_MAX_USD_PEN", "3.8"); // el operador estrecha el techo
    await expect(quoteFromPartner()).rejects.toThrow(/fx_rate_out_of_band:transfi:3\.900000/);
  });

  // El criterio, como unidad. Mismo criterio que usan la cascada, el hit de caché y la salida.
  it("T-312-B5: isRateWithinBand — bordes inclusive y NaN fuera (fail-closed)", () => {
    const config = testFxConfig({ minRate: 3, maxRate: 4 });
    expect(isRateWithinBand(3, config)).toBe(true);
    expect(isRateWithinBand(4, config)).toBe(true);
    expect(isRateWithinBand(3.5, config)).toBe(true);
    expect(isRateWithinBand(2.999, config)).toBe(false);
    expect(isRateWithinBand(4.001, config)).toBe(false);
    // Un `NaN` NO está dentro de la banda: la forma afirmativa lo rechaza, la negada lo aceptaría.
    expect(isRateWithinBand(NaN, config)).toBe(false);
  });
});

describe("WKH-312 — frescura de la tasa en el camino del socio", () => {
  const transfiQuote: FxQuote = {
    ...goodQuote,
    provenance: "transfi",
    rateSource: "transfi",
  };

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  // La ventana es la MISMA que la del mid (`FX_MID_MAX_AGE_MS`, 48 h por defecto) y acá se escribe
  // como literal: 48 h en la config del test, un dato de hace 5 días como entrada, y el veredicto
  // esperado escrito a mano. En ningún lado se recalcula la resta que hace el código.
  it("T-312-F1: una tasa del socio de hace 5 días, con ventana de 48 h ⇒ no se emite", () => {
    const config = testFxConfig({ maxAgeMs: 48 * 3600_000 });
    const cincoDiasAtras = new Date(Date.now() - 5 * 24 * 3600_000).toISOString();
    expect(() =>
      assertValidQuote({ ...transfiQuote, rateAsOf: cincoDiasAtras }, config),
    ).toThrow("fx_rate_not_fresh:transfi:stale");

    // dentro de la ventana: una hora atrás sí sale
    const unaHoraAtras = new Date(Date.now() - 3600_000).toISOString();
    expect(assertValidQuote({ ...transfiQuote, rateAsOf: unaHoraAtras }, config).rateAsOf).toBe(
      unaHoraAtras,
    );
  });

  // Las otras dos ramas del mismo criterio, con códigos DISTINTOS entre sí: una fecha futura es un
  // dato malo (y desactivaría el guard para siempre si se aceptara), y una fecha impresentable es
  // "no sé de cuándo es". No son el mismo problema y no comparten código.
  it("T-312-F2: fecha futura y fecha impresentable rechazan con veredictos distintos", () => {
    const config = testFxConfig({ maxAgeMs: 48 * 3600_000 });
    expect(() =>
      assertValidQuote(
        { ...transfiQuote, rateAsOf: new Date(Date.now() + 365 * 24 * 3600_000).toISOString() },
        config,
      ),
    ).toThrow("fx_rate_not_fresh:transfi:future");
    expect(() =>
      assertValidQuote({ ...transfiQuote, rateAsOf: "no-es-una-fecha" }, config),
    ).toThrow("fx_rate_not_fresh:transfi:unparseable");
  });

  /**
   * AC-4 — LA JUSTIFICACIÓN, FIJADA CON UN TEST Y NO CON UN COMENTARIO.
   *
   * El guard de frescura está cableado en el punto común (T-312-F1 lo prueba), pero HOY no puede
   * dispararse por el camino del socio, y eso hay que decirlo en vez de dejar que se lea como una
   * protección que no es: `rateAsOf` lo sella ESTE adapter al recibir la respuesta, porque el
   * socio cotiza por request y el mapeo actual (sandbox-unverified, `TODO(sandbox)`) no tiene
   * ningún campo donde el socio declare la fecha de SU tasa. Inventarle un nombre de campo sería
   * escribir un guard contra una forma imaginada.
   *
   * Este test mide justamente eso: un socio que manda fechas viejas en campos plausibles NO mueve
   * el `rateAsOf` emitido. El día que el sandbox confirme un campo de fecha real, este test se cae
   * —que es lo que tiene que pasar— y el guard de arriba pasa a ser un control con dientes.
   */
  it("T-312-F3 (AC-4): el `rateAsOf` del socio lo sella el adapter al responder, no lo declara el socio", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          rate: 3.5,
          destAmount: 350,
          quoteId: "tq-fresh",
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          // el socio "declara" que su tasa es vieja, en tres campos plausibles que hoy NADIE lee
          rateAsOf: "2020-01-01T00:00:00.000Z",
          asOf: "2020-01-01T00:00:00.000Z",
          timestamp: "2020-01-01T00:00:00.000Z",
        }),
      })),
    );
    const antes = Date.now();
    const q = await new TransFiFxProvider("k", SANDBOX_BASE).quote(fxInput);
    const despues = Date.now();
    // La ventana se mide con el reloj DEL TEST, que es externo al código bajo prueba.
    expect(Date.parse(q.rateAsOf)).toBeGreaterThanOrEqual(antes);
    expect(Date.parse(q.rateAsOf)).toBeLessThanOrEqual(despues);
    expect(q.rateAsOf).not.toContain("2020");
  });
});

describe("WKH-312 — 'no sé la tasa' NO se colapsa con 'la tasa es mala'", () => {
  // El bug que este bloque evita ya se pagó caro en este ecosistema: si una caída de red llega al
  // log con el mismo código que una tasa fuera de mercado, mañana alguien depura un problema de
  // precios que era un cable. Los dos rechazan la cotización; ninguno se puede leer por el otro.

  const quoteFromPartner = () => new TransFiFxProvider("k", SANDBOX_BASE).quote(fxInput);

  async function codeOf(stub: () => void): Promise<string> {
    stub();
    return quoteFromPartner().then(
      () => "NO_LANZO",
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
  }

  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("T-312-U1: el socio no responde (red caída) ⇒ transfi_quote_unreachable, con su warn propio", async () => {
    const code = await codeOf(() =>
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new TypeError("fetch failed");
        }),
      ),
    );
    expect(code).toBe("transfi_quote_unreachable");
    expect(warn).toHaveBeenCalledWith("[remit-fx] fx_quote_rejected", {
      rateSource: "transfi",
      code: "transfi_quote_unreachable",
    });
  });

  it("T-312-U2: el socio responde algo que ni siquiera es JSON ⇒ transfi_quote_unreachable", async () => {
    const code = await codeOf(() =>
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: true,
          json: async () => {
            throw new SyntaxError("Unexpected token < in JSON at position 0");
          },
        })),
      ),
    );
    expect(code).toBe("transfi_quote_unreachable");
  });

  it("T-312-U3: los cuatro 'no sé' tienen códigos propios y NINGUNO se lee como un problema de precio", async () => {
    const noSe = [
      {
        caso: "red caída / timeout",
        code: await codeOf(() =>
          vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
              throw new TypeError("fetch failed");
            }),
          ),
        ),
        esperado: "transfi_quote_unreachable",
      },
      {
        caso: "cuerpo que no es JSON",
        code: await codeOf(() =>
          vi.stubGlobal(
            "fetch",
            vi.fn(async () => ({
              ok: true,
              json: async () => {
                throw new SyntaxError("no json");
              },
            })),
          ),
        ),
        esperado: "transfi_quote_unreachable",
      },
      {
        caso: "el socio contesta 503",
        code: await codeOf(() =>
          vi.stubGlobal(
            "fetch",
            vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })),
          ),
        ),
        esperado: "transfi_quote_error_503",
      },
      {
        caso: "el socio contesta un shape ilegible",
        code: await codeOf(() =>
          vi.stubGlobal(
            "fetch",
            vi.fn(async () => ({
              ok: true,
              json: async () => ({ rate: { value: 3.6 }, destAmount: 350, quoteId: "x" }),
            })),
          ),
        ),
        esperado: "transfi_quote_bad_shape",
      },
    ];

    for (const entry of noSe) {
      expect(entry.code, entry.caso).toBe(entry.esperado);
      // Ninguno de los cuatro puede confundirse con un veredicto SOBRE una tasa conocida.
      expect(entry.code, `${entry.caso} no debe leerse como un problema de precio`).not.toMatch(
        /fx_rate_out_of_band|fx_rate_not_fresh/,
      );
    }

    // Y el contraste: una tasa que SÍ conocemos y está fuera de banda usa el otro vocabulario.
    const banda = await codeOf(() =>
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: true,
          json: async () => ({
            rate: 37.5,
            destAmount: 3750,
            quoteId: "tq-band",
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
          }),
        })),
      ),
    );
    expect(banda).toMatch(/^fx_rate_out_of_band:transfi:/);
    expect(banda).not.toMatch(/unreachable|bad_shape|quote_error/);
  });
});

// ── Cascada del FX mid: procedencia, guards y fail-closed ────────────────────
// Los casos (c) de este bloque ANTES aseveraban "cae al estático". Esa conducta se ELIMINÓ: era el
// bug (la constante 3.75, +10.2% sobre el mercado real, etiquetada como cotización buena). Ahora
// cada uno asevera qué tasa salió y con qué procedencia, o que NO se cotizó.

describe("FX mid — cascada, guards y fail-closed", () => {
  // El mid cachea a nivel MÓDULO: cada caso necesita una instancia FRESCA, si no el primer test que
  // cachea una tasa contamina a los demás.
  async function freshFx(): Promise<typeof import("./fx")> {
    vi.resetModules();
    return import("./fx");
  }

  /** Mock de fetch que responde según la URL pedida. Devuelve el mock para contar llamadas. */
  function stubFetchByUrl(
    handler: (url: string) => { ok: boolean; status?: number; body: unknown } | "throw",
  ) {
    const mock = vi.fn(async (url: unknown) => {
      const result = handler(String(url));
      if (result === "throw") throw new Error("network_down");
      return {
        ok: result.ok,
        status: result.status ?? (result.ok ? 200 : 500),
        json: async () => result.body,
      };
    });
    vi.stubGlobal("fetch", mock);
    return mock;
  }

  /** Todas las fuentes responden 200 con el mismo cuerpo de er-api. */
  function stubFetchOk(body: unknown) {
    return stubFetchByUrl(() => ({ ok: true, body }));
  }

  async function quoteWith(mod: typeof import("./fx")): Promise<FxQuote> {
    return new mod.LiveMidFxProvider().quote(fxInput);
  }

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  // T1 — AC-1
  it("T1: feed en vivo ⇒ fx-mid-live, con la fuente y la FECHA DEL FEED, y la tasa deriva del feed", async () => {
    const mod = await freshFx();
    const asOfMs = Date.now() - 3600_000; // el dato es de hace una hora
    stubFetchOk({
      rates: { PEN: 3.9 },
      time_last_update_unix: Math.floor(asOfMs / 1000),
    });
    const q = await quoteWith(mod);
    expect(q.provenance).toBe("fx-mid-live");
    expect(q.rateSource).toBe("er-api");
    // la fecha es la DEL FEED, no el momento de servir
    expect(q.rateAsOf).toBe(new Date(Math.floor(asOfMs / 1000) * 1000).toISOString());
    // la tasa deriva del feed (3.9 menos el spread), NO de la vieja constante 3.75
    expect(q.rate).toBeGreaterThan(3.8);
    expect(q.rate).toBeLessThan(3.9);
  });

  // T2 — AC-1
  it("T2: 2ª llamada dentro del TTL ⇒ fx-mid-cached, SIN nueva llamada de red y con el MISMO rateAsOf", async () => {
    const mod = await freshFx();
    // El dato se fecha UNA HORA ATRÁS (igual que T1). Con `ageMs = 0` la fecha del feed se trunca al
    // segundo (`.000Z`) y el único dígito que la distingue del momento de servir son los ms: si el
    // reloj cae justo en `.000Z`, una caché que MINTIERA sobre su frescura (devolviendo "ahora" en vez
    // de la fecha original) produciría el MISMO string y este test la dejaría pasar. Una corrida de
    // cada mil daría un falso "el guard está protegido" sobre un guard de dinero.
    const fetchMock = stubFetchOk(erBody(3.9, 3600_000));
    const first = await quoteWith(mod);
    expect(first.provenance).toBe("fx-mid-live");
    expect(fetchMock.mock.calls.length).toBe(1);

    const second = await quoteWith(mod);
    expect(second.provenance).toBe("fx-mid-cached");
    expect(fetchMock.mock.calls.length).toBe(1); // no hubo red
    // el cacheado NO puede mentir sobre su frescura: conserva la fecha ORIGINAL del dato
    expect(second.rateAsOf).toBe(first.rateAsOf);
    expect(second.rateSource).toBe(first.rateSource);
    expect(second.rate).toBe(first.rate);
  });

  // T3 — AC-1, CD-5
  it("T3: toda cotización emitida cumple MARKET_FX_PROVENANCES y declara su fuente", async () => {
    const mod = await freshFx();
    stubFetchOk(erBody(3.9));
    const live = await quoteWith(mod);
    const cached = await quoteWith(mod);
    for (const q of [live, cached]) {
      expect(MARKET_FX_PROVENANCES.has(q.provenance)).toBe(true);
      expect(q.rateSource).not.toBe("");
      expect(Date.parse(q.rateAsOf)).not.toBeNaN();
    }
    // y ninguna emite la etiqueta retirada
    expect([live.provenance, cached.provenance]).not.toContain("local-fallback");
  });

  // T5 — AC-2: la constante quedó FUERA del money-path
  it("T5: con STATIC_USD_PEN='9.99' seteada, fuentes caídas ⇒ NO cotiza (rejects)", async () => {
    const mod = await freshFx();
    vi.stubEnv("STATIC_USD_PEN", "9.99");
    stubFetchByUrl(() => "throw");
    await expect(quoteWith(mod)).rejects.toThrow(/fx_mid_unavailable/);
  });

  it("T5b: con STATIC_USD_PEN='9.99' y fuentes VIVAS, la tasa sale del feed (la constante no influye)", async () => {
    const mod = await freshFx();
    vi.stubEnv("STATIC_USD_PEN", "9.99");
    stubFetchOk(erBody(3.9));
    const q = await quoteWith(mod);
    expect(q.rate).toBeGreaterThan(3.8);
    expect(q.rate).toBeLessThan(3.9); // ni cerca de 9.99
    expect(q.provenance).toBe("fx-mid-live");
  });

  // T6 — AC-2: la caché vencida NO se sirve
  it("T6: caché poblada + TTL vencido + fuentes caídas ⇒ rejects (la caché vencida no se sirve)", async () => {
    const mod = await freshFx();
    const fetchMock = stubFetchOk(erBody(3.9));
    expect((await quoteWith(mod)).provenance).toBe("fx-mid-live"); // caché poblada
    expect(fetchMock.mock.calls.length).toBe(1);

    // TTL a 0 (call-time) ⇒ la caché deja de ser fresca, y todas las fuentes caen
    vi.stubEnv("FX_RATE_CACHE_TTL_MS", "0");
    stubFetchByUrl(() => "throw");
    await expect(quoteWith(mod)).rejects.toThrow(/fx_mid_unavailable/);
  });

  // T7 — AC-3
  it("T7: FX_MID_SOURCES='currency-api' llama SÓLO a esa URL, con su parser", async () => {
    const mod = await freshFx();
    vi.stubEnv("FX_MID_SOURCES", "currency-api");
    const fetchMock = stubFetchByUrl(() => ({ ok: true, body: currencyBody(3.42) }));
    const q = await quoteWith(mod);
    expect(fetchMock.mock.calls.length).toBe(1);
    expect(String(fetchMock.mock.calls[0]![0])).toContain("currency-api");
    expect(q.rateSource).toBe("currency-api");
  });

  it("T7b: invertir FX_MID_SOURCES invierte el orden REAL de las llamadas", async () => {
    const mod = await freshFx();
    vi.stubEnv("FX_MID_SOURCES", "currency-api,er-api");
    // ambas caen, así que se intentan las dos y queda el orden registrado
    const fetchMock = stubFetchByUrl(() => ({ ok: false, status: 500, body: {} }));
    await expect(quoteWith(mod)).rejects.toThrow(/fx_mid_unavailable/);
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("currency-api");
    expect(urls[1]).toContain("er-api");
  });

  // T9 — AC-3: el punto de extensión NO es un control muerto
  it("T9: FX_MID_ER_API_URL apunta a otro host y se llama ESE, con el parser de er-api", async () => {
    const mod = await freshFx();
    vi.stubEnv("FX_MID_SOURCES", "er-api");
    vi.stubEnv("FX_MID_ER_API_URL", "http://localhost:9/x");
    const fetchMock = stubFetchByUrl(() => ({ ok: true, body: erBody(3.44) }));
    const q = await quoteWith(mod);
    expect(String(fetchMock.mock.calls[0]![0])).toBe("http://localhost:9/x");
    expect(q.rateSource).toBe("er-api");
    expect(q.provenance).toBe("fx-mid-live");
  });

  // T11 — AC-5, CD-7: los 5 códigos de rechazo, cada uno con su EFECTO
  it("T11: los 5 rechazos producen sus 5 códigos, value-free, y NINGUNO aporta tasa", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cases: ReadonlyArray<readonly [string, () => void]> = [
      [
        "fx_mid_http_503",
        () => stubFetchByUrl(() => ({ ok: false, status: 503, body: { secret: "BODY-LEAK" } })),
      ],
      ["fx_mid_fetch_failed", () => stubFetchByUrl(() => "throw")],
      [
        "fx_mid_bad_shape",
        () => stubFetchByUrl(() => ({ ok: true, body: { rates: "BODY-LEAK" } })),
      ],
      [
        "fx_mid_no_usable_pen_rate",
        () => stubFetchByUrl(() => ({ ok: true, body: erBody(-1) })),
      ],
      ["fx_mid_out_of_band", () => stubFetchByUrl(() => ({ ok: true, body: erBody(37.5) }))],
      [
        "fx_mid_stale_data",
        () => stubFetchByUrl(() => ({ ok: true, body: erBody(3.4, 5 * 24 * 3600_000) })),
      ],
    ];

    for (const [code, stub] of cases) {
      const mod = await freshFx();
      vi.stubEnv("FX_MID_SOURCES", "er-api");
      warn.mockClear();
      stub();
      // EFECTO: esa fuente no aportó tasa — con una sola fuente, no hay cotización
      await expect(quoteWith(mod)).rejects.toThrow(/fx_mid_unavailable/);
      expect(warn).toHaveBeenCalledWith("[remit-fx] fx_mid_source_rejected", {
        sourceId: "er-api",
        code,
      });
      // value-free: ni el body de la fuente ni la URL completa
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).not.toContain("BODY-LEAK");
      expect(logged).not.toContain("open.er-api.com");
    }
  });

  // T12 — AC-6: la banda
  it("T12: una tasa 10x (37.5) se descarta por banda y NO se cotiza jamás con ella", async () => {
    const mod = await freshFx();
    vi.stubEnv("FX_MID_SOURCES", "er-api");
    stubFetchOk(erBody(37.5));
    await expect(quoteWith(mod)).rejects.toThrow(/fx_mid_unavailable/);
  });

  it("T12b: una tasa 0.0001 se descarta por banda", async () => {
    const mod = await freshFx();
    vi.stubEnv("FX_MID_SOURCES", "er-api");
    stubFetchOk(erBody(0.0001));
    await expect(quoteWith(mod)).rejects.toThrow(/fx_mid_unavailable/);
  });

  // T12c: una tasa 0 la rechazan DOS guards distintos, y cuál de los dos actúa importa.
  // El efecto de dinero es el mismo (no se cotiza) porque la banda también ataja el 0 — por eso
  // afirmar sólo "rejects" acá NO distingue `pen > 0` de `pen >= 0`. Lo que sí distingue es el
  // CÓDIGO: "la fuente nos dio un cero" y "la fuente está fuera de banda" son diagnósticos
  // distintos, y es lo que lee el operador para saber qué se rompió.
  it("T12c: una tasa 0 se rechaza como NO USABLE (no como fuera de banda) y no cotiza", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await freshFx();
    vi.stubEnv("FX_MID_SOURCES", "er-api");
    stubFetchOk(erBody(0));
    await expect(quoteWith(mod)).rejects.toThrow(/fx_mid_unavailable/);
    expect(warn).toHaveBeenCalledWith("[remit-fx] fx_mid_source_rejected", {
      sourceId: "er-api",
      code: "fx_mid_no_usable_pen_rate",
    });
  });

  // T13 — AC-6: el límite es EL que decide
  it("T13: subir FX_MID_MAX_USD_PEN a 40 vuelve aceptable la MISMA tasa de T12", async () => {
    const mod = await freshFx();
    vi.stubEnv("FX_MID_SOURCES", "er-api");
    vi.stubEnv("FX_MID_MAX_USD_PEN", "40");
    stubFetchOk(erBody(37.5));
    const q = await quoteWith(mod);
    expect(q.provenance).toBe("fx-mid-live");
    expect(q.rate).toBeGreaterThan(36); // cotizó con 37.5 porque la banda lo permitió
  });

  // T14 — AC-7: 200 reciente + dato congelado ≠ en vivo
  it("T14: 200 con un dato de hace 5 días ⇒ fx_mid_stale_data ⇒ no cotiza", async () => {
    const mod = await freshFx();
    vi.stubEnv("FX_MID_SOURCES", "er-api");
    stubFetchOk(erBody(3.4, 5 * 24 * 3600_000));
    await expect(quoteWith(mod)).rejects.toThrow(/fx_mid_unavailable/);
  });

  // T15 — AC-7 / DT-6
  it("T15: 200 SIN campo de fecha ⇒ fx_mid_bad_shape, no cotiza", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await freshFx();
    vi.stubEnv("FX_MID_SOURCES", "er-api");
    stubFetchOk({ rates: { PEN: 3.4 } }); // el shape viejo del repo: sin fecha
    await expect(quoteWith(mod)).rejects.toThrow(/fx_mid_unavailable/);
    expect(warn).toHaveBeenCalledWith("[remit-fx] fx_mid_source_rejected", {
      sourceId: "er-api",
      code: "fx_mid_bad_shape",
    });
  });

  // T16 — AC-7: el TTL no revive un dato viejo
  it("T16: dato de 47 h cacheado; si MAX_AGE baja por debajo, la caché NO se sirve y se re-fetchea", async () => {
    const mod = await freshFx();
    // una sola fuente: así el contador de llamadas mide re-fetch, no la cantidad de fuentes
    vi.stubEnv("FX_MID_SOURCES", "er-api");
    const fetchMock = stubFetchOk(erBody(3.4, 47 * 3600_000));
    const first = await quoteWith(mod);
    expect(first.provenance).toBe("fx-mid-live"); // 47 h < 48 h default
    expect(fetchMock.mock.calls.length).toBe(1);

    // ahora el mismo dato es "viejo": el TTL de caché sigue vigente, pero la EDAD manda
    vi.stubEnv("FX_MID_MAX_AGE_MS", String(24 * 3600_000));
    await expect(quoteWith(mod)).rejects.toThrow(/fx_mid_unavailable/);
    expect(fetchMock.mock.calls.length).toBe(2); // re-fetcheó, no sirvió la caché
  });

  // Espejo de T16 sobre el otro knob. La banda era el ÚNICO control de tiempo real que la caché
  // ignoraba: la tasa se cacheaba dentro de la banda vigente en ese momento y se seguía sirviendo
  // hasta 5 minutos aunque el operador la estrechara — y esos 5 minutos caen justo cuando alguien
  // está respondiendo a un incidente de tasa. La banda se re-evalúa contra la config ACTUAL.
  it("T16b: tasa cacheada en banda; si la banda se ESTRECHA por debajo, la caché NO se sirve y se re-fetchea", async () => {
    const mod = await freshFx();
    vi.stubEnv("FX_MID_SOURCES", "er-api"); // una sola fuente: el contador mide re-fetch
    const fetchMock = stubFetchOk(erBody(4.9, 3600_000));
    const first = await quoteWith(mod);
    expect(first.provenance).toBe("fx-mid-live"); // 4.9 < 5.0 default
    expect(fetchMock.mock.calls.length).toBe(1);

    // el operador estrecha el techo SIN redeploy (AC-9): 4.9 deja de ser aceptable
    vi.stubEnv("FX_MID_MAX_USD_PEN", "3.5");
    await expect(quoteWith(mod)).rejects.toThrow(/fx_mid_unavailable/);
    expect(fetchMock.mock.calls.length).toBe(2); // re-fetcheó, no sirvió la caché fuera de banda
  });

  it("T16c: subir el PISO por encima de la tasa cacheada tampoco la sirve", async () => {
    const mod = await freshFx();
    vi.stubEnv("FX_MID_SOURCES", "er-api");
    const fetchMock = stubFetchOk(erBody(3.0, 3600_000));
    expect((await quoteWith(mod)).provenance).toBe("fx-mid-live");
    vi.stubEnv("FX_MID_MIN_USD_PEN", "3.2");
    await expect(quoteWith(mod)).rejects.toThrow(/fx_mid_unavailable/);
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  // T20 — AC-2, CD-11: la cascada real
  it("T20: er-api 500 → currency-api 200 ⇒ exactamente 2 llamadas, EN ORDEN, y cotiza con la 2ª", async () => {
    const mod = await freshFx();
    const fetchMock = stubFetchByUrl((url) =>
      url.includes("er-api")
        ? { ok: false, status: 500, body: {} }
        : { ok: true, body: currencyBody(3.42) },
    );
    const q = await quoteWith(mod);
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("er-api");
    expect(urls[1]).toContain("currency-api");
    expect(q.rateSource).toBe("currency-api");
    expect(q.provenance).toBe("fx-mid-live");
    expect(q.rate).toBeLessThan(3.42);
    expect(q.rate).toBeGreaterThan(3.3);
  });

  // AC-8: la config inválida no se traga
  it("config inválida ⇒ la cotización falla ruidosa (no cotiza con la banda apagada)", async () => {
    const mod = await freshFx();
    vi.stubEnv("FX_MID_MAX_USD_PEN", "abc");
    stubFetchOk(erBody(3.9));
    await expect(quoteWith(mod)).rejects.toThrow(/fx_mid_config_invalid:FX_MID_MAX_USD_PEN/);
  });

  it("el quote emitido sigue pasando el guard de dinero y su id ya no dice 'fallback'", async () => {
    const mod = await freshFx();
    stubFetchOk(erBody(3.9));
    const q = await quoteWith(mod);
    expect(Number.isFinite(q.rate)).toBe(true);
    expect(q.rate).toBeGreaterThan(0);
    expect(q.netDeliveredLocal).toBeGreaterThan(0);
    expect(q.quoteId).toMatch(/^fxmid-/);
  });

  // ── El guard de frescura mira en las DOS direcciones ───────────────────────────────────────
  // Una edad negativa nunca supera el máximo, así que una fuente que sella hacia ADELANTE tendría
  // el guard de frescura desactivado de forma permanente — justo el escenario que el guard existe
  // para atajar (un JSON congelado servido con 200 reciente). Y esa fecha futura viajaba al usuario
  // en `rateAsOf`, que es el campo con el que se audita la cotización.
  it("un feed fechado en el FUTURO se rechaza (fx_mid_future_data) y no cotiza", async () => {
    const mod = await freshFx();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("FX_MID_SOURCES", "er-api");
    stubFetchOk(erBody(3.4, -10 * 365 * 24 * 3600_000)); // ~2036
    await expect(quoteWith(mod)).rejects.toThrow(/fx_mid_unavailable/);
    expect(warn).toHaveBeenCalledWith("[remit-fx] fx_mid_source_rejected", {
      sourceId: "er-api",
      code: "fx_mid_future_data",
    });
  });

  it("un skew de reloj chico (fecha 30 s adelantada) SÍ se tolera: no es una fuente que sella al futuro", async () => {
    const mod = await freshFx();
    vi.stubEnv("FX_MID_SOURCES", "er-api");
    stubFetchOk(erBody(3.4, -30_000));
    const q = await quoteWith(mod);
    expect(q.provenance).toBe("fx-mid-live");
  });

  // La rama de la fecha impresentable NO es alcanzable desde afuera (los parsers de las fuentes
  // validan la fecha antes, y la caché sólo se puebla con datos que ya pasaron G5), así que se
  // testea el criterio DIRECTO. Es la rama que importa: con `NaN`, la misma expresión movía los dos
  // controles en direcciones OPUESTAS — el guard de frescura ACEPTABA (`NaN > max` es false) y la
  // caché RECHAZABA (`NaN <= max` es false). El que fallaba abierto era el que emite la tasa.
  it("checkFreshness: una fecha impresentable NO es 'ok' (antes hacía que el guard aceptara)", () => {
    const maxAge = 48 * 3600_000;
    expect(checkFreshness("no-es-una-fecha", maxAge)).toBe("unparseable");
    expect(checkFreshness("", maxAge)).toBe("unparseable");
    // y las otras tres decisiones del mismo criterio, para que se lean juntas
    expect(checkFreshness(new Date(Date.now() - 3600_000).toISOString(), maxAge)).toBe("ok");
    expect(checkFreshness(new Date(Date.now() - 5 * 24 * 3600_000).toISOString(), maxAge)).toBe(
      "stale",
    );
    expect(checkFreshness(new Date(Date.now() + 365 * 24 * 3600_000).toISOString(), maxAge)).toBe(
      "future",
    );
    // el skew chico sigue siendo aceptable
    expect(checkFreshness(new Date(Date.now() + 30_000).toISOString(), maxAge)).toBe("ok");
  });

  // ── El spread: la otra puerta por la que salía el MISMO error que la HU vino a cerrar ──────
  // Los tres valores de abajo se MIDIERON contra un mid de mercado de 3.40 antes del arreglo, con
  // el código sin mutar: los tres emitían HTTP 200 etiquetado `fx-mid-live`. Ahora los tres cortan.
  it("spread absurdo ⇒ NO se emite cotización (los tres valores medidos, con el feed sano y en banda)", async () => {
    const casos: { bps: string; emitiaAntes: string; error: RegExp }[] = [
      // +10.0% sobre el mercado: numéricamente el mismo incidente que la constante 3.75
      { bps: "-1000", emitiaAntes: "3.74", error: /fx_mid_config_invalid:FALLBACK_FX_SPREAD_BPS/ },
      // el doble del mercado
      { bps: "-10000", emitiaAntes: "6.8", error: /fx_mid_config_invalid:FALLBACK_FX_SPREAD_BPS/ },
      // 0.14 PEN por 400 dólares — pasa el rango de config, lo ataja la banda sobre la tasa EMITIDA
      { bps: "9999", emitiaAntes: "0.00034", error: /fx_rate_out_of_band/ },
    ];
    for (const c of casos) {
      const mod = await freshFx();
      vi.stubEnv("FALLBACK_FX_SPREAD_BPS", c.bps);
      stubFetchOk(erBody(3.4)); // feed sano: en banda, fresco, shape válido
      await expect(quoteWith(mod), `bps=${c.bps} (antes emitía ${c.emitiaAntes})`).rejects.toThrow(
        c.error,
      );
    }
  });

  // La banda valida el MID (fx.ts, guard G4). Esto valida lo que SALE, que es lo que el usuario
  // recibe: un spread grande-pero-válido por rango puede dejar la tasa emitida bajo el piso.
  it("la tasa EMITIDA pasa por la banda, no sólo el mid que entró", async () => {
    const mod = await freshFx();
    vi.stubEnv("FALLBACK_FX_SPREAD_BPS", "3000"); // 30%: 3.40 → 2.38, bajo el piso de 2.5
    stubFetchOk(erBody(3.4));
    await expect(quoteWith(mod)).rejects.toThrow(/fx_rate_out_of_band/);
  });

  it("un fee fijo negativo ⇒ no cotiza (entregaría de más)", async () => {
    const mod = await freshFx();
    vi.stubEnv("FALLBACK_FX_FLAT_FEE_USD", "-5");
    stubFetchOk(erBody(3.4));
    await expect(quoteWith(mod)).rejects.toThrow(
      /fx_mid_config_invalid:FALLBACK_FX_FLAT_FEE_USD/,
    );
  });

  // AC-9/DT-8 extremo a extremo: el mutante que congela la lectura al importar muere acá.
  it("AC-9: rotar el spread cambia la tasa SIN reimportar el módulo (no se lee al importar)", async () => {
    const mod = await freshFx();
    vi.stubEnv("FX_MID_SOURCES", "er-api");
    vi.stubEnv("FX_RATE_CACHE_TTL_MS", "0"); // sin caché: cada quote re-resuelve
    stubFetchOk(erBody(3.4));

    vi.stubEnv("FALLBACK_FX_SPREAD_BPS", "0");
    const sinSpread = await quoteWith(mod);
    expect(sinSpread.rate).toBe(3.4);

    // MISMA instancia del módulo: si el spread se leyera al importar, esto seguiría dando 3.4
    vi.stubEnv("FALLBACK_FX_SPREAD_BPS", "1000"); // 10%
    const conSpread = await quoteWith(mod);
    expect(conSpread.rate).toBe(3.06);
    expect(conSpread.rate).toBeLessThan(sinSpread.rate);
  });

  it("feed con las ~160 monedas extra → sigue leyendo PEN (passthrough)", async () => {
    const mod = await freshFx();
    stubFetchOk({
      result: "success",
      base_code: "USD",
      time_last_update_utc: "Fri, 25 Jul 2026 00:00:01 +0000",
      time_last_update_unix: Math.floor(Date.now() / 1000),
      rates: { USD: 1, EUR: 0.92, PEN: 3.9, BRL: 5.4, ARS: 1010 },
    });
    const q = await quoteWith(mod);
    expect(q.rate).toBeLessThan(3.9);
    expect(q.rate).toBeGreaterThan(3.8);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // WKH-314 · UNA COTIZACIÓN NO PUEDE PROMETER CERO (NI CASI CERO)
  //
  // Antes de esta HU: `netUsd = max(0, enviado − comisión)`, y con la comisión por defecto
  // (0.50) cualquier envío de hasta 50 centavos daba `netDeliveredLocal = 0`. El guard de
  // salida lo aceptaba porque pide NO-NEGATIVO (`>= 0`), no positivo. Resultado: HTTP 200,
  // etiqueta `fx-mid-live`, tasa real y en banda, y CERO soles para la persona. Todos los
  // guards de la HU anterior decían que sí; ninguno miraba el resultado.
  //
  // Los dos ejes que se candan acá, y hacen falta LOS DOS:
  //  1. el mínimo corta el envío que entregaría cero;
  //  2. la configuración no puede volver inútil al mínimo (si no, el guard se apaga solo).
  // ════════════════════════════════════════════════════════════════════════════

  /** Cotiza con un monto arbitrario; el resto del input es el canónico de la suite. */
  async function quoteAmount(mod: typeof import("./fx"), amountUsd: number): Promise<FxQuote> {
    return new mod.LiveMidFxProvider().quote({ ...fxInput, amountUsd });
  }

  /**
   * WKH-314 (AR): el guard del monto mínimo se mudó de `LiveMidFxProvider` al núcleo del agente,
   * para que cubra también el camino de TransFi. Por eso los casos del mínimo se ejercen desde
   * `runCorridorFx` y NO desde el proveedor: probarlo en el proveedor pasaría a verificar un
   * lugar donde el guard ya no está.
   */
  async function freshCore(): Promise<typeof import("../agents/corridor-fx")> {
    vi.resetModules();
    return import("../agents/corridor-fx");
  }

  async function quoteViaCore(
    core: typeof import("../agents/corridor-fx"),
    amountUsd: number,
  ): Promise<FxQuote> {
    return core.runCorridorFx({ amountUsd });
  }

  it("T-314-1 (EL test): 40 centavos, que antes daban 200 con CERO soles, ahora cortan — y el feed ni se consulta", async () => {
    const core = await freshCore();
    vi.stubEnv("TRANSFI_API_KEY", ""); // camino del mid real
    const fetchMock = stubFetchOk(erBody(3.4)); // feed perfectamente sano: en banda y fresco

    const error = await quoteViaCore(core, 0.4).then(
      (q) => q,
      (e: unknown) => e,
    );

    // ── EL EFECTO DE DINERO PRIMERO ──────────────────────────────────────────
    // Si estas dos aserciones fueran después del chequeo del mensaje, un mutante que
    // rompiera el texto mataría el test sin que se llegue a mirar si se emitió cotización.
    // Lo que importa no es cómo se llama el error: es que NO salió una promesa de cero soles.
    expect(error, "no puede emitirse una cotización por debajo del mínimo").toBeInstanceOf(Error);
    expect(
      fetchMock,
      "el monto se rechaza ANTES de salir a buscar la tasa: un envío que vamos a rechazar no justifica un fetch",
    ).not.toHaveBeenCalled();

    // ── y recién ahora, la forma del rechazo ─────────────────────────────────
    expect((error as Error).message).toMatch(/^fx_amount_below_minimum:/);
    // El mínimo VIAJA en el error: sin esto el caller lo descubre por bisección.
    expect((error as Error).message).toBe("fx_amount_below_minimum:5");
  });

  it("T-314-2: el borde exacto — el mínimo justo SÍ cotiza, un centavo menos NO", async () => {
    const core = await freshCore();
    vi.stubEnv("TRANSFI_API_KEY", "");
    stubFetchOk(erBody(3.4));

    // Exactamente el mínimo: pasa. El guard es `>=`, no `>`.
    const enElBorde = await quoteViaCore(core, 5);
    expect(enElBorde.netDeliveredLocal).toBeGreaterThan(0);

    // Un centavo por debajo: corta.
    await expect(quoteViaCore(core, 4.99)).rejects.toThrow(/fx_amount_below_minimum/);
  });

  it("T-314-3: ningún monto aceptado entrega cero (barrido alrededor del punto donde antes fallaba)", async () => {
    const core = await freshCore();
    vi.stubEnv("TRANSFI_API_KEY", "");
    stubFetchOk(erBody(3.4));
    // 0.40 y 0.50 daban CERO antes de esta HU; 0.60 daba S/ 0.33 (comisión = 83% del envío).
    for (const amount of [0.01, 0.4, 0.5, 0.6, 1, 4.99]) {
      await expect(quoteViaCore(core, amount), `amountUsd=${amount}`).rejects.toThrow(
        /fx_amount_below_minimum/,
      );
    }
  });

  // ── LA ATADURA: el eje que cierra la CLASE, no sólo el caso ────────────────────────
  // Un mínimo escrito suelto protege hoy y se apaga solo mañana: `FALLBACK_FX_FLAT_FEE_USD`
  // es una env sin techo. Con la comisión en 6 y el mínimo en 5, el envío mínimo aceptado
  // entregaría CERO otra vez, con el mínimo ahí escrito sin proteger nada. Por eso esa
  // COMBINACIÓN es config inválida y no arranca.
  it("T-314-4: una comisión que supera el mínimo es CONFIG INVÁLIDA — el mínimo no se puede apagar solo", async () => {
    const mod = await freshFx();
    const fetchMock = stubFetchOk(erBody(3.4));
    vi.stubEnv("FALLBACK_FX_FLAT_FEE_USD", "6"); // > mínimo 5: antes emitía cero
    vi.stubEnv("FX_MIN_SEND_USD", "5");

    // Efecto primero: con esa configuración NO se cotiza NINGÚN monto, ni siquiera uno grande.
    await expect(quoteAmount(mod, 100)).rejects.toThrow();
    expect(fetchMock, "config inválida ⇒ ni se consulta el feed").not.toHaveBeenCalled();

    // Y el error nombra a las DOS variables: la falla es la relación, no una sola env.
    await expect(quoteAmount(mod, 100)).rejects.toThrow(
      /fx_mid_config_invalid:FALLBACK_FX_FLAT_FEE_USD_VS_FX_MIN_SEND_USD/,
    );
  });

  it("T-314-5: la comisión no puede comerse más del 20% del mínimo (el techo, medido en el borde)", async () => {
    // Con mínimo 10: 2.00 es exactamente el 20% y pasa; 2.01 lo excede y no arranca.
    const enElTecho = await freshFx();
    stubFetchOk(erBody(3.4));
    vi.stubEnv("FX_MIN_SEND_USD", "10");
    vi.stubEnv("FALLBACK_FX_FLAT_FEE_USD", "2");
    expect((await quoteAmount(enElTecho, 10)).netDeliveredLocal).toBeGreaterThan(0);

    const pasado = await freshFx();
    stubFetchOk(erBody(3.4));
    vi.stubEnv("FX_MIN_SEND_USD", "10");
    vi.stubEnv("FALLBACK_FX_FLAT_FEE_USD", "2.01");
    await expect(quoteAmount(pasado, 10)).rejects.toThrow(
      /fx_mid_config_invalid:FALLBACK_FX_FLAT_FEE_USD_VS_FX_MIN_SEND_USD/,
    );
  });

  // Assert contra el LITERAL, no contra la constante importada: un test que compara la config
  // contra el mismo default que la produce verifica el cableado, no el valor. Si alguien cambia
  // el mínimo o la comisión por defecto, este test tiene que ponerse rojo y obligar a una
  // decisión explícita — es la decisión del founder, no un detalle de implementación.
  it("T-314-6: los defaults son mínimo 5 y comisión 0.50, o sea 10% en el piso (la mitad del techo)", async () => {
    const { resolveFxConfig } = await import("./fx-config");
    const config = resolveFxConfig();

    expect(config.minSendUsd).toBe(5);
    expect(config.flatFeeUsd).toBe(0.5);
    // La atadura, escrita como afirmación y no como comentario: en el peor caso aceptado por
    // la configuración por defecto (un envío exactamente en el mínimo), la comisión es el 10%.
    expect(config.flatFeeUsd / config.minSendUsd).toBeCloseTo(0.1, 10);
  });

  // El continuo del que el cero es sólo el borde visible: 60 centavos entregaban S/ 0.33, o sea
  // una comisión del 83%, y pasaban TODOS los controles. Ese caso no se ataja con un guard
  // propio: no puede ocurrir, porque el mínimo y la comisión están atados. Este test fija esa
  // consecuencia para que si alguien desata los dos números, se entere acá.
  it("T-314-7: la proporción comisión/envío queda acotada POR CONSTRUCCIÓN, no por casualidad", async () => {
    const { resolveFxConfig } = await import("./fx-config");
    const { minSendUsd, flatFeeUsd } = resolveFxConfig();
    // El peor caso posible es el envío mínimo: cualquier envío mayor diluye la comisión.
    const peorCasoAceptado = flatFeeUsd / minSendUsd;
    expect(peorCasoAceptado).toBeLessThanOrEqual(0.2);
    // Y el caso histórico concreto queda del lado prohibido: 0.50 sobre 0.60 es el 83%.
    expect(0.5 / 0.6).toBeGreaterThan(0.2);
  });

  // ── AR de WKH-314: la atadura acota la PROPORCIÓN, no el monto entregado ──────────────
  // Este par de configuración pasa TODOS los guards de arriba: el mínimo es > 0, la comisión es
  // exactamente el 20% del mínimo (la atadura acepta, está justo en el techo) y el envío iguala
  // al mínimo (el guard acepta). Y aun así entregaba CERO — no porque `netUsd` sea cero (es
  // 0.0008), sino porque 0.0026 soles REDONDEAN a 0.00 al pasar a céntimos. La plata se perdía
  // en el redondeo, con todos los controles en verde.
  //
  // Lo ataja el guard de salida pidiendo entregado > 0, que es la mitad que faltaba: se exigía
  // que la TASA fuera positiva y no que llegara algo a destino.
  it("T-314-FP1-c: un par de config válido con envío en el mínimo ya no puede entregar cero", async () => {
    // Va por el NÚCLEO a propósito: así el envío atraviesa de verdad el guard del mínimo (que
    // lo acepta, porque iguala al mínimo) y llega al guard de salida. Probándolo contra el
    // proveedor se saltearía el mínimo y el caso dejaría de ser el que el AR encontró.
    const core = await freshCore();
    vi.stubEnv("TRANSFI_API_KEY", "");
    stubFetchOk(erBody(3.4));
    vi.stubEnv("FX_MIN_SEND_USD", "0.001");
    vi.stubEnv("FALLBACK_FX_FLAT_FEE_USD", "0.0002"); // exactamente el 20%: la atadura ACEPTA

    // Efecto primero: no sale ninguna cotización.
    const resultado = await quoteViaCore(core, 0.001).then(
      (q) => q,
      (e: unknown) => e,
    );
    expect(resultado, "no puede emitirse una cotización que entrega cero").toBeInstanceOf(Error);
    // Y el rechazo NO viene del mínimo ni de la atadura (los dos aceptan esta config): viene del
    // guard de salida. Si viniera de otro lado, este caso no estaría realmente cubierto.
    expect((resultado as Error).message).toMatch(/^invalid_quote_net:/);
  });

  // ── AR de WKH-314: el guard se mudó al núcleo para cubrir LOS DOS proveedores ────────────
  // Cuando vivía dentro de `LiveMidFxProvider`, este escenario NO estaba cubierto: con el
  // adapter del socio activo (dos envs, y después de ese opt-in nada vuelve a fallar ruidoso),
  // el mínimo simplemente no existía. Es el test que compra la mudanza; si alguien devuelve el
  // guard al proveedor del mid, este caso se pone rojo.
  it("T-314-FP4: con el adapter del socio ACTIVO, el mínimo sigue cortando — y no se le pega al socio", async () => {
    const core = await freshCore();
    vi.stubEnv("TRANSFI_API_KEY", "clave-de-prueba"); // credencial ficticia, nunca una real
    vi.stubEnv("TRANSFI_ADAPTER_READY", "true");
    vi.stubEnv("TRANSFI_ENV", "sandbox");
    const fetchMock = stubFetchOk(erBody(3.4));

    const resultado = await quoteViaCore(core, 0.4).then(
      (q) => q,
      (e: unknown) => e,
    );

    // Efecto primero: no salió cotización y NO se llamó al partner. Que el socio no reciba el
    // request es la mitad que importa: el corte ocurre antes de cualquier I/O, en los dos caminos.
    expect(resultado).toBeInstanceOf(Error);
    expect(fetchMock, "no se le pega al socio por un envío que vamos a rechazar").not.toHaveBeenCalled();
    expect((resultado as Error).message).toMatch(/^fx_amount_below_minimum:/);
  });

  // Contra-ejemplo del anterior: con el adapter activo y un monto válido, el núcleo SÍ llega al
  // socio. Sin esto, un mutante que cortara siempre en el camino de TransFi quedaría verde.
  it("T-314-FP4-neg: con el adapter del socio activo y un monto válido, el request SÍ sale", async () => {
    const core = await freshCore();
    vi.stubEnv("TRANSFI_API_KEY", "clave-de-prueba");
    vi.stubEnv("TRANSFI_ADAPTER_READY", "true");
    vi.stubEnv("TRANSFI_ENV", "sandbox");
    const fetchMock = stubFetchOk({
      rate: 3.6,
      fee: 0.5,
      destAmount: 358.4,
      quoteId: "tq-min",
      // El `expiresAt` del partner ENTRÓ AL ARRANGE (2026-08-04) y no es decoración: desde que el
      // vencimiento viaja firmado dentro de la referencia, el núcleo no puede emitir una cotización
      // que no diga hasta cuándo vale. Sin este campo el caso de abajo lo cubre explícitamente.
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    });

    const q = await quoteViaCore(core, 100);
    expect(q.provenance).toBe("transfi");
    expect(fetchMock).toHaveBeenCalled();
  });

  // 🔴 EL CAMINO DEL SOCIO SIN VENCIMIENTO NO COTIZA (2026-08-04). `fx.ts` mapea
  // `expiresAt: String(d.expiresAt ?? "")`: si el partner no lo manda, llega vacío. Antes eso era
  // inocuo porque el vencimiento era decorativo; ahora es la vigencia que el desembolso hace
  // cumplir, y una referencia sin ella no vence NUNCA. Se corta al EMITIR (502 ruidoso, y el
  // `TRANSFI_ADAPTER_READY` existe justo para que esto se descubra al activar el adapter y no con
  // plata real), en vez de emitir una referencia eterna: mismo criterio que `assertValidQuote` con
  // una tasa NaN — antes que emitir algo que nadie pueda respaldar, no se emite.
  it("T-EXP-1: el socio que NO declara expiresAt no produce cotización (nada de referencias eternas)", async () => {
    const core = await freshCore();
    vi.stubEnv("TRANSFI_API_KEY", "clave-de-prueba");
    vi.stubEnv("TRANSFI_ADAPTER_READY", "true");
    vi.stubEnv("TRANSFI_ENV", "sandbox");
    // Exactamente el body de arriba, MENOS `expiresAt`: la única diferencia es la que decide.
    stubFetchOk({ rate: 3.6, fee: 0.5, destAmount: 358.4, quoteId: "tq-min" });

    const resultado = await quoteViaCore(core, 100).then(
      (q) => q,
      (e: unknown) => e,
    );

    // Efecto primero: NO hay cotización. Y el rechazo viene del guard del vencimiento y no de
    // cualquier otro throw del camino — si no, el caso no estaría realmente cubierto.
    expect(resultado, "no puede emitirse una referencia que no vence nunca").toBeInstanceOf(Error);
    expect((resultado as Error).message).toMatch(/^quote_ref_unusable_expiry:/);
  });

  it("T-314-8: el mínimo se rota por env sin reimportar el módulo (call-time, como el resto)", async () => {
    const core = await freshCore();
    vi.stubEnv("TRANSFI_API_KEY", "");
    stubFetchOk(erBody(3.4));
    vi.stubEnv("FX_RATE_CACHE_TTL_MS", "0");

    vi.stubEnv("FX_MIN_SEND_USD", "50");
    await expect(quoteViaCore(core, 20)).rejects.toThrow(/fx_amount_below_minimum:50/);

    // MISMA instancia del módulo: si el mínimo se leyera al importar, esto seguiría cortando.
    vi.stubEnv("FX_MIN_SEND_USD", "10");
    expect((await quoteViaCore(core, 20)).netDeliveredLocal).toBeGreaterThan(0);
  });

  it("T-314-9: un mínimo de cero o negativo no es un mínimo — config inválida", async () => {
    for (const value of ["0", "-1"]) {
      const mod = await freshFx();
      stubFetchOk(erBody(3.4));
      vi.stubEnv("FX_MIN_SEND_USD", value);
      await expect(quoteAmount(mod, 100), `FX_MIN_SEND_USD=${value}`).rejects.toThrow(
        /fx_mid_config_invalid:FX_MIN_SEND_USD/,
      );
    }
  });

  // El guard se testea como UNIDAD, mismo criterio que `assertValidQuote` y `checkFreshness`.
  // La rama del `NaN` no es alcanzable desde la ruta HTTP (Zod exige un número), y por eso
  // necesita este test: `amountUsd < min` ACEPTA un `NaN` y `!(amountUsd >= min)` lo RECHAZA.
  // Es la misma trampa que ya mordió a la frescura en la HU anterior.
  it("T-314-10: assertAmountAboveMinimum rechaza NaN (la comparación ingenua lo aceptaría)", async () => {
    const { assertAmountAboveMinimum } = await freshFx();
    const { resolveFxConfig } = await import("./fx-config");
    const config = resolveFxConfig();

    expect(() => assertAmountAboveMinimum(Number.NaN, config)).toThrow(/fx_amount_below_minimum/);
    expect(() => assertAmountAboveMinimum(4.99, config)).toThrow(/fx_amount_below_minimum/);
    // y el lado que debe pasar, para que el guard no sea "rechazar siempre"
    expect(() => assertAmountAboveMinimum(5, config)).not.toThrow();
    expect(() => assertAmountAboveMinimum(1000, config)).not.toThrow();
  });

  // ════════════════════════════════════════════════════════════════════════════
  // LA OTRA PUNTA DEL MISMO CAMPO: EL TECHO COTIZABLE (10.000 USD, del AGENTE)
  //
  // Antes de esto, `amountUsd` sólo tenía piso. Medido el 2026-07-31 con el mid en 3.40 y
  // TODOS los guards existentes en verde: 1e6 devolvía 200 con S/ 3.314.998,34; 1e15 y hasta
  // 1e300 también. El desbordamiento a `Infinity` recién corta en 1e308 (`invalid_quote_net`,
  // → 502), así que entre el caso legítimo y el punto donde la aritmética se rompe había un
  // rango de 300 órdenes de magnitud donde el agente EMITÍA una cotización y se comprometía a
  // honrarla diez minutos. Lo que faltaba no era robustez numérica: era la política.
  //
  // El tope es DEL AGENTE, no por caller: así protege al operador de cualquier caller,
  // incluidos los que todavía no existen. Un tope por caller es una excepción explícita que se
  // agrega el día que un cliente grande la pida, y no una puerta abierta por defecto.
  // ════════════════════════════════════════════════════════════════════════════

  it("T-MAX-1 (EL test): un pedido por un millón se rechaza, y el feed ni se consulta", async () => {
    const core = await freshCore();
    vi.stubEnv("TRANSFI_API_KEY", "");
    const fetchMock = stubFetchOk(erBody(3.4)); // feed sano: en banda y fresco

    const error = await quoteViaCore(core, 1_000_000).then(
      (q) => q,
      (e: unknown) => e,
    );

    // ── EL EFECTO PRIMERO ────────────────────────────────────────────────────
    // Lo que importa no es cómo se llama el error: es que NO salió una cotización por un millón
    // de dólares con fecha de vencimiento. Si esta aserción fuera después de la del mensaje, un
    // mutante que sólo cambiara el texto mataría el test sin llegar a mirar si se emitió.
    expect(error, "no puede emitirse una cotización por encima del techo").toBeInstanceOf(Error);
    expect(
      fetchMock,
      "el monto se rechaza ANTES de salir a buscar la tasa, igual que el mínimo",
    ).not.toHaveBeenCalled();

    // ── y recién ahora, la forma del rechazo ─────────────────────────────────
    expect((error as Error).message).toMatch(/^fx_amount_above_maximum:/);
    // El techo VIAJA en el error: sin esto el caller lo descubre por bisección.
    expect((error as Error).message).toBe("fx_amount_above_maximum:10000");
  });

  it("T-MAX-2: el borde exacto, 10.000 justo SÍ cotiza, un centavo más NO", async () => {
    const core = await freshCore();
    vi.stubEnv("TRANSFI_API_KEY", "");
    stubFetchOk(erBody(3.4));

    // Exactamente el techo: pasa. El guard es `<=`, no `<`. El borde va para adentro, igual
    // que el del mínimo: los dos extremos del rango son montos cotizables.
    const enElBorde = await quoteViaCore(core, 10000);
    expect(enElBorde.netDeliveredLocal).toBeGreaterThan(0);

    // Un centavo por encima: corta.
    await expect(quoteViaCore(core, 10000.01)).rejects.toThrow(/fx_amount_above_maximum/);
  });

  it("T-MAX-3: el rango sano sigue cotizando y el mínimo sigue cortando (el techo no se comió nada)", async () => {
    const core = await freshCore();
    vi.stubEnv("TRANSFI_API_KEY", "");
    stubFetchOk(erBody(3.4));

    // Contra-ejemplo obligatorio: un guard que rechaza siempre pasaría todos los tests de
    // arriba. Estos montos son los que el agente existe para cotizar.
    for (const amount of [5, 100, 400, 9999.99]) {
      expect((await quoteViaCore(core, amount)).netDeliveredLocal, `amountUsd=${amount}`)
        .toBeGreaterThan(0);
    }
    // Y la punta de abajo sigue exactamente como estaba: agregar el techo no la tocó.
    await expect(quoteViaCore(core, 4.99)).rejects.toThrow(/fx_amount_below_minimum:5/);
  });

  it("T-MAX-4: los dos rechazos son DISTINGUIBLES, quien integra sabe para dónde corregir", async () => {
    const core = await freshCore();
    vi.stubEnv("TRANSFI_API_KEY", "");
    stubFetchOk(erBody(3.4));

    const chico = await quoteViaCore(core, 1).catch((e: unknown) => (e as Error).message);
    const grande = await quoteViaCore(core, 1_000_000).catch((e: unknown) => (e as Error).message);

    expect(chico).toMatch(/^fx_amount_below_minimum:/);
    expect(grande).toMatch(/^fx_amount_above_maximum:/);
    // Y no se solapan: colapsar los dos en un código único dejaría al caller sin saber si tiene
    // que subir o bajar el monto. Cada uno además trae SU límite, que son números distintos.
    expect(chico).not.toBe(grande);
    expect(chico).not.toContain("above_maximum");
    expect(grande).not.toContain("below_minimum");
  });

  // Assert contra el LITERAL 10000, no contra la constante importada: un test que compara la
  // config contra el mismo default que la produce verifica el cableado, no el valor. Es la
  // decisión del founder, y cambiarla tiene que costar poner este test en rojo a propósito.
  it("T-MAX-5: el techo por defecto es 10.000 USD (decisión del founder, no un detalle)", async () => {
    const { resolveFxConfig } = await import("./fx-config");
    const config = resolveFxConfig();

    expect(config.maxSendUsd).toBe(10000);
    // Y el rango por defecto es el que se decidió: de 5 a 10.000.
    expect(config.minSendUsd).toBe(5);
  });

  it("T-MAX-6: el techo se rota por env sin reimportar el módulo (call-time, como el resto)", async () => {
    const core = await freshCore();
    vi.stubEnv("TRANSFI_API_KEY", "");
    stubFetchOk(erBody(3.4));
    vi.stubEnv("FX_RATE_CACHE_TTL_MS", "0");

    vi.stubEnv("FX_MAX_SEND_USD", "100");
    await expect(quoteViaCore(core, 500)).rejects.toThrow(/fx_amount_above_maximum:100/);

    // MISMA instancia del módulo: si el techo se leyera al importar, esto seguiría cortando.
    vi.stubEnv("FX_MAX_SEND_USD", "1000");
    expect((await quoteViaCore(core, 500)).netDeliveredLocal).toBeGreaterThan(0);
  });

  it("T-MAX-7: un techo por debajo del piso es CONFIG INVÁLIDA, no un agente que rechaza todo", async () => {
    // Sin esta validación, `FX_MAX_SEND_USD=1` con el piso en 5 deja una banda vacía: NINGÚN
    // monto cotiza, y el error que ve el caller es el del MÍNIMO, que apunta a la variable
    // equivocada. Preferimos que no arranque a que conteste 400 a todo y culpe al caller.
    for (const value of ["1", "5", "0", "-1"]) {
      const core = await freshCore();
      vi.stubEnv("TRANSFI_API_KEY", "");
      const fetchMock = stubFetchOk(erBody(3.4));
      vi.stubEnv("FX_MIN_SEND_USD", "5");
      vi.stubEnv("FX_MAX_SEND_USD", value);

      await expect(quoteViaCore(core, 100), `FX_MAX_SEND_USD=${value}`).rejects.toThrow(
        /fx_mid_config_invalid:FX_MAX_SEND_USD/,
      );
      expect(fetchMock, "config inválida ⇒ ni se consulta el feed").not.toHaveBeenCalled();
      vi.unstubAllEnvs();
    }
  });

  // El análogo de T-314-FP4, y es el test que compra que el guard viva en el NÚCLEO: con el
  // adapter del socio activo, un techo escrito dentro de `LiveMidFxProvider` no existiría.
  it("T-MAX-8: con el adapter del socio ACTIVO, el techo sigue cortando, y no se le pega al socio", async () => {
    const core = await freshCore();
    vi.stubEnv("TRANSFI_API_KEY", "clave-de-prueba"); // credencial ficticia, nunca una real
    vi.stubEnv("TRANSFI_ADAPTER_READY", "true");
    vi.stubEnv("TRANSFI_ENV", "sandbox");
    const fetchMock = stubFetchOk(erBody(3.4));

    const resultado = await quoteViaCore(core, 1_000_000).then(
      (q) => q,
      (e: unknown) => e,
    );

    expect(resultado).toBeInstanceOf(Error);
    expect(
      fetchMock,
      "no se le pide una cotización por un millón a un socio por un envío que vamos a rechazar",
    ).not.toHaveBeenCalled();
    expect((resultado as Error).message).toMatch(/^fx_amount_above_maximum:/);
  });

  // El guard como UNIDAD, mismo criterio que `assertAmountAboveMinimum`. La rama del `NaN` no es
  // alcanzable desde la ruta (Zod exige un número, y el mínimo corre antes), y por eso necesita
  // este test: `amountUsd > max` ACEPTA un `NaN` y `!(amountUsd <= max)` lo RECHAZA. El guard
  // tiene que ser correcto por sí solo, sin depender de quién corra antes.
  it("T-MAX-9: assertAmountBelowMaximum rechaza NaN (la comparación ingenua lo aceptaría)", async () => {
    const { assertAmountBelowMaximum } = await freshFx();
    const { resolveFxConfig } = await import("./fx-config");
    const config = resolveFxConfig();

    expect(() => assertAmountBelowMaximum(Number.NaN, config)).toThrow(/fx_amount_above_maximum/);
    expect(() => assertAmountBelowMaximum(10000.01, config)).toThrow(/fx_amount_above_maximum/);
    expect(() => assertAmountBelowMaximum(Number.POSITIVE_INFINITY, config)).toThrow(
      /fx_amount_above_maximum/,
    );
    // y el lado que debe pasar, para que el guard no sea "rechazar siempre"
    expect(() => assertAmountBelowMaximum(10000, config)).not.toThrow();
    expect(() => assertAmountBelowMaximum(100, config)).not.toThrow();
  });
});
