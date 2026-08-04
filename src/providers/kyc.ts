// KYC/AML provider — Didit adapter + fallback determinístico.
// Didit: verificación DNI + liveness + screening OFAC/PEP/sanciones + monitoreo continuo,
// SBS-compliant Perú. Docs: https://docs.didit.me  (endpoints exactos a confirmar en sandbox).

import { z } from "zod";
import {
  resolveDiditBaseUrl,
  resolveDiditEnvironment,
  type DiditBaseUrl,
  type DiditEnvironment,
} from "./didit-env";
import type { KycInput, KycProvider, KycResult, KycStatusResult } from "./types";

// MNR-3 (re-AR): allowlist explícita de proveniencias REALES (fail-safe en el eje provenance).
// Un typo futuro en un provider NO debe leerse como "real" y abrir el money-path.
// WKH-203/CD-9: vive ACÁ (junto a los providers que PRODUCEN estos valores) y es la ÚNICA;
// la consumen kyc-validator.ts (isPayoutAllowed) y cashout-payout.ts (isKycGatePassed).
export const REAL_KYC_PROVENANCES = new Set<string>(["didit"]);

/**
 * Proveniencias SIMULADAS: una verificación que nadie hizo.
 *
 * La emite el mock de Didit de `chaski-v3` (`app/api/mock-didit/**`), que existe porque Didit **no
 * publica un host de sandbox** y la única forma de recorrer el producto sin el documento de una
 * persona real es un endpoint propio. La etiqueta no la elige esa ruta: sale del ambiente con el que
 * se resolvió el host (`mapDiditDecision`), así que el host y la etiqueta no pueden discrepar.
 *
 * 🔴 ESTE SET NO ABRE NADA POR SÍ SOLO, y ese es el punto. Está separado de `REAL_KYC_PROVENANCES`
 * a propósito: la regla es que **un KYC simulado sólo puede desbloquear un desembolso simulado**.
 * Con un provider de payout REAL configurado, estar acá adentro no sirve de nada — la rama que lo
 * acepta pregunta primero si el desembolso mueve plata de verdad, y si la mueve, no acepta.
 * PROHIBIDO fusionar los dos sets, y PROHIBIDO agregar `didit-mock` al de arriba.
 */

export const MOCK_KYC_PROVENANCES = new Set<string>(["didit-mock"]);

/**
 * Etiqueta de origen para lo que devuelve el adapter de Didit. Sale del ambiente DECLARADO, no de un
 * literal.
 *
 * 🔴 POR QUÉ. Hasta acá las dos salidas de este adapter escribían `provenance: "didit"` fijo, así que
 * CUALQUIER host que se configurara quedaba etiquetado como verificación real. Mientras el único host
 * posible era el de Didit eso era cierto por construcción; con un mock configurable deja de serlo, y
 * `REAL_KYC_PROVENANCES` (arriba) es justamente lo que decide si el desembolso abre. Una etiqueta que
 * no mira contra quién se habló convierte ese set en decorativo.
 *
 * El mismo arreglo vive en `chaski-v3/src/infrastructure/didit/decision.ts`. Son dos repos y dos
 * adapters distintos que consultan al MISMO proveedor: los dos tenían el literal y los dos lo pierden.
 */
export function provenanceForEnvironment(env: DiditEnvironment): string {
  return env === "live" ? "didit" : "didit-mock";
}

/**
 * WKH-204: normalización ÚNICA de identity claims. Sirve a las DOS convenciones de vendor_data:
 * deja el DNI (dígitos) intacto y vuelve el wallet address EVM case-insensitive.
 * ÚNICA fuente (CD-9): la consumen kyc.ts (DiditKycProvider.status) y cashout-payout.ts (C4).
 * PROHIBIDO duplicarla — mismo criterio que REAL_KYC_PROVENANCES: el drift es lo que previene.
 */
export function normalizeIdentity(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Shape de la respuesta EXTERNA de Didit que consume `verify()` — reemplaza a los casts crudos sin
 * validar que había sobre `res.json()`. Tres decisiones, las tres deliberadas:
 *
 *  1. Declara SOLO los 4 campos que el código lee (`status`, `aml.hits`, `session_id`, `id`).
 *  2. 🔴 NO es `.passthrough()` (a diferencia de los schemas de fx.ts): con el strip por default de
 *     zod, el objeto parseado NO PUEDE cargar `id_verifications[]`, `first_name`, `document_number`
 *     ni `date_of_birth` — CD-7 pasa de ser una regla escrita en un comentario a ser una propiedad
 *     del tipo. Los campos extra del partner NO invalidan la respuesta (zod los descarta en
 *     silencio, no falla), así que la tolerancia a campos nuevos se mantiene intacta.
 *  3. Todo `.nullish()` + `hits: z.unknown()`: el schema TIPA, no DECIDE. La decisión de compliance
 *     sigue viviendo abajo (`decision === "approved" && amlHits === 0`) y en assertValidKycStatus.
 *
 * Los nombres exactos siguen sandbox-unverified: los fija el TODO(sandbox) de `verify()`.
 */
const DiditVerifyResponseSchema = z.object({
  // Didit manda "Approved"; se aceptan escalares (se coercen con String(), como antes), pero un
  // objeto/array NO se lee como estado: cae en la degradación fail-closed.
  status: z.union([z.string(), z.number(), z.boolean()]).nullish(),
  aml: z.object({ hits: z.unknown() }).nullish(),
  session_id: z.union([z.string(), z.number()]).nullish(),
  id: z.union([z.string(), z.number()]).nullish(),
});
type DiditVerifyResponse = z.infer<typeof DiditVerifyResponseSchema>;

/** Adapter Didit — activo cuando DIDIT_API_KEY está seteada. */
export class DiditKycProvider implements KycProvider {
  /**
   * `baseUrl` es un `DiditBaseUrl` (BRANDED) y se RECIBE, no se lee de una env acá: mismo contrato
   * que `TransFiPayoutProvider` (payout.ts:109). Es lo que garantiza por COMPILADOR que el único
   * origen de host es `resolveDiditBaseUrl()` — un `string` cualquiera (un default nuevo, un literal
   * hardcodeado) no compila como argumento. Antes esto era un `const` de módulo con
   * `?? "<host productivo>"`: sin env seteada, el adapter hablaba con la producción de Didit.
   */
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: DiditBaseUrl,
    /**
     * Ambiente con el que se resolvió `baseUrl`. Se RECIBE por la misma razón que el host: si se
     * leyera de la env acá adentro, el host y la etiqueta podrían salir de dos lecturas distintas, y
     * la forma de divergir sería etiquetar como real algo consultado contra el mock. Vienen del mismo
     * lugar (`getKycProvider`) o no vienen.
     */
    private readonly environment: DiditEnvironment,
  ) {}

  async verify(input: KycInput): Promise<KycResult> {
    // Didit expone verificación por "session"; acá se crea/consulta la verificación
    // del legalId (DNI) + screening AML. La forma exacta de request/response se fija
    // con el sandbox (Fase A) — TODO: mapear campos reales.
    //
    // 🔴 LA VERSIÓN DEL PATH ES `v3` Y TIENE QUE COINCIDIR CON LA DE `status()` (abajo).
    // Hasta 2026-08-04 esta línea decía `/v2/session/` mientras `status()` consultaba
    // `/v3/session/{id}/decision/`: el agente creaba la sesión en una versión y la consultaba en
    // otra. Medido en producción ese día: el host configurado (el mock de `chaski-v3`) responde 404
    // a `POST /v2/session/` y 200 a `POST /v3/session/`, así que TODA invocación del agente
    // publicado terminaba en `didit_error_404` → 502 `verification_unavailable`, cobrada igual.
    // `v3` no es "la versión que sirve el mock": es la que `chaski-v3` usa contra el Didit REAL
    // (`app/api/kyc/session/route.ts:72`, el flujo hosted-redirect que ya corre en producción).
    const res = await fetch(`${this.baseUrl}/v3/session/`, {
      method: "POST",
      signal: AbortSignal.timeout(8000), // MNR-3: no colgar el money-path si el partner stallea
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
      },
      body: JSON.stringify({
        // TODO(sandbox): confirmar el payload exacto de Didit (features: id-verification,
        // liveness, aml). Enviar legalId + país + datos para el screening.
        vendor_data: input.legalId,
        features: ["ID_VERIFICATION", "LIVENESS", "AML"],
        metadata: { senderCountry: input.senderCountry, purpose: input.purpose },
      }),
    });
    if (!res.ok) {
      throw new Error(`didit_error_${res.status}`);
    }
    const parsed = DiditVerifyResponseSchema.safeParse(await res.json());
    // Shape NO reconocible → NO se lanza (antes tampoco: un `status` de tipo raro se coercía con
    // String() y caía en approved:false). Se degrada por el MISMO camino, con todos los campos
    // AUSENTES: `decision` queda "" → nunca "approved" → fail-closed, y `payoutAllowed` del agente
    // queda false. Lo único que cambia es que el fallo deja rastro (warn + reason) en vez de ser
    // silencioso — y que un body `null`, que antes tiraba un TypeError crudo, ahora degrada limpio.
    if (!parsed.success) {
      // CD-7: etiqueta value-free. PROHIBIDO loguear el body ni los issues de zod (traen los
      // nombres de los campos del partner y, según la versión, valores recibidos).
      console.warn("[remit-kyc] didit_verify_bad_shape → approved:false (fail-closed)");
    }
    const data: DiditVerifyResponse = parsed.success ? parsed.data : {};
    // TODO(sandbox): mapear la decisión real de Didit (status/aml.hits/risk).
    const decision = String(data.status ?? "").toLowerCase();
    // ⚠️ El `Array.isArray(...) ? .length : 0` se PRESERVA tal cual, fail-open latente incluido
    // (si Didit no manda un array, `amlHits` cae a 0): confirmar la forma real es el item 2 del
    // TODO(sandbox) de status(), founder-gated. De ahí el `hits: z.unknown()` del schema — tipa el
    // campo sin fingir que su forma está confirmada, y sin cambiar la decisión de compliance.
    const amlHitsRaw = data.aml?.hits;
    const amlHits = Array.isArray(amlHitsRaw) ? amlHitsRaw.length : 0;
    const approved = decision === "approved" && amlHits === 0;
    return {
      approved,
      riskLevel: amlHits > 0 ? "high" : approved ? "low" : "medium",
      reasons: approved
        ? []
        : [
            // El discriminador de shape se AGREGA (no reemplaza): los reasons históricos se siguen
            // emitiendo igual para no romper consumidores. Value-free, como el resto (CD-4/CD-7).
            ...(parsed.success ? [] : ["didit_response_bad_shape"]),
            `didit_status_${decision}`,
            `aml_hits_${amlHits}`,
          ],
      travelRuleData: buildTravelRule(input),
      verificationId: String(data.session_id ?? data.id ?? "unknown"),
      provenance: provenanceForEnvironment(this.environment),
    };
  }

  async status(verificationId: string, identityClaim: string): Promise<KycStatusResult> {
    // TODO(sandbox / DIDIT_ADAPTER_READY — R-1): checklist OBLIGATORIO antes de activar
    // DIDIT_ADAPTER_READY=true. Los TRES items son bloqueantes:
    //
    // 1. CUERPO del create (2026-08-04 — REEMPLAZA al viejo item "compat v2↔v3"): las dos llamadas
    //    de este adapter ya viven en la MISMA versión (`POST /v3/session/` en verify() +
    //    `GET /v3/session/{id}/decision/` acá), así que no queda ninguna pregunta de compat entre
    //    versiones. Lo que sigue SIN confirmar contra Didit real es el BODY que manda verify():
    //    hoy manda `features: ["ID_VERIFICATION","LIVENESS","AML"]` y NO manda `workflow_id`,
    //    mientras el único llamador nuestro que habló con el Didit REAL (chaski-v3
    //    `app/api/kyc/session/route.ts:72-80`) manda `workflow_id` + `vendor_data` + `callback`.
    //    El mock no exige `workflow_id`, así que la diferencia NO se ve en DIDIT_ENV=mock. Si Didit
    //    lo exige, con DIDIT_ENV=live el create devuelve !ok → `didit_error_<n>` → 502: fail-SAFE,
    //    nunca fail-open. Confirmarlo (y, si hace falta, agregar DIDIT_WORKFLOW_ID) es parte del
    //    checklist previo a DIDIT_ADAPTER_READY=true contra el host real.
    //
    // 2. ⚠️ FORMA DE `aml.hits` — FAIL-OPEN LATENTE (AR/MNR-1): confirmar contra el sandbox la
    //    forma EXACTA que devuelve Didit. ¿Es un array? ¿Un número (`aml: { hits: 3 }`)? ¿Otro
    //    nombre (`aml: { total_hits: [...] }`)? ¿Puede venir `aml: null`?
    //    El `Array.isArray(amlHitsRaw) ? ... : 0` de abajo asume ARRAY: si NO es un array,
    //    `amlHits` cae a 0 en silencio y un KYC con hits de AML REALES pasaría como
    //    `approved: true` con `riskLevel:"low"`. A diferencia del item 1, este NO es fail-safe:
    //    es un fail-OPEN de compliance en el money-path. Hoy es inocuo SOLO porque el adapter
    //    entero está tras DIDIT_ADAPTER_READY — activarlo sin confirmar esto lo vuelve real.
    //
    // 3. 🆕 (WKH-204 / R-5): confirmar que GET /v3/session/{id}/decision/ realmente ECOA
    //    `vendor_data`, y con qué nombre/forma exacta. chaski-v2 lo asume (decision.ts:19) y
    //    WKH-180 lo dio por bueno, pero ESTE repo nunca lo verificó contra el sandbox. Es
    //    fail-SAFE: si no lo ecoa → identityMatches:false → rama C5 → blocked, NUNCA fail-open.
    //    Sin esto confirmado, el binding de identidad bloquea TODO en prod.
    // CD-7: de este JSON se leen SOLO status, aml.hits, session_id y vendor_data. PROHIBIDO leer/
    // loguear id_verifications[], first_name, last_name, document_number, date_of_birth.
    // `vendor_data` se usa para COMPARAR y se DESCARTA: nunca va a reasons, al return ni a un log.
    const res = await fetch(`${this.baseUrl}/v3/session/${encodeURIComponent(verificationId)}/decision/`, {
      method: "GET",
      signal: AbortSignal.timeout(8000), // igual que payout.ts:47 — no colgar el money-path
      headers: { "x-api-key": this.apiKey },
    });
    if (!res.ok) throw new Error(`didit_status_error_${res.status}`); // fail-closed (rama B6)
    const d = (await res.json()) as Record<string, unknown>;
    const decision = String(d.status ?? "").toLowerCase(); // Didit manda "Approved"
    const amlHitsRaw = (d.aml as { hits?: unknown } | undefined)?.hits;
    const amlHits = Array.isArray(amlHitsRaw) ? amlHitsRaw.length : 0;
    const approved = decision === "approved" && amlHits === 0; // mismo criterio que verify()
    const echoed = String(d.session_id ?? "");
    if (echoed !== "" && echoed !== verificationId) {
      throw new Error("didit_status_id_mismatch"); // rama B10, fail-closed
    }

    // WKH-204 / C5-C8 — el binding de identidad. La comparación vive ACÁ a propósito (CD-7):
    // `vendor_data` en este repo es el DNI; exponerlo crudo filtraría PII. Solo sale un booleano.
    //
    // 🔴 C8 — narrowing por `typeof`, NUNCA `String(...)`: `String(123)` es "123" (NO ""), así que
    // un vendor_data no-string ALCANZARÍA la comparación y un claim "123" MATCHEARÍA = fail-open
    // (misma clase que WKH-198/WKH-203). Un tipo inesperado DEBE colapsar a "" y bloquear por C5.
    const vendorRaw: unknown = d.vendor_data;
    const vendorData = typeof vendorRaw === "string" ? vendorRaw : ""; // C8 → "" → cae en C5
    const normalizedVendor = normalizeIdentity(vendorData);

    // C5: sin vendor_data no hay CONTRA QUÉ comparar → BLOQUEAR. C6: distinto → false. C7: igual → true.
    // ⚠️ El `normalizedVendor !== ""` va PRIMERO y es un AND: PROHIBIDO la forma de chaski-v2
    // (`vendorData !== "" && vendorData !== claim`), que OMITE el check si viene vacío → fail-OPEN
    // (CD-12, probado ejecutando por el AR de WKH-202). La divergencia con chaski-v2 ES el fix.
    const identityMatches =
      normalizedVendor !== "" && normalizedVendor === normalizeIdentity(identityClaim);

    // WKH-204 fix-pack / R-5 — discriminador VALUE-FREE para ops. El agente recibe SOLO un booleano
    // (CD-7, y está bien así), así que NO puede distinguir "Didit no ecoó vendor_data" (C5) de "el
    // claim no matchea" (C6): para él son la misma señal. La diferencia es crítica: R-5 = este repo
    // NUNCA verificó contra el sandbox que GET /v3/.../decision/ realmente ecoe `vendor_data`. Si no
    // lo ecoa, el binding bloquea TODO en prod y ops ve una avalancha de warns idénticos,
    // indistinguibles de un ataque real. Esta es la única señal que separa "falla de integración"
    // (identity_no_binding masivo) de "alguien está atacando" (identity_mismatch puntual).
    //
    // 🔴 Son ETIQUETAS DE RAMA, NUNCA valores: PROHIBIDO interpolar acá el vendor_data, el claim o
    // cualquier derivado (CD-4/CD-7). El contrato de `reasons` ya exige value-free.
    // 🔴 El nombre NO contiene el literal "vendor_data" A PROPÓSITO: el canario CD-7 de kyc.test.ts
    // assertea que ese literal jamás cruza el borde. No se debilita un canario de PII para acomodar
    // el nombre de una etiqueta — se elige otro nombre. (De ahí `no_binding` y no `no_vendor_data`.)
    const identityReasons = identityMatches
      ? []
      : [normalizedVendor === "" ? "identity_no_binding" : "identity_mismatch"];

    return assertValidKycStatus({
      approved,
      verificationId, // canónico = el PEDIDO (igual que payout.ts:53)
      provenance: provenanceForEnvironment(this.environment),
      identityMatches,
      // Los dos ejes son INDEPENDIENTES (una verificación puede estar aprobada Y no ser tuya):
      // por eso los reasons de identidad se CONCATENAN, no reemplazan a los de compliance.
      reasons: [
        ...(approved ? [] : [`didit_status_${decision}`, `aml_hits_${amlHits}`]),
        ...identityReasons,
      ],
    });
  }
}

/**
 * Fallback determinístico — corre SIN keys de partner (dev/demo/CI).
 * NO es verificación real: aplica reglas conservadoras y SIEMPRE se tagea
 * `provenance:"local-fallback"`. En producción, un payout REAL debe exigir
 * KYC con provenance !== "local-fallback" (ver el hard-gate del orquestador).
 */
export class FallbackKycProvider implements KycProvider {
  async verify(input: KycInput): Promise<KycResult> {
    const reasons: string[] = ["fallback_no_real_verification"]; // MNR-1: siempre explicitar que NO es real
    const hasLegalId = input.legalId.trim().length >= 6;
    if (!hasLegalId) reasons.push("missing_or_short_legal_id");
    // regla demo: montos altos → medium/high (proxy de "requiere KYC reforzado")
    const highAmount = input.amountUsd >= 1000;
    if (highAmount) reasons.push("high_amount_requires_enhanced_kyc"); // MNR-1: reason auditable
    const approved = hasLegalId; // determinístico, no verifica identidad real
    return {
      approved,
      riskLevel: !approved ? "high" : highAmount ? "medium" : "low",
      reasons,
      travelRuleData: buildTravelRule(input),
      verificationId: `fallback-${hashLite(input.legalId)}`,
      provenance: "local-fallback",
    };
  }

  async status(verificationId: string, _identityClaim: string): Promise<KycStatusResult> {
    // NO es verificación real y NO hay store: determinístico y SIEMPRE tageado local-fallback.
    // Es INOCUO por construcción: REAL_KYC_PROVENANCES lo bloquea en prod SIEMPRE (rama B3).
    // El `approved: true` NO abre nada — la seguridad vive en la allowlist del gate (B3/B4),
    // igual que en FallbackKycProvider.verify() (approved = hasLegalId).
    return {
      approved: true,
      verificationId,
      provenance: "local-fallback",
      // WKH-204 / C9: NO tiene store y NO debe fingir que lo tiene (mismo razonamiento que su
      // `approved: true`). INOCUO por construcción: B3 lo bloquea en prod SIEMPRE, y en dev/CI
      // exige ALLOW_FALLBACK_KYC=true (B5). La seguridad vive en la allowlist, no acá.
      identityMatches: true,
      reasons: ["fallback_no_real_verification"], // mismo reason que FallbackKycProvider.verify()
    };
  }
}

function buildTravelRule(input: KycInput): KycResult["travelRuleData"] {
  return {
    originator: {
      name: input.senderName,
      country: input.senderCountry,
      legalId: input.legalId,
    },
    beneficiary: { name: input.receiverName, country: input.receiverCountry },
  };
}

// guard de salida — fail-loud. WKH-203/CD-8 (anti WKH-198): `approved` DEBE ser booleano real;
// nunca dejar que un undefined/NaN-ish se lea como señal de compliance.
export function assertValidKycStatus(s: KycStatusResult): KycStatusResult {
  if (typeof s.approved !== "boolean") throw new Error("invalid_kyc_status_approved");
  if (!s.verificationId) throw new Error("invalid_kyc_status_id");
  if (!s.provenance) throw new Error("invalid_kyc_status_provenance");
  // WKH-204/C10: espejo exacto del guard de `approved` — una señal de binding no-booleana
  // NUNCA debe llegar al gate (anti-WKH-198).
  if (typeof s.identityMatches !== "boolean") throw new Error("invalid_kyc_status_identity");
  return s;
}

// hash liviano determinístico (no cripto) solo para un id estable en fallback
function hashLite(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

/**
 * Factory: adapter Didit si hay key + readiness confirmado, si no el fallback.
 * MNR-2 (AR): el mapeo de campos del adapter es sandbox-unverified hasta la Fase A. Setear solo
 * la key NO debe activar el adapter en el money-path a ciegas → se exige `DIDIT_ADAPTER_READY=true`
 * (opt-in explícito tras confirmar el mapeo). Key sin readiness = fail-loud, NO downgrade silencioso.
 */
export function getKycProvider(): KycProvider {
  const key = process.env.DIDIT_API_KEY;
  if (!key) return new FallbackKycProvider();
  if (process.env.DIDIT_ADAPTER_READY !== "true") {
    throw new Error(
      "didit_adapter_not_ready: DIDIT_API_KEY seteada pero DIDIT_ADAPTER_READY!=true — " +
        "confirmá el mapeo de campos con el sandbox antes de activar el adapter en el money-path.",
    );
  }
  // `resolveDiditBaseUrl()` se llama ACÁ y no antes: es el punto donde se construye el adapter REAL
  // (mismo lugar que `getPayoutProvider()` llama a `resolveTransFiBaseUrl()`). Consecuencia
  // deliberada: la rama de arriba (sin key → FallbackKycProvider) NUNCA necesita `DIDIT_ENV`, así
  // que el deploy devnet actual sigue andando inerte sin tocar ninguna env nueva. El fail-closed
  // solo muerde a quien de verdad va a hablarle a Didit.
  return new DiditKycProvider(key, resolveDiditBaseUrl(), resolveDiditEnvironment());
}
