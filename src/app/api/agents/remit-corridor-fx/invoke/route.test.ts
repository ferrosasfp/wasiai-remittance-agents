import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

// Mock del core con default = implementación real (los demás tests corren el path real).
// El test del 502 usa mockImplementationOnce para forzar un throw sin tocar corridor-fx.ts.
const { runCorridorFxMock } = vi.hoisted(() => ({ runCorridorFxMock: vi.fn() }));
vi.mock("@/agents/corridor-fx", async (importActual) => {
  const actual = await importActual<typeof import("@/agents/corridor-fx")>();
  runCorridorFxMock.mockImplementation(actual.runCorridorFx);
  return { ...actual, runCorridorFx: runCorridorFxMock };
});

import { POST } from "./route";

const ENDPOINT = "http://localhost/api/agents/remit-corridor-fx/invoke";

function invoke(body: unknown) {
  return POST(
    new NextRequest(ENDPOINT, { method: "POST", body: JSON.stringify(body) }),
  );
}

/**
 * Cuerpo del feed FX CON FECHA declarada. Sin fecha, la fuente se descarta por shape inválido.
 */
function feedBody(pen: number): unknown {
  return { rates: { PEN: pen }, time_last_update_unix: Math.floor(Date.now() / 1000) };
}

describe("POST /api/agents/remit-corridor-fx/invoke", () => {
  beforeEach(() => {
    vi.stubEnv("TRANSFI_API_KEY", ""); // mid real (mockeado)
    // La caché del mid es estado de MÓDULO y sobrevive entre tests de este archivo: sin esto, un
    // caso que simula "todas las fuentes caídas" serviría la tasa que cacheó un test anterior y
    // pasaría por el motivo equivocado. TTL 0 ⇒ cada test ejerce la cascada de verdad.
    vi.stubEnv("FX_RATE_CACHE_TTL_MS", "0");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => feedBody(3.8) })),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  // AC-6: body válido → 200 { result } legible por data.result
  it("body válido → 200 { result } legible por data.result", async () => {
    const res = await invoke({ amountUsd: 100 });
    expect(res.status).toBe(200);
    const data = await res.json();
    const output = data.result ?? data; // contrato compose.ts:893
    expect(output.slug).toBe("remit-corridor-fx");
    expect(output.localCurrency).toBe("PEN");
    expect(Number.isFinite(output.rate)).toBe(true);
    expect(output.netDeliveredLocal).toBeGreaterThan(0);
    expect(output.quoteId).toBeTruthy();
  });

  // AC-3: rate deriva del mid real + spread (no hardcode)
  it("rate deriva del mid real + spread declarado", async () => {
    const res = await invoke({ amountUsd: 100 });
    const { result } = await res.json();
    // mid mockeado 3.8, spread default 250 bps → 3.8*(1-0.025)=3.705 (spread en contra)
    expect(result.rate).toBeLessThan(3.8);
    expect(result.rate).toBeGreaterThan(3.6);
  });

  // T3 — AC-1: TransFi OFF → la cotización sale del mid REAL y lo declara
  it("TransFi OFF → provenance fx-mid-live, con fuente y fecha del dato", async () => {
    const res = await invoke({ amountUsd: 100 });
    const { result } = await res.json();
    expect(result.provenance).toBe("fx-mid-live");
    expect(result.rateSource).toBe("er-api");
    expect(Date.parse(result.rateAsOf)).not.toBeNaN();
    // la etiqueta vieja (que compartía nombre con la constante 3.75) ya no se emite
    expect(result.provenance).not.toBe("local-fallback");
  });

  // T4 — AC-2: el fail-closed aterriza en 502, sin cotización a medias
  it("T4: todas las fuentes caídas → 502 quote_unavailable, y el body NO trae result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network_down");
      }),
    );
    const res = await invoke({ amountUsd: 100 });
    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data.error).toBe("quote_unavailable");
    expect("result" in data).toBe(false);
  });

  it("T4b: fuente con tasa fuera de banda → 502, jamás un 200 con esa tasa", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => feedBody(37.5),
      })),
    );
    const res = await invoke({ amountUsd: 100 });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("quote_unavailable");
  });

  // AC-7: amountUsd<=0 → 400 estructurado (no 500)
  it("amountUsd<=0 → 400 estructurado", async () => {
    const res = await invoke({ amountUsd: -5 });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("invalid_input");
    expect(data.details).toBeTruthy();
  });

  // AC-7: body no-JSON → 400 (no 500)
  it("body no-JSON → 400 (no 500)", async () => {
    const res = await POST(
      new NextRequest(ENDPOINT, { method: "POST", body: "not-json{" }),
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("invalid_input");
  });

  // AC-7: runCorridorFx lanza (quote inválida / misconfig) → 502 { error: "quote_unavailable" }
  // sin filtrar stack/internals (patrón cobraya: warn estructurado, body opaco).
  it("runCorridorFx lanza → 502 { error: quote_unavailable } sin filtrar internals", async () => {
    runCorridorFxMock.mockImplementationOnce(async () => {
      throw new Error("assertValidQuote: rate is NaN /secret/internal/path");
    });
    const res = await invoke({ amountUsd: 100 });
    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data).toEqual({ error: "quote_unavailable" });
    // no debe filtrar stack ni el mensaje interno del throw
    expect(JSON.stringify(data)).not.toContain("assertValidQuote");
    expect(JSON.stringify(data)).not.toContain("secret");
    expect(data.stack).toBeUndefined();
  });
});
