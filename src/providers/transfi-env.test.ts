import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  TRANSFI_CANONICAL_BASE_URL,
  resolveTransFiBaseUrl,
  resolveTransFiEnvironment,
} from "./transfi-env";
import { LiveMidFxProvider, TransFiFxProvider, getFxQuoteProvider } from "./fx";
import { FallbackPayoutProvider, TransFiPayoutProvider, getPayoutProvider } from "./payout";
import { runCashoutPayout } from "../agents/cashout-payout";
import { issueQuoteRef } from "./quote-ref";
import type { FxQuoteInput, PayoutInput } from "./types";

/** Referencia AUTENTICADA de cotización por 100 USD — el core la exige desde el binding quote↔monto. */
const QUOTE_REF_100 = issueQuoteRef("fxmid-test", 100);

// ⚠️ CERO red real en este archivo: `fetch` SIEMPRE mockeado. Ninguna aserción puede tocar
// api.transfi.com (que es precisamente el bug que este módulo cierra).

// Envs que este archivo manipula. Snapshot/restore MANUAL (no `vi.stubEnv`) porque varios casos
// necesitan la env AUSENTE, no vacía: "sin setear" es justo el estado que antes apuntaba a producción.
const MANAGED_ENVS = [
  "TRANSFI_ENV",
  "TRANSFI_BASE_URL",
  "TRANSFI_API_KEY",
  "TRANSFI_USERNAME",
  "TRANSFI_PASSWORD",
  "TRANSFI_MID",
  "TRANSFI_ADAPTER_READY",
  "TRANSFI_USDC_NETWORK",
  "TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS",
  "NODE_ENV",
  "PAYOUT_ALLOW_MOCK",
  "ALLOW_FALLBACK_PAYOUT",
  "ALLOW_FALLBACK_KYC",
  "DIDIT_API_KEY",
  "DIDIT_ADAPTER_READY",
  // Deben estar acá para que el snapshot/restore las limpie: si no, el `setEnv("DIDIT_ENV", …)` de
  // G-18 se FILTRARÍA a los demás tests del archivo (y el orden de ejecución decidiría el resultado).
  "DIDIT_ENV",
  "DIDIT_BASE_URL",
] as const;

let envSnapshot: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  envSnapshot = {};
  for (const key of MANAGED_ENVS) envSnapshot[key] = process.env[key];
  // Punto de partida de TODOS los casos: ambiente NO declarado (el estado del bug original).
  setEnv("TRANSFI_ENV", undefined);
  setEnv("TRANSFI_BASE_URL", undefined);
});

afterEach(() => {
  for (const key of MANAGED_ENVS) setEnv(key, envSnapshot[key]);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** fetch mockeado que registra las URLs pedidas. Devuelve 200 con el body dado. */
function stubFetchCapturing(body: unknown) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    calls.push(String(url));
    return new Response(JSON.stringify(body), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

const fxInput: FxQuoteInput = {
  amountUsd: 100,
  sourceAsset: "USDC",
  destCurrency: "PEN",
  destCountry: "PE",
  payoutMethod: "yape",
};

const payoutInput: PayoutInput = {
  quoteId: "q1",
  amountUsd: 100,
  beneficiary: { name: "Bob", country: "PE", method: "yape", destination: "999999999" },
  travelRuleData: {
    originator: { name: "Alice", country: "US", legalId: "ref:v1" },
    beneficiary: { name: "Bob", country: "PE" },
  },
  idempotencyKey: "idem-1",
};

// ── 1. FAIL-CLOSED: sin TRANSFI_ENV no se resuelve NINGÚN host ─────────────────────────────────
describe("resolveTransFiEnvironment / resolveTransFiBaseUrl — fail-closed (G-1)", () => {
  it("G-1: TRANSFI_ENV ausente → throw transfi_env_unset (NUNCA un host adivinado)", () => {
    expect(() => resolveTransFiEnvironment()).toThrow(/^transfi_env_unset/);
    expect(() => resolveTransFiBaseUrl()).toThrow(/^transfi_env_unset/);
  });

  it("G-1: TRANSFI_ENV ausente → el error NO contiene el host productivo del partner", () => {
    // El bug original resolvía SILENCIOSAMENTE a https://api.transfi.com. Hoy no hay ningún camino
    // en el que la ausencia de la env produzca un host: solo un throw sin URL.
    try {
      resolveTransFiBaseUrl();
      throw new Error("no lanzó: el fail-closed está roto");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toMatch(/^transfi_env_unset/);
      expect(message).not.toContain("api.transfi.com");
    }
  });

  it('G-1: TRANSFI_ENV="" (seteada vacía) también es fail-closed', () => {
    setEnv("TRANSFI_ENV", "   ");
    expect(() => resolveTransFiBaseUrl()).toThrow(/^transfi_env_unset/);
  });

  it("G-2: TRANSFI_ENV con un valor fuera del conjunto cerrado → transfi_env_invalid", () => {
    setEnv("TRANSFI_ENV", "staging");
    expect(() => resolveTransFiBaseUrl()).toThrow(/^transfi_env_invalid:staging/);
  });

  it("G-3: sandbox → host canónico de sandbox", () => {
    setEnv("TRANSFI_ENV", "sandbox");
    expect(resolveTransFiEnvironment()).toBe("sandbox");
    expect(resolveTransFiBaseUrl()).toBe("https://sandbox-api.transfi.com");
    expect(resolveTransFiBaseUrl()).toBe(TRANSFI_CANONICAL_BASE_URL.sandbox);
  });

  it("G-4: production fuera de NODE_ENV=production → throw (dev/CI no le habla al partner real)", () => {
    setEnv("TRANSFI_ENV", "production");
    setEnv("NODE_ENV", "test");
    expect(() => resolveTransFiBaseUrl()).toThrow(/^transfi_env_production_outside_node_prod/);
  });

  it("G-5: production + NODE_ENV=production → host productivo, declarado a mano (sin red)", () => {
    setEnv("TRANSFI_ENV", "production");
    setEnv("NODE_ENV", "production");
    // Solo se compara el string resuelto: este test NO hace ni una request.
    expect(resolveTransFiBaseUrl()).toBe(TRANSFI_CANONICAL_BASE_URL.production);
  });
});

// ── 2. El override legado no puede CONTRADECIR al ambiente declarado ───────────────────────────
describe("TRANSFI_BASE_URL como override — no puede contradecir a TRANSFI_ENV (G-6)", () => {
  it("G-6: sandbox + override al host PRODUCTIVO → transfi_base_url_env_conflict", () => {
    setEnv("TRANSFI_ENV", "sandbox");
    setEnv("TRANSFI_BASE_URL", "https://api.transfi.com");
    expect(() => resolveTransFiBaseUrl()).toThrow(/^transfi_base_url_env_conflict/);
  });

  it("G-6: production + override al host de SANDBOX → transfi_base_url_env_conflict", () => {
    setEnv("TRANSFI_ENV", "production");
    setEnv("NODE_ENV", "production");
    setEnv("TRANSFI_BASE_URL", "https://sandbox-api.transfi.com");
    expect(() => resolveTransFiBaseUrl()).toThrow(/^transfi_base_url_env_conflict/);
  });

  it("G-7: sandbox + host *.transfi.com no clasificable → fail-closed (podría ser productivo)", () => {
    setEnv("TRANSFI_ENV", "sandbox");
    setEnv("TRANSFI_BASE_URL", "https://api-eu.transfi.com");
    expect(() => resolveTransFiBaseUrl()).toThrow(/^transfi_base_url_unclassified_partner_host/);
  });

  it("G-8: production + host que no es del partner (mock) → refuse", () => {
    setEnv("TRANSFI_ENV", "production");
    setEnv("NODE_ENV", "production");
    setEnv("TRANSFI_BASE_URL", "https://mock.example");
    expect(() => resolveTransFiBaseUrl()).toThrow(/^transfi_base_url_non_partner_host_in_production/);
  });

  it("G-9: sandbox + mock local en http → permitido (CI), y normaliza la barra final", () => {
    setEnv("TRANSFI_ENV", "sandbox");
    setEnv("TRANSFI_BASE_URL", "http://localhost:4010/");
    expect(resolveTransFiBaseUrl()).toBe("http://localhost:4010");
  });

  it("G-10: http a un host remoto → refuse (las creds Basic viajarían en claro)", () => {
    setEnv("TRANSFI_ENV", "sandbox");
    setEnv("TRANSFI_BASE_URL", "http://mock.example");
    expect(() => resolveTransFiBaseUrl()).toThrow(/^transfi_base_url_insecure_scheme/);
  });

  it("G-11: override que no es una URL absoluta → transfi_base_url_invalid", () => {
    setEnv("TRANSFI_ENV", "sandbox");
    setEnv("TRANSFI_BASE_URL", "sandbox-api.transfi.com");
    expect(() => resolveTransFiBaseUrl()).toThrow(/^transfi_base_url_invalid/);
  });

  it("G-12: override igual al canónico del ambiente declarado → pasa (idempotente)", () => {
    setEnv("TRANSFI_ENV", "sandbox");
    setEnv("TRANSFI_BASE_URL", "https://sandbox-api.transfi.com/");
    expect(resolveTransFiBaseUrl()).toBe("https://sandbox-api.transfi.com");
  });
});

// ── 3. Las DOS factories fail-closed igual (el bug era la asimetría entre ellas) ────────────────
describe("factories — sin TRANSFI_ENV el adapter REAL no se construye (G-13)", () => {
  it("G-13: getFxQuoteProvider con key+readiness y SIN TRANSFI_ENV → throw, y CERO fetch", () => {
    const { fetchMock } = stubFetchCapturing({});
    setEnv("TRANSFI_API_KEY", "k");
    setEnv("TRANSFI_ADAPTER_READY", "true");
    expect(() => getFxQuoteProvider()).toThrow(/^transfi_env_unset/);
    // 🔴 la aserción central de todo el fix: sin ambiente declarado NO sale una sola request.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("G-13: getPayoutProvider con creds+readiness y SIN TRANSFI_ENV → throw, y CERO fetch", () => {
    const { fetchMock } = stubFetchCapturing({});
    setEnv("TRANSFI_USERNAME", "u");
    setEnv("TRANSFI_PASSWORD", "p");
    setEnv("TRANSFI_MID", "m");
    setEnv("TRANSFI_ADAPTER_READY", "true");
    expect(() => getPayoutProvider()).toThrow(/^transfi_env_unset/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("G-14: con TRANSFI_ENV declarada las dos factories SÍ construyen el adapter real", () => {
    setEnv("TRANSFI_ENV", "sandbox");
    setEnv("TRANSFI_ADAPTER_READY", "true");
    setEnv("TRANSFI_API_KEY", "k");
    setEnv("TRANSFI_USERNAME", "u");
    setEnv("TRANSFI_PASSWORD", "p");
    setEnv("TRANSFI_MID", "m");
    expect(getFxQuoteProvider()).toBeInstanceOf(TransFiFxProvider);
    expect(getPayoutProvider()).toBeInstanceOf(TransFiPayoutProvider);
  });
});

// ── 4. Los dos providers NO pueden divergir (el "sandbox a medias") ────────────────────────────
describe("FX y payout hablan SIEMPRE con el mismo ambiente (G-15)", () => {
  it("G-15: mismo TRANSFI_ENV → mismo origin en las dos requests reales", async () => {
    setEnv("TRANSFI_ENV", "sandbox");
    setEnv("TRANSFI_ADAPTER_READY", "true");
    setEnv("TRANSFI_API_KEY", "k");
    setEnv("TRANSFI_USERNAME", "u");
    setEnv("TRANSFI_PASSWORD", "p");
    setEnv("TRANSFI_MID", "m");
    setEnv("TRANSFI_USDC_NETWORK", "solana"); // sin default: `execute()` exige la red declarada

    const fx = stubFetchCapturing({
      rate: 3.6,
      destAmount: 358.4,
      quoteId: "tq-1",
      expiresAt: "2026-07-27T00:00:00.000Z",
    });
    await getFxQuoteProvider().quote(fxInput);
    const fxUrl = fx.calls[0];

    const payout = stubFetchCapturing({ orderId: "ord-1", walletAddress: "0xdep" });
    await getPayoutProvider().execute(payoutInput);
    const payoutUrl = payout.calls[0];

    expect(fxUrl).toBeDefined();
    expect(payoutUrl).toBeDefined();
    const fxOrigin = new URL(fxUrl!).origin;
    const payoutOrigin = new URL(payoutUrl!).origin;
    // Esto es lo que fallaba antes del fix: fx apuntaba a api.transfi.com y payout a sandbox-api.
    expect(fxOrigin).toBe(payoutOrigin);
    expect(fxOrigin).toBe(TRANSFI_CANONICAL_BASE_URL.sandbox);
    expect(fxOrigin).not.toBe(TRANSFI_CANONICAL_BASE_URL.production);
  });

  it("G-16: un override único mueve a los DOS providers a la vez (una sola fuente de verdad)", async () => {
    setEnv("TRANSFI_ENV", "sandbox");
    setEnv("TRANSFI_BASE_URL", "http://127.0.0.1:4010");
    setEnv("TRANSFI_ADAPTER_READY", "true");
    setEnv("TRANSFI_API_KEY", "k");
    setEnv("TRANSFI_USERNAME", "u");
    setEnv("TRANSFI_PASSWORD", "p");
    setEnv("TRANSFI_MID", "m");
    setEnv("TRANSFI_USDC_NETWORK", "solana"); // sin default: `execute()` exige la red declarada

    const fx = stubFetchCapturing({
      rate: 3.6,
      destAmount: 358.4,
      quoteId: "tq-1",
      expiresAt: "2026-07-27T00:00:00.000Z",
    });
    await getFxQuoteProvider().quote(fxInput);
    const payout = stubFetchCapturing({ orderId: "ord-1", walletAddress: "0xdep" });
    await getPayoutProvider().execute(payoutInput);

    expect(fx.calls[0]).toBe("http://127.0.0.1:4010/v1/quotes");
    expect(payout.calls[0]).toBe("http://127.0.0.1:4010/v3/orders");
  });
});

// ── 5. Guard ESTRUCTURAL: no puede reaparecer una segunda fuente de verdad ─────────────────────
// El bug no fue un default feo: fue que DOS archivos podían opinar sobre el ambiente. Este test
// falla si alguien vuelve a introducir un host o una lectura de `TRANSFI_BASE_URL` en un provider.
describe("no hay segunda fuente de verdad del host de TransFi (G-17)", () => {
  const readProvider = (file: string): string =>
    readFileSync(new URL(`./${file}`, import.meta.url), "utf8");

  // Se ignoran los comentarios: el post-mortem del incidente vive documentado EN estos archivos y
  // menciona los hosts a propósito. Lo que este test prohíbe es CÓDIGO que resuelva un host.
  const stripComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  for (const file of ["fx.ts", "payout.ts"]) {
    it(`G-17: ${file} no lee TRANSFI_BASE_URL ni hardcodea un host de TransFi`, () => {
      const code = stripComments(readProvider(file));
      expect(code).not.toContain("TRANSFI_BASE_URL");
      expect(code).not.toContain("transfi.com");
    });

    it(`G-17: ${file} obtiene el host SOLO vía resolveTransFiBaseUrl()`, () => {
      const code = stripComments(readProvider(file));
      expect(code).toContain("resolveTransFiBaseUrl()");
    });
  }

  it("G-17: el host canónico de producción existe en UN solo archivo del repo (transfi-env.ts)", () => {
    const envModule = stripComments(readProvider("transfi-env.ts"));
    expect(envModule).toContain("https://api.transfi.com");
    expect(envModule).toContain("https://sandbox-api.transfi.com");
  });
});

// ── 6. NO-REGRESIÓN del modo devnet actual (sin creds TransFi + PAYOUT_ALLOW_MOCK) ─────────────
describe("modo devnet actual (sin creds TransFi) sigue andando sin TRANSFI_ENV (G-18)", () => {
  it("G-18: sin creds y sin TRANSFI_ENV → las dos factories devuelven el fallback, sin throw", () => {
    setEnv("TRANSFI_API_KEY", undefined);
    setEnv("TRANSFI_USERNAME", undefined);
    setEnv("TRANSFI_PASSWORD", undefined);
    setEnv("TRANSFI_MID", undefined);
    expect(getFxQuoteProvider()).toBeInstanceOf(LiveMidFxProvider);
    expect(getPayoutProvider()).toBeInstanceOf(FallbackPayoutProvider);
  });

  it("G-18: el quote del mid real no toca TransFi (y no necesita TRANSFI_ENV)", async () => {
    // El feed DEBE declarar la fecha de su dato: sin ella la fuente se descarta (shape inválido)
    // y este test moriría por el motivo equivocado.
    const { calls } = stubFetchCapturing({
      rates: { PEN: 3.8 },
      time_last_update_unix: Math.floor(Date.now() / 1000),
    });
    const quote = await new LiveMidFxProvider().quote(fxInput);
    expect(quote.provenance).toBe("fx-mid-live");
    expect(quote.rateSource).toBe("er-api");
    for (const url of calls) expect(url).not.toContain("transfi.com");
  });

  it("G-18: devnet e2e (mock + devnet-stub) ejecuta sin TRANSFI_ENV", async () => {
    setEnv("ALLOW_FALLBACK_PAYOUT", "true"); // NODE_ENV=test → rama dev del fail-safe de payout
    setEnv("DIDIT_API_KEY", "k");
    setEnv("DIDIT_ADAPTER_READY", "true");
    // El adapter de Didit tiene su propio fail-closed de ambiente (didit-env.ts, módulo hermano de
    // este): sin DIDIT_ENV la factory lanza. Este test declara "mock" + localhost porque su punto es
    // el fail-closed de TRANSFI_ENV, no el de Didit — y porque un test jamás debe resolver el host
    // real de Didit. El eje Didit se cubre en didit-env.test.ts.
    setEnv("DIDIT_ENV", "mock");
    setEnv("DIDIT_BASE_URL", "http://localhost:9999/didit-mock");
    setEnv("TRANSFI_USDC_NETWORK", "solana");
    setEnv("TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS", "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
    const { calls } = stubFetchCapturing({
      status: "Approved",
      session_id: "v1",
      vendor_data: "12345678",
    });
    const out = await runCashoutPayout({
      quoteId: QUOTE_REF_100, // el core exige la referencia autenticada (binding quote↔monto)
      amountUsd: 100,
      kycVerificationId: "v1",
      senderIdentity: "12345678",
      beneficiary: { name: "Bob", country: "PE", method: "yape", destination: "999999999" },
      idempotencyKey: "idem-1",
    });
    expect(out.executed).toBe(true);
    expect(out.provenance).toBe("devnet-stub");
    expect(out.depositAddress).toBe("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
    // el único fetch del flujo es el de Didit: TransFi nunca se toca en modo mock.
    for (const url of calls) expect(url).not.toContain("transfi.com");
  });

  it("G-18: PROD + PAYOUT_ALLOW_MOCK sin TRANSFI_ENV → el gate KYC bloquea, NO transfi_env_unset", async () => {
    setEnv("NODE_ENV", "production");
    setEnv("PAYOUT_ALLOW_MOCK", "true");
    setEnv("ALLOW_FALLBACK_KYC", "true"); // en prod no abre nada (B3), acá solo prueba que no throwea
    setEnv("DIDIT_API_KEY", undefined);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { calls } = stubFetchCapturing({});
    const out = await runCashoutPayout({
      quoteId: QUOTE_REF_100, // el core exige la referencia autenticada (binding quote↔monto)
      amountUsd: 100,
      kycVerificationId: "v1",
      senderIdentity: "12345678",
      beneficiary: { name: "Bob", country: "PE", method: "yape", destination: "999999999" },
      idempotencyKey: "idem-1",
    });
    expect(out.status).toBe("blocked");
    expect(out.reason).toBe("kyc_gate_not_passed");
    for (const url of calls) expect(url).not.toContain("transfi.com");
  });
});
