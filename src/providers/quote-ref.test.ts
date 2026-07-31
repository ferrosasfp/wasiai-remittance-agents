import { createHmac } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  QUOTE_BINDING_SECRET_UNSET_CODE,
  checkQuoteBinding,
  issueQuoteRef,
  resetEphemeralQuoteBindingSecretForTests,
  resolveQuoteBindingSecret,
} from "./quote-ref";

// Los guards de dinero de este repo se testean COMO UNIDAD, no sólo por su efecto (mismo criterio
// que `assertValidQuote` / `checkFreshness` / `assertAmountBelowMaximum`).

beforeEach(() => {
  resetEphemeralQuoteBindingSecretForTests();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetEphemeralQuoteBindingSecretForTests();
});

/** El módulo avisa por warn en cada `unresolvable`; silenciarlo mantiene legible la salida. */
function silenceWarn() {
  return vi.spyOn(console, "warn").mockImplementation(() => {});
}

describe("issueQuoteRef / checkQuoteBinding — el camino que SÍ ata", () => {
  it("el monto que se cotizó → bound", () => {
    expect(checkQuoteBinding(issueQuoteRef("fxmid-1", 100), 100)).toBe("bound");
  });

  it("montos con decimales sobreviven el round-trip (no hay redondeo a centavos)", () => {
    for (const amount of [0.01, 5, 100.5, 1234.56, 9999.99, 0.000001]) {
      expect(checkQuoteBinding(issueQuoteRef("fxmid-1", amount), amount)).toBe("bound");
    }
  });

  it("mismo monto, ids de proveedor distintos → referencias DISTINTAS (el id interno se conserva)", () => {
    // Si la referencia sólo llevara el monto, TODAS las cotizaciones de ese monto colapsarían en el
    // mismo `quoteId` — y `quote_id` es la columna con la que se identifica una cotización aguas abajo.
    expect(issueQuoteRef("fxmid-1", 100)).not.toBe(issueQuoteRef("fxmid-2", 100));
  });

  it("es determinística: mismo (id, monto) → MISMA referencia (no aporta unicidad propia)", () => {
    // El corolario del test anterior, y el que evita que alguien lea la firma como un identificador
    // único. La unicidad la pone el id del proveedor; acá no hay nonce ni timestamp.
    expect(issueQuoteRef("fxmid-1", 100)).toBe(issueQuoteRef("fxmid-1", 100));
  });

  it("un id interno con puntos y separadores adentro sigue resolviendo (payload base64url)", () => {
    // El id lo elige el partner: no podemos asumir su alfabeto.
    const ref = issueQuoteRef("tq.1|weird.id", 250);
    expect(checkQuoteBinding(ref, 250)).toBe("bound");
  });
});

describe("checkQuoteBinding — estado 2: amount_mismatch (SÍ se pudo resolver)", () => {
  it("🔴 EL ATAQUE: cotizo 100 y pido el desembolso por 1.000.000 con ESA referencia", () => {
    expect(checkQuoteBinding(issueQuoteRef("fxmid-1", 100), 1_000_000)).toBe("amount_mismatch");
  });

  it("pedir DE MENOS tampoco pasa: es igualdad, no un techo", () => {
    // Un `<=` dejaría pasar el desembolso parcial como efecto lateral, sin que nadie lo decidiera.
    expect(checkQuoteBinding(issueQuoteRef("fxmid-1", 100), 99.99)).toBe("amount_mismatch");
  });

  it("un centavo de más ya no coincide", () => {
    expect(checkQuoteBinding(issueQuoteRef("fxmid-1", 100), 100.01)).toBe("amount_mismatch");
  });
});

describe("checkQuoteBinding — estado 3: unresolvable ('no pude preguntar' ≠ 'no coinciden')", () => {
  it("el `quoteId` CRUDO de antes de este módulo NO resuelve (no es un mismatch de montos)", () => {
    silenceWarn();
    // Es la distinción entera: `fxmid-…` era una referencia legítima ayer, y hoy no se puede
    // resolver. Reportarla como "los montos no coinciden" sería afirmar algo que no verificamos.
    expect(checkQuoteBinding("fxmid-1785537458977", 100)).toBe("unresolvable");
    expect(checkQuoteBinding("q1", 100)).toBe("unresolvable");
    expect(checkQuoteBinding("", 100)).toBe("unresolvable");
  });

  it("referencia FIRMADA CON OTRO SECRETO → unresolvable (no falsificable)", () => {
    silenceWarn();
    vi.stubEnv("QUOTE_BINDING_SECRET", "secreto-A");
    const ref = issueQuoteRef("fxmid-1", 100);
    expect(checkQuoteBinding(ref, 100)).toBe("bound");
    vi.stubEnv("QUOTE_BINDING_SECRET", "secreto-B");
    expect(checkQuoteBinding(ref, 100)).toBe("unresolvable");
  });

  it("🔴 payload manipulado para inflar el monto → unresolvable, NO bound", () => {
    silenceWarn();
    vi.stubEnv("QUOTE_BINDING_SECRET", "s");
    const ref = issueQuoteRef("fxmid-1", 100);
    const parts = ref.split(".");
    // El atacante reescribe el monto de adentro conservando la firma original.
    const forged = Buffer.from("1000000|fxmid-1", "utf8").toString("base64url");
    expect(checkQuoteBinding(`${parts[0]}.${forged}.${parts[2]}`, 1_000_000)).toBe("unresolvable");
  });

  it("firma truncada / de otra longitud → unresolvable (nunca un throw de timingSafeEqual)", () => {
    silenceWarn();
    const parts = issueQuoteRef("fxmid-1", 100).split(".");
    expect(checkQuoteBinding(`${parts[0]}.${parts[1]}.AA`, 100)).toBe("unresolvable");
    expect(checkQuoteBinding(`${parts[0]}.${parts[1]}.`, 100)).toBe("unresolvable");
  });

  it("prefijo de versión ajeno → unresolvable aunque la firma sea nuestra", () => {
    silenceWarn();
    const parts = issueQuoteRef("fxmid-1", 100).split(".");
    expect(checkQuoteBinding(`q2.${parts[1]}.${parts[2]}`, 100)).toBe("unresolvable");
  });

  it("payload BIEN FIRMADO pero inservible (sin separador / monto no numérico) → unresolvable", () => {
    silenceWarn();
    vi.stubEnv("QUOTE_BINDING_SECRET", "s");
    // Estas ramas viven DESPUÉS de la verificación de firma, así que para alcanzarlas hay que firmar
    // de verdad. Se replica el formato acá a propósito: si alguien lo cambia, este test lo señala.
    const signed = (payload: string) => {
      const b64 = Buffer.from(payload, "utf8").toString("base64url");
      const sig = createHmac("sha256", "s")
        .update(`q1.${b64}`)
        .digest()
        .subarray(0, 16)
        .toString("base64url");
      return `q1.${b64}.${sig}`;
    };
    // control: el helper del test produce algo que el guard SÍ acepta (si no, los asserts de abajo
    // pasarían por la razón equivocada — un falso KILLED).
    expect(checkQuoteBinding(signed("100|fxmid-1"), 100)).toBe("bound");
    expect(checkQuoteBinding(signed("sin-separador"), 100)).toBe("unresolvable");
    expect(checkQuoteBinding(signed("abc|fxmid-1"), 100)).toBe("unresolvable"); // monto no numérico
    expect(checkQuoteBinding(signed("|fxmid-1"), 100)).toBe("unresolvable"); // monto vacío
    expect(checkQuoteBinding(signed("100|"), 100)).toBe("unresolvable"); // id interno vacío
    expect(checkQuoteBinding(signed("Infinity|fxmid-1"), 100)).toBe("unresolvable"); // no finito
  });

  it("el warn del unresolvable es VALUE-FREE: no lleva la referencia ni el monto", () => {
    const warn = silenceWarn();
    checkQuoteBinding("fxmid-1785537458977", 424242);
    const dump = JSON.stringify(warn.mock.calls);
    expect(dump).toContain("quote_ref_bad_format");
    expect(dump).not.toContain("1785537458977");
    expect(dump).not.toContain("424242");
  });
});

describe("resolveQuoteBindingSecret — config nuestra, no del caller", () => {
  it("PROD sin QUOTE_BINDING_SECRET → LANZA (nunca un default conocido)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("QUOTE_BINDING_SECRET", "");
    expect(() => resolveQuoteBindingSecret()).toThrow(
      new RegExp(QUOTE_BINDING_SECRET_UNSET_CODE),
    );
    // Y el throw NO se lava como "tu cotización está mal": llega a la ruta y sale por el 502.
    expect(() => checkQuoteBinding("q1.x.y", 100)).toThrow(
      new RegExp(QUOTE_BINDING_SECRET_UNSET_CODE),
    );
  });

  it("PROD sin secreto: el error es value-free (nombra la variable, no su contenido)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("QUOTE_BINDING_SECRET", "   "); // sólo-espacios = no seteada
    expect(() => resolveQuoteBindingSecret()).toThrow(/QUOTE_BINDING_SECRET/);
  });

  it("PROD CON secreto → no lanza y el ciclo emitir→verificar cierra", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("QUOTE_BINDING_SECRET", "un-secreto-de-produccion");
    expect(checkQuoteBinding(issueQuoteRef("fxmid-1", 100), 100)).toBe("bound");
  });

  it("fuera de prod sin env: secreto EFÍMERO estable dentro del proceso (no un valor conocido)", () => {
    vi.stubEnv("QUOTE_BINDING_SECRET", "");
    const a = resolveQuoteBindingSecret();
    const b = resolveQuoteBindingSecret();
    expect(a.equals(b)).toBe(true); // estable: emitir y verificar deben coincidir
    expect(a.length).toBe(32);
    // Y cambia entre procesos (se simula reseteando): una referencia vieja no se puede resolver.
    silenceWarn();
    const ref = issueQuoteRef("fxmid-1", 100);
    resetEphemeralQuoteBindingSecretForTests();
    expect(checkQuoteBinding(ref, 100)).toBe("unresolvable");
  });

  it("la env se lee EN CADA llamada (rotar el secreto surte efecto sin redeploy)", () => {
    vi.stubEnv("QUOTE_BINDING_SECRET", "uno");
    const primero = resolveQuoteBindingSecret().toString("utf8");
    vi.stubEnv("QUOTE_BINDING_SECRET", "dos");
    expect(resolveQuoteBindingSecret().toString("utf8")).not.toBe(primero);
  });
});
