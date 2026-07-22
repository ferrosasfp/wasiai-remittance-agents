import { describe, it, expect, afterEach, vi } from "vitest";
import {
  FallbackPayoutProvider,
  TransFiPayoutProvider,
  assertValidPayout,
  getPayoutProvider,
  normalizeStatus,
  resolveDevnetStubAddress,
} from "./payout";
import { runCashoutPayout } from "../agents/cashout-payout";
import type { PayoutInput, PayoutResult } from "./types";

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

// §9: `mockImplementation` (no `mockResolvedValue`) para poder inspeccionar los args del request.
// Tipado explícito (evitar `any` — golden path TS strict): captura [url, init] tipados.
function stubFetch(body: unknown, status = 200) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(body, status));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// Variante: body 2xx CRUDO no-JSON (para probar el fail-loud tipado, no SyntaxError). §Reglas:
// `mockImplementation` (no `mockResolvedValue`) — cada llamada re-crea la Response (body de un solo uso).
function stubFetchRaw(text: string, status = 200) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(text, { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const CREDS = { username: "u", password: "p", mid: "m" };

describe("FallbackPayoutProvider (mock — NO mueve plata)", () => {
  it("no entrega real: deliveredLocal null + provenance local-fallback + depositAddress null", async () => {
    const r = await new FallbackPayoutProvider().execute(input);
    expect(r.provenance).toBe("local-fallback");
    expect(r.deliveredLocal).toBeNull();
    expect(r.txRef).toBeNull();
    expect(r.depositAddress).toBeNull();
    expect(r.payoutId).toContain("fallback-");
  });
  it("status() del mock también devuelve depositAddress null", async () => {
    const r = await new FallbackPayoutProvider().status("x");
    expect(r.depositAddress).toBeNull();
    expect(r.provenance).toBe("local-fallback");
  });
});

describe("assertValidPayout", () => {
  const ok: PayoutResult = {
    payoutId: "p1",
    status: "settled",
    deliveredLocal: 368,
    txRef: "0xabc",
    failureReason: null,
    provenance: "transfi",
    depositAddress: null,
  };
  it("pasa uno válido", () => expect(assertValidPayout(ok)).toBe(ok));
  it("lanza si payoutId vacío", () =>
    expect(() => assertValidPayout({ ...ok, payoutId: "" })).toThrow(/invalid_payout_id/));
  it("lanza si deliveredLocal NaN", () =>
    expect(() => assertValidPayout({ ...ok, deliveredLocal: NaN })).toThrow(
      /invalid_payout_delivered/,
    ));
});

// ── Adapter TransFi — contrato HTTP real (WKH-208) ────────────────────────────
describe("TransFiPayoutProvider.execute — contrato HTTP", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("AC-1: auth Basic base64(user:pass) + header mid; NUNCA Bearer ni x-api-key", async () => {
    const fetchMock = stubFetch({ orderId: "ord-1", walletAddress: "0xdep" });
    await new TransFiPayoutProvider(CREDS).execute(input);
    const [, init] = fetchMock.mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Basic " + Buffer.from("u:p").toString("base64"));
    expect(headers.mid).toBe("m");
    expect(JSON.stringify(headers).toLowerCase()).not.toContain("bearer");
    expect(headers["x-api-key"]).toBeUndefined();
  });

  it("AC-2: POST /v3/orders; orderType offramp; partnerId=idempotencyKey byte-idéntico; sin header idempotency-key", async () => {
    const fetchMock = stubFetch({ orderId: "ord-1", walletAddress: "0xdep" });
    await new TransFiPayoutProvider(CREDS).execute(input);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toMatch(/\/v3\/orders$/);
    expect(url).not.toContain("/v1/payouts");
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body.orderType).toBe("offramp");
    expect(body.partnerId).toBe(input.idempotencyKey);
    const headers = init?.headers as Record<string, string>;
    expect(headers["idempotency-key"]).toBeUndefined();
  });

  it("FIX-A (CR MNR-1): body incluye sourceUrl desde TRANSFI_SOURCE_URL cuando está seteada", async () => {
    const fetchMock = stubFetch({ orderId: "ord-1", walletAddress: "0xdep" });
    vi.stubEnv("TRANSFI_SOURCE_URL", "https://merchant.example/return");
    await new TransFiPayoutProvider(CREDS).execute(input);
    const body = JSON.parse(fetchMock.mock.calls[0]![1]?.body as string) as { sourceUrl: string };
    expect(body.sourceUrl).toBe("https://merchant.example/return");
  });

  it("FIX-B (AR MNR-1): 2xx con body no-JSON → transfi_payout_bad_response tipado, NO SyntaxError crudo, NO mock", async () => {
    stubFetchRaw("not json");
    await expect(new TransFiPayoutProvider(CREDS).execute(input)).rejects.toThrow(
      /^transfi_payout_bad_response$/,
    );
    // el error NO es un SyntaxError crudo del parser
    await expect(new TransFiPayoutProvider(CREDS).execute(input)).rejects.not.toThrow(SyntaxError);
  });

  it("AC-3: 2xx → status submitted, payoutId=orderId, depositAddress=walletAddress, deliveredLocal null, provenance transfi", async () => {
    stubFetch({ orderId: "ord-1", walletAddress: "0xdeposit" });
    const r = await new TransFiPayoutProvider(CREDS).execute(input);
    expect(r.status).toBe("submitted");
    expect(r.payoutId).toBe("ord-1");
    expect(r.depositAddress).toBe("0xdeposit");
    expect(r.deliveredLocal).toBeNull();
    expect(r.provenance).toBe("transfi");
  });

  it("AC-3 adversarial: status:fund_settled EN el POST NO produce settled (se fuerza submitted)", async () => {
    stubFetch({ orderId: "ord-1", walletAddress: "0xdeposit", status: "fund_settled" });
    const r = await new TransFiPayoutProvider(CREDS).execute(input);
    expect(r.status).toBe("submitted"); // CD-5: nunca leer status del create-order
  });

  it("AC-6: red no soportada (avalanche) → throw transfi_unsupported_network, SIN llamar fetch", async () => {
    const fetchMock = stubFetch({ orderId: "ord-1" });
    vi.stubEnv("TRANSFI_USDC_NETWORK", "avalanche");
    await expect(new TransFiPayoutProvider(CREDS).execute(input)).rejects.toThrow(
      /transfi_unsupported_network_avalanche/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("AC-6 feliz: polygon → source.currency USDCPOLYGON", async () => {
    const fetchMock = stubFetch({ orderId: "ord-1", walletAddress: "0xdep" });
    vi.stubEnv("TRANSFI_USDC_NETWORK", "polygon");
    await new TransFiPayoutProvider(CREDS).execute(input);
    const body = JSON.parse(fetchMock.mock.calls[0]![1]?.body as string) as {
      source: { currency: string };
    };
    expect(body.source.currency).toBe("USDCPOLYGON");
  });

  it("AC-6 feliz: base (default) → source.currency USDCBASE", async () => {
    const fetchMock = stubFetch({ orderId: "ord-1", walletAddress: "0xdep" });
    vi.stubEnv("TRANSFI_USDC_NETWORK", "base");
    await new TransFiPayoutProvider(CREDS).execute(input);
    const body = JSON.parse(fetchMock.mock.calls[0]![1]?.body as string) as {
      source: { currency: string };
    };
    expect(body.source.currency).toBe("USDCBASE");
  });

  it("AC-6 feliz: solana → source.currency USDCSOL", async () => {
    const fetchMock = stubFetch({ orderId: "ord-1", walletAddress: "0xdep" });
    vi.stubEnv("TRANSFI_USDC_NETWORK", "solana");
    await new TransFiPayoutProvider(CREDS).execute(input);
    const body = JSON.parse(fetchMock.mock.calls[0]![1]?.body as string) as {
      source: { currency: string };
    };
    expect(body.source.currency).toBe("USDCSOL");
  });

  it("AC-2: solana → depositAddress base58 pass-through intacto", async () => {
    stubFetch({
      orderId: "ord-1",
      depositAddress: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    });
    vi.stubEnv("TRANSFI_USDC_NETWORK", "solana");
    const r = await new TransFiPayoutProvider(CREDS).execute(input);
    expect(r.depositAddress).toBe("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
  });

  it("AC-7: 4xx (PARTNER_ID_ALREADY_USED) → throws transfi_payout_error_409, nunca resuelve", async () => {
    stubFetch({ code: "PARTNER_ID_ALREADY_USED" }, 409);
    await expect(new TransFiPayoutProvider(CREDS).execute(input)).rejects.toThrow(
      /transfi_payout_error_409/,
    );
  });

  it("AC-7: 5xx → throws transfi_payout_error_500", async () => {
    stubFetch({}, 500);
    await expect(new TransFiPayoutProvider(CREDS).execute(input)).rejects.toThrow(
      /transfi_payout_error_500/,
    );
  });
});

describe("TransFiPayoutProvider.status", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("GET /v3/orders/{id} con Basic+mid; mapea normalizeStatus; depositAddress null", async () => {
    const fetchMock = stubFetch({ status: "fund_settled" });
    const r = await new TransFiPayoutProvider(CREDS).status("ord-1");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toMatch(/\/v3\/orders\/ord-1$/);
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Basic " + Buffer.from("u:p").toString("base64"));
    expect(headers.mid).toBe("m");
    expect(r.status).toBe("settled");
    expect(r.payoutId).toBe("ord-1");
    expect(r.depositAddress).toBeNull();
  });

  it("FIX-B (AR MNR-1): status() 2xx con body no-JSON → transfi_payout_status_bad_response tipado, NO SyntaxError", async () => {
    stubFetchRaw("not json");
    await expect(new TransFiPayoutProvider(CREDS).status("ord-1")).rejects.toThrow(
      /^transfi_payout_status_bad_response$/,
    );
    await expect(new TransFiPayoutProvider(CREDS).status("ord-1")).rejects.not.toThrow(SyntaxError);
  });

  it("AC-7: !2xx en status → throws transfi_payout_status_error_500", async () => {
    stubFetch({}, 500);
    await expect(new TransFiPayoutProvider(CREDS).status("ord-1")).rejects.toThrow(
      /transfi_payout_status_error_500/,
    );
  });
});

// AC-8: tabla directa sobre normalizeStatus (exportado). Un caso por estado documentado + desconocido.
describe("normalizeStatus (AC-8/CD-7)", () => {
  it.each([
    ["initiated", "submitted"],
    ["asset_deposited", "submitted"],
    ["fund_settled", "settled"],
    ["fund_failed", "failed"],
    ["expired", "failed"],
  ])("%s → %s", (transfi, expected) => {
    expect(normalizeStatus(transfi)).toBe(expected);
  });
  it("desconocido → submitted (NUNCA settled fabricado)", () => {
    expect(normalizeStatus("wat_status")).toBe("submitted");
    expect(normalizeStatus(undefined)).toBe("submitted");
  });
});

// ── Escape-hatch devnet-only (WKH-232 / HU-SOL-15) ────────────────────────────
describe("FallbackPayoutProvider — escape-hatch devnet (WKH-232 / HU-SOL-15)", () => {
  afterEach(() => vi.unstubAllEnvs());

  const VALID = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"; // base58 real, 44 chars

  it("T-1 (AC-1): doble-gate → depositAddress = env address + provenance devnet-stub, sin fetch a TransFi", async () => {
    vi.stubEnv("TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS", VALID);
    vi.stubEnv("TRANSFI_USDC_NETWORK", "solana");
    const r = await new FallbackPayoutProvider().execute(input);
    expect(r.depositAddress).toBe(VALID);
    expect(r.provenance).toBe("devnet-stub");
  });

  it("T-2 (AC-6/CD-3): provenance distinguible — nunca transfi ni local-fallback", async () => {
    vi.stubEnv("TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS", VALID);
    vi.stubEnv("TRANSFI_USDC_NETWORK", "solana");
    const r = await new FallbackPayoutProvider().execute(input);
    expect(r.provenance).not.toBe("transfi");
    expect(r.provenance).not.toBe("local-fallback");
    expect(r.provenance).toBe("devnet-stub");
  });

  it("T-3 (AC-2/CD-1): el real SIEMPRE precede — con creds+readiness el mock ni se instancia", () => {
    vi.stubEnv("TRANSFI_USERNAME", "u");
    vi.stubEnv("TRANSFI_PASSWORD", "p");
    vi.stubEnv("TRANSFI_MID", "m");
    vi.stubEnv("TRANSFI_ADAPTER_READY", "true");
    vi.stubEnv("TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS", VALID);
    vi.stubEnv("TRANSFI_USDC_NETWORK", "solana");
    expect(getPayoutProvider()).toBeInstanceOf(TransFiPayoutProvider);
  });

  it("T-4 (AC-3/CD-4): sin la env → byte-idéntico (depositAddress null + local-fallback)", async () => {
    vi.stubEnv("TRANSFI_USDC_NETWORK", "solana"); // solo una pata del gate
    const r = await new FallbackPayoutProvider().execute(input);
    expect(r.depositAddress).toBeNull();
    expect(r.provenance).toBe("local-fallback");
  });

  it("T-5 (AC-4a/CD-5): address malformada (no base58) → fail-closed", async () => {
    vi.stubEnv("TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS", "0xNOTbase58INVALID");
    vi.stubEnv("TRANSFI_USDC_NETWORK", "solana");
    const r = await new FallbackPayoutProvider().execute(input);
    expect(r.depositAddress).toBeNull();
    expect(r.provenance).toBe("local-fallback");
  });

  it("T-6 (AC-4b/CD-2): red≠solana → fail-closed aunque la address sea base58 válida", async () => {
    vi.stubEnv("TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS", VALID);
    vi.stubEnv("TRANSFI_USDC_NETWORK", "base");
    const r = await new FallbackPayoutProvider().execute(input);
    expect(r.depositAddress).toBeNull();
    expect(r.provenance).toBe("local-fallback");
  });

  it("T-7 (AC-5/CD-6): hereda el gate de prod — el stub no bypassea assertPayoutProviderSafe", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TRANSFI_USERNAME", "");
    vi.stubEnv("TRANSFI_PASSWORD", "");
    vi.stubEnv("TRANSFI_MID", "");
    vi.stubEnv("PAYOUT_ALLOW_MOCK", "");
    vi.stubEnv("TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS", VALID);
    vi.stubEnv("TRANSFI_USDC_NETWORK", "solana");
    await expect(
      runCashoutPayout({
        quoteId: "q1",
        amountUsd: 100,
        kycVerificationId: "kyc-1",
        beneficiary: { name: "Bob", country: "PE", method: "yape", destination: "999999999" },
        idempotencyKey: "idem-1",
      }),
    ).rejects.toThrow(/payout_refused/);
  });

  it("T-8 (CD-10): boundary de longitud — 31/45 null, 32/44 válido", () => {
    vi.stubEnv("TRANSFI_USDC_NETWORK", "solana");
    vi.stubEnv("TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS", "1".repeat(31));
    expect(resolveDevnetStubAddress()).toBeNull();
    vi.stubEnv("TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS", "1".repeat(32));
    expect(resolveDevnetStubAddress()).toBe("1".repeat(32));
    vi.stubEnv("TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS", "1".repeat(44));
    expect(resolveDevnetStubAddress()).toBe("1".repeat(44));
    vi.stubEnv("TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS", "1".repeat(45));
    expect(resolveDevnetStubAddress()).toBeNull();
  });

  it("T-9 (CD-10): charset — chars ambiguos 0/O/I/l → null", () => {
    vi.stubEnv("TRANSFI_USDC_NETWORK", "solana");
    // 43 chars base58 + 1 char ambiguo (total 44) → fuera del charset → null.
    for (const bad of ["0", "O", "I", "l"]) {
      vi.stubEnv("TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS", "1".repeat(43) + bad);
      expect(resolveDevnetStubAddress()).toBeNull();
    }
  });
});

describe("getPayoutProvider factory (AC-5)", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("sin las 3 creds → fallback", () => {
    vi.stubEnv("TRANSFI_USERNAME", "");
    vi.stubEnv("TRANSFI_PASSWORD", "");
    vi.stubEnv("TRANSFI_MID", "");
    expect(getPayoutProvider()).toBeInstanceOf(FallbackPayoutProvider);
  });
  it("falta una de las creds → fallback (no adapter real a medias)", () => {
    vi.stubEnv("TRANSFI_USERNAME", "u");
    vi.stubEnv("TRANSFI_PASSWORD", "p");
    vi.stubEnv("TRANSFI_MID", "");
    vi.stubEnv("TRANSFI_ADAPTER_READY", "true");
    expect(getPayoutProvider()).toBeInstanceOf(FallbackPayoutProvider);
  });
  it("creds sin readiness → throws transfi_adapter_not_ready", () => {
    vi.stubEnv("TRANSFI_USERNAME", "u");
    vi.stubEnv("TRANSFI_PASSWORD", "p");
    vi.stubEnv("TRANSFI_MID", "m");
    vi.stubEnv("TRANSFI_ADAPTER_READY", "");
    expect(() => getPayoutProvider()).toThrow(/transfi_adapter_not_ready/);
  });
  it("creds + readiness → adapter TransFi", () => {
    vi.stubEnv("TRANSFI_USERNAME", "u");
    vi.stubEnv("TRANSFI_PASSWORD", "p");
    vi.stubEnv("TRANSFI_MID", "m");
    vi.stubEnv("TRANSFI_ADAPTER_READY", "true");
    expect(getPayoutProvider()).toBeInstanceOf(TransFiPayoutProvider);
  });
});
