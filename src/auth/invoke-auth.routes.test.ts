// Verificación POR COMPORTAMIENTO de las 3 rutas `invoke` reales (no del guard aislado).
//
// El punto de este archivo: probar que el guard está EN LAS TRES y que, sin `INVOKE_AUTH_SECRET`,
// las tres se comportan exactamente como antes. El caso de la ruta que se olvidaron de cablear no
// lo detecta ningún test del módulo — sólo uno que llame al `POST` de cada una.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

import { POST as postFx } from "@/app/api/agents/remit-corridor-fx/invoke/route";
import { POST as postKyc } from "@/app/api/agents/remit-kyc-validator/invoke/route";
import { POST as postPayout } from "@/app/api/agents/remit-cashout-payout/invoke/route";
import { INVOKE_AUTH_SECRET_ENV, INVOKE_AUTH_SCHEME } from "./invoke-auth";

const SECRET = "secreto-de-prueba-de-las-rutas-invoke";

type Handler = (req: NextRequest) => Promise<Response>;

/** Las 3 rutas, con un body INVÁLIDO cada una: hoy las 3 responden 400 `invalid_input`. */
const RUTAS: readonly [string, Handler, string][] = [
  ["remit-corridor-fx", postFx, "http://localhost/api/agents/remit-corridor-fx/invoke"],
  ["remit-kyc-validator", postKyc, "http://localhost/api/agents/remit-kyc-validator/invoke"],
  ["remit-cashout-payout", postPayout, "http://localhost/api/agents/remit-cashout-payout/invoke"],
];

function call(handler: Handler, url: string, headers: Record<string, string> = {}) {
  return handler(
    new NextRequest(url, { method: "POST", body: JSON.stringify({}), headers }),
  );
}

/** Cuerpo del feed FX con fecha declarada — sin fecha la fuente se descarta por shape inválido. */
function feedBody(pen: number): unknown {
  return { rates: { PEN: pen }, time_last_update_unix: Math.floor(Date.now() / 1000) };
}

describe("las 3 rutas invoke — el guard de credencial está cableado en las TRES", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // ── EL REQUISITO DE DESPLIEGUE, MEDIDO EN LAS RUTAS DE VERDAD ────────────────────────────────

  it("SIN la env: las 3 rutas responden lo de hoy (400 invalid_input) y NUNCA 401", async () => {
    for (const [agente, handler, url] of RUTAS) {
      // Sin cabecera: es EXACTAMENTE lo que mandan chaski punto a punto y el gateway hoy.
      const res = await call(handler, url);
      expect(res.status, agente).toBe(400);
      expect(((await res.json()) as { error: string }).error, agente).toBe("invalid_input");
    }
  });

  it("SIN la env: una cabecera basura tampoco cambia nada (no hay chequeo que ofender)", async () => {
    for (const [agente, handler, url] of RUTAS) {
      const res = await call(handler, url, { authorization: "Basic no-es-un-bearer" });
      expect(res.status, agente).toBe(400);
    }
  });

  it("SIN la env: una llamada REAL de hoy sigue dando 200 con trabajo real (no sólo el 400)", async () => {
    vi.stubEnv("TRANSFI_API_KEY", "");
    vi.stubEnv("FX_RATE_CACHE_TTL_MS", "0");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => feedBody(3.8) })),
    );
    const res = await postFx(
      new NextRequest("http://localhost/api/agents/remit-corridor-fx/invoke", {
        method: "POST",
        body: JSON.stringify({ amountUsd: 100 }), // sin ninguna cabecera de auth
      }),
    );
    expect(res.status).toBe(200);
    const { result } = (await res.json()) as { result: { quoteId: string; rate: number } };
    expect(result.quoteId).toBeTruthy();
    expect(result.rate).toBeGreaterThan(0);
  });

  // ── CON LA ENV ───────────────────────────────────────────────────────────────────────────────

  it("con la env y la credencial correcta: las 3 pasan el guard y llegan al validador (400, no 401)", async () => {
    vi.stubEnv(INVOKE_AUTH_SECRET_ENV, SECRET);
    for (const [agente, handler, url] of RUTAS) {
      const res = await call(handler, url, {
        authorization: `${INVOKE_AUTH_SCHEME} ${SECRET}`,
      });
      expect(res.status, agente).toBe(400);
      expect(((await res.json()) as { error: string }).error, agente).toBe("invalid_input");
    }
  });

  it("con la env: las 3 rechazan 401 y con los TRES motivos distinguibles", async () => {
    vi.stubEnv(INVOKE_AUTH_SECRET_ENV, SECRET);
    const casos: [Record<string, string>, string][] = [
      [{}, "credential_missing"],
      [{ authorization: SECRET }, "credential_malformed"], // el secreto pelado, sin esquema
      [{ authorization: `${INVOKE_AUTH_SCHEME} otro` }, "credential_mismatch"],
    ];
    for (const [agente, handler, url] of RUTAS) {
      const vistos = new Set<string>();
      for (const [headers, esperado] of casos) {
        const res = await call(handler, url, headers);
        expect(res.status, `${agente} / ${esperado}`).toBe(401);
        const body = (await res.json()) as { error: string; reason: string };
        expect(body.error, agente).toBe("unauthorized");
        expect(body.reason, `${agente} / ${esperado}`).toBe(esperado);
        vistos.add(body.reason);
      }
      expect(vistos.size, `${agente}: los 3 motivos colapsaron en uno`).toBe(3);
    }
  });

  it("con la env y sin credencial: el 401 corta ANTES de parsear el body del caller", async () => {
    vi.stubEnv(INVOKE_AUTH_SECRET_ENV, SECRET);
    // Body ilegible: si el guard corriera DESPUÉS del parse, esto saldría 400 invalid_input.
    const res = await postPayout(
      new NextRequest("http://localhost/api/agents/remit-cashout-payout/invoke", {
        method: "POST",
        body: "{no es json",
      }),
    );
    expect(res.status).toBe(401);
  });
});
