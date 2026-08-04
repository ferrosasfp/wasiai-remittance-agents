// src/auth/invoke-auth.ts
// Guard de credencial de las 3 rutas `POST /api/agents/<agente>/invoke`. ÚNICA fuente de verdad de
// "¿este llamador puede invocar al agente?".
//
// ⚠️ ESTE MÓDULO NACE APAGADO Y TIENE QUE PODER DESPLEGARSE APAGADO. Leer el bloque siguiente antes
// de tocar cualquier rama: la propiedad más importante de acá NO es rechazar, es NO rechazar.
//
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  POR QUÉ ESTO NO ES "PRENDER UN CHEQUEO" (el inventario está en
//  `doc/auth-rutas-invoke-inventario-de-llamadores.md`, relevado el 2026-08-04)
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// Hoy los 3 `invoke` hacen trabajo real y devuelven 200 SIN NINGUNA CABECERA, y eso está medido
// contra producción, no deducido. Los llamadores conocidos son tres, y NINGUNO manda credencial:
//
//  1. chaski punto a punto — `chaski-v3/app/api/a2a/quote/route.ts:142-147` y
//     `chaski-v3/app/api/payout/prepare/route.ts:269-274` (más 3 call sites gemelos en `chaski-v2`).
//     Cabeceras EXACTAS: `{ "content-type": "application/json" }`.
//  2. el gateway `wasiai-a2a` — `compose.ts:1563-1567` hace `ssrfFetch(agent.invokeUrl, { headers })`
//     donde `headers` sale de `buildAuthHeaders(registry)` (`compose.ts:171-185`). 🔴 Los 3 agentes
//     están en el gateway como `registry: "self-published"`, que es un nombre SINTÉTICO
//     (`wasiai-a2a/src/types/index.ts:217-218`) y NO existe como fila de `registries`. Entonces
//     `registries.find(r => r.name === agent.registry)` da `undefined` ⇒ `buildAuthHeaders({})` ⇒
//     `{}`, y `registryIsSystemTrusted` es `false` ⇒ tampoco viaja el `x-a2a-key` del caller.
//     **El gateway hoy NO TIENE FORMA de mandarle una credencial a estos 3 agentes.**
//  3. internet — la `invokeUrl` sale en el `/discover` público del gateway, sin auth.
//
// Por eso el guard se despliega INERTE: sin `INVOKE_AUTH_SECRET`, el comportamiento de las 3 rutas
// es el de hoy, hasta el byte. Prenderlo antes de que el gateway pueda mandar la cabecera mataría el
// leg de payout con una remesa a mitad de camino. El orden de encendido está en el `.env.example`.
//
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  QUÉ NO ES ESTE MÓDULO
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// NO es cobro. Los 3 manifiestos declaran `payment.method:"x402"` (`src/manifest/build.ts:46`) pero
// este repo no implementa x402 del lado servidor en ninguna línea: quien cobra es el gateway, en su
// leg downstream, ANTES de hacer el POST (ver el reparto de roles en `README.es.md:53-72`). Un
// secreto compartido identifica al GATEWAY, no al usuario final, y no cobra un centavo. Lo que cierra
// es el agujero de "internet obtiene trabajo real gratis", que es un problema distinto y real.
//
// NO cubre los `/manifest`: la ficha de cobro es pública a propósito (cualquiera tiene que poder leer
// dónde cobra el agente antes de contratarlo). Este guard se llama SÓLO desde los 3 `invoke`.
//
// NO es `middleware.ts`, a propósito: el middleware de Next corre en el runtime edge, donde
// `node:crypto`/`timingSafeEqual` no existe, y además NO lo ejercitan los tests de ruta de este repo
// (que importan el `POST` y lo llaman directo). Un guard que la suite no puede ejecutar es un guard
// que nadie verifica. Vive en el handler, primera línea, dentro del camino que los tests recorren.

import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

/** Env con el secreto compartido. NUNCA `NEXT_PUBLIC_`: viajaría al navegador. */
export const INVOKE_AUTH_SECRET_ENV = "INVOKE_AUTH_SECRET";

/**
 * Cabecera y esquema. Se eligió `Authorization: Bearer <secreto>` y no una cabecera propia porque el
 * gateway YA sabe mandar exactamente eso sin una línea de código nueva: `RegistryAuth` con
 * `type:"bearer"` produce `Authorization: Bearer <valor>` en `compose.ts:180-182`. Inventar
 * `x-remit-invoke-key` habría obligado a `type:"header"` con una key que alguien tiene que tipear
 * bien en una fila de base de datos. Menos superficie para configurar mal.
 */
export const INVOKE_AUTH_HEADER = "authorization";
export const INVOKE_AUTH_SCHEME = "Bearer";

/**
 * Veredicto del guard. Es un conjunto CERRADO de 5 y NO un booleano, por la misma razón por la que
 * `QuoteBindingVerdict` (`providers/quote-ref.ts:250`) no lo es: los tres rechazos se corrigen en
 * lugares distintos y colapsarlos deja al que configura sin forma de saber cuál de los tres le tocó.
 *
 *  · `not_enforced`         — no hay secreto configurado ⇒ NO SE CHEQUEA NADA. Es el estado de hoy.
 *  · `authorized`           — la credencial coincide.
 *  · `credential_missing`   — no vino cabecera `Authorization` (o vino vacía). El llamador NO se
 *                             enteró de que ahora hace falta: hay que sembrarle la env a ÉL.
 *  · `credential_malformed` — vino cabecera pero no es `Bearer <token>`. Es el caso del secreto
 *                             pegado crudo sin el prefijo, o pegado en un `Basic`. La env está de
 *                             los dos lados; lo que está mal es CÓMO se manda.
 *  · `credential_mismatch`  — vino un `Bearer <token>` bien formado que no coincide. Los dos lados
 *                             creen tener el secreto y tienen secretos DISTINTOS (típico: se rotó de
 *                             un lado, o se copió con un salto de línea de más).
 *
 * Las tres últimas son 401. Que las tres viajen en el BODY y no sólo al log es deliberado: chaski
 * aplana todo no-2xx del agente en un 502 opaco (`app/api/payout/prepare/route.ts:278-280`), así que
 * un motivo que sólo exista en los logs de este repo no llega nunca a quien está depurando del otro
 * lado. Lo que NO viaja jamás, ni al body ni al log, es el VALOR de ninguna credencial.
 */
export type InvokeAuthVerdict =
  | "not_enforced"
  | "authorized"
  | "credential_missing"
  | "credential_malformed"
  | "credential_mismatch";

/**
 * Resuelve el secreto configurado, o `null` si no hay ninguno.
 *
 * 🔴 "NO CONFIGURADO" INCLUYE LA CADENA VACÍA Y LA DE PUROS ESPACIOS, y eso ES el requisito de
 * despliegue, no una comodidad: una env que quedó en `""` (Vercel las escribe así más seguido de lo
 * que uno quisiera) tiene que dejar pasar todo, no rechazar todo contra un secreto que nadie puede
 * mandar. Mismo criterio que `resolveQuoteBindingSecret` (`providers/quote-ref.ts:143-144`).
 *
 * Se lee EN CADA REQUEST, no al importar el módulo: rotar el secreto surte efecto en la próxima
 * llamada, sin redeploy, y apagar el guard es borrar una variable — el rollback que el orden de
 * encendido promete.
 *
 * El `.trim()` es contra el artefacto de pegado (un `\n` al final al copiar de una terminal). Se
 * aplica del MISMO lado en el token recibido, así que no hay una mitad indulgente y otra estricta.
 */
function resolveConfiguredSecret(): string | null {
  const raw = process.env[INVOKE_AUTH_SECRET_ENV];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Extrae el token de un `Authorization: Bearer <token>`. Devuelve `null` si la cabecera existe pero
 * no tiene esa forma — o sea, lo que el llamador de arriba traduce a `credential_malformed`.
 *
 * El esquema se compara sin distinguir mayúsculas (RFC 7235 §2.1: el scheme es case-insensitive), y
 * eso NO es indulgencia con el secreto: el secreto se compara aparte, byte a byte y en tiempo
 * constante. Aceptar `bearer` evita un rechazo por una `b` cuando la credencial era correcta, que es
 * exactamente el tipo de falso negativo que este módulo existe para no producir.
 */
function extractBearerToken(rawHeader: string): string | null {
  const match = /^(\S+)[ \t]+(\S[\s\S]*)$/.exec(rawHeader.trim());
  if (match === null) return null; // sin esquema, o esquema sin token ("Bearer" pelado)
  const scheme = match[1];
  const token = match[2];
  if (scheme === undefined || token === undefined) return null;
  if (scheme.toLowerCase() !== INVOKE_AUTH_SCHEME.toLowerCase()) return null;
  const trimmed = token.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Compara la credencial recibida contra la configurada en TIEMPO CONSTANTE.
 *
 * 🔴 NO TOCAR ESTA FUNCIÓN CON UN `===`. Un `===` sobre un secreto corta en el primer byte que
 * difiere, y esa diferencia de tiempo es un oráculo con el que se adivina el secreto byte a byte.
 *
 * Se comparan los DIGESTS SHA-256, no las cadenas: así los dos operandos miden siempre 32 bytes,
 * `timingSafeEqual` (que lanza con longitudes distintas) nunca puede lanzar, y no hace falta un
 * `if (a.length !== b.length)` previo — que sería una rama que se resuelve antes de mirar un solo
 * byte y filtra la LONGITUD del secreto. (En `quote-ref.ts:288-292` esa rama sí está, y ahí es
 * correcta: la firma que compara tiene longitud FIJA y pública. Un secreto de operador no.)
 */
function credentialMatches(providedCredential: string, expectedCredential: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(providedCredential, "utf8").digest(),
    createHash("sha256").update(expectedCredential, "utf8").digest(),
  );
}

/**
 * Función TOTAL sobre el valor crudo de la cabecera `Authorization` (`null` = no vino).
 *
 * Exportada para testearla como unidad, mismo criterio que `checkQuoteBinding` y `checkFreshness`:
 * los guards de este repo se prueban por su veredicto, no sólo por el status que termina saliendo.
 */
export function checkInvokeAuth(rawHeader: string | null): InvokeAuthVerdict {
  const expectedCredential = resolveConfiguredSecret();
  // 🔴 LA PRIMERA RAMA, Y ANTES DE MIRAR LA CABECERA. Sin secreto configurado este módulo no tiene
  // opinión: no hay 401 posible, no hay log, no hay nada. Ése es el estado en el que se despliega.
  if (expectedCredential === null) return "not_enforced";

  if (rawHeader === null || rawHeader.trim() === "") return "credential_missing";

  const providedCredential = extractBearerToken(rawHeader);
  if (providedCredential === null) return "credential_malformed";

  return credentialMatches(providedCredential, expectedCredential)
    ? "authorized"
    : "credential_mismatch";
}

/** Los veredictos que niegan el paso. Conjunto cerrado; el `Record` de abajo los cubre por tipos. */
type InvokeAuthRejection = Exclude<InvokeAuthVerdict, "not_enforced" | "authorized">;

/**
 * Mensaje de ayuda por motivo. Value-free: describe QUÉ corregir, sin mencionar ningún valor.
 * Está tipado como `Record` sobre el conjunto cerrado de rechazos: agregar un motivo nuevo al tipo
 * sin darle su mensaje NO COMPILA, que es como se impide que un motivo nuevo nazca colapsado.
 */
const REJECTION_HINT: Readonly<Record<InvokeAuthRejection, string>> = Object.freeze({
  credential_missing: `este agente exige la cabecera Authorization: ${INVOKE_AUTH_SCHEME} <secreto> — seteá ${INVOKE_AUTH_SECRET_ENV} en el llamador y hacé que la mande`,
  credential_malformed: `la cabecera Authorization llegó pero no tiene la forma "${INVOKE_AUTH_SCHEME} <secreto>" — mandá el esquema, no el secreto pelado`,
  credential_mismatch: `la credencial está bien formada pero no coincide — ${INVOKE_AUTH_SECRET_ENV} tiene valores distintos en el llamador y en el agente`,
});

/**
 * Guard de ruta. Devuelve la respuesta de rechazo, o `null` si la llamada sigue.
 *
 * `null` es el resultado de DOS veredictos distintos (`not_enforced` y `authorized`) y eso es
 * deliberado: la ruta no tiene que saber cuál de los dos fue, porque en los dos casos hace
 * exactamente lo mismo que hacía antes de que este módulo existiera.
 *
 * `agent` es una etiqueta ESTÁTICA que pone cada ruta (su pathSlug literal). Es para el log de ops:
 * sin ella, un 401 no dice a qué agente le pegaron. No viene de la request, así que no puede ecoar
 * nada del caller.
 */
export function guardInvokeAuth(req: Request, agent: string): NextResponse | null {
  const verdict = checkInvokeAuth(req.headers.get(INVOKE_AUTH_HEADER));
  if (verdict === "not_enforced" || verdict === "authorized") return null;

  // Warn value-free: SÓLO el código de rama y el nombre del agente. Nunca la cabecera, nunca el
  // token, nunca el secreto. Mismo patrón que `rejectRef` (`providers/quote-ref.ts:252-255`).
  console.warn("[remit-invoke-auth] invoke_unauthorized", { agent, code: verdict });

  return NextResponse.json(
    { error: "unauthorized", reason: verdict, hint: REJECTION_HINT[verdict] },
    { status: 401, headers: { "WWW-Authenticate": INVOKE_AUTH_SCHEME } },
  );
}
