// src/manifest/input-schema-drift.test.ts
// EL CHECK DE DERIVA: obliga al `inputSchema` que se publica (registry.ts) a coincidir con el schema
// Zod que el agente realmente ejecuta. Si divergen, esto se pone rojo ANTES de que la ficha llegue a
// ningún catálogo.
//
// POR QUÉ EXISTE. Medido el 2026-08-04 contra el catálogo vivo, copiando el payload LITERAL del
// `inputSchema` publicado:
//   · payout → 200 {"executed":false,"status":"blocked","reason":"kyc_identity_claim_missing"}
//   · kyc    → 400 {"error":"invalid_input", fieldErrors:{receiverName:["Required"], receiverCountry:["Required"]}}
// La ficha exigía `kycPayoutAllowed` (borrado en WKH-203) y callaba `senderIdentity` (sin el cual el
// gate bloquea siempre). Quien armaba la llamada leyendo el catálogo —el planner de /orchestrate
// incluido— construía un input imposible, y pagaba igual por el intento. Sin este archivo eso se
// vuelve a desincronizar en la próxima HU que toque un `z.object`.
//
// CÓMO. La derivación usa SOLO API pública de Zod (`.shape`, `.isOptional()`, `.unwrap()`,
// `.removeDefault()`, `.options`, `.value`, `.minLength`, `.minValue`) — nada de `_def`. Un tipo Zod
// que el derivador no conozca LANZA en vez de pasar de largo: un campo nuevo no puede quedar sin
// verificar por accidente.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { z } from "zod";
import { MANIFEST_ENTRIES, findEntry } from "./registry";
import { KycInputSchema } from "@/agents/kyc-validator";
import { CorridorFxInputSchema, runCorridorFx } from "@/agents/corridor-fx";
import { CashoutPayoutInputSchema, runCashoutPayout } from "@/agents/cashout-payout";
import type { JsonSchemaObject, JsonSchemaProperty } from "./types";

/** pathSlug → el validador que corre de verdad en `/invoke`. */
const VALIDATORS: Record<string, z.ZodObject<z.ZodRawShape>> = {
  "remit-kyc-validator": KycInputSchema,
  "remit-corridor-fx": CorridorFxInputSchema,
  "remit-cashout-payout": CashoutPayoutInputSchema,
};

/**
 * Los campos que la ficha declara `required` SIN que Zod los exija. No es un permiso: cada uno tiene
 * que tener, más abajo en este archivo, la prueba de que omitirlo impide obtener un resultado útil.
 * Un `required` de más es seguro (quien lo manda siempre funciona); uno de menos es el bug de arriba.
 */
const GATE_REQUIRED: Record<string, readonly string[]> = {
  "remit-kyc-validator": [],
  "remit-corridor-fx": [],
  // Zod lo acepta ausente a propósito (un 400 diría "falta input" cuando falta AUTORIZACIÓN), pero
  // sin él el agente responde blocked/kyc_identity_claim_missing y no desembolsa nunca.
  "remit-cashout-payout": ["senderIdentity"],
};

// ── Derivación desde Zod (solo API pública) ──────────────────────────────────────────────────────

type DerivedProperty = {
  type: string;
  enum?: readonly string[];
  const?: string;
  minLength?: number;
  exclusiveMinimum?: number;
  properties?: Record<string, DerivedProperty>;
  required?: string[];
};

/** Saca las envolturas que NO cambian el tipo del valor, sólo si es obligatorio. */
function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  if (schema instanceof z.ZodOptional) return unwrap(schema.unwrap() as z.ZodTypeAny);
  if (schema instanceof z.ZodDefault) return unwrap(schema.removeDefault() as z.ZodTypeAny);
  if (schema instanceof z.ZodNullable) return unwrap(schema.unwrap() as z.ZodTypeAny);
  return schema;
}

function deriveProperty(schema: z.ZodTypeAny): DerivedProperty {
  const inner = unwrap(schema);

  if (inner instanceof z.ZodObject) return deriveObject(inner as z.ZodObject<z.ZodRawShape>);

  if (inner instanceof z.ZodEnum) {
    return { type: "string", enum: [...(inner.options as readonly string[])] };
  }

  if (inner instanceof z.ZodLiteral) {
    const value = inner.value as unknown;
    if (typeof value !== "string") {
      throw new Error(`literal no-string en el schema: ${String(value)}`);
    }
    return { type: "string", const: value };
  }

  if (inner instanceof z.ZodString) {
    const min = inner.minLength;
    return { type: "string", ...(min !== null ? { minLength: min } : {}) };
  }

  if (inner instanceof z.ZodNumber) {
    const min = inner.minValue;
    if (min === null) return { type: "number" };
    // Exclusivo vs inclusivo se decide EJECUTANDO el validador con el borde, no leyendo `_def`:
    // `z.number().positive()` y `z.number().min(0)` comparten `minValue === 0` y no son lo mismo.
    const bordeAceptado = inner.safeParse(min).success;
    if (bordeAceptado) throw new Error("minimo inclusivo: el schema publicado no lo sabe expresar");
    return { type: "number", exclusiveMinimum: min };
  }

  if (inner instanceof z.ZodBoolean) return { type: "boolean" };

  // Fail-loud: agregar un tipo Zod nuevo obliga a enseñárselo al derivador, no lo deja sin cubrir.
  throw new Error(`tipo Zod no soportado por el derivador: ${inner.constructor.name}`);
}

function deriveObject(schema: z.ZodObject<z.ZodRawShape>): DerivedProperty {
  const shape = schema.shape;
  const properties: Record<string, DerivedProperty> = {};
  const required: string[] = [];
  for (const key of Object.keys(shape)) {
    const field = shape[key] as z.ZodTypeAny;
    properties[key] = deriveProperty(field);
    // `.isOptional()` es conductual (Zod lo resuelve con `safeParse(undefined)`), así que cubre
    // `.optional()` y `.default()` con el mismo criterio con el que el agente responde en vivo.
    if (!field.isOptional()) required.push(key);
  }
  return { type: "object", properties, required };
}

// ── Comparación ──────────────────────────────────────────────────────────────────────────────────

/** Las facetas que el schema publicado DEBE espejar. `description` queda libre: es prosa. */
const FACETS = ["type", "enum", "const", "minLength", "exclusiveMinimum"] as const;

function compareProperty(
  published: JsonSchemaProperty,
  derived: DerivedProperty,
  path: string,
): void {
  for (const facet of FACETS) {
    const esperado = derived[facet];
    const publicado = published[facet];
    if (esperado === undefined) {
      expect(publicado, `${path}: la ficha declara ${facet} y el validador Zod no lo exige`)
        .toBeUndefined();
      continue;
    }
    expect(publicado, `${path}: ${facet} de la ficha no es el del validador Zod`).toEqual(esperado);
  }

  if (derived.properties === undefined) {
    expect(published.properties, `${path}: la ficha anida propiedades que Zod no tiene`).toBeUndefined();
    return;
  }
  compareObject(
    { type: "object", required: published.required ?? [], properties: published.properties ?? {} },
    derived,
    path,
    [],
  );
}

function compareObject(
  published: JsonSchemaObject,
  derived: DerivedProperty,
  path: string,
  gateRequired: readonly string[],
): void {
  const derivedProps = derived.properties ?? {};

  // (1) MISMO JUEGO DE CAMPOS. Un campo de más es el `kycPayoutAllowed` que Zod strippea en silencio;
  // uno de menos es el `senderIdentity` que nadie sabía que tenía que mandar.
  expect(Object.keys(published.properties).sort(), `${path}: properties`).toEqual(
    Object.keys(derivedProps).sort(),
  );

  // (2) NADA OBLIGATORIO SIN DECLARAR. Zod-required ⊆ ficha-required: si el validador lo exige y la
  // ficha lo calla, quien lee la ficha se come un 400 (fue `receiverName`/`receiverCountry`).
  for (const key of derived.required ?? []) {
    expect(published.required, `${path}: ${key} es obligatorio en Zod y falta en required`).toContain(
      key,
    );
  }

  // (3) LOS `required` DE MÁS SON LOS DECLARADOS, Y NINGUNO MÁS. Uno nuevo obliga a escribir la
  // prueba de que omitirlo bloquea; si no, la ficha estaría pidiendo algo que no hace falta.
  const extras = published.required.filter((key) => !(derived.required ?? []).includes(key));
  expect([...extras].sort(), `${path}: required de mas sin justificacion conductual`).toEqual(
    [...gateRequired].sort(),
  );

  for (const [key, derivada] of Object.entries(derivedProps)) {
    const publicada = published.properties[key];
    if (publicada === undefined) continue; // ya lo reportó (1)
    compareProperty(publicada, derivada, `${path}.${key}`);
  }
}

/** Lookup fail-loud: un agente sin validador o sin fila de gate es un agujero, no un `undefined`. */
function porAgente<T>(tabla: Record<string, T>, pathSlug: string, cual: string): T {
  const valor = tabla[pathSlug];
  if (valor === undefined) throw new Error(`${cual} sin entrada para ${pathSlug}`);
  return valor;
}

// ── Los tests ────────────────────────────────────────────────────────────────────────────────────

describe("check de deriva — el inputSchema publicado vs. el schema Zod real", () => {
  it("el mapa de validadores cubre a los 3 agentes del registro, sin sobrantes", () => {
    expect(Object.keys(VALIDATORS).sort()).toEqual(MANIFEST_ENTRIES.map((e) => e.pathSlug).sort());
    expect(Object.keys(GATE_REQUIRED).sort()).toEqual(Object.keys(VALIDATORS).sort());
  });

  for (const entry of MANIFEST_ENTRIES) {
    it(`${entry.pathSlug}: la ficha describe exactamente lo que el validador exige`, () => {
      compareObject(
        entry.inputSchema,
        deriveObject(porAgente(VALIDATORS, entry.pathSlug, "VALIDATORS")),
        entry.pathSlug,
        porAgente(GATE_REQUIRED, entry.pathSlug, "GATE_REQUIRED"),
      );
    });
  }
});

// ── La justificación conductual del único `required` que Zod no exige ────────────────────────────

/**
 * Arma un payload a partir del `inputSchema` PUBLICADO (no de un fixture): recorre `required` y pone
 * un valor del tipo declarado. Si la ficha pidiera un campo que el agente no conoce, o callara uno
 * que exige, este payload lo mostraría — que es exactamente la prueba al revés.
 */
function payloadDesdeLaFicha(
  schema: JsonSchemaObject,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of schema.required) {
    if (key in overrides) {
      out[key] = overrides[key];
      continue;
    }
    const prop = schema.properties[key];
    if (prop === undefined) throw new Error(`required sin properties: ${key}`);
    out[key] = valorDeEjemplo(prop, key);
  }
  return out;
}

function valorDeEjemplo(prop: JsonSchemaProperty, key: string): unknown {
  if (prop.type === "object") {
    return payloadDesdeLaFicha({
      type: "object",
      required: prop.required ?? [],
      properties: prop.properties ?? {},
    });
  }
  if (prop.type === "number") return (prop.exclusiveMinimum ?? 0) + 100;
  if (prop.type === "boolean") return true;
  if (prop.const !== undefined) return prop.const;
  if (prop.enum !== undefined) return prop.enum[0];
  // Largo suficiente para cualquier `minLength` de estos schemas; el contenido no es PII real.
  return key === "senderIdentity" || key === "address" ? "12345678" : `x-${key}`;
}

describe("senderIdentity está en required aunque Zod lo acepte ausente — la prueba", () => {
  beforeEach(() => {
    vi.stubEnv("DIDIT_ENV", "mock");
    vi.stubEnv("DIDIT_BASE_URL", "http://localhost:9999/didit-mock");
    vi.stubEnv("TRANSFI_API_KEY", "");
    vi.stubEnv("ALLOW_FALLBACK_PAYOUT", "true");
    vi.stubEnv("DIDIT_API_KEY", "k");
    vi.stubEnv("DIDIT_ADAPTER_READY", "true");
    vi.stubEnv("FX_RATE_CACHE_TTL_MS", "0");
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  /** Feed FX sano + la decisión aprobada de Didit, atada al vendor_data que manda la ficha. */
  function stubUpstream(vendorData: string) {
    const fxFeed = {
      ok: true,
      json: async () => ({ rates: { PEN: 3.4 }, time_last_update_unix: Math.floor(Date.now() / 1000) }),
    };
    // Se enruta por URL y no por orden de llamada: el feed FX y Didit tienen hosts distintos, y un
    // contador se rompería solo con que uno de los dos hiciera un reintento.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const href = String(url);
        if (href.includes("didit-mock")) {
          // El `session_id` se ECOA desde la URL: el adapter rechaza una decisión cuyo id no sea el
          // pedido (rama B10), y el id acá lo pone el payload que arma la ficha, no este archivo.
          const sessionId = decodeURIComponent(href.split("/session/")[1]?.split("/")[0] ?? "");
          return new Response(
            JSON.stringify({ status: "Approved", session_id: sessionId, vendor_data: vendorData }),
            { status: 200 },
          );
        }
        return fxFeed as unknown as Response;
      }),
    );
  }

  /** El `quoteId` sale de una llamada REAL a remit-corridor-fx, armada desde SU ficha publicada. */
  async function cotizarDesdeLaFicha(): Promise<{ quoteId: string; amountUsd: number }> {
    const fx = findEntry("remit-corridor-fx");
    if (fx === undefined) throw new Error("registro sin remit-corridor-fx");
    const input = payloadDesdeLaFicha(fx.inputSchema);
    const quote = await runCorridorFx(input);
    return { quoteId: quote.quoteId, amountUsd: input.amountUsd as number };
  }

  it("con senderIdentity (el payload de la ficha, tal cual) → ejecuta el desembolso", async () => {
    stubUpstream("12345678");
    const { quoteId, amountUsd } = await cotizarDesdeLaFicha();
    const payout = findEntry("remit-cashout-payout");
    if (payout === undefined) throw new Error("registro sin remit-cashout-payout");

    const out = await runCashoutPayout(
      payloadDesdeLaFicha(payout.inputSchema, { quoteId, amountUsd }),
    );

    expect(out.executed).toBe(true);
    expect(out.status).not.toBe("blocked");
  });

  it("sin senderIdentity → blocked/kyc_identity_claim_missing: por eso la ficha lo pide", async () => {
    stubUpstream("12345678");
    const { quoteId, amountUsd } = await cotizarDesdeLaFicha();
    const payout = findEntry("remit-cashout-payout");
    if (payout === undefined) throw new Error("registro sin remit-cashout-payout");

    const input = payloadDesdeLaFicha(payout.inputSchema, { quoteId, amountUsd });
    delete input.senderIdentity;

    // No es un 400: Zod lo deja pasar. El agente igual no desembolsa. Ésa es la asimetría que la
    // ficha tiene que contar, y el motivo por el que `senderIdentity` va en `required`.
    expect(CashoutPayoutInputSchema.safeParse(input).success).toBe(true);
    const out = await runCashoutPayout(input);
    expect(out.executed).toBe(false);
    expect(out.status).toBe("blocked");
    expect(out.reason).toBe("kyc_identity_claim_missing");
  });
});

describe("prueba al revés — el payload de la ficha pasa el validador de cada agente", () => {
  for (const entry of MANIFEST_ENTRIES) {
    const validador = () => porAgente(VALIDATORS, entry.pathSlug, "VALIDATORS");

    it(`${entry.pathSlug}: el payload armado desde su inputSchema no da invalid_input`, () => {
      const parsed = validador().safeParse(payloadDesdeLaFicha(entry.inputSchema));
      expect(parsed.success, JSON.stringify(parsed.success ? {} : parsed.error.flatten())).toBe(true);
    });

    it(`${entry.pathSlug}: sacarle CUALQUIER campo required al payload lo rompe o lo bloquea`, () => {
      const gate = porAgente(GATE_REQUIRED, entry.pathSlug, "GATE_REQUIRED");
      for (const key of entry.inputSchema.required) {
        const input = payloadDesdeLaFicha(entry.inputSchema);
        delete input[key];
        const parsed = validador().safeParse(input);
        // Los `required` de Zod tienen que fallar el parseo; los de gate pasan Zod y bloquean
        // después (lo prueba el describe de arriba). Ninguno puede ser irrelevante.
        expect(parsed.success, `${entry.pathSlug}.${key}: required que no cambia nada`).toBe(
          gate.includes(key),
        );
      }
    });
  }
});
