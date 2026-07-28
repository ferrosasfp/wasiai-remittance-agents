// TransFi environment — ÚNICA fuente de verdad del ambiente/host de TransFi para TODO el repo.
//
// ⚠️ POR QUÉ EXISTE ESTE MÓDULO (incidente de config money-path):
// hasta este fix la MISMA env (`TRANSFI_BASE_URL`) se leía en DOS lugares con defaults OPUESTOS:
//   · `payout.ts` default `https://sandbox-api.transfi.com`  (sandbox, correcto)
//   · `fx.ts`    default `https://api.transfi.com`           (PRODUCCIÓN del partner)
// Sin la env seteada el repo quedaba "sandbox a medias": el agente de payout hablaba sandbox y el
// de FX consultaba la API PRODUCTIVA de un partner licenciado (gasta su cuota, ensucia sus métricas,
// dispara sus rate-limits y devuelve datos reales que el sistema trata como de prueba).
//
// Las 3 reglas de este módulo (en orden de importancia):
//  1. FAIL-CLOSED: sin `TRANSFI_ENV` explícita NO se resuelve ningún host. Un servicio que no sabe
//     contra qué API habla no debe hablar. NUNCA se infiere el ambiente en silencio.
//  2. UNA SOLA FUENTE: `resolveTransFiBaseUrl()` es la ÚNICA forma de obtener un host de TransFi.
//     Está garantizado POR EL COMPILADOR: los adapters reciben un `TransFiBaseUrl` (tipo BRANDED)
//     y solo esta función puede producir uno. Un `string` cualquiera (un default nuevo, un literal
//     hardcodeado) NO compila como argumento. Los dos providers no pueden divergir por construcción.
//  3. El override `TRANSFI_BASE_URL` (legado / mock de CI) NO puede CONTRADECIR a `TRANSFI_ENV`:
//     apuntar a producción declarando sandbox es un throw, no una advertencia.
//
// El movimiento de plata real sigue gated donde ya estaba (creds + `TRANSFI_ADAPTER_READY`, ver
// `getPayoutProvider()` y `assertPayoutProviderSafe()`). Este módulo agrega el eje que faltaba:
// el AMBIENTE de la URL, no solo las credenciales.

/** Ambientes de TransFi. Conjunto CERRADO: no existe "staging", "dev" ni un tercer valor. */
export type TransFiEnvironment = "sandbox" | "production";

// Brand nominal: `TransFiBaseUrl` es asignable a `string`, pero un `string` NO es asignable a
// `TransFiBaseUrl`. Es lo que hace imposible (a nivel de tipos) un segundo origen de host.
declare const transfiBaseUrlBrand: unique symbol;
export type TransFiBaseUrl = string & { readonly [transfiBaseUrlBrand]: "transfi-base-url" };

/** Hosts canónicos publicados por TransFi (doc/transfi-offramp-api-spec.md L7-L8). */
export const TRANSFI_CANONICAL_BASE_URL: Readonly<Record<TransFiEnvironment, string>> =
  Object.freeze({
    sandbox: "https://sandbox-api.transfi.com",
    production: "https://api.transfi.com",
  });

/** Clasificación de los hosts conocidos del partner. Un host acá NO es opinable. */
const KNOWN_PARTNER_HOST: Readonly<Record<string, TransFiEnvironment>> = Object.freeze({
  "sandbox-api.transfi.com": "sandbox",
  "api.transfi.com": "production",
});

/** Hosts a los que se permite `http://` (mocks locales de CI). Cualquier otro exige `https`. */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function isPartnerDomain(hostname: string): boolean {
  return hostname === "transfi.com" || hostname.endsWith(".transfi.com");
}

/**
 * Resuelve el ambiente declarado. FAIL-CLOSED: sin `TRANSFI_ENV` lanza.
 *
 * 🔴 PROHIBIDO agregar acá un `?? "sandbox"` ni derivar el ambiente de `NODE_ENV`, del host, o de
 * la presencia de credenciales. El operador DECLARA el ambiente; el código no lo adivina. Un default
 * (cualquiera, incluso el seguro) devuelve el bug de origen: dos lugares que creen cosas distintas.
 */
export function resolveTransFiEnvironment(): TransFiEnvironment {
  const raw = process.env.TRANSFI_ENV?.trim().toLowerCase();
  if (!raw) {
    throw new Error(
      "transfi_env_unset: seteá TRANSFI_ENV=sandbox (o =production con KYB aprobado) antes de " +
        "usar el adapter de TransFi. No se asume ningún ambiente: un servicio que no sabe contra " +
        "qué API habla no habla.",
    );
  }
  if (raw !== "sandbox" && raw !== "production") {
    // Valor de config de un conjunto cerrado (nunca un secreto ni PII): se ecoa para diagnosticar typos.
    throw new Error(`transfi_env_invalid:${raw} (valores válidos: sandbox | production)`);
  }
  if (raw === "production" && process.env.NODE_ENV !== "production") {
    // Una máquina de dev/CI NUNCA debe hablarle a la API productiva de un partner licenciado.
    throw new Error(
      "transfi_env_production_outside_node_prod: TRANSFI_ENV=production requiere " +
        "NODE_ENV=production. Un build de dev/CI no habla con la API productiva del partner.",
    );
  }
  return raw;
}

/**
 * Resuelve el base URL de TransFi. ÚNICA fábrica de `TransFiBaseUrl` del repo.
 *
 * Se llama LAZY (solo cuando se construye un adapter REAL, ver `getPayoutProvider()` /
 * `getFxQuoteProvider()`), NO al importar el módulo. Consecuencia deliberada: el modo devnet actual
 * (sin credenciales de TransFi + `PAYOUT_ALLOW_MOCK=true`) nunca llega acá y sigue funcionando sin
 * `TRANSFI_ENV`, porque el mock no le habla a TransFi. Si el hosting evaluara esto al arrancar,
 * el fail-closed voltearía un deploy que hoy es inerte y correcto.
 */
export function resolveTransFiBaseUrl(): TransFiBaseUrl {
  const environment = resolveTransFiEnvironment();
  const canonical = TRANSFI_CANONICAL_BASE_URL[environment];

  const override = process.env.TRANSFI_BASE_URL?.trim();
  if (!override) return canonical as TransFiBaseUrl;

  let parsed: URL;
  try {
    parsed = new URL(override);
  } catch {
    throw new Error("transfi_base_url_invalid: TRANSFI_BASE_URL no es una URL absoluta válida.");
  }

  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" && !LOCAL_HOSTS.has(hostname)) {
    // Las creds viajan en un header Basic: sobre http se filtran en claro.
    throw new Error(
      `transfi_base_url_insecure_scheme:${parsed.protocol.replace(":", "")} ` +
        "(solo https, salvo un mock en localhost)",
    );
  }

  const hostEnvironment = KNOWN_PARTNER_HOST[hostname];
  if (hostEnvironment !== undefined && hostEnvironment !== environment) {
    // El caso exacto del incidente: declarar sandbox y apuntar al host productivo (o al revés).
    throw new Error(
      `transfi_base_url_env_conflict: TRANSFI_ENV=${environment} pero TRANSFI_BASE_URL apunta al ` +
        `host de ${hostEnvironment}. Corregí una de las dos: el ambiente no se resuelve a medias.`,
    );
  }
  if (hostEnvironment === undefined && isPartnerDomain(hostname) && environment !== "production") {
    // Un host *.transfi.com que NO es el sandbox canónico no se puede probar sandbox: fail-closed.
    throw new Error(
      "transfi_base_url_unclassified_partner_host: TRANSFI_BASE_URL apunta a un host de TransFi " +
        "que no es el sandbox canónico. Con TRANSFI_ENV=sandbox no se acepta (podría ser productivo).",
    );
  }
  if (!isPartnerDomain(hostname) && environment === "production") {
    // En producción el money-path habla con el partner, no con un mock.
    throw new Error(
      "transfi_base_url_non_partner_host_in_production: con TRANSFI_ENV=production el host debe " +
        "ser de TransFi (los mocks son solo para sandbox/CI).",
    );
  }

  // Normalización: sin la barra final, porque los call sites concatenan `/v3/orders` y `/v1/quotes`.
  return override.replace(/\/+$/, "") as TransFiBaseUrl;
}
