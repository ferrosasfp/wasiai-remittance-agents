import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveFxConfig, FX_SOURCE_REGISTRY } from "./fx-config";

// Envs que este archivo manipula. Snapshot/restore MANUAL (no `vi.stubEnv`) porque varios casos
// necesitan la env AUSENTE, no vacía: "sin setear" es el estado que resuelve los defaults.
const MANAGED_ENVS = [
  "FX_MID_SOURCES",
  "FX_MID_ER_API_URL",
  "FX_MID_CURRENCY_API_URL",
  "FX_RATE_CACHE_TTL_MS",
  "FX_MID_MAX_AGE_MS",
  "FX_MID_MIN_USD_PEN",
  "FX_MID_MAX_USD_PEN",
] as const;

let envSnapshot: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  envSnapshot = {};
  for (const key of MANAGED_ENVS) envSnapshot[key] = process.env[key];
  // Punto de partida de TODOS los casos: ninguna env declarada (se resuelven los defaults).
  for (const key of MANAGED_ENVS) setEnv(key, undefined);
});

afterEach(() => {
  for (const key of MANAGED_ENVS) setEnv(key, envSnapshot[key]);
});

// T19 — SDD §4.3
describe("resolveFxConfig — defaults (cada uno afirma algo sobre el mundo externo)", () => {
  it("sin ninguna env, los 6 defaults son exactamente los declarados", () => {
    const config = resolveFxConfig();
    expect(config.cacheTtlMs).toBe(300000); // 5 min
    expect(config.maxAgeMs).toBe(172800000); // 48 h
    expect(config.minRate).toBe(2.5);
    expect(config.maxRate).toBe(5.0);
    expect(config.sources.map((s) => s.id)).toEqual(["er-api", "currency-api"]);
    expect(config.sources.map((s) => s.url)).toEqual([
      "https://open.er-api.com/v6/latest/USD",
      "https://latest.currency-api.pages.dev/v1/currencies/usd.json",
    ]);
  });

  it("la banda default deja pasar el mercado real (~3.40) y ataja los absurdos", () => {
    const { minRate, maxRate } = resolveFxConfig();
    expect(3.4).toBeGreaterThan(minRate);
    expect(3.4).toBeLessThan(maxRate);
    // los casos que la banda existe para atajar
    expect(0).toBeLessThan(minRate); // un cero
    expect(37.5).toBeGreaterThan(maxRate); // un orden de magnitud
    expect(7300).toBeGreaterThan(maxRate); // la tasa de OTRA moneda (PYG)
    expect(0.92).toBeLessThan(minRate); // EUR
  });
});

// T7 — AC-3
describe("resolveFxConfig — elegir y reordenar fuentes por env", () => {
  it("FX_MID_SOURCES='currency-api' deja UNA sola fuente", () => {
    setEnv("FX_MID_SOURCES", "currency-api");
    const config = resolveFxConfig();
    expect(config.sources.map((s) => s.id)).toEqual(["currency-api"]);
  });

  it("invertir el orden de la env invierte el orden de la cascada", () => {
    setEnv("FX_MID_SOURCES", "currency-api,er-api");
    expect(resolveFxConfig().sources.map((s) => s.id)).toEqual(["currency-api", "er-api"]);
  });

  it("tolera espacios alrededor de los ids", () => {
    setEnv("FX_MID_SOURCES", "  currency-api ,  er-api  ");
    expect(resolveFxConfig().sources.map((s) => s.id)).toEqual(["currency-api", "er-api"]);
  });
});

// T8 — AC-3, AC-8
describe("resolveFxConfig — una fuente no registrada es config inválida, no una lista vacía", () => {
  it("un id no registrado lanza fx_mid_config_invalid:FX_MID_SOURCES", () => {
    setEnv("FX_MID_SOURCES", "er-api,inventada");
    expect(() => resolveFxConfig()).toThrow(/fx_mid_config_invalid:FX_MID_SOURCES/);
  });

  it("un id no registrado NO degrada a saltearlo y quedarse con el resto", () => {
    setEnv("FX_MID_SOURCES", "inventada");
    expect(() => resolveFxConfig()).toThrow(/fx_mid_config_invalid:FX_MID_SOURCES/);
  });

  it("una lista vacía (solo comas o whitespace) lanza, no deja la cascada sin fuentes", () => {
    for (const value of [",", " , , ", "   "]) {
      setEnv("FX_MID_SOURCES", value);
      if (value.trim() === "") {
        // whitespace puro cae al default (env "no declarada"), no a cero fuentes
        expect(resolveFxConfig().sources.length).toBeGreaterThan(0);
      } else {
        expect(() => resolveFxConfig()).toThrow(/fx_mid_config_invalid:FX_MID_SOURCES/);
      }
    }
  });

  it("una URL en vez de un id NO se acepta (la env elige fuentes registradas, no URLs libres)", () => {
    setEnv("FX_MID_SOURCES", "https://open.er-api.com/v6/latest/USD");
    expect(() => resolveFxConfig()).toThrow(/fx_mid_config_invalid:FX_MID_SOURCES/);
  });
});

// T9 — AC-3
describe("resolveFxConfig — override de host por fuente (el punto de extensión no es un control muerto)", () => {
  it("FX_MID_ER_API_URL cambia la URL de er-api y CONSERVA su parser", () => {
    setEnv("FX_MID_ER_API_URL", "http://localhost:9/x");
    const config = resolveFxConfig();
    const erApi = config.sources.find((s) => s.id === "er-api");
    expect(erApi?.url).toBe("http://localhost:9/x");
    // el parser sigue siendo el de er-api: lee rates.PEN + time_last_update_unix
    const parsed = erApi?.parse({
      rates: { PEN: 3.4 },
      time_last_update_unix: Math.floor(Date.now() / 1000),
    });
    expect(parsed?.rate).toBe(3.4);
  });

  it("FX_MID_CURRENCY_API_URL cambia sólo la URL de currency-api", () => {
    setEnv("FX_MID_CURRENCY_API_URL", "http://localhost:9/y");
    const config = resolveFxConfig();
    expect(config.sources.find((s) => s.id === "currency-api")?.url).toBe("http://localhost:9/y");
    expect(config.sources.find((s) => s.id === "er-api")?.url).toBe(
      "https://open.er-api.com/v6/latest/USD",
    );
  });

  it("un override vacío o de whitespace cae a la URL canónica", () => {
    for (const value of ["", "   "]) {
      setEnv("FX_MID_ER_API_URL", value);
      expect(resolveFxConfig().sources.find((s) => s.id === "er-api")?.url).toBe(
        "https://open.er-api.com/v6/latest/USD",
      );
    }
  });
});

// T17 — AC-8: el bug de la casa, por 5ª vez
describe("resolveFxConfig — config inválida LANZA (nunca cotizar con un guard apagado)", () => {
  it("FX_MID_MAX_USD_PEN='abc' lanza en vez de desactivar la banda en silencio", () => {
    setEnv("FX_MID_MAX_USD_PEN", "abc");
    expect(() => resolveFxConfig()).toThrow(/fx_mid_config_invalid:FX_MID_MAX_USD_PEN/);
    // la premisa del guard: comparar contra NaN da false SIEMPRE, así que sin el throw la banda
    // no rechazaría absolutamente nada.
    expect(37.5 > Number("abc")).toBe(false);
    expect(0.0001 < Number("abc")).toBe(false);
  });

  it("min >= max lanza señalando FX_MID_MAX_USD_PEN (banda vacía)", () => {
    setEnv("FX_MID_MIN_USD_PEN", "5");
    setEnv("FX_MID_MAX_USD_PEN", "5");
    expect(() => resolveFxConfig()).toThrow(/fx_mid_config_invalid:FX_MID_MAX_USD_PEN/);
    setEnv("FX_MID_MIN_USD_PEN", "6");
    setEnv("FX_MID_MAX_USD_PEN", "5");
    expect(() => resolveFxConfig()).toThrow(/fx_mid_config_invalid:FX_MID_MAX_USD_PEN/);
  });

  it("TTL negativo lanza señalando FX_RATE_CACHE_TTL_MS", () => {
    setEnv("FX_RATE_CACHE_TTL_MS", "-1");
    expect(() => resolveFxConfig()).toThrow(/fx_mid_config_invalid:FX_RATE_CACHE_TTL_MS/);
  });

  it("TTL 0 es válido (deshabilita la caché, no es una config rota)", () => {
    setEnv("FX_RATE_CACHE_TTL_MS", "0");
    expect(resolveFxConfig().cacheTtlMs).toBe(0);
  });

  it("MAX_AGE '0' lanza señalando FX_MID_MAX_AGE_MS (ningún dato sería fresco jamás)", () => {
    setEnv("FX_MID_MAX_AGE_MS", "0");
    expect(() => resolveFxConfig()).toThrow(/fx_mid_config_invalid:FX_MID_MAX_AGE_MS/);
  });

  it("MIN negativo o 0 lanza señalando FX_MID_MIN_USD_PEN", () => {
    for (const value of ["-1", "0"]) {
      setEnv("FX_MID_MIN_USD_PEN", value);
      expect(() => resolveFxConfig()).toThrow(/fx_mid_config_invalid:FX_MID_MIN_USD_PEN/);
    }
  });

  it("cada numérico no finito lanza señalando SU PROPIO campo", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["FX_RATE_CACHE_TTL_MS", "abc"],
      ["FX_MID_MAX_AGE_MS", "no-numero"],
      ["FX_MID_MIN_USD_PEN", "NaN"],
      ["FX_MID_MAX_USD_PEN", "{}"],
    ];
    for (const [field, value] of cases) {
      for (const key of MANAGED_ENVS) setEnv(key, undefined);
      setEnv(field, value);
      expect(() => resolveFxConfig()).toThrow(new RegExp(`fx_mid_config_invalid:${field}`));
    }
  });

  it("Infinity no pasa como numérico válido", () => {
    setEnv("FX_MID_MAX_USD_PEN", "Infinity");
    expect(() => resolveFxConfig()).toThrow(/fx_mid_config_invalid:FX_MID_MAX_USD_PEN/);
  });
});

// T18 — AC-9: el mutante M8 muere acá
describe("resolveFxConfig — call-time (rotar una env surte efecto sin redeploy)", () => {
  it("cambiar la env DESPUÉS del import cambia la conducta, SIN vi.resetModules()", () => {
    // el módulo ya está importado en el tope del archivo: si la config se leyera al importar,
    // este cambio no tendría ningún efecto y el test moriría.
    expect(resolveFxConfig().maxRate).toBe(5.0);
    setEnv("FX_MID_MAX_USD_PEN", "40");
    expect(resolveFxConfig().maxRate).toBe(40);
    setEnv("FX_MID_MAX_USD_PEN", "7");
    expect(resolveFxConfig().maxRate).toBe(7);
  });

  it("lo mismo para la lista de fuentes", () => {
    expect(resolveFxConfig().sources.map((s) => s.id)).toEqual(["er-api", "currency-api"]);
    setEnv("FX_MID_SOURCES", "currency-api");
    expect(resolveFxConfig().sources.map((s) => s.id)).toEqual(["currency-api"]);
  });
});

describe("parsers de las fuentes registradas (cada fuente trae el suyo)", () => {
  const erApi = FX_SOURCE_REGISTRY.find((s) => s.id === "er-api")!;
  const currencyApi = FX_SOURCE_REGISTRY.find((s) => s.id === "currency-api")!;

  it("er-api lee rates.PEN y time_last_update_unix (segundos)", () => {
    const parsed = erApi.parse({ rates: { PEN: 3.403282 }, time_last_update_unix: 1785283351 });
    expect(parsed?.rate).toBe(3.403282);
    expect(parsed?.dataAsOf).toBe(new Date(1785283351 * 1000).toISOString());
  });

  it("currency-api lee usd.pen y date (YYYY-MM-DD)", () => {
    const parsed = currencyApi.parse({ usd: { pen: 3.39558288 }, date: "2026-07-29" });
    expect(parsed?.rate).toBe(3.39558288);
    expect(parsed?.dataAsOf).toBe("2026-07-29T00:00:00.000Z");
  });

  it("los parsers NO son intercambiables: cada uno devuelve null con el shape del otro", () => {
    expect(erApi.parse({ usd: { pen: 3.4 }, date: "2026-07-29" })).toBeNull();
    expect(currencyApi.parse({ rates: { PEN: 3.4 }, time_last_update_unix: 1785283351 })).toBeNull();
  });

  // DT-6
  it("SIN fecha declarada ⇒ null (shape inválido): 'no sé de cuándo es' no es 'es de ahora'", () => {
    expect(erApi.parse({ rates: { PEN: 3.4 } })).toBeNull();
    expect(currencyApi.parse({ usd: { pen: 3.4 } })).toBeNull();
    // el caso real: fecha presente pero ilegible
    expect(erApi.parse({ rates: { PEN: 3.4 }, time_last_update_unix: "no-fecha" })).toBeNull();
    expect(currencyApi.parse({ usd: { pen: 3.4 }, date: "29/07/2026" })).toBeNull();
  });

  it("sin tasa usable ⇒ null", () => {
    expect(erApi.parse({ rates: {}, time_last_update_unix: 1785283351 })).toBeNull();
    expect(erApi.parse({ time_last_update_unix: 1785283351 })).toBeNull();
    expect(currencyApi.parse({ usd: {}, date: "2026-07-29" })).toBeNull();
  });

  it("campos extra NO rompen el parseo (las fuentes agregan monedas todo el tiempo)", () => {
    const parsed = erApi.parse({
      result: "success",
      rates: { PEN: 3.4, EUR: 0.92, PYG: 7300 },
      time_last_update_unix: 1785283351,
      time_next_update_utc: "Thu, 30 Jul 2026 00:02:31 +0000",
    });
    expect(parsed?.rate).toBe(3.4);
  });

  it("una tasa como string numérico se coerce (el partner puede mandarla así)", () => {
    expect(erApi.parse({ rates: { PEN: "3.4" }, time_last_update_unix: 1785283351 })?.rate).toBe(3.4);
  });
});
