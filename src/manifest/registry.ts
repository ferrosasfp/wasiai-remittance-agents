// src/manifest/registry.ts
// Tabla de declaración de los 3 agentes: la ÚNICA fuente de verdad de qué publica cada manifiesto.
//
// CD-3: `chain` vive acá, tipada como `ManifestChain` (conjunto cerrado testnet). NINGUNA env puede
// llevar un manifiesto a mainnet: es imposible por construcción, no por disciplina. Lo único que se
// lee del entorno es el valor del payTo (y sólo a través de `resolvePayTo`, en tiempo de llamada).
//
// `pathSlug !== slug` en FX y payout es DELIBERADO: el directorio de la ruta es el histórico
// (`remit-corridor-fx`) porque el `agentUrl` ya registrado apunta ahí y no se toca; el `slug` que el
// manifiesto declara es el canónico de cobro (`remit-corridor-fx-solana`). No "corregir".
//
// `PRICE_USDC` se IMPORTA de cada agente (lectura pura, sin I/O al importarse): evita una segunda
// verdad del precio. No redeclarar el número acá.
//
// LOS 3 AGENTES COBRAN EN `solana-devnet`: el pipeline de remesas no toca ninguna chain EVM. Cada
// agente tiene su PROPIA env de payTo (`payToEnv`) aunque hoy las 3 apunten a la misma billetera:
// separarlas mañana es cambiar una variable de entorno, no este archivo. NINGUNA dirección vive acá
// (ni como default ni como fallback). Ver el bloque de las 3 envs en `.env.example`.

// EL `inputSchema` DE CADA AGENTE SE ESCRIBE A MANO ACÁ Y NO SE GENERA DESDE EL ZOD, A PROPÓSITO.
// Generarlo eliminaría la deriva por construcción, pero convertiría a cualquier refactor del
// validador en un cambio del contrato publicado que nadie revisa, y no dejaría lugar para decir lo
// que JSON Schema no deriva (qué campo, siendo opcional para Zod, bloquea el desembolso igual).
// Lo que impide la deriva es `input-schema-drift.test.ts`: compara ESTA tabla contra el Zod real y
// se pone rojo si divergen. Si tocás un schema Zod y no tocás acá, la suite falla — es el punto.
//
// MEDIDO EN EL CATÁLOGO VIVO (2026-08-04, GET /agents/:slug/agent-card) ANTES DE ESTE ARCHIVO:
//  · payout   → `required` incluía `kycPayoutAllowed` (borrado en WKH-203: Zod lo strippea) y NO
//               mencionaba `senderIdentity`/`address` ⇒ el input del catálogo daba SIEMPRE
//               `200 {"executed":false,"status":"blocked","reason":"kyc_identity_claim_missing"}`.
//  · kyc      → `required` no incluía `receiverName` ni `receiverCountry` (los dos obligatorios en
//               Zod) y publicaba un `beneficiary` que el agente no conoce ⇒ `400 invalid_input`.
// Quien armaba la llamada leyendo el catálogo —el planner de /orchestrate incluido— construía un
// input que no podía funcionar nunca, y pagaba igual por el intento.

import { PRICE_USDC as KYC_PRICE_USDC } from "@/agents/kyc-validator";
import { PRICE_USDC as FX_PRICE_USDC } from "@/agents/corridor-fx";
import { PRICE_USDC as PAYOUT_PRICE_USDC } from "@/agents/cashout-payout";
import type { ManifestEntry } from "./types";

export const MANIFEST_ENTRIES: readonly ManifestEntry[] = Object.freeze([
  Object.freeze({
    pathSlug: "remit-kyc-validator",
    slug: "remit-kyc-validator",
    name: "remit-kyc-validator",
    description: "KYC/AML + Travel Rule screening para remesas. Respuestas sin PII.",
    capabilities: Object.freeze([
      "kyc-verification",
      "aml-screening",
      "travel-rule",
      "remittance-compliance",
    ]),
    // Espeja `KycInputSchema` (src/agents/kyc-validator.ts:16-24): 7 campos, los 7 obligatorios,
    // ninguno opcional. `receiverName`/`receiverCountry` faltaban en el catálogo vivo.
    inputSchema: Object.freeze({
      type: "object",
      required: Object.freeze([
        "senderName",
        "senderCountry",
        "legalId",
        "amountUsd",
        "receiverName",
        "receiverCountry",
        "purpose",
      ]),
      properties: Object.freeze({
        senderName: Object.freeze({ type: "string", minLength: 1 }),
        senderCountry: Object.freeze({
          type: "string",
          minLength: 2,
          description: "Pais del remitente. El validador solo exige 2 caracteres o mas.",
        }),
        legalId: Object.freeze({
          type: "string",
          minLength: 1,
          description: "Documento del remitente. No vuelve en la respuesta del agente.",
        }),
        amountUsd: Object.freeze({ type: "number", exclusiveMinimum: 0 }),
        receiverName: Object.freeze({ type: "string", minLength: 1 }),
        receiverCountry: Object.freeze({
          type: "string",
          minLength: 2,
          description: "Pais del beneficiario. El validador solo exige 2 caracteres o mas.",
        }),
        purpose: Object.freeze({ type: "string", minLength: 1 }),
      }),
    }),
    chain: "solana-devnet",
    family: "solana",
    asset: "USDC",
    payToEnv: "REMIT_KYC_VALIDATOR_PAYTO",
    priceUsdc: KYC_PRICE_USDC,
  }),
  Object.freeze({
    pathSlug: "remit-corridor-fx",
    slug: "remit-corridor-fx-solana",
    name: "remit-corridor-fx-solana",
    description: "Cotizacion de corredor USDC to PEN: tasa mid real + spread declarado.",
    capabilities: Object.freeze(["remittance-fx-quote", "usdc-to-pen", "corridor-pricing"]),
    // Espeja `CorridorFxInputSchema` (src/agents/corridor-fx.ts:19-24). Los 3 campos con
    // `.default()` de Zod son opcionales EN SERIO: omitirlos cotiza igual (PE / PEN / yape).
    // `destCurrency` faltaba en el catálogo vivo; no rompía nada porque tiene default.
    inputSchema: Object.freeze({
      type: "object",
      required: Object.freeze(["amountUsd"]),
      properties: Object.freeze({
        amountUsd: Object.freeze({
          type: "number",
          exclusiveMinimum: 0,
          description:
            "Monto a enviar. Ademas del schema hay un piso y un techo de corredor: fuera de rango la cotizacion se rechaza.",
        }),
        destCountry: Object.freeze({
          type: "string",
          minLength: 2,
          description: "Opcional. Si se omite, el agente cotiza PE.",
        }),
        destCurrency: Object.freeze({
          type: "string",
          const: "PEN",
          description: "Opcional y de un solo valor. Si se omite, el agente cotiza PEN.",
        }),
        payoutMethod: Object.freeze({
          type: "string",
          enum: Object.freeze(["yape", "plin", "bank_cci"]),
          description: "Opcional. Si se omite, el agente cotiza yape.",
        }),
      }),
    }),
    chain: "solana-devnet",
    family: "solana",
    asset: "USDC",
    payToEnv: "REMIT_CORRIDOR_FX_PAYTO",
    priceUsdc: FX_PRICE_USDC,
  }),
  Object.freeze({
    pathSlug: "remit-cashout-payout",
    slug: "remit-cashout-payout-solana",
    name: "remit-cashout-payout-solana",
    // ⚠️ LA ETAPA VA EN LA FICHA, Y NO ES DECORATIVA. Esta descripción decía "value delivery del
    // corredor de remesas" a secas: publicarla así habría hecho que el catálogo pasara de estar
    // desactualizado a AFIRMAR que el agente desembolsa dinero real. El deploy de etapa 1 corre con
    // `PAYOUT_ALLOW_MOCK=true` y sólo puede simular (`assertPayoutProviderSafe`, cashout-payout.ts:117),
    // y el Travel Rule que acompaña al desembolso todavía es un stub (`resolveTravelRuleData`, :384).
    description:
      "Cash-out a Peru (Yape/Plin/CCI). ETAPA 1: el desembolso es SIMULADO y no mueve dinero real; TransFi real en etapa 2.",
    capabilities: Object.freeze([
      "remittance-payout",
      "cashout",
      "value-delivery",
      "fiat-disbursement",
      // MARCA DE ETAPA. Las 4 de arriba nombran el ROL del agente en el pipeline (y por eso el
      // discovery las tiene que seguir encontrando); ésta declara qué puede hacer HOY con plata.
      // Es aditiva a propósito: no le saca ningún match a quien busca por rol.
      // 🔴 SE BORRA EL DÍA QUE `isPayoutProviderReal()` pueda ser true en el deploy — o sea, cuando
      // el deploy tenga TRANSFI_USERNAME + TRANSFI_PASSWORD + TRANSFI_MID + el readiness de la
      // capacidad "payout" (`TRANSFI_PAYOUT_ADAPTER_READY=true`, o la legada `TRANSFI_ADAPTER_READY`
      // mientras la específica no esté definida). Encender SÓLO la cotización del socio
      // (`TRANSFI_FX_ADAPTER_READY`) NO borra esta marca, y es correcto: sigue sin desembolsar.
      // No hay ningún mecanismo que lo borre solo: la etapa es config del deploy y esta tabla es
      // código estático. Mientras la marca esté, la ficha promete de menos, que es el lado seguro.
      "disbursement-simulated",
    ]),
    // Espeja `CashoutPayoutInputSchema` (src/agents/cashout-payout.ts:46-82). Dos correcciones
    // grandes contra el catálogo vivo: se fue `kycPayoutAllowed` (Zod ya no lo conoce) y aparecen
    // `senderIdentity`/`address`, sin los cuales el gate bloquea SIEMPRE.
    inputSchema: Object.freeze({
      type: "object",
      // 🔴 `senderIdentity` ESTÁ ACÁ AUNQUE ZOD LO ACEPTE AUSENTE, y es la única entrada de esta
      // lista que no es Zod-obligatoria. Sin él (o su alias legado `address`) el agente responde
      // `200 blocked / kyc_identity_claim_missing` y no desembolsa nunca: es opcional para el
      // validador y obligatorio para obtener un resultado. Declararlo de menos es lo que rompía al
      // planner. El check de deriva no lo deja pasar de arriba: exige la prueba de que omitirlo
      // efectivamente bloquea (ver `input-schema-drift.test.ts`).
      required: Object.freeze([
        "quoteId",
        "amountUsd",
        "kycVerificationId",
        "senderIdentity",
        "beneficiary",
        "idempotencyKey",
      ]),
      properties: Object.freeze({
        quoteId: Object.freeze({
          type: "string",
          minLength: 1,
          description:
            "La referencia que devolvio remit-corridor-fx en ESTA remesa. Lleva firmados el monto y el vencimiento: un id inventado da blocked/quote_unresolvable.",
        }),
        amountUsd: Object.freeze({
          type: "number",
          exclusiveMinimum: 0,
          description:
            "Tiene que ser exactamente el monto de ese quoteId. Si difiere, da blocked/quote_amount_mismatch.",
        }),
        kycVerificationId: Object.freeze({
          type: "string",
          minLength: 1,
          description:
            "El verificationId que devolvio remit-kyc-validator. El agente re-consulta la aprobacion: mandarlo no la otorga.",
        }),
        senderIdentity: Object.freeze({
          type: "string",
          minLength: 1,
          description:
            "El valor que quedo ligado a esa verificacion cuando se creo. Sin el (o sin address) la respuesta es blocked/kyc_identity_claim_missing.",
        }),
        address: Object.freeze({
          type: "string",
          minLength: 1,
          description:
            "Alias LEGADO de senderIdentity, para chaski-v2. Si vienen los dos, gana senderIdentity. No construir nada nuevo sobre este campo.",
        }),
        beneficiary: Object.freeze({
          type: "object",
          required: Object.freeze(["name", "country", "method", "destination"]),
          properties: Object.freeze({
            name: Object.freeze({ type: "string", minLength: 1 }),
            country: Object.freeze({ type: "string", minLength: 2 }),
            method: Object.freeze({
              type: "string",
              enum: Object.freeze(["yape", "plin", "bank_cci"]),
            }),
            destination: Object.freeze({
              type: "string",
              minLength: 1,
              description: "Numero de Yape/Plin o CCI. No vuelve en la respuesta del agente.",
            }),
          }),
        }),
        idempotencyKey: Object.freeze({ type: "string", minLength: 1 }),
      }),
    }),
    chain: "solana-devnet",
    family: "solana",
    asset: "USDC",
    payToEnv: "REMIT_CASHOUT_PAYOUT_PAYTO",
    priceUsdc: PAYOUT_PRICE_USDC,
  }),
]);

export function findEntry(pathSlug: string): ManifestEntry | undefined {
  return MANIFEST_ENTRIES.find((entry) => entry.pathSlug === pathSlug);
}
