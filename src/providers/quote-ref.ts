// Referencia de cotización AUTENTICADA — ata el monto del desembolso al monto que se cotizó.
//
// ⚠️ QUÉ CAMBIÓ Y POR QUÉ (medido el 2026-07-31, antes de este módulo):
// `remit-cashout-payout` recibía `quoteId` y `amountUsd` como DOS campos independientes del caller y
// no leía nunca la cotización que decía estar honrando. No existía —ni acá, ni en el gateway, ni en
// el contrato de TransFi— nada que atara uno al otro. Medido ejecutando:
//   · cotización de 100 USD (`fxmid-1785537458977`, S/ 329,84) + payout por 1.000.000 con ESE mismo
//     `quoteId` ⇒ `executed:true`.
//   · `quoteId:"no-existo-jamas-cotice"` (jamás emitido por nadie) + 999.999.999 ⇒ `executed:true`.
//   · con el adapter REAL activo, la orden salía a `POST /v3/orders` con `source.amount: 1000000`
//     y SIN NINGÚN campo `quoteId`: el partner nunca ve la cotización, así que no había nada aguas
//     abajo que pudiera atarla. No era una omisión de este repo: el contrato off-ramp de TransFi no
//     tiene entidad "quote" (doc/transfi-offramp-api-spec.md).
// Consecuencia directa: el techo `FX_MAX_SEND_USD` que se acababa de poner en la cotización NO
// alcanzaba al desembolso. Se podía cotizar sólo hasta 10.000 y desembolsar por un millón.
//
// 🔴 POR QUÉ LA REFERENCIA VA FIRMADA, y no es un id opaco más un chequeo de texto plano:
// el agente FX es SIN ESTADO (`fxmid-${Date.now()}`) y este repo no tiene almacenamiento de ningún
// tipo — cero dependencias de DB o caché compartida. Un `quoteId` opaco no lo puede resolver NADIE,
// ni siquiera nosotros. Y meter el monto en claro dentro del id no serviría para heredar el techo:
// el atacante se fabricaría `...-1000000` y volvería a estar donde estaba. La única forma de que el
// desembolso herede un límite que se aplicó al cotizar es que el monto viaje AUTENTICADO.
//
// 🔴 LO QUE ESTE MÓDULO **NO** HACE (leer antes de construir algo encima):
//  · NO es un quote-lock. `expiresAt` NO viaja en la referencia ni se verifica en ningún lado: una
//    referencia válida sirve para siempre. El vencimiento sigue sin enforcement, igual que antes.
//  · NO ata la TASA. Ata el monto en USD y nada más. Nada impide desembolsar dos veces con la misma
//    referencia, ni desembolsarle a otro beneficiario.
//  · NO reemplaza la atestación de settlement de chaski-v2 (que ata el monto al USDC que entró
//    ON-CHAIN). Son controles distintos: éste dice "es el monto que cotizamos", aquél dice "es el
//    monto que efectivamente llegó".

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Prefijo de versión de la referencia. Va DENTRO del material firmado: sin eso, el día que exista un
 * `q2` con otro significado de payload, una referencia vieja se podría re-etiquetar sin invalidar la
 * firma. Es el mismo criterio con el que `transfi-env.ts` no acepta un host sin marca.
 */
const QUOTE_REF_VERSION = "q1";

/** Bytes de HMAC-SHA256 que se conservan. 16 = 128 bits: sobra contra falsificación y el id queda corto. */
const SIGNATURE_BYTES = 16;

/**
 * Separador entre el monto y el id interno del proveedor DENTRO del payload. No puede aparecer en un
 * base64url (alfabeto `A-Za-z0-9-_`), así que el `.` que separa los tres segmentos tampoco colisiona.
 */
const PAYLOAD_SEPARATOR = "|";

/** Código de error de configuración. Es NUESTRO problema, no del caller — ver el docstring de abajo. */
export const QUOTE_BINDING_SECRET_UNSET_CODE = "quote_binding_secret_unset";

/**
 * Secreto efímero por proceso, para dev/CI. Se crea perezosamente (nunca al importar: la regla
 * call-time de `resolveFxConfig()` vale igual acá) y se guarda, porque emitir y verificar DEBEN usar
 * el mismo material dentro de un proceso.
 */
let ephemeralSecret: Buffer | null = null;

/**
 * Resuelve el secreto de firma. **LANZA** si falta en producción.
 *
 * En producción no hay default y no hay escape: un secreto con valor conocido es un secreto que
 * cualquiera puede usar para firmar, y toda la propiedad que este módulo aporta es que el caller NO
 * pueda fabricar una referencia. Fuera de producción, si la env no está se usa un secreto ALEATORIO
 * por proceso: no es un debilitamiento (es menos falsificable que uno fijo), sólo significa que una
 * referencia emitida por otro proceso o antes de un reinicio no se va a poder resolver.
 *
 * 🔴 QUE ESTO LANCE **NO** ES EL TERCER ESTADO. Un secreto ausente es un defecto de NUESTRA
 * configuración y tiene que salir por la puerta de los 502, igual que `didit_adapter_not_ready`
 * (CD-12); `unresolvable` describe una referencia DEL CALLER que no se puede resolver y sale por la
 * puerta de los 200-blocked. Colapsarlos le diría al caller "tu cotización está mal" cuando el que
 * está mal es el deploy — y el que integra no tendría forma de saber que reintentar no sirve.
 */
export function resolveQuoteBindingSecret(): Buffer {
  // Call-time, en CADA emisión y CADA verificación (AC-9 / DT-8 de `fx-config.ts`): rotar el secreto
  // surte efecto en la próxima cotización, sin redeploy.
  const raw = process.env.QUOTE_BINDING_SECRET;
  if (raw !== undefined && raw.trim() !== "") return Buffer.from(raw, "utf8");
  if (process.env.NODE_ENV === "production") {
    // Value-free: sólo el nombre de la variable, nunca su contenido (patrón `transfi_usdc_network_unset`).
    throw new Error(
      `${QUOTE_BINDING_SECRET_UNSET_CODE}: seteá QUOTE_BINDING_SECRET antes de cotizar o desembolsar.`,
    );
  }
  if (ephemeralSecret === null) ephemeralSecret = randomBytes(32);
  return ephemeralSecret;
}

/** Sólo para tests: olvida el secreto efímero. NO afecta el camino con `QUOTE_BINDING_SECRET` seteada. */
export function resetEphemeralQuoteBindingSecretForTests(): void {
  ephemeralSecret = null;
}

/** `String(n)` es la representación más corta que ROUND-TRIPEA el double: `Number(String(n)) === n`. */
function encodeAmount(amountUsd: number): string {
  return String(amountUsd);
}

function sign(payloadB64: string): string {
  return createHmac("sha256", resolveQuoteBindingSecret())
    .update(`${QUOTE_REF_VERSION}.${payloadB64}`)
    .digest()
    .subarray(0, SIGNATURE_BYTES)
    .toString("base64url");
}

/**
 * Emite la referencia autenticada que reemplaza al `quoteId` crudo en la salida del agente FX.
 *
 * `innerQuoteId` es el id que produjo el PROVEEDOR (el `fxmid-…` nuestro o el id real del partner):
 * se conserva adentro para no perder trazabilidad, y porque sin él TODAS las cotizaciones del mismo
 * monto colapsarían en la MISMA referencia — y `quoteId` es la columna con la que se identifica una
 * cotización aguas abajo.
 *
 * ⚠️ La referencia es DETERMINÍSTICA en (id del proveedor, monto): hereda la unicidad del id del
 * proveedor y nada más. Hoy `fxmid-${Date.now()}` tiene resolución de milisegundo, así que dos
 * cotizaciones del mismo monto en el mismo milisegundo siguen dando el mismo `quoteId` — igual que
 * antes de este módulo. Está pinneado en `agents/corridor-fx.test.ts` para que nadie le atribuya a
 * la firma una unicidad que no aporta.
 *
 * Se llama desde `runCorridorFx` (el núcleo) y NO desde los proveedores, por la misma razón por la
 * que el piso y el techo del monto viven en el núcleo: ahí cubre a los dos proveedores y no
 * desaparece el día que se active el adapter del socio.
 */
export function issueQuoteRef(innerQuoteId: string, amountUsd: number): string {
  const payloadB64 = Buffer.from(
    `${encodeAmount(amountUsd)}${PAYLOAD_SEPARATOR}${innerQuoteId}`,
    "utf8",
  ).toString("base64url");
  return `${QUOTE_REF_VERSION}.${payloadB64}.${sign(payloadB64)}`;
}

/**
 * Veredicto del binding. **TRES estados, no un booleano**, y la distinción es el punto:
 *  · `bound`            — la referencia se resolvió y el monto pedido es el que se cotizó.
 *  · `amount_mismatch`  — se resolvió, y el monto NO es el que se cotizó. Es una respuesta.
 *  · `unresolvable`     — NO se pudo resolver (formato, firma o payload). No es "los montos no
 *                         coinciden": es "no pude preguntar". Un booleano los colapsaría en `false`
 *                         y perdería justo la información con la que ops distingue una integración
 *                         rota (masivo y parejo) de una falsificación (puntual).
 *
 * Se exporta el TIPO además de la función, mismo criterio que `FreshnessVerdict` en `fx.ts`: los
 * guards de dinero de este repo se testean como unidad, no sólo por su efecto.
 */
export type QuoteBindingVerdict = "bound" | "amount_mismatch" | "unresolvable";

/** Warn value-free: SÓLO el código de rama. Nunca la referencia, el monto ni nada del caller. */
function rejectRef(code: string): void {
  console.warn("[remit-quote-ref] quote_ref_unresolvable", { code });
}

/**
 * Resuelve la referencia y la compara contra el monto pedido. Es el guard de POLÍTICA que ata el
 * desembolso a la cotización; se aplica en el núcleo del agente de payout.
 *
 * La comparación es IGUALDAD, no "menor o igual": honrar una cotización significa el mismo monto.
 * Un desembolso parcial contra una cotización es otra decisión de producto y hoy no existe; si algún
 * día existe, tiene que ser una rama explícita y no el efecto lateral de un `<=`.
 *
 * ⚠️ La verificación de la FIRMA va ANTES de decodificar el payload, a propósito: así un caller no
 * puede usar el decodificador como oráculo con referencias que nunca firmamos.
 *
 * Exportada para testearla directo, mismo criterio que `assertValidQuote` y `checkFreshness`.
 */
export function checkQuoteBinding(quoteRef: string, amountUsd: number): QuoteBindingVerdict {
  const parts = quoteRef.split(".");
  if (parts.length !== 3 || parts[0] !== QUOTE_REF_VERSION) {
    // Incluye el caso del `quoteId` CRUDO de antes de este módulo (`fxmid-…`, `q1`, el id del
    // partner): no lo emitimos nosotros con esta forma ⇒ no se puede resolver ⇒ no se desembolsa.
    rejectRef("quote_ref_bad_format");
    return "unresolvable";
  }
  const payloadB64 = parts[1] as string;
  const providedSig = parts[2] as string;
  const expectedSig = sign(payloadB64);
  // `timingSafeEqual` exige longitudes iguales; una longitud distinta ya es un no-match y no revela
  // nada del secreto (la longitud de nuestra firma es fija y pública).
  const provided = Buffer.from(providedSig, "base64url");
  const expected = Buffer.from(expectedSig, "base64url");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    rejectRef("quote_ref_bad_signature");
    return "unresolvable";
  }
  const payload = Buffer.from(payloadB64, "base64url").toString("utf8");
  const separatorAt = payload.indexOf(PAYLOAD_SEPARATOR);
  // El id interno puede contener cualquier cosa (lo elige el partner), así que se corta en el PRIMER
  // separador: el monto es el prefijo y el resto es el id, entero.
  if (separatorAt <= 0 || separatorAt === payload.length - 1) {
    rejectRef("quote_ref_bad_payload");
    return "unresolvable";
  }
  const quotedAmount = Number(payload.slice(0, separatorAt));
  if (!Number.isFinite(quotedAmount)) {
    rejectRef("quote_ref_bad_payload");
    return "unresolvable";
  }
  // `!(a === b)` y no `a !== b` daría lo mismo acá, pero el orden importa: se compara contra el monto
  // ya parseado por Zod (`z.number().positive()`, que rechaza NaN), y un NaN que llegara igual caería
  // en `amount_mismatch` porque `NaN === NaN` es false. Fail-closed por construcción.
  return quotedAmount === amountUsd ? "bound" : "amount_mismatch";
}
