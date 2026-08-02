// remit-cashout-payout — agente de payout. v2 PARALELA de agentshop-cashout-matcher.
// El demo (agentshop-*) queda INTACTO y vivo (jurado Team1); esto es un slug/servicio NUEVO.
//
// ⚠️ Este agente es el LEAF que llama al partner de payout. El movimiento del PRINCIPAL real +
// la máquina de estados (quote-lock → principal-in → payout → reconcile → refund) es la capa de
// VALUE-DELIVERY (WKH-168), gated al sandbox de TransFi. Acá NO se escribe money-code a ciegas:
// el fallback es un mock que NO mueve plata, y hay fail-safes para que no se ejecute payout real
// sin un provider real configurado.

import { z } from "zod";
import { getPayoutProvider } from "../providers/payout";
import {
  getKycProvider,
  MOCK_KYC_PROVENANCES,
  normalizeIdentity,
  REAL_KYC_PROVENANCES,
} from "../providers/kyc";
import { checkQuoteBinding } from "../providers/quote-ref";
import type { KycStatusResult, PayoutResult } from "../providers/types";

export const SLUG = "remit-cashout-payout";
export const PRICE_USDC = 0.03;

export const CashoutPayoutInputSchema = z.object({
  // La referencia AUTENTICADA que emitió `remit-corridor-fx`. Lleva el monto cotizado firmado
  // adentro: es lo que permite que este agente verifique la cotización que dice honrar, en vez de
  // creerle al caller. Zod sólo exige que sea un string no vacío — la resolución real ocurre en el
  // núcleo (`checkQuoteBinding`), donde un rechazo puede devolver 200 blocked con un motivo propio
  // en vez de un 400 `invalid_input` que se confundiría con un error de schema.
  quoteId: z.string().min(1),
  // 🔴 NO ES UN CAMPO LIBRE, aunque lo parezca por el schema: tiene que ser EXACTAMENTE el monto que
  // se cotizó bajo ese `quoteId`. Hasta 2026-07-31 sí era libre, y una cotización de 100 USD servía
  // para pedir un desembolso de un millón (ver el encabezado de `quote-ref.ts`).
  amountUsd: z.number().positive(),
  kycVerificationId: z.string().min(1), // handle del KYC (el Travel Rule se recupera por acá, no PII inline)
  // WKH-203/DT-4: `kycPayoutAllowed` FUE ELIMINADO a propósito. El input NO decide compliance:
  // la decisión se re-deriva server-side en isKycGatePassed(). z.object sin .strict() strippea
  // la key en silencio → los callers que la sigan mandando NO se rompen (compat), pero
  // `input.kycPayoutAllowed` ya NO compila: la confianza en el caller es estructuralmente imposible.
  // WKH-204: identity claim del sender. String OPACO a propósito (CD-11): PROHIBIDO z.enum/z.literal
  // ni un discriminado {type,value} — z.enum ECOA el valor recibido en parsed.error.flatten(), que
  // route.ts:15 devuelve en el 400 → fuga de PII. Semántica: "el valor que quedó ligado (vendor_data)
  // a esa verificación en su creación" (el DNI si la creó remit-kyc-validator; el address si chaski-v2).
  // ⚠️ optional() a propósito: un campo requerido ausente daría 400 invalid_input — indistinguible de
  // un error de schema real y semánticamente falso (no falta input, falta AUTORIZACIÓN). Con optional()
  // + rama de gate da 200 blocked/kyc_identity_claim_missing: igual de fail-closed, pero auditable.
  senderIdentity: z.string().min(1).optional(),
  // WKH-204/CD-16 — LEGADO/DEPRECADO: puente de compat con chaski-v2, que ya manda `address` no-vacío
  // (submit/route.ts:59-62) y forwardea el body verbatim (:102) — hoy Zod lo strippea en silencio.
  // NO es un fail-open: es un claim real que se compara con las MISMAS ramas fail-closed.
  // PROHIBIDO construir features nuevas sobre él. Se elimina cuando chaski-v2 mande `senderIdentity`.
  address: z.string().min(1).optional(),
  beneficiary: z.object({
    name: z.string().min(1),
    country: z.string().min(2),
    method: z.enum(["yape", "plin", "bank_cci"]),
    destination: z.string().min(1),
  }),
  idempotencyKey: z.string().min(1),
});

export type CashoutPayoutInput = z.infer<typeof CashoutPayoutInputSchema>;

export interface CashoutPayoutOutput {
  slug: string;
  executed: boolean; // si se intentó el payout (false = gate bloqueó)
  status: PayoutResult["status"] | "blocked";
  payoutId: string | null;
  deliveredLocal: number | null;
  txRef: string | null;
  reason: string | null;
  provenance: string;
  depositAddress: string | null; // WKH-212: address dedicada del create-order (null en mock/blocked)
}

/**
 * FAIL-SAFE: nunca ejecutar un payout REAL con el fallback (mock). En prod se exige un provider
 * real (TransFi key + readiness); en dev el fallback requiere opt-in explícito y ruidoso.
 */
/**
 * ¿El desembolso mueve plata de verdad? Extraída de `assertPayoutProviderSafe` para tener UNA sola
 * definición: la consumen el fail-safe de abajo y el gate de KYC simulado (`isKycGatePassed`). Dos
 * copias de este predicado divergirían, y la forma de divergir sería que una diga "es mock" mientras
 * la otra desembolsa de verdad, que es exactamente el escenario que no puede pasar.
 */
export function isPayoutProviderReal(): boolean {
  return (
    !!process.env.TRANSFI_USERNAME &&
    !!process.env.TRANSFI_PASSWORD &&
    !!process.env.TRANSFI_MID &&
    process.env.TRANSFI_ADAPTER_READY === "true"
  );
}

function assertPayoutProviderSafe(): void {
  const hasReal = isPayoutProviderReal();
  if (hasReal) return;
  if (process.env.NODE_ENV === "production") {
    // ⚠️ SEGURIDAD MONEY-PATH (WKH-172, etapa 1): PAYOUT_ALLOW_MOCK habilita SOLO el
    // FallbackPayoutProvider (mock, NUNCA mueve plata). NO abre ningún path a desembolso real:
    // el path real sigue gated por TRANSFI_USERNAME + TRANSFI_PASSWORD + TRANSFI_MID +
    // TRANSFI_ADAPTER_READY==="true" (el `hasReal` de arriba, y de nuevo en getPayoutProvider()).
    // NO lo gatea TRANSFI_API_KEY: esa la lee fx.ts y nadie de este path (ver el comentario de
    // getPayoutProvider() en providers/payout.ts). Auditar el candado por esa variable es mirar
    // la que no es: setearla o borrarla no mueve NADA del payout.
    // Ojo que los dos modos de falla NO son el mismo: faltando cualquiera de las 3 credenciales
    // se cae al mock en silencio, mientras que con las 3 puestas y TRANSFI_ADAPTER_READY!=="true"
    // getPayoutProvider() LANZA transfi_adapter_not_ready en vez de degradar al mock.
    // Activar este flag en CUALQUIER deploy que no sea el de etapa 1 (mock) es un
    // INCIDENTE DE SEGURIDAD money-path.
    if (process.env.PAYOUT_ALLOW_MOCK !== "true") {
      throw new Error("payout_refused: se requiere provider de payout REAL en producción (no fallback)");
    }
    console.warn(
      "[remit-payout] PROD + PAYOUT_ALLOW_MOCK: usando payout FALLBACK (mock, NO mueve plata) — SOLO etapa 1",
    );
    return;
  }
  if (process.env.ALLOW_FALLBACK_PAYOUT !== "true") {
    throw new Error(
      "payout_refused: el payout fallback (mock) requiere ALLOW_FALLBACK_PAYOUT=true explícito (solo dev/CI)",
    );
  }
  console.warn("[remit-payout] usando payout FALLBACK (mock, NO mueve plata) — solo dev/CI");
}

/**
 * WKH-204 / C1-C4: la identity claim resuelta + DE DÓNDE vino.
 * `source` es un discriminador VALUE-FREE (conjunto cerrado de 2 literales) — sirve para diagnosticar
 * el flujo legado en los logs sin tocar `value`. 🔴 PROHIBIDO loguear `value` (es el DNI — CD-4/CD-7).
 */
type IdentityClaim = { value: string; source: "senderIdentity" | "address" };

/**
 * WKH-204 / C1-C4: resuelve la identity claim del caller. Devuelve null = BLOQUEAR (fail-closed).
 * CD-15 — precedencia determinística: `senderIdentity` (explícito) GANA sobre `address` (legado).
 * PROHIBIDA cualquier rama "ambos presentes y discrepan → ambiguo": gana el explícito, siempre.
 */
function resolveIdentityClaim(input: CashoutPayoutInput): IdentityClaim | null {
  const claim = input.senderIdentity ?? input.address; // C1 / C2
  if (claim === undefined) return null; // C3
  // 🔴 C4 — NO la borres "porque min(1) ya lo cubre": NO lo cubre. z.string().min(1) NO trimea
  // (verificado ejecutando con zod 3.25.76: "   " → success:true). Un claim "   " ATRAVIESA Zod.
  // Sin C4, si vendor_data también viniera vacío, "" === "" matchearía = fail-open clase WKH-198.
  // C5 también lo ataja, pero son defensa en profundidad y cada una debe existir por separado:
  // C4 evita además gastar una llamada a Didit y dar señal al caller.
  if (normalizeIdentity(claim) === "") return null; // C4
  // `source` espeja el `??` de arriba: si senderIdentity resolvió, ganó él (CD-15). Un senderIdentity
  // whitespace NO cae al address: ya ganó en el `??` y C4 lo bloquea — comportamiento preservado.
  return {
    value: claim,
    source: input.senderIdentity !== undefined ? "senderIdentity" : "address",
  };
}

/**
 * WKH-203: el input NO decide compliance. Se consulta la fuente autoritativa por verificationId.
 * Misma allowlist (REAL_KYC_PROVENANCES) y mismo default `false` que isPayoutAllowed()
 * (kyc-validator.ts). NO es un espejo byte-a-byte: la comparación de `approved` es MÁS ESTRICTA
 * A PROPÓSITO (`!== true` acá vs. la truthiness `!kyc.approved` de kyc-validator.ts) — CD-8 /
 * anti-WKH-198: un `approved` no-booleano NUNCA debe leerse como señal de compliance.
 * ⚠️ NO "alinear" este gate con la truthiness de kyc-validator.ts: la divergencia es el fix.
 * Default = BLOQUEAR: no existe ninguna rama "else → allow".
 *
 * WKH-204: además de que la verificación esté APROBADA, ahora se exige que sea DEL que pide el
 * payout (binding verificationId ↔ sender) vía `identityMatches` (C11). La comparación real vive
 * DENTRO del provider (CD-7): acá solo llega un booleano derivado, nunca el vendor_data/DNI.
 */
async function isKycGatePassed(verificationId: string, claim: IdentityClaim): Promise<boolean> {
  // B7: FUERA del try — su throw (didit_adapter_not_ready) DEBE propagar fail-loud (CD-12).
  // Si esto se mete adentro del try se convierte en kyc_gate_unavailable y se rompe la rama B7:
  // key sin readiness sería un downgrade silencioso al fallback.
  const kycProvider = getKycProvider();
  let s: KycStatusResult;
  try {
    s = await kycProvider.status(verificationId, claim.value);
  } catch (err) {
    // B6: partner caído/timeout ≠ aprobado. Nunca "asumir true".
    console.warn("[remit-payout] kyc gate unavailable:", {
      errorName: err instanceof Error ? err.name : "unknown", // nunca err.message/input (CD-4)
    });
    throw new Error("kyc_gate_unavailable");
  }
  if (s.approved !== true) return false; // B2 + B9: estricto, NUNCA truthy (CD-8, anti-WKH-198)
  // 🔴 C11 (WKH-204): la verificación está aprobada, ¿pero es DEL que pide el payout? Va DESPUÉS de
  // `approved` y ANTES de la allowlist: es un AND que SOLO PUEDE RESTAR allows — ningún camino que
  // hoy devuelve false pasa a devolver true. PROHIBIDO un ||, un early-return que saltee B1-B10, o
  // mover esta línea. PROHIBIDO `!s.identityMatches` (truthiness): es `!== true` estricto (CD-8).
  if (s.identityMatches !== true) {
    // CD-13: discriminación fina para ops, VALUE-FREE — nunca el claim, nunca el vendor_data/DNI.
    //
    // fix-pack: el viejo `identityClaimPresent: true` era una TAUTOLOGÍA — C11 es inalcanzable si el
    // claim no resolvió (resolveIdentityClaim → null → early-return en runCashoutPayout), así que
    // nunca podía ser false: cero información, y se leía como si fuera dinámico. Lo reemplazan dos
    // señales que SÍ discriminan:
    //  · `reasons` (del provider): separa identity_no_binding (Didit no ecoó vendor_data → R-5, falla
    //    de INTEGRACIÓN, se ve masiva y pareja) de identity_mismatch (claim ajeno → ATAQUE, puntual).
    //    Sin esto, ops no puede distinguir "la integración está rota" de "nos están atacando".
    //    Es value-free POR CONTRATO (KycStatusResult.reasons). En C11 solo trae los identity_*:
    //    `approved` ya es true acá (B2 filtró antes), así que el eje compliance no aporta reasons.
    //  · `claimSource`: senderIdentity (moderno) vs address (legado chaski-v2/CD-16) — conjunto
    //    cerrado de literales, nunca el valor.
    // 🔴 PROHIBIDO agregar acá `claim.value`, el vendor_data o cualquier derivado del DNI (CD-4/CD-7).
    console.warn("[remit-payout] kyc identity binding mismatch:", {
      branch: "C11",
      claimSource: claim.source,
      reasons: s.reasons,
    });
    return false;
  }
  if (REAL_KYC_PROVENANCES.has(s.provenance)) return true; // B1: única rama que abre con plata real
  // B1-sim: KYC SIMULADO. Sólo abre si el desembolso TAMPOCO mueve plata. Con un provider real
  // configurado esta rama no devuelve nada y se sigue de largo hasta el `return false` final: una
  // verificación que nadie hizo no puede desembolsar dinero de verdad, y no depende de que alguien
  // se acuerde de chequearlo — no hay ninguna rama que lo permita.
  //
  // El orden importa y es el mismo criterio que B1/B3: la pregunta por el dinero va PRIMERO. Y
  // `isPayoutProviderReal()` es la MISMA función que usa el fail-safe del provider, no una copia:
  // si las dos pudieran discrepar, la forma de discrepar sería aceptar un KYC falso contra un
  // desembolso real.
  if (MOCK_KYC_PROVENANCES.has(s.provenance)) {
    if (isPayoutProviderReal()) {
      console.warn(
        "[remit-payout] KYC SIMULADO rechazado: el provider de payout es REAL. Una verificación " +
          "que nadie hizo no desembolsa plata de verdad.",
        { branch: "B1-sim" },
      );
      return false;
    }
    console.warn(
      "[remit-payout] gate KYC pasado con verificación SIMULADA (didit-mock) contra un payout que " +
        "TAMPOCO mueve plata — recorrido de prueba, nada de esto es un desembolso",
      { branch: "B1-sim" },
    );
    return true;
  }
  // B3: en prod el fallback JAMÁS abre — ninguna env puede abrirlo. El orden (isProd primero)
  // es deliberado: no lo inviertas.
  const isProd = process.env.NODE_ENV === "production";
  if (!isProd && process.env.ALLOW_FALLBACK_KYC === "true") {
    // B5
    console.warn(
      "[remit-payout] gate KYC pasado con provenance FALLBACK (no verificación real) — solo dev/CI",
    );
    return true;
  }
  return false; // B3/B4/B8: default = BLOQUEAR
}

/**
 * Core del agente. Devuelve el objeto que va dentro de `{ result }`.
 * Lanza ZodError si el input es inválido; lanza `payout_refused` si el fail-safe bloquea;
 * lanza `kyc_gate_unavailable` si el gate KYC no se puede resolver (B6 → 502, fail-closed);
 * lanza `quote_binding_secret_unset` en producción sin `QUOTE_BINDING_SECRET` (→ 502: es un defecto
 * de NUESTRA config, no una cotización mala del caller — por eso NO es el `blocked` de abajo).
 */
export async function runCashoutPayout(raw: unknown): Promise<CashoutPayoutOutput> {
  const input = CashoutPayoutInputSchema.parse(raw); // 1. (ya sin kycPayoutAllowed — DT-4)

  assertPayoutProviderSafe(); // 2. INTACTO (CD-1) — throws primero, como hoy
  const provider = getPayoutProvider(); // 3. INTACTO — throws adapter_not_ready, como hoy

  // 4. EL BINDING CON LA COTIZACIÓN. Hasta acá el agente aceptaba `quoteId` y `amountUsd` como dos
  // campos INDEPENDIENTES del caller y no leía nunca la cotización que decía estar honrando: cotizar
  // 100 y desembolsar un millón con ese mismo `quoteId` daba `executed:true` (medido). El techo
  // `FX_MAX_SEND_USD` quedaba del lado de la cotización y no llegaba nunca hasta acá.
  //
  // Va DESPUÉS de 2 y 3 (CD-1: cuando hay dos problemas, gana el error de payout) y ANTES del gate
  // KYC por el mismo motivo que C3/C4: es cero-I/O y ya determina el rechazo, así que no se gasta
  // una llamada a Didit ni se le da esa señal a un caller cuya cotización ni siquiera resuelve.
  //
  // 🔴 SON TRES ESTADOS, NO DOS. "No coinciden los montos" y "no pude resolver la referencia" NO son
  // el mismo hecho y no comparten motivo: el primero es una respuesta, el segundo es la ausencia de
  // una respuesta. Los dos bloquean, pero quien integra necesita saber cuál le pasó — y ops necesita
  // distinguir una avalancha pareja (referencias viejas / secreto mal configurado) de un intento
  // puntual de falsificación. Un booleano acá habría borrado exactamente esa diferencia.
  const quoteBinding = checkQuoteBinding(input.quoteId, input.amountUsd);
  if (quoteBinding !== "bound") {
    return {
      slug: SLUG,
      executed: false,
      status: "blocked",
      payoutId: null,
      deliveredLocal: null,
      txRef: null,
      // Motivos PROPIOS, distintos de los del agente FX (`fx_amount_below_minimum` /
      // `fx_amount_above_maximum`): aquéllos dicen "el monto está fuera de lo que cotizamos", éstos
      // dicen "el monto no es el de TU cotización". Se corrigen de formas distintas.
      // 🔴 Sin números: ni el monto pedido ni el cotizado. Ecoar el monto de la referencia
      // convertiría al agente en un oráculo que revela, con una referencia ajena, cuánto cotizó otro.
      reason: quoteBinding === "amount_mismatch" ? "quote_amount_mismatch" : "quote_unresolvable",
      provenance: "n/a",
      depositAddress: null,
    };
  }

  // 5. WKH-204 / C1-C4: resolver la identity claim. DESPUÉS de 2 y 3 (CD-1: cuando hay dos
  // problemas, gana el error de payout). C3/C4 bloquean SIN llamar al provider: no se gasta una
  // llamada a Didit ni se le da señal al caller.
  const identityClaim = resolveIdentityClaim(input);
  if (identityClaim === null) {
    return {
      slug: SLUG,
      executed: false,
      status: "blocked",
      payoutId: null,
      deliveredLocal: null,
      txRef: null,
      reason: "kyc_identity_claim_missing",
      provenance: "n/a",
      depositAddress: null, // WKH-212: no hubo payout, no hay address
    };
  }

  // 6. GATE (WKH-203): la decisión de compliance se re-deriva server-side contra la fuente
  // autoritativa, + binding de identidad (WKH-204, C11 adentro). Va DESPUÉS de 2 y 3 a propósito
  // (CD-1: preservar el error de payout cuando hay dos problemas a la vez). getPayoutProvider() es
  // cero-I/O y cero side-effects → inerte y seguro.
  if (!(await isKycGatePassed(input.kycVerificationId, identityClaim))) {
    return {
      slug: SLUG,
      executed: false,
      status: "blocked",
      payoutId: null,
      deliveredLocal: null,
      txRef: null,
      reason: "kyc_gate_not_passed",
      provenance: "n/a",
      depositAddress: null, // WKH-212: no hubo payout, no hay address
    };
  }

  // El Travel Rule data se recupera por kycVerificationId vía canal seguro (NO viaja como PII en el input a2a).
  const travelRuleData = await resolveTravelRuleData(input.kycVerificationId);

  const result = await provider.execute({
    quoteId: input.quoteId,
    amountUsd: input.amountUsd,
    beneficiary: input.beneficiary,
    travelRuleData,
    idempotencyKey: input.idempotencyKey,
  });

  return {
    slug: SLUG,
    executed: true,
    status: result.status,
    payoutId: result.payoutId,
    deliveredLocal: result.deliveredLocal,
    txRef: result.txRef,
    reason: result.failureReason,
    provenance: result.provenance,
    depositAddress: result.depositAddress, // WKH-212: propaga la address del provider (real o null)
  };
}

/**
 * Recupera el Travel Rule data por el handle del KYC, desde un canal/almacén seguro
 * (el store del provider / Didit). STUB hasta la Fase A — no expone PII en el pipeline a2a.
 */
async function resolveTravelRuleData(
  verificationId: string,
): Promise<import("../providers/types").PayoutInput["travelRuleData"]> {
  // TODO(WKH-168 / sandbox): fetch real al store seguro por verificationId.
  return {
    originator: { name: "", country: "", legalId: `ref:${verificationId}` },
    beneficiary: { name: "", country: "" },
  };
}
