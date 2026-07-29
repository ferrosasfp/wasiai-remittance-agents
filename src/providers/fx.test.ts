import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  LiveMidFxProvider,
  TransFiFxProvider,
  assertValidQuote,
  checkFreshness,
  getFxQuoteProvider,
} from "./fx";
import { resolveTransFiBaseUrl, type TransFiBaseUrl } from "./transfi-env";
import { MARKET_FX_PROVENANCES, type FxQuote, type FxQuoteInput } from "./types";

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
    expect(assertValidQuote(goodQuote)).toBe(goodQuote);
  });
  it("lanza si rate = NaN", () => {
    expect(() => assertValidQuote({ ...goodQuote, rate: NaN })).toThrow(/invalid_quote_rate/);
  });
  it("lanza si netDeliveredLocal = NaN", () => {
    expect(() => assertValidQuote({ ...goodQuote, netDeliveredLocal: NaN })).toThrow(
      /invalid_quote_net/,
    );
  });
  it("lanza si quoteId vacío", () => {
    expect(() => assertValidQuote({ ...goodQuote, quoteId: "" })).toThrow(/invalid_quote_id/);
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

  it("T-314-1 (EL test): 40 centavos, que antes daban 200 con CERO soles, ahora cortan — y el feed ni se consulta", async () => {
    const mod = await freshFx();
    const fetchMock = stubFetchOk(erBody(3.4)); // feed perfectamente sano: en banda y fresco

    const error = await quoteAmount(mod, 0.4).then(
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
    const mod = await freshFx();
    stubFetchOk(erBody(3.4));

    // Exactamente el mínimo: pasa. El guard es `>=`, no `>`.
    const enElBorde = await quoteAmount(mod, 5);
    expect(enElBorde.netDeliveredLocal).toBeGreaterThan(0);

    // Un centavo por debajo: corta.
    await expect(quoteAmount(mod, 4.99)).rejects.toThrow(/fx_amount_below_minimum/);
  });

  it("T-314-3: ningún monto aceptado entrega cero (barrido alrededor del punto donde antes fallaba)", async () => {
    const mod = await freshFx();
    stubFetchOk(erBody(3.4));
    // 0.40 y 0.50 daban CERO antes de esta HU; 0.60 daba S/ 0.33 (comisión = 83% del envío).
    for (const amount of [0.01, 0.4, 0.5, 0.6, 1, 4.99]) {
      await expect(quoteAmount(mod, amount), `amountUsd=${amount}`).rejects.toThrow(
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

  it("T-314-8: el mínimo se rota por env sin reimportar el módulo (call-time, como el resto)", async () => {
    const mod = await freshFx();
    stubFetchOk(erBody(3.4));
    vi.stubEnv("FX_RATE_CACHE_TTL_MS", "0");

    vi.stubEnv("FX_MIN_SEND_USD", "50");
    await expect(quoteAmount(mod, 20)).rejects.toThrow(/fx_amount_below_minimum:50/);

    // MISMA instancia del módulo: si el mínimo se leyera al importar, esto seguiría cortando.
    vi.stubEnv("FX_MIN_SEND_USD", "10");
    expect((await quoteAmount(mod, 20)).netDeliveredLocal).toBeGreaterThan(0);
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
});
