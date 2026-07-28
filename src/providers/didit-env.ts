// Didit environment — ÚNICA fuente de verdad del host de Didit para TODO el repo.
// Módulo HERMANO de `transfi-env.ts`: mismo patrón, mismas 3 reglas, otro partner.
//
// ⚠️ POR QUÉ EXISTE ESTE MÓDULO (el follow-up que dejó abierto el fix de TransFi):
// el SDD de `009-transfi-env-single-source-fail-closed` (§ riesgos, punto 1) anotó que
// `DIDIT_BASE_URL` tenía el MISMO defecto que `TRANSFI_BASE_URL`:
//   `process.env.DIDIT_BASE_URL ?? "https://verification.didit.me"`   (kyc.ts:8)
// o sea, sin ninguna env seteada el adapter apuntaba solo a la PRODUCCIÓN de Didit. Acá el eje en
// riesgo NO es plata: son DOCUMENTOS DE IDENTIDAD de personas reales. Una corrida mal configurada
// con una API key real creaba verificaciones DE VERDAD, con PII real, y consumía cuota facturable.
//
// Las 3 reglas de este módulo (idénticas a las de `transfi-env.ts`, en el mismo orden):
//  1. FAIL-CLOSED: sin `DIDIT_ENV` explícita NO se resuelve ningún host. Un servicio que no sabe
//     contra qué API de identidad habla no debe hablar. NUNCA se infiere el ambiente en silencio.
//  2. UNA SOLA FUENTE: `resolveDiditBaseUrl()` es la ÚNICA forma de obtener un host de Didit.
//     Está garantizado POR EL COMPILADOR: `DiditKycProvider` recibe un `DiditBaseUrl` (tipo
//     BRANDED) y solo esta función puede producir uno. Un `string` cualquiera (un default nuevo,
//     un literal hardcodeado) NO compila como argumento.
//  3. El override `DIDIT_BASE_URL` NO puede CONTRADECIR a `DIDIT_ENV`: declarar `mock` y apuntar
//     al host real de Didit es un throw, no una advertencia.
//
// 🔴 LA ÚNICA DIFERENCIA REAL CON `transfi-env.ts` — leer antes de "unificarlos":
// TransFi publica DOS hosts (`sandbox-api.transfi.com` / `api.transfi.com`), así que allá el
// ambiente SELECCIONA un host. **Didit no publica un host de sandbox.** Su modo de prueba es el
// free tier (500 verificaciones/mes) sobre EL MISMO host productivo, separado por API key +
// workflow, no por URL. Por eso acá los valores NO son `sandbox|production`: inventar un
// `https://sandbox-verification.didit.me` sería fabricar un endpoint de un tercero que no existe,
// y el fix quedaría peor que el bug (todo apuntando a un host que no resuelve). El conjunto
// honesto es:
//   · `live` → el host real de Didit. Consume cuota y crea verificaciones REALES.
//   · `mock` → un endpoint NUESTRO (mock local / CI). Exige `DIDIT_BASE_URL`, porque no hay
//              ningún host canónico de mock que se pueda asumir.
// La separación free-tier vs producción sigue viviendo donde Didit la puso: en `DIDIT_API_KEY` y
// `DIDIT_WORKFLOW_ID`. Este módulo agrega el eje que faltaba (la INTENCIÓN de hablarle a Didit).
//
// El movimiento del money-path sigue gated donde ya estaba (`DIDIT_API_KEY` +
// `DIDIT_ADAPTER_READY`, ver `getKycProvider()`), igual que TransFi con `TRANSFI_ADAPTER_READY`.

/** Ambientes de Didit. Conjunto CERRADO: no existe "sandbox" (Didit no publica uno), ni "staging". */
export type DiditEnvironment = "mock" | "live";

// Brand nominal: `DiditBaseUrl` es asignable a `string`, pero un `string` NO es asignable a
// `DiditBaseUrl`. Es lo que hace imposible (a nivel de tipos) un segundo origen de host.
declare const diditBaseUrlBrand: unique symbol;
export type DiditBaseUrl = string & { readonly [diditBaseUrlBrand]: "didit-base-url" };

/** Host canónico de Didit. ÚNICO literal del repo: si aparece un segundo, el fix se perdió. */
export const DIDIT_LIVE_BASE_URL = "https://verification.didit.me";

/** Hosts a los que se permite `http://` (mocks locales de CI). Cualquier otro exige `https`. */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function isDiditDomain(hostname: string): boolean {
  return hostname === "didit.me" || hostname.endsWith(".didit.me");
}

/**
 * Resuelve el ambiente declarado. FAIL-CLOSED: sin `DIDIT_ENV` lanza.
 *
 * 🔴 PROHIBIDO agregar acá un `?? "mock"` ni derivar el ambiente de `NODE_ENV`, del host, o de la
 * presencia de `DIDIT_API_KEY`. El operador DECLARA el ambiente; el código no lo adivina. Un default
 * (cualquiera, incluso el seguro) devuelve el bug de origen: dos lugares que creen cosas distintas.
 */
export function resolveDiditEnvironment(): DiditEnvironment {
  const raw = process.env.DIDIT_ENV?.trim().toLowerCase();
  if (!raw) {
    throw new Error(
      "didit_env_unset: seteá DIDIT_ENV=live (host real de Didit, crea verificaciones REALES con " +
        "PII y consume cuota) o DIDIT_ENV=mock + DIDIT_BASE_URL (endpoint propio) antes de usar el " +
        "adapter de Didit. No se asume ningún ambiente: un servicio que no sabe contra qué API de " +
        "identidad habla no habla.",
    );
  }
  if (raw !== "mock" && raw !== "live") {
    // Valor de config de un conjunto cerrado (nunca un secreto ni PII): se ecoa para diagnosticar
    // typos. OJO: "sandbox" cae acá A PROPÓSITO — Didit no tiene sandbox (ver cabecera).
    throw new Error(
      `didit_env_invalid:${raw} (valores válidos: mock | live — "sandbox" NO existe en Didit: ` +
        "su modo de prueba es el free tier sobre el host real, vía DIDIT_API_KEY/DIDIT_WORKFLOW_ID)",
    );
  }
  if (raw === "live" && process.env.NODE_ENV !== "production") {
    // Espejo exacto de `transfi_env_production_outside_node_prod`: una máquina de dev/CI NUNCA le
    // habla a la API productiva de un partner licenciado. Acá pesa más que en TransFi, porque lo
    // que se crea del otro lado son verificaciones con PII de personas reales.
    throw new Error(
      "didit_env_live_outside_node_prod: DIDIT_ENV=live requiere NODE_ENV=production. Un build de " +
        "dev/CI no crea verificaciones de identidad reales contra la cuenta productiva.",
    );
  }
  return raw;
}

/**
 * Resuelve el base URL de Didit. ÚNICA fábrica de `DiditBaseUrl` del repo.
 *
 * Se llama LAZY (solo cuando se construye el adapter REAL, ver `getKycProvider()`), NO al importar
 * el módulo. Consecuencia deliberada, idéntica a la de `resolveTransFiBaseUrl()`: el modo devnet
 * actual (sin `DIDIT_API_KEY` → `FallbackKycProvider`) nunca llega acá y sigue funcionando sin
 * `DIDIT_ENV`, porque el fallback no le habla a Didit. Si el hosting evaluara esto al arrancar, el
 * fail-closed voltearía un deploy que hoy es inerte y correcto.
 */
export function resolveDiditBaseUrl(): DiditBaseUrl {
  const environment = resolveDiditEnvironment();
  const override = process.env.DIDIT_BASE_URL?.trim();

  if (!override) {
    if (environment === "mock") {
      // No hay host canónico de mock que asumir: exigirlo es el fail-closed correcto.
      throw new Error(
        "didit_base_url_required_for_mock: con DIDIT_ENV=mock hay que setear DIDIT_BASE_URL " +
          "(no existe un host de mock canónico que asumir).",
      );
    }
    return DIDIT_LIVE_BASE_URL as DiditBaseUrl;
  }

  let parsed: URL;
  try {
    parsed = new URL(override);
  } catch {
    throw new Error("didit_base_url_invalid: DIDIT_BASE_URL no es una URL absoluta válida.");
  }

  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" && !LOCAL_HOSTS.has(hostname)) {
    // La API key viaja en el header `x-api-key` y las respuestas traen PII: sobre http se filtran
    // en claro. Solo un mock en localhost puede ser http.
    throw new Error(
      `didit_base_url_insecure_scheme:${parsed.protocol.replace(":", "")} ` +
        "(solo https, salvo un mock en localhost)",
    );
  }

  if (environment === "mock" && isDiditDomain(hostname)) {
    // El caso exacto del incidente, invertido: declarar mock y apuntar al Didit real. Un "test"
    // que cree verificaciones reales con PII es peor que un test que no corre.
    throw new Error(
      "didit_base_url_env_conflict: DIDIT_ENV=mock pero DIDIT_BASE_URL apunta a un host de Didit. " +
        "Corregí una de las dos: el ambiente no se resuelve a medias.",
    );
  }
  if (environment === "live" && !isDiditDomain(hostname)) {
    // En `live` el KYC habla con Didit, no con un mock: un mock que responda "Approved" es un
    // bypass del gate de compliance (el mismo que consumen isPayoutAllowed / isKycGatePassed).
    throw new Error(
      "didit_base_url_non_didit_host_in_live: con DIDIT_ENV=live el host debe ser de Didit " +
        "(los mocks son solo para DIDIT_ENV=mock).",
    );
  }

  // Normalización: sin la barra final, porque los call sites concatenan `/v2/session/` y
  // `/v3/session/{id}/decision/`.
  return override.replace(/\/+$/, "") as DiditBaseUrl;
}
