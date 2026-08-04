// TransFi readiness — ÚNICA fuente de verdad de "¿está habilitada ESTA capacidad de TransFi?".
// Módulo hermano de `transfi-env.ts` (que resuelve el AMBIENTE); acá se resuelve la INTENCIÓN.
//
// ⚠️ POR QUÉ EXISTE (el candado compartido):
// hasta este fix una sola env, `TRANSFI_ADAPTER_READY`, era la 2ª llave de DOS capacidades que no
// tienen nada que ver entre sí:
//   · COTIZAR con el socio  → `getFxQuoteProvider()` (fx.ts), credencial `TRANSFI_API_KEY`,
//     endpoint `/v1/quotes`. Lee. No mueve un centavo.
//   · DESEMBOLSAR con el socio → `getPayoutProvider()` (payout.ts), credenciales
//     `TRANSFI_USERNAME`/`TRANSFI_PASSWORD`/`TRANSFI_MID`, endpoint `POST /v3/orders`. Mueve plata.
//
// Las dos son separables, y se verificó que lo son: el body de la orden de payout
// (`payout.ts:153-187`) NO manda ningún `quoteId` del socio ni ningún campo derivado de una
// cotización de TransFi. La atadura entre cotizar y desembolsar es NUESTRA referencia firmada
// (`quote-ref.ts`, verificada en `checkQuoteBinding`, cashout-payout.ts:305), que se emite igual
// venga la tasa del mid o del socio. O sea que el desembolso no necesita una cotización del socio
// para existir: la combinación "tasa del mid + desembolso real" ya es alcanzable HOY por el eje de
// las credenciales (sin `TRANSFI_API_KEY`, `getFxQuoteProvider()` devuelve `LiveMidFxProvider`
// cualquiera sea el flag).
//
// Lo que el candado compartido producía, con las dos credenciales puestas:
//  1. Para verificar el mapeo de la COTIZACIÓN del socio en sandbox —que es literalmente para lo
//     que se creó el flag— había que encender también el adapter que arma órdenes de desembolso.
//  2. Y al revés: encender el desembolso cambiaba EN EL MISMO REDEPLOY la fuente de la tasa a un
//     mapeo sandbox-unverified. Apagar de más es molesto; encender de más mueve plata.
//
// 🔴 LAS TRES REGLAS DE ESTE MÓDULO
//  1. FAIL-CLOSED TOTAL: `isTransFiCapabilityReady()` es una función total sobre un conjunto
//     CERRADO de capacidades y toda rama que no sea el literal exacto `"true"` devuelve `false`.
//     No hay `??` con default encendido, ni truthiness, ni `.toLowerCase()`, ni `trim()`:
//     `"TRUE"`, `"1"`, `"yes"`, `" true"` y `""` son APAGADO. (`"TRUE"` es un valor plausible de
//     tipear y por eso está en los tests: si algún día se acepta, que sea una decisión, no un
//     `toLowerCase()` que alguien agregó "para ser amable").
//  2. UNA SOLA LECTURA: éste es el único archivo del repo que lee estas tres envs. Los call sites
//     preguntan por la CAPACIDAD (`"fx"` / `"payout"`), no por el nombre de una variable. Un
//     `process.env.TRANSFI_*_ADAPTER_READY` fuera de acá es el bug de origen volviendo.
//  3. LA VIEJA SIGUE VALIENDO, PERO PIERDE: ver el bloque de compatibilidad de abajo.

/** Capacidades de TransFi que se habilitan por separado. Conjunto CERRADO: no hay una tercera. */
export type TransFiCapability = "fx" | "payout";

interface CapabilitySpec {
  /** Env específica de la capacidad. Es la que MANDA cuando está definida. */
  readonly flagEnv: string;
  /** Qué credencial ya estaba puesta cuando el gate corta (para el mensaje de error). */
  readonly credentialHint: string;
  /** Qué hay que verificar en sandbox antes de encenderla (para el mensaje de error). */
  readonly verifyHint: string;
}

const CAPABILITY: Readonly<Record<TransFiCapability, CapabilitySpec>> = Object.freeze({
  fx: Object.freeze({
    flagEnv: "TRANSFI_FX_ADAPTER_READY",
    credentialHint: "TRANSFI_API_KEY seteada",
    verifyHint:
      "confirmá el mapeo de campos con el sandbox antes de activar el adapter en el money-path",
  }),
  payout: Object.freeze({
    flagEnv: "TRANSFI_PAYOUT_ADAPTER_READY",
    credentialHint: "credenciales TransFi seteadas",
    verifyHint: "confirmá el mapeo + el flujo de depósito con el sandbox antes de mover plata",
  }),
});

/**
 * Flag LEGADA: la que gateaba las dos capacidades a la vez.
 *
 * 🔴 COMPATIBILIDAD — POR QUÉ SIGUE VALIENDO Y POR QUÉ PIERDE (leer antes de borrarla):
 * un deploy que HOY tiene `TRANSFI_ADAPTER_READY=true` tiene las dos capacidades habilitadas. Si
 * este cambio la ignorara, ese deploy se apagaría solo al mergear — un cambio de comportamiento
 * silencioso en el money-path, disparado por un refactor. Por eso la legada sigue siendo el
 * paraguas de las dos: con las envs nuevas ausentes, el resultado es BYTE-IDÉNTICO al de antes
 * (`ready ⟺ TRANSFI_ADAPTER_READY === "true"`, para fx y para payout).
 *
 * Pero pierde contra la específica, y esa precedencia es el punto de todo el cambio: si la legada
 * pudiera encender una capacidad que su env específica declara apagada, el candado seguiría
 * compartido y no habría forma de habilitar una sola. Concreto y medible: con
 * `TRANSFI_ADAPTER_READY=true` + `TRANSFI_PAYOUT_ADAPTER_READY=""`, el payout queda APAGADO.
 *
 * Y pierde en la dirección segura: la específica sólo enciende con el literal `"true"`, así que
 * cualquier otro valor (incluida la cadena vacía) APAGA lo que la legada habría encendido. Nunca
 * al revés — una específica presente no puede encender nada que ella misma no diga con `"true"`.
 *
 * NO es un error tener las tres seteadas, y es deliberado: el estado "las nuevas puestas y la vieja
 * todavía sin borrar" es exactamente el paso del medio de la migración. Tirar ahí convertiría el
 * momento de migrar en una caída. Lo que sí hace es AVISAR, y sólo cuando la legada está decidiendo
 * de verdad (si la específica está definida, la legada es irrelevante y no se menciona).
 */
export const LEGACY_READINESS_ENV = "TRANSFI_ADAPTER_READY";

/** Nombre de la env específica de una capacidad. Para mensajes y docs; no decide nada. */
export function transfiReadinessEnv(capability: TransFiCapability): string {
  return CAPABILITY[capability].flagEnv;
}

/**
 * ¿Está habilitada la capacidad? Función TOTAL: los tres casos de entrada están cubiertos y el
 * único que devuelve `true` es un literal `"true"` exacto.
 *
 *  1. env específica DEFINIDA (aunque sea `""`) → manda ella: `true` ⟺ `=== "true"`.
 *  2. env específica AUSENTE + legada definida  → decide la legada (compat), con warn.
 *  3. ninguna de las dos                        → `false`.
 *
 * "Definida" es `!== undefined`, no truthiness: `TRANSFI_PAYOUT_ADAPTER_READY=""` es una decisión
 * del operador ("esta no") y tiene que ganarle al paraguas legado, no caer en el caso 2.
 */
export function isTransFiCapabilityReady(capability: TransFiCapability): boolean {
  const spec = CAPABILITY[capability];
  const own = process.env[spec.flagEnv];
  if (own !== undefined) return own === "true";

  const legacy = process.env[LEGACY_READINESS_ENV];
  if (legacy === undefined) return false;

  const enabled = legacy === "true";
  // Value-free: el nombre de la capacidad es un conjunto cerrado de 2 literales y el efecto es un
  // booleano ya resuelto. El VALOR crudo de la env legada no se ecoa (podría ser cualquier cosa).
  // Se avisa en cada resolución, no una sola vez por proceso: un `let warned` haría que en
  // producción el aviso apareciera en la primera request y nunca más, que es donde nadie lo ve.
  console.warn(
    `[transfi] ${LEGACY_READINESS_ENV} (legada) está decidiendo la capacidad "${capability}": ` +
      `queda ${enabled ? "HABILITADA" : "deshabilitada"}. Migrá a ${spec.flagEnv} — la legada ` +
      "gatea la cotización y el desembolso juntos.",
  );
  return enabled;
}

/**
 * Corta fail-loud si la capacidad no está habilitada. Se llama SÓLO cuando la credencial de esa
 * capacidad ya está puesta: credencial sin readiness es misconfig, y misconfig lanza — nunca
 * degrada en silencio al mock (ése era el diseño original y no cambia).
 *
 * El código del error (`transfi_adapter_not_ready`) se mantiene byte a byte: lo consumen los routes
 * (→ 502) y los tests existentes. Lo que cambió es la env que el mensaje te manda a mirar.
 */
export function assertTransFiCapabilityReady(capability: TransFiCapability): void {
  if (isTransFiCapabilityReady(capability)) return;
  const spec = CAPABILITY[capability];
  throw new Error(
    `transfi_adapter_not_ready: ${spec.credentialHint} pero ${spec.flagEnv}!=true — ` +
      `${spec.verifyHint}.`,
  );
}
