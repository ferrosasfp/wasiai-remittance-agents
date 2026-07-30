// src/app/api/agents/remit-kyc-validator/manifest/route.test.ts
// Superficie HTTP del manifiesto de remit-kyc-validator (chain solana-devnet, familia solana: el
// pipeline de remesas cobra entero en Solana, ninguna pata toca Avalanche).
// Los únicos códigos permitidos son 200 y 503: un 200 con ficha a medias es exactamente el bug que
// esta HU viene a matar (alguien lo copia al registro y el agente cobra $0 en silencio).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import * as routeModule from "./route";
import { GET } from "./route";

const ENDPOINT = "http://localhost/api/agents/remit-kyc-validator/manifest";
const KYC_ENV = "REMIT_KYC_VALIDATOR_PAYTO";

// Fixtures de FORMATO (no son wallets reales — no usar en ningún runbook).
const SOL_OK = "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr";
const SOL_OK_2 = "So11111111111111111111111111111111111111112";
const EVM_OK = "0x1111111111111111111111111111111111111111";

function get(url: string = ENDPOINT, headers?: Record<string, string>) {
  return GET(new NextRequest(url, headers ? { headers } : undefined));
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// T1 — AC-1
describe("GET /api/agents/remit-kyc-validator/manifest — publicable", () => {
  beforeEach(() => {
    vi.stubEnv(KYC_ENV, SOL_OK);
  });

  it("200 con las capabilities exactas y el payment completo de solana-devnet", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.capabilities).toEqual([
      "kyc-verification",
      "aml-screening",
      "travel-rule",
      "remittance-compliance",
    ]);
    expect(body.payment).toEqual({
      method: "x402",
      chain: "solana-devnet",
      contract: SOL_OK,
      asset: "USDC",
    });
    expect(body.slug).toBe("remit-kyc-validator");
    expect(body.name).toBe(body.slug);
    expect(body.manifestVersion).toBe("1");
    expect(body.priceUsdc).toBe(0.02);
  });

  // T14 a/b — AC-7
  it("el módulo exporta dynamic = 'force-dynamic' (sin esto el payTo queda congelado en build)", () => {
    expect(routeModule.dynamic).toBe("force-dynamic");
  });

  it("la respuesta 200 lleva Cache-Control: no-store", async () => {
    const res = await get();
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  // T8 — AC-4
  it("no hace NINGUNA I/O saliente: con fetch stubbeado a throw sigue devolviendo 200", async () => {
    vi.stubGlobal("fetch", () => {
      throw new Error("no-io-allowed");
    });
    const res = await get();
    expect(res.status).toBe(200);
    expect((await res.json()).payment.contract).toBe(SOL_OK);
  });

  // T15 — AC-8
  it("ignora query params y headers del caller: mismo body con ?payTo=0xEVIL&debug=1", async () => {
    const plain = await (await get()).json();
    const dirty = await (
      await get(`${ENDPOINT}?payTo=0xEVIL&debug=1`, {
        "x-forwarded-host": "evil.example",
        authorization: "Bearer token-del-caller",
      })
    ).json();
    expect(dirty).toEqual(plain);
    expect(JSON.stringify(dirty)).not.toContain("EVIL");
    expect(JSON.stringify(dirty)).not.toContain("evil.example");
    expect(JSON.stringify(dirty)).not.toContain("token-del-caller");
  });
});

// T14c — AC-7
describe("GET manifest — la env se lee en cada request (no hay caché ni lectura congelada)", () => {
  it("dos GET con envs distintas devuelven contracts distintos", async () => {
    vi.stubEnv(KYC_ENV, SOL_OK);
    const first = await (await get()).json();
    vi.stubEnv(KYC_ENV, SOL_OK_2);
    const second = await (await get()).json();
    expect(first.payment.contract).toBe(SOL_OK);
    expect(second.payment.contract).toBe(SOL_OK_2);
    expect(second.payment.contract).not.toBe(first.payment.contract);
  });
});

// T5 — AC-3
describe("GET manifest — fail-closed: nadie puede copiar una ficha a medias", () => {
  it("sin la env configurada: 503, sin NINGUNA clave payment en el body", async () => {
    // env ausente a propósito (no se stubea)
    const res = await get();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect("payment" in body).toBe(false);
    expect(body.error).toBe("manifest_unavailable");
    expect(body.missing).toContain("payment.contract");
    expect(body.invalid).toEqual([]);
  });

  it("el 503 también lleva Cache-Control: no-store", async () => {
    const res = await get();
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("env vacía y whitespace-only ⇒ 503 sin payment", async () => {
    for (const value of ["", "   "]) {
      vi.stubEnv(KYC_ENV, value);
      const res = await get();
      expect(res.status).toBe(503);
      const body = await res.json();
      expect("payment" in body).toBe(false);
      expect(body.missing).toContain("payment.contract");
    }
  });

  it("payTo con formato inválido ⇒ 503 invalid, sin payment", async () => {
    vi.stubEnv(KYC_ENV, "z".repeat(44)); // base58 de 44 chars que decodifica a 33 bytes
    const res = await get();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect("payment" in body).toBe(false);
    expect(body.invalid).toContain("payment.contract");
    expect(body.missing).toEqual([]);
  });

  // El error más probable del operador después del pase a Solana: dejar en la env la address EVM
  // que servía cuando este agente cobraba en Fuji. El settle la rechazaría (INVALID_PAY_TO_FORMAT)
  // y el agente cobraría $0 con un manifiesto diciendo que todo está bien.
  it("payTo de la familia equivocada (EVM en slot solana-devnet) ⇒ 503", async () => {
    vi.stubEnv(KYC_ENV, EVM_OK);
    const res = await get();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect("payment" in body).toBe(false);
    expect(body.invalid).toContain("payment.contract");
  });

  // T15 — AC-8: el 503 no ecoa el valor de la env
  it("el body de 503 NO ecoa el valor de la env", async () => {
    vi.stubEnv(KYC_ENV, "0xDEADBEEF-not-an-address");
    const res = await get();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("DEADBEEF");
  });

  // FIX-PACK CR-MNR-1 — la rama catch (route.ts:31-40) no la ejercitaba nadie: se le podía meter
  // ahí un 200 con ficha a medias (el bug que esta HU vino a matar) y la suite quedaba verde.
  it("si buildManifest LANZA: 503 sin payment (no un 200 a medias, no un 500)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv(KYC_ENV, SOL_OK); // env PERFECTA: el 503 sale del catch, no del fail-closed
    vi.resetModules();
    vi.doMock("@/manifest/build", () => ({
      buildManifest: () => {
        throw new Error("boom-interno-del-manifiesto");
      },
    }));
    try {
      const { GET: GET_throwing } = await import("./route");
      const res = await GET_throwing(new NextRequest(ENDPOINT));
      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = await res.json();
      expect("payment" in body).toBe(false);
      expect(body.error).toBe("manifest_unavailable");
      expect(body.missing).toEqual([]);
      expect(body.invalid).toEqual([]);
      // el log del catch tampoco ecoa el mensaje del error ni el valor de la env
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).not.toContain("boom-interno-del-manifiesto");
      expect(logged).not.toContain(SOL_OK);
    } finally {
      vi.doUnmock("@/manifest/build");
      vi.resetModules();
    }
  });

  it("tampoco lo ecoa en los logs", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv(KYC_ENV, "0xDEADBEEF-not-an-address");
    await get();
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain("DEADBEEF");
  });
});
