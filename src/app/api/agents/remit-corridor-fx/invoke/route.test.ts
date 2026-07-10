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

describe("POST /api/agents/remit-corridor-fx/invoke", () => {
  beforeEach(() => {
    vi.stubEnv("TRANSFI_API_KEY", ""); // fallback (FX mid real mockeado)
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ rates: { PEN: 3.8 } }) })),
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

  // AC-4: TransFi OFF → provenance local-fallback
  it("TransFi OFF → provenance local-fallback", async () => {
    const res = await invoke({ amountUsd: 100 });
    const { result } = await res.json();
    expect(result.provenance).toBe("local-fallback");
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
