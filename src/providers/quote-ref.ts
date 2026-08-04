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
// ⚠️ SEGUNDA MEDICIÓN (2026-08-04) — LA REFERENCIA NO VENCÍA:
// el payload firmado llevaba el monto y el id del proveedor, y NADA MÁS. `checkQuoteBinding` no
// miraba el reloj porque no tenía qué mirar. Medido en producción:
//   · una cotización con `expiresAt` 10:46:03.863Z, invocada a las 10:46:53.965Z (50 s VENCIDA)
//     ⇒ `executed:true`.
// La vigencia de 10 minutos que la cotización PROMETE (`fx.ts`) la chequeaba únicamente chaski, en
// el dominio del navegador (`chaski-v3/src/domain/remittance.ts`), y ese chequeo se saltea llamando
// al agente directo. Del lado servidor no la hacía cumplir nadie. Ahora el instante de vencimiento
// viaja DENTRO del material firmado y `checkQuoteBinding` lo hace cumplir: una referencia vencida es
// su propio veredicto (`expired`), no un mismatch ni un "no pude resolver".
//
// 🔴 LO QUE ESTE MÓDULO **NO** HACE (leer antes de construir algo encima):
//  · NO es de USO ÚNICO. La misma referencia vigente sirve para N desembolsos cambiando sólo la
//    `idempotencyKey` (medido: 1 cotización de 10.000 USD ⇒ 3 desembolsos de 10.000). El techo
//    `FX_MAX_SEND_USD` es POR LLAMADA, no por cotización ni por período. Marcar una referencia como
//    consumida exige ALMACENAMIENTO compartido, y este repo no tiene ninguno (cero DB, cero caché
//    entre instancias) — por eso queda como DEUDA EXPLÍCITA y no como un olvido: ver la sección
//    "DEUDA" al pie de este encabezado. La ventana de vencimiento ACOTA el daño (de "para siempre"
//    a "lo que dure la cotización"), NO lo elimina.
//  · NO ata la TASA. Ata el monto en USD y el instante de vencimiento. Nada impide desembolsarle a
//    otro beneficiario con la misma referencia.
//  · NO reemplaza la atestación de settlement de chaski-v2 (que ata el monto al USDC que entró
//    ON-CHAIN). Son controles distintos: éste dice "es el monto que cotizamos", aquél dice "es el
//    monto que efectivamente llegó".
//
// 🔴 DEUDA — USO ÚNICO (no entra en este cambio, y la razón importa):
// para que una referencia sirva UNA sola vez hay que RECORDAR cuáles ya se usaron, y recordar es
// estado. Las tres formas de tenerlo son un store compartido (Redis/DB, que este repo no tiene y
// cuya caída habría que decidir si abre o cierra el money-path), delegarlo en la idempotencia del
// partner (que hoy ni siquiera ve la cotización — `doc/transfi-offramp-api-spec.md`: TransFi no
// tiene entidad "quote"), o un nonce en la referencia (que no alcanza: sin dónde anotarlo, nadie
// sabe si ya se gastó). Ninguna es un cambio local, y meter media —por ejemplo un Set en memoria—
// sería PEOR que no tener nada: en un deploy multi-instancia daría "ya usada" o "nunca usada" según
// a qué instancia le toque, y el modo de falla silencioso sería el que deja pasar.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Prefijo de versión de la referencia. Va DENTRO del material firmado: sin eso, el día que exista un
 * `q2` con otro significado de payload, una referencia vieja se podría re-etiquetar sin invalidar la
 * firma. Es el mismo criterio con el que `transfi-env.ts` no acepta un host sin marca.
 *
 * 🔴 `q1` → `q2` PORQUE EL PAYLOAD CAMBIÓ DE SIGNIFICADO (2026-08-04): eran dos campos
 * (`monto|id`), ahora son tres (`monto|vencimiento|id`). Ése es exactamente el escenario para el que
 * se escribió el párrafo de arriba, y el bump NO es cosmético: sin él, una referencia `q1` legítima
 * cuyo id interno empiece con dígitos y contenga el separador —el id lo elige el partner y SÍ puede
 * traer `|`, está pinneado en un test— se re-leería como `monto|vencimiento|id` y sus dígitos se
 * interpretarían como un instante de vencimiento que nadie firmó con ese sentido. Con el bump, toda
 * referencia `q1` es irresoluble POR CONSTRUCCIÓN (la versión está dentro del material firmado), y
 * no por la suerte de que el segundo campo no parezca una fecha.
 *
 * ⚠️ COMPATIBILIDAD — LAS `q1` EN VUELO SE RECHAZAN, Y ES LA ÚNICA OPCIÓN HONESTA. El costo está
 * ACOTADO POR LA PROPIA COTIZACIÓN: una `q1` todavía honrable es, por definición, más nueva que la
 * vigencia que la cotización promete (10 min en `fx.ts`), así que el peor caso es esa ventana, una
 * sola vez, en el deploy — la misma que ya rompe cualquier rotación de `QUOTE_BINDING_SECRET`, y la
 * misma que el chequeo nuevo iba a imponer diez minutos después de todas formas. La corrección para
 * el caller es "volvé a cotizar", que es idéntica a la de una cotización vencida.
 * Aceptarlas en cambio NO tiene ventana: la referencia es determinística y sin estado, así que nada
 * distingue una `q1` emitida hace 30 segundos de una cosechada hace tres semanas — esa
 * indistinguibilidad ES el bug. No existe un punto medio seguro, porque el dato que haría falta para
 * ser indulgente sin riesgo es justamente el que a `q1` le falta.
 */
const QUOTE_REF_VERSION = "q2";

/**
 * La versión anterior, SÓLO para poder decirle a ops cuál es la rama. No se acepta: se reconoce.
 * Sin esto, la purga del deploy (masiva, pareja, y que se apaga sola en minutos) llegaría al log con
 * el mismo código que un intento de falsificación (puntual y persistente) — y ésa es exactamente la
 * distinción por la que el veredicto de este módulo no es un booleano.
 */
const QUOTE_REF_LEGACY_VERSION = "q1";

/** Bytes de HMAC-SHA256 que se conservan. 16 = 128 bits: sobra contra falsificación y el id queda corto. */
const SIGNATURE_BYTES = 16;

/**
 * Separador entre los campos del payload (`monto|vencimiento|id`). No puede aparecer en un
 * base64url (alfabeto `A-Za-z0-9-_`), así que el `.` que separa los tres segmentos tampoco colisiona.
 *
 * ⚠️ El id del proveedor va ÚLTIMO y puede contener el separador (lo elige el partner): por eso se
 * corta un número FIJO de veces por la izquierda y el resto es el id, entero. Agregar un campo nuevo
 * a la derecha del id rompería esa propiedad.
 */
const PAYLOAD_SEPARATOR = "|";

/** Campos del payload ANTES del id: `monto` y `vencimiento`. El id es todo lo que queda después. */
const PAYLOAD_FIELDS_BEFORE_ID = 2;

/** Código del rechazo al EMITIR una referencia sin vigencia utilizable — ver `issueQuoteRef`. */
export const QUOTE_REF_UNUSABLE_EXPIRY_CODE = "quote_ref_unusable_expiry";

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
 *
 * 🔴 `expiresAt` ES OBLIGATORIO Y ES EL `expiresAt` DE LA COTIZACIÓN — no una ventana nueva.
 * La vigencia no se inventa acá: la declara quien cotiza (`LiveMidFxProvider` pone `now + 10 min`;
 * el adapter del socio propaga la del partner) y este módulo se limita a hacerla exigible. Poner acá
 * una constante propia crearía un segundo número que decide lo mismo, y divergirían en el primer
 * cambio: la cotización prometería una cosa y el desembolso haría cumplir otra.
 *
 * Que sea un PARÁMETRO REQUERIDO es el candado: no existe forma de emitir una referencia sin
 * vigencia, y lo garantiza el compilador en cada call-site, no la disciplina de quien lo llama.
 *
 * **LANZA** `quote_ref_unusable_expiry` si el instante no es parseable. Es el mismo criterio que
 * `assertValidQuote` con una tasa NaN: si no se puede establecer hasta cuándo vale, no se emite —
 * antes que emitir una referencia cuya vigencia nadie va a poder verificar. Alcanza al camino del
 * socio, donde `expiresAt` puede llegar vacío (`fx.ts` lo mapea con `?? ""` si el partner no lo
 * manda): ese día el agente FX corta con un 502 ruidoso en vez de emitir una referencia eterna.
 * El instante se parsea UNA vez, acá, y se guarda ya normalizado a epoch-ms: así el verificador
 * nunca puede fallar parseando un dato NUESTRO, en un momento en el que ya no queda nada mejor que
 * hacer que rechazar.
 *
 * ⚠️ Emitir NO chequea que la cotización ya esté vencida al nacer: eso es una afirmación sobre el
 * reloj de quien cotiza (el partner, en el camino real) y su lugar es la verificación, donde el
 * único reloj que importa es el nuestro.
 */
export function issueQuoteRef(
  innerQuoteId: string,
  amountUsd: number,
  expiresAt: string,
): string {
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    // Value-free: el código y nada más (mismo patrón que `QUOTE_BINDING_SECRET_UNSET_CODE`). El
    // valor ilegible viene del partner y no se ecoa.
    throw new Error(
      `${QUOTE_REF_UNUSABLE_EXPIRY_CODE}: la cotización no declara un vencimiento parseable.`,
    );
  }
  const payloadB64 = Buffer.from(
    [encodeAmount(amountUsd), String(expiresAtMs), innerQuoteId].join(PAYLOAD_SEPARATOR),
    "utf8",
  ).toString("base64url");
  return `${QUOTE_REF_VERSION}.${payloadB64}.${sign(payloadB64)}`;
}

/**
 * Veredicto del binding. **CUATRO estados, no un booleano**, y la distinción es el punto:
 *  · `bound`            — la referencia se resolvió, está vigente, y el monto pedido es el cotizado.
 *  · `amount_mismatch`  — se resolvió, y el monto NO es el que se cotizó. Es una respuesta.
 *  · `expired`          — se resolvió, y la cotización YA VENCIÓ. También es una respuesta, y no es
 *                         la misma: se corrige volviendo a cotizar, no cambiando el monto. Colapsarlo
 *                         en `unresolvable` diría "no pude resolver tu referencia" cuando la
 *                         resolvimos perfectamente y la respuesta es "esa cotización ya no vale";
 *                         colapsarlo en `amount_mismatch` mandaría a corregir el campo equivocado.
 *  · `unresolvable`     — NO se pudo resolver (formato, versión, firma o payload). No es "los montos
 *                         no coinciden": es "no pude preguntar". Un booleano los colapsaría en
 *                         `false` y perdería justo la información con la que ops distingue una
 *                         integración rota (masivo y parejo) de una falsificación (puntual).
 *
 * Se exporta el TIPO además de la función, mismo criterio que `FreshnessVerdict` en `fx.ts`: los
 * guards de dinero de este repo se testean como unidad, no sólo por su efecto.
 */
export type QuoteBindingVerdict = "bound" | "amount_mismatch" | "expired" | "unresolvable";

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
    //
    // La `q1` se nombra aparte SÓLO en el log: es una referencia que emitimos nosotros y que hoy no
    // podemos resolver porque no dice hasta cuándo valía. Rechaza igual —no hay rama que la acepte—
    // pero ops necesita poder ver que una avalancha de rechazos justo después de un deploy es la
    // purga esperada, que se apaga sola en la vigencia de una cotización, y no un ataque.
    rejectRef(
      parts[0] === QUOTE_REF_LEGACY_VERSION ? "quote_ref_legacy_version" : "quote_ref_bad_format",
    );
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
  // El id interno puede contener cualquier cosa (lo elige el partner, y sí puede traer el
  // separador), así que se cortan SÓLO los dos campos de la izquierda y el resto es el id, entero.
  const fields = payload.split(PAYLOAD_SEPARATOR);
  if (fields.length < PAYLOAD_FIELDS_BEFORE_ID + 1) {
    rejectRef("quote_ref_bad_payload");
    return "unresolvable";
  }
  const [rawAmount, rawExpiresAtMs] = fields as [string, string, ...string[]];
  const innerQuoteId = fields.slice(PAYLOAD_FIELDS_BEFORE_ID).join(PAYLOAD_SEPARATOR);
  if (rawAmount === "" || rawExpiresAtMs === "" || innerQuoteId === "") {
    rejectRef("quote_ref_bad_payload");
    return "unresolvable";
  }
  const quotedAmount = Number(rawAmount);
  if (!Number.isFinite(quotedAmount)) {
    rejectRef("quote_ref_bad_payload");
    return "unresolvable";
  }
  // El vencimiento lo escribimos NOSOTROS ya normalizado a epoch-ms y va firmado, así que llegar acá
  // con algo no numérico es imposible por el camino de `issueQuoteRef`. Se valida igual, por el mismo
  // motivo por el que se valida el monto: el guard tiene que ser correcto por sí solo, y la rama que
  // no se valida es siempre la que falla abierta.
  const expiresAtMs = Number(rawExpiresAtMs);
  if (!Number.isFinite(expiresAtMs)) {
    rejectRef("quote_ref_bad_payload");
    return "unresolvable";
  }
  // 🔴 EL VENCIMIENTO SE EVALÚA ANTES QUE EL MONTO, a propósito. Una cotización vencida no es
  // honrable POR NINGÚN MONTO, así que responder `amount_mismatch` sobre una referencia muerta
  // mandaría a corregir un campo cuyo arreglo no cambia el resultado. Primero lo que ninguna
  // corrección del otro campo puede salvar.
  //
  // `>` y no `>=`: la cotización promete valer HASTA `expiresAt`, así que el instante exacto todavía
  // vale. No hay tolerancia de reloj y no debe haberla: sería un número nuevo, inventado acá, que
  // extendería en silencio una vigencia que la cotización ya declaró — justo lo que este cambio vino
  // a terminar. `Date.now()` se lee UNA sola vez para que el veredicto no dependa de dónde caiga un
  // tick entre dos lecturas.
  if (Date.now() > expiresAtMs) {
    // No es un `unresolvable`: se resolvió perfectamente. Va por su propio warn para que ops pueda
    // ver una avalancha de vencidas (un caller que cachea cotizaciones) sin confundirla con
    // referencias que no resuelven. Value-free, como todos los de este módulo.
    console.warn("[remit-quote-ref] quote_ref_expired");
    return "expired";
  }
  // `!(a === b)` y no `a !== b` daría lo mismo acá, pero el orden importa: se compara contra el monto
  // ya parseado por Zod (`z.number().positive()`, que rechaza NaN), y un NaN que llegara igual caería
  // en `amount_mismatch` porque `NaN === NaN` es false. Fail-closed por construcción.
  return quotedAmount === amountUsd ? "bound" : "amount_mismatch";
}
