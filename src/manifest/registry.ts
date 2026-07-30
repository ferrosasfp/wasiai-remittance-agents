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
    description: "Cash-out a Peru (Yape/Plin/CCI): value delivery del corredor de remesas.",
    capabilities: Object.freeze([
      "remittance-payout",
      "cashout",
      "value-delivery",
      "fiat-disbursement",
    ]),
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
