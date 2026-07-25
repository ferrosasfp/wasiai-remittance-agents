import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  FallbackFxProvider,
  TransFiFxProvider,
  assertValidQuote,
  getFxQuoteProvider,
} from "./fx";
import type { FxQuote, FxQuoteInput } from "./types";

const goodQuote: FxQuote = {
  rate: 3.7,
  feeUsd: 0.5,
  netDeliveredLocal: 368,
  localCurrency: "PEN",
  etaMinutes: 30,
  quoteId: "q1",
  expiresAt: new Date().toISOString(),
  provenance: "transfi",
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

describe("FallbackFxProvider (FX mid real + spread en contra del cliente)", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ rates: { PEN: 3.8 } }) })),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("aplica spread en contra del cliente + devuelve quote válido", async () => {
    const q = await new FallbackFxProvider().quote({
      amountUsd: 100,
      sourceAsset: "USDC",
      destCurrency: "PEN",
      destCountry: "PE",
      payoutMethod: "yape",
    });
    expect(q.provenance).toBe("local-fallback");
    expect(q.rate).toBeGreaterThan(3.6);
    expect(q.rate).toBeLessThan(3.8); // spread reduce lo que recibe el cliente
    expect(Number.isFinite(q.netDeliveredLocal)).toBe(true);
    expect(q.netDeliveredLocal).toBeGreaterThan(0);
  });
});

describe("getFxQuoteProvider factory (MNR-2: readiness fail-loud)", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("sin key → fallback", () => {
    vi.stubEnv("TRANSFI_API_KEY", "");
    expect(getFxQuoteProvider()).toBeInstanceOf(FallbackFxProvider);
  });
  it("key SIN readiness → throws", () => {
    vi.stubEnv("TRANSFI_API_KEY", "k");
    vi.stubEnv("TRANSFI_ADAPTER_READY", "");
    expect(() => getFxQuoteProvider()).toThrow(/transfi_adapter_not_ready/);
  });
  it("key + readiness → adapter TransFi", () => {
    vi.stubEnv("TRANSFI_API_KEY", "k");
    vi.stubEnv("TRANSFI_ADAPTER_READY", "true");
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
    const q = await new TransFiFxProvider("k").quote(fxInput);
    expect(q).toEqual({
      rate: 3.6,
      feeUsd: 0.4,
      netDeliveredLocal: 358.4,
      localCurrency: "PEN",
      etaMinutes: 15,
      quoteId: "tq-1",
      expiresAt: "2026-07-25T00:00:00.000Z",
      provenance: "transfi",
    });
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
    const q = await new TransFiFxProvider("k").quote(fxInput);
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
    const q = await new TransFiFxProvider("k").quote(fxInput);
    expect(q.rate).toBe(3.65);
    expect(q.feeUsd).toBe(0.5);
    expect(q.netDeliveredLocal).toBe(365);
    expect(q.etaMinutes).toBe(20);
  });

  it("(b) id numérico + fee null + fallback quoteId→id → coerciones históricas preservadas", async () => {
    stubQuoteResponse({ rate: 3.6, fee: null, destAmount: 358.4, id: 99, expiresAt: null });
    const q = await new TransFiFxProvider("k").quote(fxInput);
    expect(q.quoteId).toBe("99"); // String(d.quoteId ?? d.id)
    expect(q.feeUsd).toBe(0); // fee null → ?? 0
    expect(q.expiresAt).toBe(""); // expiresAt null → ?? ""
    expect(q.etaMinutes).toBe(30); // default histórico
  });

  it("(c) shape inválido (rate como objeto) → throws transfi_quote_bad_shape", async () => {
    stubQuoteResponse({ rate: { value: 3.6 }, destAmount: 358.4, quoteId: "tq-4" });
    await expect(new TransFiFxProvider("k").quote(fxInput)).rejects.toThrow(
      /transfi_quote_bad_shape/,
    );
  });

  it("(c) body que no es objeto (array) → throws transfi_quote_bad_shape", async () => {
    stubQuoteResponse([{ rate: 3.6 }]);
    await expect(new TransFiFxProvider("k").quote(fxInput)).rejects.toThrow(
      /transfi_quote_bad_shape/,
    );
  });

  it("(c) campo AUSENTE (rate) → degradación byte-idéntica: muere en assertValidQuote", async () => {
    // el schema es .nullish() a propósito: un campo faltante NO inventa un error nuevo, sigue
    // cayendo en el guard de dinero de siempre (BLQ-MED-2).
    stubQuoteResponse({ destAmount: 358.4, quoteId: "tq-5" });
    await expect(new TransFiFxProvider("k").quote(fxInput)).rejects.toThrow(/invalid_quote_rate/);
  });

  it("(c) quoteId/id ausentes → degradación byte-idéntica: invalid_quote_id", async () => {
    stubQuoteResponse({ rate: 3.6, destAmount: 358.4 });
    await expect(new TransFiFxProvider("k").quote(fxInput)).rejects.toThrow(/invalid_quote_id/);
  });

  it("!res.ok → sigue lanzando transfi_quote_error_<n> (nada cambió antes del parseo)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
    await expect(new TransFiFxProvider("k").quote(fxInput)).rejects.toThrow(
      /transfi_quote_error_503/,
    );
  });
});

describe("FallbackFxProvider — validación de shape del feed FX (open.er-api.com)", () => {
  // El mid tiene cache a nivel MÓDULO: cada caso necesita una instancia FRESCA del módulo, si no
  // el primer test que cachea una tasa contamina a los demás.
  async function freshQuote(body: unknown): Promise<FxQuote> {
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => body })));
    const mod = await import("./fx");
    return new mod.FallbackFxProvider().quote(fxInput);
  }
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("(a) feed válido → usa la tasa real del feed", async () => {
    const q = await freshQuote({ rates: { PEN: 3.9 } });
    // spread en contra del cliente → siempre por debajo del mid, pero anclado a ÉL (no al estático)
    expect(q.rate).toBeLessThan(3.9);
    expect(q.rate).toBeGreaterThan(3.8);
    expect(q.provenance).toBe("local-fallback");
  });

  it("(b) feed con las ~160 monedas extra → sigue leyendo PEN (passthrough)", async () => {
    const q = await freshQuote({
      result: "success",
      base_code: "USD",
      time_last_update_utc: "Fri, 25 Jul 2026 00:00:01 +0000",
      rates: { USD: 1, EUR: 0.92, PEN: 3.9, BRL: 5.4, ARS: 1010 },
    });
    expect(q.rate).toBeLessThan(3.9);
    expect(q.rate).toBeGreaterThan(3.8);
  });

  it("(c) shape inválido (rates no es objeto) → cae al estático + warn EXPLÍCITO (antes: silencioso)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("STATIC_USD_PEN", "4.2");
    const bad = await freshQuote({ rates: "3.9" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("fx_mid_bad_shape"));
    // control: mismo módulo/spread pero con un feed VÁLIDO de 4.2 → si el bad-shape usó el
    // estático (4.2), las dos tasas tienen que ser idénticas, sin depender del spread configurado.
    const control = await freshQuote({ rates: { PEN: 4.2 } });
    expect(bad.rate).toBe(control.rate);
  });

  it("(c) 2xx sin tasa PEN usable → cae al estático + warn EXPLÍCITO", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("STATIC_USD_PEN", "4.2");
    const missing = await freshQuote({ rates: { EUR: 0.92 } }); // PEN ausente
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("fx_mid_no_usable_pen_rate"));
    const control = await freshQuote({ rates: { PEN: 4.2 } });
    expect(missing.rate).toBe(control.rate);
  });

  it("(c) el quote del fallback sigue siendo VÁLIDO aun degradando al estático", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const q = await freshQuote({ nada: true });
    expect(Number.isFinite(q.rate)).toBe(true);
    expect(q.rate).toBeGreaterThan(0);
    expect(q.netDeliveredLocal).toBeGreaterThan(0);
    expect(q.quoteId).toMatch(/^fallback-/);
  });
});
