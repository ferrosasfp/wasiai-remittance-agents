import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runCorridorFx } from "./corridor-fx";

describe("runCorridorFx", () => {
  beforeEach(() => {
    vi.stubEnv("TRANSFI_API_KEY", ""); // usa el fallback (FX mid real mockeado)
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ rates: { PEN: 3.8 } }) })),
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
});
