// src/app/api/agents/remit-cashout-payout/manifest/route.test.ts
// Superficie HTTP del manifiesto de remit-cashout-payout. pathSlug (`remit-cashout-payout`) y slug
// canónico (`remit-cashout-payout-solana`) son DISTINTOS a propósito.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import * as routeModule from "./route";
import { GET } from "./route";

const ENDPOINT = "http://localhost/api/agents/remit-cashout-payout/manifest";
const PAYOUT_ENV = "REMIT_CASHOUT_PAYOUT_PAYTO";

// Fixtures de FORMATO (no son wallets reales — no usar en ningún runbook).
const SOL_OK = "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr";
const SOL_OK_2 = "So11111111111111111111111111111111111111112";
const SOL_33B = "z".repeat(44);
const EVM_OK = "0x1111111111111111111111111111111111111111";

function get(url: string = ENDPOINT, headers?: Record<string, string>) {
  return GET(new NextRequest(url, headers ? { headers } : undefined));
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// T3 — AC-2
describe("GET /api/agents/remit-cashout-payout/manifest — publicable", () => {
  beforeEach(() => {
    vi.stubEnv(PAYOUT_ENV, SOL_OK);
  });

  it("200 con chain solana-devnet y el slug canónico remit-cashout-payout-solana", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.payment.chain).toBe("solana-devnet");
    expect(body.slug).toBe("remit-cashout-payout-solana");
    expect(body.name).toBe(body.slug);
    expect(body.payment).toEqual({
      method: "x402",
      chain: "solana-devnet",
      contract: SOL_OK,
      asset: "USDC",
    });
    expect(body.capabilities).toEqual([
      "remittance-payout",
      "cashout",
      "value-delivery",
      "fiat-disbursement",
    ]);
    expect(body.priceUsdc).toBe(0.03);
  });

  // T14 a/b — AC-7
  it("el módulo exporta dynamic = 'force-dynamic'", () => {
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
  it("ignora query params y headers del caller", async () => {
    const plain = await (await get()).json();
    const dirty = await (
      await get(`${ENDPOINT}?payTo=0xEVIL&debug=1`, {
        "x-forwarded-host": "evil.example",
        authorization: "Bearer token-del-caller",
      })
    ).json();
    expect(dirty).toEqual(plain);
    expect(JSON.stringify(dirty)).not.toContain("EVIL");
    expect(JSON.stringify(dirty)).not.toContain("token-del-caller");
  });
});

// T14c — AC-7
describe("GET manifest — la env se lee en cada request", () => {
  it("dos GET con envs distintas devuelven contracts distintos", async () => {
    vi.stubEnv(PAYOUT_ENV, SOL_OK);
    const first = await (await get()).json();
    vi.stubEnv(PAYOUT_ENV, SOL_OK_2);
    const second = await (await get()).json();
    expect(first.payment.contract).toBe(SOL_OK);
    expect(second.payment.contract).toBe(SOL_OK_2);
    expect(second.payment.contract).not.toBe(first.payment.contract);
  });
});

// T5 — AC-3
describe("GET manifest — fail-closed", () => {
  it("sin la env configurada: 503, sin NINGUNA clave payment en el body", async () => {
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
      vi.stubEnv(PAYOUT_ENV, value);
      const res = await get();
      expect(res.status).toBe(503);
      expect("payment" in (await res.json())).toBe(false);
    }
  });

  it("payTo de la familia equivocada (EVM en slot solana-devnet) ⇒ 503", async () => {
    vi.stubEnv(PAYOUT_ENV, EVM_OK);
    const res = await get();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect("payment" in body).toBe(false);
    expect(body.invalid).toContain("payment.contract");
  });

  it("base58 de 44 chars que decodifica a 33 bytes ⇒ 503 (el settle la rechazaría)", async () => {
    vi.stubEnv(PAYOUT_ENV, SOL_33B);
    const res = await get();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect("payment" in body).toBe(false);
    expect(body.invalid).toContain("payment.contract");
  });

  // T15 — AC-8
  it("el body de 503 NO ecoa el valor de la env", async () => {
    vi.stubEnv(PAYOUT_ENV, "DEADBEEF-not-an-address");
    const res = await get();
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain("DEADBEEF");
  });
});
