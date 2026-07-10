// remit-corridor-fx — agente de cotización de corredor/FX. v2 PARALELA de agentshop-corridor-discoverer.
// El demo (agentshop-*) queda INTACTO y vivo (jurado Team1); esto es un slug/servicio NUEVO.
// Mismo patrón que remit-kyc-validator: zod input → FxQuoteProvider (TransFi || fallback FX-real) → { result }.
// Honra el contrato HTTP del gateway a2a: POST /invoke → 200 { result: {...} }.

import { z } from "zod";
import { getFxQuoteProvider } from "../providers/fx";
import type { FxQuote } from "../providers/types";

export const SLUG = "remit-corridor-fx";
export const PRICE_USDC = 0.03;

export const CorridorFxInputSchema = z.object({
  amountUsd: z.number().positive(),
  destCountry: z.string().min(2).default("PE"),
  destCurrency: z.literal("PEN").default("PEN"),
  payoutMethod: z.enum(["yape", "plin", "bank_cci"]).default("yape"),
});

export type CorridorFxInput = z.infer<typeof CorridorFxInputSchema>;

export interface CorridorFxOutput extends FxQuote {
  slug: string;
}

/**
 * Core del agente (testeable, sin HTTP). Devuelve el objeto que va dentro de `{ result }`.
 * El `quoteId` + `expiresAt` se pasan al agente de payout para atar el desembolso a esta tasa.
 * Lanza ZodError si el input es inválido (el handler → 400).
 */
export async function runCorridorFx(raw: unknown): Promise<CorridorFxOutput> {
  const input = CorridorFxInputSchema.parse(raw);
  const provider = getFxQuoteProvider();
  const quote = await provider.quote({
    amountUsd: input.amountUsd,
    sourceAsset: "USDC",
    destCurrency: input.destCurrency,
    destCountry: input.destCountry,
    payoutMethod: input.payoutMethod,
  });
  return { slug: SLUG, ...quote };
}
