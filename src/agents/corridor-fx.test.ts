import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runCorridorFx } from "./corridor-fx";

/**
 * Cuerpo del feed FX CON FECHA declarada. Una fuente que no declara la fecha de su dato se trata
 * como shape inválido: no se puede afirmar frescura de un dato que no dice cuándo se produjo.
 */
function feedBody(pen: number): unknown {
  return { rates: { PEN: pen }, time_last_update_unix: Math.floor(Date.now() / 1000) };
}

describe("runCorridorFx", () => {
  beforeEach(() => {
    vi.stubEnv("TRANSFI_API_KEY", ""); // usa el mid real (mockeado)
    // La caché del mid es estado de MÓDULO: sin TTL 0, un test que simula fuentes caídas serviría
    // la tasa cacheada por un test anterior y pasaría por el motivo equivocado.
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

  it("input válido → quote con slug + montos finitos", async () => {
    const out = await runCorridorFx({ amountUsd: 100 });
    expect(out.slug).toBe("remit-corridor-fx");
    expect(out.localCurrency).toBe("PEN");
    expect(out.netDeliveredLocal).toBeGreaterThan(0);
    expect(Number.isFinite(out.rate)).toBe(true);
    expect(out.quoteId).toBeTruthy();
  });

  it("amount negativo → throws (zod → 400)", async () => {
    await expect(runCorridorFx({ amountUsd: -5 })).rejects.toThrow();
  });

  // T22 — AC-2: el core NO atrapa el fallo de la tasa. El 502 del route no es casualidad:
  // es la consecuencia de que acá se propague en vez de devolver una cotización inventada.
  it("T22: sin ninguna fuente de tasa usable, runCorridorFx RECHAZA (no cotiza igual)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network_down");
      }),
    );
    await expect(runCorridorFx({ amountUsd: 100 })).rejects.toThrow(/fx_mid_unavailable/);
  });

  it("T22b: una tasa absurda (fuera de banda) tampoco produce cotización", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => feedBody(37.5) })),
    );
    await expect(runCorridorFx({ amountUsd: 100 })).rejects.toThrow(/fx_mid_unavailable/);
  });
});
