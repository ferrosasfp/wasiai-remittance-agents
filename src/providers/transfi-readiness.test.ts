import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LiveMidFxProvider, TransFiFxProvider, getFxQuoteProvider } from "./fx";
import { FallbackPayoutProvider, TransFiPayoutProvider, getPayoutProvider } from "./payout";
import { isPayoutProviderReal } from "../agents/cashout-payout";
import { LEGACY_READINESS_ENV, transfiReadinessEnv } from "./transfi-readiness";

/**
 * ⚠️ CÓMO SE MIDE ACÁ, Y POR QUÉ NO DE LA OTRA FORMA.
 *
 * Ninguna aserción de este archivo compara contra `TRANSFI_*_ADAPTER_READY === "true"`. Un test que
 * recalcula la condición que el código aplica pasa con CUALQUIER condición, incluida la invertida:
 * mide su propia copia de la tabla de verdad, no el cableado. Lo que se mide acá es la CONSECUENCIA
 * observable de la capacidad — qué objeto arma la factory REAL de cada camino:
 *
 *   · cotizar   → `getFxQuoteProvider()`  ⇒ `TransFiFxProvider` (socio) | `LiveMidFxProvider` (mid)
 *                                          | throw `transfi_adapter_not_ready`
 *   · desembolsar → `getPayoutProvider()` ⇒ `TransFiPayoutProvider` (socio, `POST /v3/orders`)
 *                                          | `FallbackPayoutProvider` (mock) | throw
 *
 * Consecuencia deliberada: si alguien le pone un default encendido a una flag, o hace que la legada
 * le gane a la específica, estos tests se ponen rojos aunque el módulo de readiness siga
 * "coherente consigo mismo".
 */

/** Lo único que se puede observar de una capacidad, desde afuera. Conjunto CERRADO. */
type Outcome = "partner" | "fallback" | "not_ready";

const NOT_READY = /transfi_adapter_not_ready/;

function outcomeOf(build: () => unknown, partner: Function, fallback: Function): Outcome {
  let provider: unknown;
  try {
    provider = build();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (NOT_READY.test(message)) return "not_ready";
    throw err; // cualquier otro error es un defecto del test, no un veredicto de readiness
  }
  if (provider instanceof partner) return "partner";
  if (provider instanceof fallback) return "fallback";
  throw new Error(`provider inesperado: ${String(provider)}`);
}

/** Qué hace HOY el camino de la COTIZACIÓN, con la config que esté puesta. */
function fxOutcome(): Outcome {
  return outcomeOf(getFxQuoteProvider, TransFiFxProvider, LiveMidFxProvider);
}

/** Qué hace HOY el camino del DESEMBOLSO, con la config que esté puesta. */
function payoutOutcome(): Outcome {
  return outcomeOf(getPayoutProvider, TransFiPayoutProvider, FallbackPayoutProvider);
}

const FX_FLAG = transfiReadinessEnv("fx");
const PAYOUT_FLAG = transfiReadinessEnv("payout");

/**
 * Las TRES flags se setean SIEMPRE, juntas y explícitamente (`undefined` = borrada). No hay un
 * "no la toco": el estado de las tres es parte del caso de prueba, y un caso que hereda una flag
 * del anterior es exactamente cómo se cuela un falso verde.
 */
function setFlags(flags: {
  fx?: string | undefined;
  payout?: string | undefined;
  legacy?: string | undefined;
}): void {
  vi.stubEnv(FX_FLAG, flags.fx);
  vi.stubEnv(PAYOUT_FLAG, flags.payout);
  vi.stubEnv(LEGACY_READINESS_ENV, flags.legacy);
}

/** Credenciales de las DOS capacidades puestas: el escenario donde el candado compartido dolía. */
function stubBothCredentials(): void {
  vi.stubEnv("TRANSFI_API_KEY", "fake-fx-key"); // credencial de la COTIZACIÓN
  vi.stubEnv("TRANSFI_USERNAME", "fake-user"); // las 3 del DESEMBOLSO
  vi.stubEnv("TRANSFI_PASSWORD", "fake-pass");
  vi.stubEnv("TRANSFI_MID", "fake-mid");
}

beforeEach(() => {
  vi.stubEnv("TRANSFI_ENV", "sandbox"); // host canónico de sandbox; ningún fetch se dispara acá
  vi.stubEnv("TRANSFI_BASE_URL", undefined); // sin override: que no dependa del ambiente de quien corra
  vi.spyOn(console, "warn").mockImplementation(() => {});
  stubBothCredentials();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// La matriz: las dos capacidades son independientes, y cada una responde a SU flag.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("readiness de TransFi — las dos capacidades por separado", () => {
  it("cotización ENCENDIDA / desembolso APAGADO → cotiza con el socio y NO desembolsa", () => {
    setFlags({ fx: "true", payout: undefined, legacy: undefined });
    expect(fxOutcome()).toBe("partner");
    expect(payoutOutcome()).toBe("not_ready");
    // El caso de uso que el candado compartido prohibía: verificar el mapeo de la cotización del
    // socio en sandbox SIN armar el adapter que crea órdenes de off-ramp.
    expect(isPayoutProviderReal()).toBe(false);
  });

  it("cotización APAGADA / desembolso ENCENDIDO → no cotiza con el socio y sí desembolsa", () => {
    setFlags({ fx: undefined, payout: "true", legacy: undefined });
    expect(fxOutcome()).toBe("not_ready");
    expect(payoutOutcome()).toBe("partner");
    expect(isPayoutProviderReal()).toBe(true);
  });

  it("desembolso ENCENDIDO sin TRANSFI_API_KEY → cotiza con el MID y desembolsa con el socio", () => {
    // Ésta es la forma OPERATIVA del caso de arriba, y la prueba de que el sentido "FX apagado /
    // payout encendido" no es una rareza inventada por este cambio: ya era alcanzable ANTES, por el
    // eje de las credenciales (sin `TRANSFI_API_KEY` la cotización cae al mid pase lo que pase con
    // cualquier flag). Cotizar con el mid es un camino de primera clase, con banda y frescura.
    vi.stubEnv("TRANSFI_API_KEY", undefined);
    setFlags({ fx: undefined, payout: "true", legacy: undefined });
    expect(fxOutcome()).toBe("fallback");
    expect(payoutOutcome()).toBe("partner");
  });

  it("las DOS apagadas → las dos cortan con el mismo error fail-loud de siempre", () => {
    setFlags({ fx: undefined, payout: undefined, legacy: undefined });
    expect(() => getFxQuoteProvider()).toThrow(NOT_READY);
    expect(() => getPayoutProvider()).toThrow(NOT_READY);
    expect(isPayoutProviderReal()).toBe(false);
  });

  it("las DOS apagadas → el error nombra la flag específica que falta, no la legada", () => {
    setFlags({ fx: undefined, payout: undefined, legacy: undefined });
    expect(() => getFxQuoteProvider()).toThrow(new RegExp(FX_FLAG));
    expect(() => getPayoutProvider()).toThrow(new RegExp(PAYOUT_FLAG));
  });

  it("las DOS encendidas → las dos hablan con el socio", () => {
    setFlags({ fx: "true", payout: "true", legacy: undefined });
    expect(fxOutcome()).toBe("partner");
    expect(payoutOutcome()).toBe("partner");
    expect(isPayoutProviderReal()).toBe(true);
  });

  it("sin las 3 credenciales, el desembolso cae al mock aunque su flag esté encendida", () => {
    // El readiness es la SEGUNDA llave, no la única: encender la flag no fabrica credenciales.
    vi.stubEnv("TRANSFI_MID", undefined);
    setFlags({ fx: undefined, payout: "true", legacy: undefined });
    expect(payoutOutcome()).toBe("fallback");
    expect(isPayoutProviderReal()).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Valores basura: sólo el literal exacto `"true"` enciende. Todo lo demás APAGA.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("readiness de TransFi — sólo el literal `true` enciende", () => {
  // "TRUE"/"True" son typos plausibles; "1"/"yes" son convenciones de otras herramientas; ""
  // es lo que deja una variable declarada y vacía en Vercel; " true" es un espacio pegado al pegar.
  const BASURA = ["1", "TRUE", "True", "", "yes", "on", " true", "true ", "sí", "false", "0"];

  it.each(BASURA)("cotización con %o → APAGADA (no enciende por truthiness)", (value) => {
    setFlags({ fx: value, payout: undefined, legacy: undefined });
    expect(fxOutcome()).toBe("not_ready");
  });

  it.each(BASURA)("desembolso con %o → APAGADO (no enciende por truthiness)", (value) => {
    setFlags({ fx: undefined, payout: value, legacy: undefined });
    expect(payoutOutcome()).toBe("not_ready");
    expect(isPayoutProviderReal()).toBe(false);
  });

  it.each(BASURA)("la legada con %o → APAGA las dos capacidades", (value) => {
    setFlags({ fx: undefined, payout: undefined, legacy: value });
    expect(fxOutcome()).toBe("not_ready");
    expect(payoutOutcome()).toBe("not_ready");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// La flag LEGADA: sigue valiendo como paraguas (compat), pero pierde contra la específica.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("readiness de TransFi — la flag legada `TRANSFI_ADAPTER_READY`", () => {
  it("legada=true y ninguna específica → las dos encendidas, igual que antes del cambio", () => {
    // COMPATIBILIDAD DURA: un deploy que hoy tiene sólo la legada no puede cambiar de conducta.
    setFlags({ fx: undefined, payout: undefined, legacy: "true" });
    expect(fxOutcome()).toBe("partner");
    expect(payoutOutcome()).toBe("partner");
    expect(isPayoutProviderReal()).toBe(true);
  });

  it("legada=true + desembolso declarado VACÍO → la legada NO lo enciende", () => {
    // El mutante que este cambio existe para matar: si la legada le ganara a la específica, el
    // candado seguiría compartido y no habría forma de habilitar una capacidad sola.
    setFlags({ fx: undefined, payout: "", legacy: "true" });
    expect(fxOutcome()).toBe("partner"); // la que no declaró nada sí hereda el paraguas
    expect(payoutOutcome()).toBe("not_ready");
    expect(isPayoutProviderReal()).toBe(false);
  });

  it("legada=true + cotización declarada `false` → la legada NO la enciende", () => {
    setFlags({ fx: "false", payout: undefined, legacy: "true" });
    expect(fxOutcome()).toBe("not_ready");
    expect(payoutOutcome()).toBe("partner");
  });

  it("legada=true + las dos específicas apagadas → NINGUNA capacidad queda encendida", () => {
    setFlags({ fx: "", payout: "", legacy: "true" });
    expect(fxOutcome()).toBe("not_ready");
    expect(payoutOutcome()).toBe("not_ready");
    expect(isPayoutProviderReal()).toBe(false);
  });

  it("legada apagada + específica=true → la específica manda también hacia arriba", () => {
    setFlags({ fx: "true", payout: undefined, legacy: "" });
    expect(fxOutcome()).toBe("partner");
    expect(payoutOutcome()).toBe("not_ready"); // ésta sí hereda la legada, que dice que no
  });

  it("ninguna de las tres seteada → las dos apagadas (default fail-closed)", () => {
    setFlags({ fx: undefined, payout: undefined, legacy: undefined });
    expect(fxOutcome()).toBe("not_ready");
    expect(payoutOutcome()).toBe("not_ready");
  });

  it("tener las tres NO es un error: es el paso del medio de la migración", () => {
    setFlags({ fx: "true", payout: "true", legacy: "true" });
    expect(fxOutcome()).toBe("partner");
    expect(payoutOutcome()).toBe("partner");
  });

  it("avisa (value-free) cuando la legada es la que decide", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setFlags({ fx: undefined, payout: undefined, legacy: "true" });
    fxOutcome();
    const mensajes = warn.mock.calls.map((c) => String(c[0]));
    expect(mensajes.some((m) => m.includes(LEGACY_READINESS_ENV) && m.includes(FX_FLAG))).toBe(true);
  });

  it("NO avisa por la legada cuando la específica está definida (ahí la legada no decide nada)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setFlags({ fx: "true", payout: "true", legacy: "true" });
    fxOutcome();
    payoutOutcome();
    const mensajes = warn.mock.calls.map((c) => String(c[0]));
    expect(mensajes.some((m) => m.includes(LEGACY_READINESS_ENV))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// El cableado: que exista UN solo lector de estas envs no es un comentario, es medible.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("readiness de TransFi — una sola lectura de las envs", () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return entry.isFile() && full.endsWith(".ts") && !full.endsWith(".test.ts") ? [full] : [];
    });
  }

  it.each([LEGACY_READINESS_ENV, FX_FLAG, PAYOUT_FLAG])(
    "ningún archivo de producción hace `process.env.%s` directo",
    (envName) => {
      // Si mañana alguien vuelve a leer una de estas envs desde `fx.ts` o `payout.ts`, la
      // precedencia (específica > legada) existiría en un lado y no en el otro — que es la forma
      // exacta en que este bug nació. El chequeo mira `process.env.X`, no la mención en prosa.
      // Cero es lo correcto INCLUSO para el módulo de readiness: ahí las envs se leen por índice
      // (`process.env[spec.flagEnv]`), a partir de la tabla de capacidades. El dueño de los tres
      // nombres lo fija el test de abajo.
      const lectores = sourceFiles(join(process.cwd(), "src")).filter((file) =>
        readFileSync(file, "utf8").includes(`process.env.${envName}`),
      );
      expect(lectores).toHaveLength(0);
    },
  );

  it("el módulo de readiness es el único que nombra las tres envs en código", () => {
    const nombradores = sourceFiles(join(process.cwd(), "src")).filter((file) => {
      const src = readFileSync(file, "utf8");
      // Se busca el nombre entre comillas (una env que el código USA), no la mención en comentarios.
      return [LEGACY_READINESS_ENV, FX_FLAG, PAYOUT_FLAG].some((name) => src.includes(`"${name}"`));
    });
    expect(nombradores.map((f) => f.split("/").slice(-2).join("/"))).toEqual([
      "providers/transfi-readiness.ts",
    ]);
  });
});
