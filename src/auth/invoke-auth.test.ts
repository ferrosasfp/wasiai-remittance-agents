import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  checkInvokeAuth,
  guardInvokeAuth,
  INVOKE_AUTH_SECRET_ENV,
  INVOKE_AUTH_HEADER,
  INVOKE_AUTH_SCHEME,
  type InvokeAuthVerdict,
} from "./invoke-auth";

const SECRET = "un-secreto-de-prueba-que-no-vive-en-ningun-deploy";

/** Enciende el guard. Ningún test lo deja encendido: el `afterEach` lo apaga. */
function enforce(secret: string = SECRET): void {
  vi.stubEnv(INVOKE_AUTH_SECRET_ENV, secret);
}

function request(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/agents/remit-corridor-fx/invoke", {
    method: "POST",
    headers,
  });
}

describe("checkInvokeAuth — el guard inerte de las 3 rutas invoke", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  //  EL REQUISITO DE DESPLIEGUE. Si alguno de estos tests se pone rojo, el deploy empieza a
  //  rechazar llamadas que hoy funcionan y una remesa queda a mitad de camino. No son tests de
  //  "cobertura": son el contrato de que esto se puede mergear sin coordinar dos repos.
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  it("SIN la env: TODA cabecera —incluida la ausencia total— pasa como not_enforced", () => {
    // La env no se stubbea: éste es el estado real del deploy de hoy.
    const cabeceras: (string | null)[] = [
      null, // el caso de chaski y del gateway HOY: no mandan nada
      "",
      "   ",
      `${INVOKE_AUTH_SCHEME} ${SECRET}`,
      `${INVOKE_AUTH_SCHEME} cualquier-otra-cosa`,
      "Basic dXNlcjpwYXNz",
      SECRET, // el secreto pelado, sin esquema
      "basura",
    ];
    for (const cabecera of cabeceras) {
      expect(checkInvokeAuth(cabecera)).toBe<InvokeAuthVerdict>("not_enforced");
    }
  });

  it("con la env en cadena vacía o puros espacios: sigue sin chequear nada", () => {
    // Una env que quedó en "" NO puede empezar a rechazar contra un secreto que nadie puede mandar.
    for (const vacia of ["", " ", "\n", "\t  \n"]) {
      enforce(vacia);
      expect(checkInvokeAuth(null)).toBe<InvokeAuthVerdict>("not_enforced");
      expect(checkInvokeAuth("lo-que-sea")).toBe<InvokeAuthVerdict>("not_enforced");
      vi.unstubAllEnvs();
    }
  });

  it("SIN la env no se loguea nada: un deploy inerte no puede ensuciar el log de ops", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(guardInvokeAuth(request(), "remit-corridor-fx")).toBeNull();
    expect(guardInvokeAuth(request({ authorization: "Basic x" }), "remit-corridor-fx")).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  //  CON LA ENV — el camino que pasa
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  it("credencial correcta → authorized", () => {
    enforce();
    expect(checkInvokeAuth(`${INVOKE_AUTH_SCHEME} ${SECRET}`)).toBe<InvokeAuthVerdict>("authorized");
  });

  it("el esquema es case-insensitive (RFC 7235) — el SECRETO no", () => {
    enforce();
    expect(checkInvokeAuth(`bearer ${SECRET}`)).toBe<InvokeAuthVerdict>("authorized");
    expect(checkInvokeAuth(`BEARER ${SECRET}`)).toBe<InvokeAuthVerdict>("authorized");
    // Cambiar UNA letra del secreto no lo hace pasar: la indulgencia es del esquema y sólo del esquema.
    expect(checkInvokeAuth(`${INVOKE_AUTH_SCHEME} ${SECRET.toUpperCase()}`)).toBe<InvokeAuthVerdict>(
      "credential_mismatch",
    );
  });

  it("el artefacto de pegado (espacios/saltos alrededor) no rechaza una credencial correcta", () => {
    enforce(`  ${SECRET}\n`); // la env pegada desde una terminal
    expect(checkInvokeAuth(`  ${INVOKE_AUTH_SCHEME}   ${SECRET}  `)).toBe<InvokeAuthVerdict>(
      "authorized",
    );
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  //  CON LA ENV — LOS TRES RECHAZOS, Y QUE SON TRES
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  it("no mandó credencial → credential_missing", () => {
    enforce();
    expect(checkInvokeAuth(null)).toBe<InvokeAuthVerdict>("credential_missing");
    expect(checkInvokeAuth("")).toBe<InvokeAuthVerdict>("credential_missing");
    expect(checkInvokeAuth("   ")).toBe<InvokeAuthVerdict>("credential_missing");
  });

  it("mandó una credencial mal formada → credential_malformed", () => {
    enforce();
    // El secreto CORRECTO pero pegado crudo, sin esquema. Es el error de configuración más probable
    // y no puede leerse como "el secreto no coincide": el secreto coincide, falta el prefijo.
    expect(checkInvokeAuth(SECRET)).toBe<InvokeAuthVerdict>("credential_malformed");
    expect(checkInvokeAuth(`Basic ${SECRET}`)).toBe<InvokeAuthVerdict>("credential_malformed");
    expect(checkInvokeAuth(INVOKE_AUTH_SCHEME)).toBe<InvokeAuthVerdict>("credential_malformed");
    expect(checkInvokeAuth(`${INVOKE_AUTH_SCHEME}   `)).toBe<InvokeAuthVerdict>(
      "credential_malformed",
    );
  });

  it("mandó una credencial bien formada que no coincide → credential_mismatch", () => {
    enforce();
    expect(checkInvokeAuth(`${INVOKE_AUTH_SCHEME} otro-secreto`)).toBe<InvokeAuthVerdict>(
      "credential_mismatch",
    );
    // Un prefijo del secreto correcto tampoco pasa (y por el mismo camino que cualquier otro valor).
    expect(checkInvokeAuth(`${INVOKE_AUTH_SCHEME} ${SECRET.slice(0, -1)}`)).toBe<InvokeAuthVerdict>(
      "credential_mismatch",
    );
  });

  it("los tres motivos son TRES valores distintos, no uno colapsado", () => {
    enforce();
    const motivos = new Set<InvokeAuthVerdict>([
      checkInvokeAuth(null),
      checkInvokeAuth(SECRET),
      checkInvokeAuth(`${INVOKE_AUTH_SCHEME} otro-secreto`),
    ]);
    expect(motivos.size).toBe(3);
    expect([...motivos].sort()).toEqual([
      "credential_malformed",
      "credential_mismatch",
      "credential_missing",
    ]);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  //  LA RESPUESTA HTTP
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  it("cada rechazo sale como un 401 con SU motivo en el body (chaski aplana el status, no el body)", async () => {
    enforce();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const casos: [string | undefined, string][] = [
      [undefined, "credential_missing"],
      [SECRET, "credential_malformed"],
      [`${INVOKE_AUTH_SCHEME} otro-secreto`, "credential_mismatch"],
    ];
    const motivos = new Set<string>();
    for (const [cabecera, esperado] of casos) {
      const res = guardInvokeAuth(
        request(cabecera === undefined ? {} : { [INVOKE_AUTH_HEADER]: cabecera }),
        "remit-corridor-fx",
      );
      expect(res).not.toBeNull();
      expect(res?.status).toBe(401);
      expect(res?.headers.get("WWW-Authenticate")).toBe(INVOKE_AUTH_SCHEME);
      const body = (await res?.json()) as { error: string; reason: string; hint: string };
      expect(body.error).toBe("unauthorized");
      expect(body.reason).toBe(esperado);
      expect(body.hint).toBeTruthy();
      motivos.add(body.reason);
    }
    expect(motivos.size).toBe(3); // los 3 llegan distintos al que depura, no sólo al log
  });

  it("ni el body ni el log ecoan NUNCA el secreto ni el token recibido", async () => {
    enforce();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tokenDelCaller = "token-del-caller-que-no-debe-aparecer";
    const res = guardInvokeAuth(
      request({ [INVOKE_AUTH_HEADER]: `${INVOKE_AUTH_SCHEME} ${tokenDelCaller}` }),
      "remit-cashout-payout",
    );
    const body = JSON.stringify(await res?.json());
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain(tokenDelCaller);
    const logueado = JSON.stringify(warn.mock.calls);
    expect(logueado).not.toContain(SECRET);
    expect(logueado).not.toContain(tokenDelCaller);
    expect(logueado).toContain("credential_mismatch"); // el código SÍ, el valor NO
    expect(logueado).toContain("remit-cashout-payout"); // qué agente, para ops
  });

  it("credencial correcta → el guard devuelve null y la ruta sigue", () => {
    enforce();
    expect(
      guardInvokeAuth(
        request({ [INVOKE_AUTH_HEADER]: `${INVOKE_AUTH_SCHEME} ${SECRET}` }),
        "remit-corridor-fx",
      ),
    ).toBeNull();
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  //  TIEMPO CONSTANTE
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  /**
   * Este test NO re-implementa la comparación: lee el fuente y exige que la ÚNICA función que
   * compara credenciales use `timingSafeEqual` y no contenga ningún operador de igualdad de JS.
   * Un `===` sobre un secreto corta en el primer byte distinto y es un oráculo de temporizado; medir
   * tiempos en CI para probarlo sería un test que falla según qué más corra en la máquina.
   */
  it("la comparación del secreto es en tiempo constante y no usa ningún ===", () => {
    const fuente = readFileSync(
      fileURLToPath(new URL("./invoke-auth.ts", import.meta.url)),
      "utf8",
    );
    const cuerpo = /function credentialMatches\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(fuente)?.[1];
    expect(cuerpo, "no se encontró credentialMatches: ¿la renombraron?").toBeDefined();
    expect(cuerpo).toContain("timingSafeEqual(");
    expect(cuerpo).not.toMatch(/[=!]==?/); // ni ===, ni !==, ni ==, ni !=
    // Y en NINGUNA parte del módulo la credencial se compara con un operador de igualdad contra
    // algo que no sea `null`. El `=== null` de "¿hay secreto configurado?" / "¿se pudo extraer el
    // token?" es un chequeo de PRESENCIA, no de valor, y no filtra ningún byte del secreto.
    expect(fuente).not.toMatch(/expectedCredential\s*[=!]==(?!\s*null\b)/);
    expect(fuente).not.toMatch(/[=!]==\s*expectedCredential/);
    expect(fuente).not.toMatch(/providedCredential\s*[=!]==(?!\s*null\b)/);
    expect(fuente).not.toMatch(/[=!]==\s*providedCredential/);
  });
});
