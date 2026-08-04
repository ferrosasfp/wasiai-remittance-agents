// CANDADO: un proveedor SIMULADO no puede afirmar más que el adapter REAL en el mismo punto.
//
// El bug que motivó este archivo: `FallbackPayoutProvider.execute()` devolvía `status:"settled"`
// mientras `TransFiPayoutProvider.execute()` fuerza `"submitted"` porque el POST solo CREA la orden
// (el desenlace llega después por webhook). O sea: el mock emitía un estado que el camino real no
// puede alcanzar jamás en ese punto, y hay un consumidor que pinta "Entregado" al leer `"settled"`.
//
// 🔴 ESTE ARCHIVO NO COMPARA CONTRA EL LITERAL "settled" — a propósito. Compara contra el conjunto
// de estados que el adapter real EMITE, MEDIDO ejecutándolo. Por eso también se pone rojo con el
// próximo estado terminal que alguien agregue a `PayoutResult["status"]` y devuelva desde un mock.
//
// ── QUÉ **NO** CUBRE (leer antes de confiar en este candado) ────────────────────────────────────
//  1. Solo mira el campo `status`. Un mock que devuelva `submitted` con un `txRef` o un
//     `deliveredLocal` inventados pasa verde: eso lo cubren los tests de `payout.test.ts`.
//  2. El techo se mide contra el CORPUS de respuestas de abajo (los estados documentados en
//     `doc/transfi-offramp-api-spec.md` L48 + las formas sin evidencia). Si TransFi publica un
//     estado nuevo y nadie lo agrega al corpus, el techo queda SUBestimado — el error resultante es
//     un rojo de más, nunca un verde de más.
//  3. Solo ve los providers EXPORTADOS por `./payout` y construibles sin argumentos. Un mock no
//     exportado, o uno que exija parámetros en el constructor, queda fuera del descubrimiento (el
//     test de partición se pone rojo si aparece un provider exportado sin clasificar, que es el caso
//     que sí importa).
//  4. La cláusula B (abajo) se apoya en qué contesta el adapter real cuando el partner no afirma
//     nada, o sea en el default de `normalizeStatus`. Si alguien cambiara ese default a un estado
//     terminal, el techo de B subiría con él. Ese mutante lo mata `payout.test.ts`
//     ("desconocido → submitted (NUNCA settled fabricado)"), no este archivo.

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import * as payoutModule from "./payout";
import { TransFiPayoutProvider, getPayoutProvider } from "./payout";
import { resolveTransFiBaseUrl, type TransFiBaseUrl } from "./transfi-env";
import type { PayoutInput, PayoutProvider, PayoutResult } from "./types";

/** Mint del host de sandbox vía el resolvedor REAL (el tipo es branded; no hay otro camino). */
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
const CREDS = { username: "u", password: "p", mid: "m" };

const input: PayoutInput = {
  quoteId: "q1",
  amountUsd: 100,
  beneficiary: { name: "Bob", country: "PE", method: "yape", destination: "999999999" },
  travelRuleData: {
    originator: { name: "Alice", country: "US", legalId: "ref:v1" },
    beneficiary: { name: "Bob", country: "PE" },
  },
  idempotencyKey: "idem-1",
};

/**
 * Corpus de respuestas 2xx del partner. `assertsOutcome` = el partner AFIRMA un estado de la orden.
 * Las de `false` son la situación del mock: nadie del otro lado dijo nada sobre el desenlace.
 * Todas llevan `orderId` para que `execute()` no corte antes por `transfi_payout_missing_order_id`
 * (ese camino lanza, no produce estado, así que no aportaría nada al techo).
 */
const PARTNER_RESPONSES: ReadonlyArray<{
  label: string;
  body: Record<string, unknown>;
  assertsOutcome: boolean;
}> = [
  // — sin evidencia: el partner no afirma nada sobre el desenlace —
  { label: "sin campo status", body: { orderId: "ord-1" }, assertsOutcome: false },
  {
    label: "solo la address de depósito",
    body: { orderId: "ord-1", walletAddress: "0xdep" },
    assertsOutcome: false,
  },
  { label: "status vacío", body: { orderId: "ord-1", status: "" }, assertsOutcome: false },
  { label: "status null", body: { orderId: "ord-1", status: null }, assertsOutcome: false },
  { label: "status no-string", body: { orderId: "ord-1", status: 7 }, assertsOutcome: false },
  {
    label: "status desconocido",
    body: { orderId: "ord-1", status: "wat_status" },
    assertsOutcome: false,
  },
  // — con evidencia: los 5 estados documentados (doc/transfi-offramp-api-spec.md L48) —
  { label: "initiated", body: { orderId: "ord-1", status: "initiated" }, assertsOutcome: true },
  {
    label: "asset_deposited",
    body: { orderId: "ord-1", status: "asset_deposited" },
    assertsOutcome: true,
  },
  {
    label: "fund_settled",
    body: { orderId: "ord-1", status: "fund_settled" },
    assertsOutcome: true,
  },
  { label: "fund_failed", body: { orderId: "ord-1", status: "fund_failed" }, assertsOutcome: true },
  { label: "expired", body: { orderId: "ord-1", status: "expired" }, assertsOutcome: true },
];

/** Los dos puntos del contrato `PayoutProvider`. El techo se mide por punto: son distintos. */
const CALL_SITES: ReadonlyArray<{ name: string; call: (p: PayoutProvider) => Promise<PayoutResult> }> =
  [
    { name: "execute()", call: (p) => p.execute(input) },
    { name: "status()", call: (p) => p.status("ord-1") },
  ];

/**
 * Estados que el adapter REAL emite en ese punto, MEDIDOS corriéndolo contra cada respuesta del
 * corpus. No es una lista declarada: si el adapter cambia lo que devuelve, este conjunto cambia solo.
 */
async function reachableStatuses(
  call: (p: PayoutProvider) => Promise<PayoutResult>,
  responses: ReadonlyArray<(typeof PARTNER_RESPONSES)[number]>,
): Promise<Set<PayoutResult["status"]>> {
  const seen = new Set<PayoutResult["status"]>();
  for (const r of responses) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(r.body), { status: 200 })),
    );
    seen.add((await call(new TransFiPayoutProvider(CREDS, SANDBOX_BASE))).status);
  }
  vi.unstubAllGlobals();
  return seen;
}

// ── Descubrimiento: qué providers exporta el módulo, y cómo está clasificado cada uno ──────────
type ProviderCtor = new () => PayoutProvider;

function isPayoutProviderClass(v: unknown): boolean {
  if (typeof v !== "function") return false;
  const proto = (v as { prototype?: Record<string, unknown> }).prototype;
  return !!proto && typeof proto.execute === "function" && typeof proto.status === "function";
}

const DISCOVERED_PROVIDERS = Object.entries(payoutModule)
  .filter(([, value]) => isPayoutProviderClass(value))
  .map(([name]) => name)
  .sort();

/** Habla con el partner licenciado: puede afirmar lo que el partner le diga. */
const REAL_ADAPTERS = ["TransFiPayoutProvider"];
/** NO mueve plata y no le pregunta a nadie: es a estos a los que se les mide el techo. */
const SIMULATED_PROVIDERS = ["FallbackPayoutProvider"];

function instantiate(name: string): PayoutProvider {
  const ctor = (payoutModule as unknown as Record<string, ProviderCtor | undefined>)[name];
  if (!ctor) throw new Error(`provider_no_exportado:${name}`); // el nombre viene de la clasificación
  return new ctor();
}

describe("candado: el mock no puede afirmar más que el real", () => {
  beforeEach(() => vi.stubEnv("TRANSFI_USDC_NETWORK", "solana")); // el adapter real la exige
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  // Sin esto el candado se puede evadir sin tocarlo: alcanza con exportar un provider nuevo y no
  // clasificarlo. La partición tiene que ser TOTAL, así que agregar un provider obliga a decidir
  // de qué lado está antes de que la suite vuelva a verde.
  it("partición total: todo provider exportado está clasificado como real o como simulado", () => {
    expect(DISCOVERED_PROVIDERS).toEqual([...REAL_ADAPTERS, ...SIMULATED_PROVIDERS].sort());
  });

  // Cláusula A — techo con TODA la evidencia posible: el mock no puede emitir un estado que el
  // adapter real NO EMITE NUNCA en ese punto, ni siquiera cuando el partner se lo pide.
  // Es la que caza el bug de origen: el POST real fuerza `submitted` contra cualquier respuesta.
  describe.each(CALL_SITES)("cláusula A — $name: el mock ⊆ lo que el real puede emitir", ({ call }) => {
    it.each(SIMULATED_PROVIDERS)("%s", async (name) => {
      const ceiling = await reachableStatuses(call, PARTNER_RESPONSES);
      expect(ceiling.size).toBeGreaterThan(0); // el techo se midió de verdad
      const mockStatus = (await call(instantiate(name))).status;
      expect([...ceiling]).toContain(mockStatus);
    });
  });

  // Cláusula B — techo con CERO evidencia, que es la situación real del mock: no habló con nadie.
  // Se mide con las respuestas en las que el partner no afirma ningún desenlace. Es estrictamente
  // más fuerte que A (su corpus es un subconjunto), pero depende del default de `normalizeStatus`
  // (ver "QUÉ NO CUBRE" #4), así que A se conserva aparte.
  describe.each(CALL_SITES)("cláusula B — $name: el mock ⊆ lo que el real dice sin evidencia", ({ call }) => {
    it.each(SIMULATED_PROVIDERS)("%s", async (name) => {
      const noEvidence = PARTNER_RESPONSES.filter((r) => !r.assertsOutcome);
      const ceiling = await reachableStatuses(call, noEvidence);
      // Si el adapter real contestara dos cosas distintas ante la misma ausencia de evidencia, el
      // techo sería ambiguo y la cláusula perdería sentido: se exige que sea UNO solo.
      expect(ceiling.size).toBe(1);
      const mockStatus = (await call(instantiate(name))).status;
      expect([...ceiling]).toContain(mockStatus);
    });
  });

  // Cierra el lazo con la fábrica: el provider que se usa de verdad en configuración de mock tiene
  // que ser uno de los que este archivo mide. Si mañana la fábrica devolviera otra cosa sin
  // exportarla/clasificarla, esto se pone rojo.
  it("el provider que devuelve la fábrica sin credenciales es uno de los SIMULADOS medidos", () => {
    vi.stubEnv("TRANSFI_USERNAME", "");
    vi.stubEnv("TRANSFI_PASSWORD", "");
    vi.stubEnv("TRANSFI_MID", "");
    expect(SIMULATED_PROVIDERS).toContain(getPayoutProvider().constructor.name);
  });
});
