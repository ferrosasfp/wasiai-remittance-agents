import { createHmac } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  QUOTE_BINDING_SECRET_UNSET_CODE,
  QUOTE_REF_UNUSABLE_EXPIRY_CODE,
  checkQuoteBinding,
  issueQuoteRef,
  resetEphemeralQuoteBindingSecretForTests,
  resolveQuoteBindingSecret,
} from "./quote-ref";

// Los guards de dinero de este repo se testean COMO UNIDAD, no sólo por su efecto (mismo criterio
// que `assertValidQuote` / `checkFreshness` / `assertAmountBelowMaximum`).

/** Instante ISO desplazado del ahora. Positivo = futuro (vigente); negativo = pasado (vencida). */
const isoIn = (ms: number): string => new Date(Date.now() + ms).toISOString();

/**
 * Vigencia para los tests que NO son sobre el vencimiento: la MISMA que promete `LiveMidFxProvider`
 * (`fx.ts`, `now + 10 min`). Se usa un valor con sentido y no un año 2099 para que estos tests
 * atraviesen el mismo chequeo que la producción, en vez de una vigencia tan absurda que el guard
 * quede fuera del recorrido.
 */
const VIGENTE_MS = 10 * 60_000;

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
  // 🔒 CANDADO DE NO-REGRESIÓN DEL VENCIMIENTO. Una cotización VIGENTE tiene que seguir pasando: un
  // guard de vencimiento que rechaza también lo vigente no protege nada, corta el money-path entero.
  // Es el test que muere si alguien invierte el comparador (ver el bloque de mutación al pie).
  it("el monto que se cotizó, con la cotización VIGENTE → bound", () => {
    expect(checkQuoteBinding(issueQuoteRef("fxmid-1", 100, isoIn(VIGENTE_MS)), 100)).toBe("bound");
  });

  it("montos con decimales sobreviven el round-trip (no hay redondeo a centavos)", () => {
    for (const amount of [0.01, 5, 100.5, 1234.56, 9999.99, 0.000001]) {
      expect(checkQuoteBinding(issueQuoteRef("fxmid-1", amount, isoIn(VIGENTE_MS)), amount)).toBe(
        "bound",
      );
    }
  });

  it("mismo monto, ids de proveedor distintos → referencias DISTINTAS (el id interno se conserva)", () => {
    // Si la referencia sólo llevara el monto, TODAS las cotizaciones de ese monto colapsarían en el
    // mismo `quoteId` — y `quote_id` es la columna con la que se identifica una cotización aguas abajo.
    const exp = isoIn(VIGENTE_MS);
    expect(issueQuoteRef("fxmid-1", 100, exp)).not.toBe(issueQuoteRef("fxmid-2", 100, exp));
  });

  it("es determinística: mismo (id, monto, vencimiento) → MISMA referencia (no aporta unicidad propia)", () => {
    // El corolario del test anterior, y el que evita que alguien lea la firma como un identificador
    // único. La unicidad la pone el id del proveedor; acá no hay nonce. El vencimiento entró al
    // payload pero NO es entropía: se le pasa el mismo instante y la referencia es la misma.
    const exp = isoIn(VIGENTE_MS);
    expect(issueQuoteRef("fxmid-1", 100, exp)).toBe(issueQuoteRef("fxmid-1", 100, exp));
  });

  it("un id interno con puntos y separadores adentro sigue resolviendo (payload base64url)", () => {
    // El id lo elige el partner: no podemos asumir su alfabeto. Con el vencimiento adentro el
    // payload pasó a tener TRES campos, y el id sigue siendo el último: se corta un número fijo de
    // veces por la izquierda, así que un `|` en el id no le roba el lugar a ningún campo.
    const ref = issueQuoteRef("tq.1|weird.id", 250, isoIn(VIGENTE_MS));
    expect(checkQuoteBinding(ref, 250)).toBe("bound");
  });
});

describe("checkQuoteBinding — estado 2: amount_mismatch (SÍ se pudo resolver)", () => {
  it("🔴 EL ATAQUE: cotizo 100 y pido el desembolso por 1.000.000 con ESA referencia", () => {
    expect(checkQuoteBinding(issueQuoteRef("fxmid-1", 100, isoIn(VIGENTE_MS)), 1_000_000)).toBe(
      "amount_mismatch",
    );
  });

  it("pedir DE MENOS tampoco pasa: es igualdad, no un techo", () => {
    // Un `<=` dejaría pasar el desembolso parcial como efecto lateral, sin que nadie lo decidiera.
    expect(checkQuoteBinding(issueQuoteRef("fxmid-1", 100, isoIn(VIGENTE_MS)), 99.99)).toBe(
      "amount_mismatch",
    );
  });

  it("un centavo de más ya no coincide", () => {
    expect(checkQuoteBinding(issueQuoteRef("fxmid-1", 100, isoIn(VIGENTE_MS)), 100.01)).toBe(
      "amount_mismatch",
    );
  });
});

// ── EL VENCIMIENTO, que es lo que esta HU vino a arreglar ──────────────────────────────────────
// Medido en producción antes de este cambio: una cotización con `expiresAt` 10:46:03.863Z, invocada
// a las 10:46:53.965Z (50 s VENCIDA), devolvía `executed:true`. La vigencia sólo la chequeaba chaski
// en el dominio del navegador, y ese chequeo se saltea llamando al agente directo.
describe("checkQuoteBinding — estado 3: expired (la cotización venció)", () => {
  it("🔴 EL ATAQUE MEDIDO: cotización vencida hace 50 s, con el monto CORRECTO → expired", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // El monto es el cotizado a propósito: sin el chequeo de vencimiento esto da `bound` y
    // desembolsa. Es exactamente la corrida de producción, reproducida.
    const ref = issueQuoteRef("fxmid-1", 100, isoIn(-50_000));
    expect(checkQuoteBinding(ref, 100)).toBe("expired");
  });

  it("vencida Y con el monto cambiado → gana `expired`: ninguna corrección del monto la salva", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // Reportar `amount_mismatch` acá mandaría a quien integra a arreglar el campo equivocado: aunque
    // mandara el monto exacto, la referencia seguiría muerta.
    const ref = issueQuoteRef("fxmid-1", 100, isoIn(-50_000));
    expect(checkQuoteBinding(ref, 1_000_000)).toBe("expired");
  });

  it("`expired` NO es `unresolvable`: la referencia se resolvió, la respuesta es que ya no vale", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const ref = issueQuoteRef("fxmid-1", 100, isoIn(-1));
    // La distinción entera: los dos bloquean, pero uno se corrige volviendo a cotizar y el otro
    // significa que no pudimos ni preguntar.
    expect(checkQuoteBinding(ref, 100)).not.toBe("unresolvable");
    expect(checkQuoteBinding(ref, 100)).toBe("expired");
  });

  it("el borde: vence AHORA MISMO → todavía vale (la vigencia es HASTA `expiresAt`)", () => {
    // `>` y no `>=`. Se congela el reloj para que el borde sea el borde y no una carrera.
    vi.useFakeTimers();
    try {
      const now = new Date("2026-08-04T10:46:03.863Z");
      vi.setSystemTime(now);
      const ref = issueQuoteRef("fxmid-1", 100, now.toISOString());
      expect(checkQuoteBinding(ref, 100)).toBe("bound");
      // Un milisegundo después, ya no.
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.setSystemTime(new Date(now.getTime() + 1));
      expect(checkQuoteBinding(ref, 100)).toBe("expired");
    } finally {
      vi.useRealTimers();
    }
  });

  it("la MISMA referencia pasa vigente y deja de pasar al vencer (el reloj es lo que decide)", () => {
    // Prueba que el veredicto depende del TIEMPO y no de algo del payload: es la misma referencia,
    // byte a byte, en los dos asserts.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-04T10:40:00.000Z"));
      const ref = issueQuoteRef("fxmid-1", 100, "2026-08-04T10:50:00.000Z");
      expect(checkQuoteBinding(ref, 100)).toBe("bound");
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.setSystemTime(new Date("2026-08-04T10:50:00.001Z"));
      expect(checkQuoteBinding(ref, 100)).toBe("expired");
    } finally {
      vi.useRealTimers();
    }
  });

  it("el warn del vencimiento es VALUE-FREE: no lleva la referencia, el monto ni el instante", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const expiresAt = isoIn(-50_000);
    checkQuoteBinding(issueQuoteRef("fxmid-1785537458977", 424242, expiresAt), 424242);
    const dump = JSON.stringify(warn.mock.calls);
    expect(dump).toContain("quote_ref_expired");
    expect(dump).not.toContain("1785537458977");
    expect(dump).not.toContain("424242");
    expect(dump).not.toContain(expiresAt);
    expect(dump).not.toContain(String(Date.parse(expiresAt)));
  });
});

// ── EMITIR: no se puede emitir una referencia sin vigencia ─────────────────────────────────────
describe("issueQuoteRef — una referencia SIN vencimiento utilizable no se emite", () => {
  it("`expiresAt` vacío (el `?? \"\"` del camino del socio) → LANZA, no emite una referencia eterna", () => {
    // `fx.ts` mapea `expiresAt: String(d.expiresAt ?? "")`: si el partner no lo manda, llega "". El
    // día que se active `TRANSFI_ADAPTER_READY`, eso tiene que cortar ruidoso (el route lo mapea a
    // 502) y NO emitir una referencia que nadie pueda vencer.
    expect(() => issueQuoteRef("tq-1", 100, "")).toThrow(
      new RegExp(QUOTE_REF_UNUSABLE_EXPIRY_CODE),
    );
  });

  it("`expiresAt` ilegible → LANZA, y el error es value-free (no ecoa lo que mandó el partner)", () => {
    const captured = ((): Error | null => {
      try {
        issueQuoteRef("tq-1", 100, "el-martes-que-viene");
        return null;
      } catch (err) {
        return err as Error;
      }
    })();
    expect(captured).not.toBeNull();
    expect(captured?.message).toContain(QUOTE_REF_UNUSABLE_EXPIRY_CODE);
    expect(captured?.message).not.toContain("el-martes-que-viene");
  });
});

describe("checkQuoteBinding — estado 4: unresolvable ('no pude preguntar' ≠ 'no coinciden')", () => {
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
    const ref = issueQuoteRef("fxmid-1", 100, isoIn(VIGENTE_MS));
    expect(checkQuoteBinding(ref, 100)).toBe("bound");
    vi.stubEnv("QUOTE_BINDING_SECRET", "secreto-B");
    expect(checkQuoteBinding(ref, 100)).toBe("unresolvable");
  });

  it("🔴 payload manipulado para inflar el monto → unresolvable, NO bound", () => {
    silenceWarn();
    vi.stubEnv("QUOTE_BINDING_SECRET", "s");
    const ref = issueQuoteRef("fxmid-1", 100, isoIn(VIGENTE_MS));
    const parts = ref.split(".");
    // El atacante reescribe el monto de adentro conservando la firma original.
    const forged = Buffer.from(
      `1000000|${Date.now() + VIGENTE_MS}|fxmid-1`,
      "utf8",
    ).toString("base64url");
    expect(checkQuoteBinding(`${parts[0]}.${forged}.${parts[2]}`, 1_000_000)).toBe("unresolvable");
  });

  it("🔴 payload manipulado para ESTIRAR EL VENCIMIENTO → unresolvable, NO bound", () => {
    // La otra mitad del ataque, ahora que el vencimiento vive adentro: quien reescriba el instante
    // para revivir una cotización muerta rompe la firma, igual que quien reescribe el monto.
    silenceWarn();
    vi.stubEnv("QUOTE_BINDING_SECRET", "s");
    const parts = issueQuoteRef("fxmid-1", 100, isoIn(-50_000)).split(".");
    const revivido = Buffer.from(
      `100|${Date.now() + VIGENTE_MS}|fxmid-1`,
      "utf8",
    ).toString("base64url");
    expect(checkQuoteBinding(`${parts[0]}.${revivido}.${parts[2]}`, 100)).toBe("unresolvable");
  });

  it("firma truncada / de otra longitud → unresolvable (nunca un throw de timingSafeEqual)", () => {
    silenceWarn();
    const parts = issueQuoteRef("fxmid-1", 100, isoIn(VIGENTE_MS)).split(".");
    expect(checkQuoteBinding(`${parts[0]}.${parts[1]}.AA`, 100)).toBe("unresolvable");
    expect(checkQuoteBinding(`${parts[0]}.${parts[1]}.`, 100)).toBe("unresolvable");
  });

  it("prefijo de versión ajeno → unresolvable aunque la firma sea nuestra", () => {
    silenceWarn();
    // `q3` (y no `q2`, que hoy ES la versión viva): la etiqueta tiene que ser una que no emitimos.
    const parts = issueQuoteRef("fxmid-1", 100, isoIn(VIGENTE_MS)).split(".");
    expect(checkQuoteBinding(`q3.${parts[1]}.${parts[2]}`, 100)).toBe("unresolvable");
  });

  // 🔴 LA DECISIÓN DE COMPATIBILIDAD, ESCRITA COMO TEST Y NO COMO PÁRRAFO.
  // Las referencias `q1` (las que circulaban SIN vencimiento adentro) se RECHAZAN, incluso firmadas
  // con el secreto vigente y con el monto correcto. No hay ventana de gracia: una `q1` no dice hasta
  // cuándo valía, así que aceptarla es exactamente el agujero que este cambio cierra, y nada
  // distingue una emitida hace 30 segundos de una cosechada hace tres semanas. El costo está acotado
  // por la propia cotización (10 min de vigencia en `fx.ts`), una sola vez, en el deploy.
  it("🔴 una referencia `q1` legítima (sin vencimiento adentro) NO se acepta: unresolvable", () => {
    silenceWarn();
    vi.stubEnv("QUOTE_BINDING_SECRET", "s");
    // Se replica acá el formato VIEJO —dos campos, versión `q1`— porque ya no se puede emitir con el
    // código de producción: es justamente lo que dejó de existir.
    const b64 = Buffer.from("100|fxmid-1", "utf8").toString("base64url");
    const sig = createHmac("sha256", "s")
      .update(`q1.${b64}`)
      .digest()
      .subarray(0, 16)
      .toString("base64url");
    expect(checkQuoteBinding(`q1.${b64}.${sig}`, 100)).toBe("unresolvable");
  });

  it("una `q1` se distingue en el LOG de una referencia cualquiera (la purga del deploy ≠ un ataque)", () => {
    const warn = silenceWarn();
    vi.stubEnv("QUOTE_BINDING_SECRET", "s");
    const b64 = Buffer.from("100|fxmid-1", "utf8").toString("base64url");
    const sig = createHmac("sha256", "s")
      .update(`q1.${b64}`)
      .digest()
      .subarray(0, 16)
      .toString("base64url");
    checkQuoteBinding(`q1.${b64}.${sig}`, 100);
    const dump = JSON.stringify(warn.mock.calls);
    // Rechaza igual que cualquier otra, pero ops puede ver que es la purga esperada del deploy —que
    // se apaga sola en la vigencia de una cotización— y no un intento de falsificación.
    expect(dump).toContain("quote_ref_legacy_version");
    expect(dump).not.toContain("quote_ref_bad_format");
  });

  it("payload BIEN FIRMADO pero inservible (campos faltantes / no numéricos) → unresolvable", () => {
    silenceWarn();
    vi.stubEnv("QUOTE_BINDING_SECRET", "s");
    // Estas ramas viven DESPUÉS de la verificación de firma, así que para alcanzarlas hay que firmar
    // de verdad. Se replica el formato acá a propósito: si alguien lo cambia, este test lo señala.
    const signed = (payload: string) => {
      const b64 = Buffer.from(payload, "utf8").toString("base64url");
      const sig = createHmac("sha256", "s")
        .update(`q2.${b64}`)
        .digest()
        .subarray(0, 16)
        .toString("base64url");
      return `q2.${b64}.${sig}`;
    };
    const vence = String(Date.now() + VIGENTE_MS);
    // control: el helper del test produce algo que el guard SÍ acepta (si no, los asserts de abajo
    // pasarían por la razón equivocada — un falso KILLED).
    expect(checkQuoteBinding(signed(`100|${vence}|fxmid-1`), 100)).toBe("bound");
    expect(checkQuoteBinding(signed("sin-separador"), 100)).toBe("unresolvable");
    expect(checkQuoteBinding(signed(`100|${vence}`), 100)).toBe("unresolvable"); // falta el id
    expect(checkQuoteBinding(signed(`abc|${vence}|fxmid-1`), 100)).toBe("unresolvable"); // monto no numérico
    expect(checkQuoteBinding(signed(`|${vence}|fxmid-1`), 100)).toBe("unresolvable"); // monto vacío
    expect(checkQuoteBinding(signed(`100|${vence}|`), 100)).toBe("unresolvable"); // id interno vacío
    expect(checkQuoteBinding(signed(`100||fxmid-1`), 100)).toBe("unresolvable"); // vencimiento vacío
    expect(checkQuoteBinding(signed("100|el-martes|fxmid-1"), 100)).toBe("unresolvable"); // no numérico
    expect(checkQuoteBinding(signed(`Infinity|${vence}|fxmid-1`), 100)).toBe("unresolvable"); // no finito
    expect(checkQuoteBinding(signed("100|Infinity|fxmid-1"), 100)).toBe("unresolvable"); // vencimiento no finito
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
    // La etiqueta tiene que ser la versión VIVA (`q2`): con una ajena el guard corta en el formato
    // y nunca llega a pedir el secreto — el test pasaría por la razón equivocada.
    expect(() => checkQuoteBinding("q2.x.y", 100)).toThrow(
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
    expect(checkQuoteBinding(issueQuoteRef("fxmid-1", 100, isoIn(VIGENTE_MS)), 100)).toBe("bound");
  });

  it("fuera de prod sin env: secreto EFÍMERO estable dentro del proceso (no un valor conocido)", () => {
    vi.stubEnv("QUOTE_BINDING_SECRET", "");
    const a = resolveQuoteBindingSecret();
    const b = resolveQuoteBindingSecret();
    expect(a.equals(b)).toBe(true); // estable: emitir y verificar deben coincidir
    expect(a.length).toBe(32);
    // Y cambia entre procesos (se simula reseteando): una referencia vieja no se puede resolver.
    silenceWarn();
    const ref = issueQuoteRef("fxmid-1", 100, isoIn(VIGENTE_MS));
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
