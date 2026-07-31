import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runCorridorFx } from "./corridor-fx";
import { checkQuoteBinding } from "../providers/quote-ref";

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

  // ── El `quoteId` que sale lleva el monto firmado adentro ──────────────────────────────────────
  // Es lo que hace posible que el agente de payout verifique la cotización que dice honrar, en vez
  // de creerle al caller dos campos sueltos.

  it("el quoteId emitido RESUELVE contra el monto cotizado, y sólo contra ése", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await runCorridorFx({ amountUsd: 100 });
    expect(checkQuoteBinding(out.quoteId, 100)).toBe("bound");
    expect(checkQuoteBinding(out.quoteId, 1_000_000)).toBe("amount_mismatch");
  });

  // ⚠️ LÍMITE CONOCIDO, PINNEADO ACÁ PARA QUE NADIE LE ATRIBUYA A LA REFERENCIA UNA UNICIDAD QUE NO
  // TIENE. La referencia es una función determinística de (id del proveedor, monto), así que hereda
  // exactamente la unicidad del id del proveedor y ni un gramo más. `LiveMidFxProvider` lo genera
  // como `fxmid-${Date.now()}`, con resolución de MILISEGUNDO: dos cotizaciones del mismo monto en el
  // mismo milisegundo salen con el MISMO `quoteId`, y salían igual antes de este cambio. No lo
  // empeora ni lo arregla; hacerlo único es del generador del proveedor, no de la referencia.
  it("dos cotizaciones de montos DISTINTOS emiten quoteIds distintos", async () => {
    const a = await runCorridorFx({ amountUsd: 100 });
    const b = await runCorridorFx({ amountUsd: 200 });
    expect(a.quoteId).not.toBe(b.quoteId);
  });

  it("límite conocido: mismo monto en el mismo milisegundo → MISMO quoteId (es del generador)", async () => {
    const [a, b] = await Promise.all([
      runCorridorFx({ amountUsd: 100 }),
      runCorridorFx({ amountUsd: 100 }),
    ]);
    // Si algún día `fxmid-` gana entropía, este test se pone rojo y hay que actualizarlo: es el
    // recordatorio de que la unicidad del `quoteId` no la aporta la referencia firmada.
    expect(a.quoteId).toBe(b.quoteId);
  });

  // 🔴 LA HERENCIA DEL TECHO, probada y no supuesta. El agente de payout no re-lee `FX_MAX_SEND_USD`:
  // hereda la decisión porque acá se rechaza ANTES de emitir nada, así que no puede existir una
  // referencia válida por encima del techo. Este test prueba el eslabón que hace válida esa cadena.
  it("por encima de FX_MAX_SEND_USD NO se emite NINGÚN quoteId (el techo corta antes)", async () => {
    vi.stubEnv("FX_MAX_SEND_USD", "10000");
    await expect(runCorridorFx({ amountUsd: 10_001 })).rejects.toThrow(/fx_amount_above_maximum/);
    // Y en el borde exacto sí cotiza: el techo no está corriendo el límite de lugar.
    const out = await runCorridorFx({ amountUsd: 10_000 });
    expect(checkQuoteBinding(out.quoteId, 10_000)).toBe("bound");
  });
});
