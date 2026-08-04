// remit-corridor-fx — agente de cotización de corredor/FX. v2 PARALELA de agentshop-corridor-discoverer.
// El demo (agentshop-*) queda INTACTO y vivo (jurado Team1); esto es un slug/servicio NUEVO.
// Mismo patrón que remit-kyc-validator: zod input → FxQuoteProvider (TransFi || fallback FX-real) → { result }.
// Honra el contrato HTTP del gateway a2a: POST /invoke → 200 { result: {...} }.

import { z } from "zod";
import {
  assertAmountAboveMinimum,
  assertAmountBelowMaximum,
  getFxQuoteProvider,
} from "../providers/fx";
import { resolveFxConfig } from "../providers/fx-config";
import { issueQuoteRef } from "../providers/quote-ref";
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
  // WKH-314 (AR) — EL MONTO MÍNIMO SE VALIDA ACÁ, ANTES DE ELEGIR PROVEEDOR.
  //
  // Vivía dentro de `LiveMidFxProvider`, y ahí protegía UN camino: el día que alguien active
  // `TRANSFI_ADAPTER_READY` (dos envs, y después de ese opt-in nada vuelve a fallar ruidoso),
  // el mínimo desaparecía sin que nada avisara. La alternativa que se descartó era repetir la
  // llamada en el otro proveedor, que es la duplicación que esta HU viene evitando.
  //
  // Acá queda en UN solo lugar, cubre a los dos proveedores, y sigue corriendo ANTES de
  // cualquier fetch al feed porque el núcleo corre antes que el proveedor. Sobre todo:
  // sobrevive a que WKH-312 reordene lo que quiera aguas abajo, porque no depende de dónde
  // vivan los guards del proveedor.
  //
  // Va después del parseo de Zod (que un monto sea un número positivo es más básico que el
  // mínimo) y antes de `getFxQuoteProvider()`: resolver el proveedor para un envío que vamos a
  // rechazar es trabajo al pedo.
  //
  // ⚠️ Esta es una SEGUNDA lectura de config por cotización, además de la que hace el proveedor.
  // No rompe la regla de "una sola lectura": esa regla existe para que el mid y el precio salgan
  // de la MISMA config, y eso sigue pasando dentro del proveedor. Acá se lee una política
  // independiente. Si una env rotara justo entre las dos lecturas, el peor caso es una
  // cotización validada contra un mínimo viejo — y desde el fix del guard de salida, ni siquiera
  // así puede entregar cero.
  //
  // EL TECHO VA ACÁ MISMO, con el mismo config y en la misma línea de defensa. Son las dos
  // puntas del MISMO campo: separarlos haría que quien busque "cuánto se puede enviar" encuentre
  // media respuesta y crea que es toda. Una sola lectura de config alimenta a los dos, así que
  // el piso y el techo que se comparan son siempre de la misma foto de la configuración.
  const config = resolveFxConfig();
  assertAmountAboveMinimum(input.amountUsd, config);
  assertAmountBelowMaximum(input.amountUsd, config);
  const provider = getFxQuoteProvider();
  const quote = await provider.quote({
    amountUsd: input.amountUsd,
    sourceAsset: "USDC",
    destCurrency: input.destCurrency,
    destCountry: input.destCountry,
    payoutMethod: input.payoutMethod,
  });
  // EL `quoteId` QUE SALE LLEVA EL MONTO FIRMADO ADENTRO, y por eso el techo de arriba alcanza
  // también al desembolso. La cadena completa es: acá se rechaza todo lo que exceda `maxSendUsd`
  // ANTES de emitir nada ⇒ no puede existir una referencia válida por encima del techo ⇒ el agente
  // de payout, que exige igualdad exacta contra el monto de la referencia, no puede desembolsar por
  // encima del techo. El desembolso no re-lee la política: hereda la decisión que se tomó acá.
  //
  // Va en el núcleo y NO dentro de los proveedores, por el mismo motivo que el piso y el techo:
  // acá cubre a los dos caminos y no desaparece el día que se active el adapter del socio. Envolver
  // al id del proveedor (en vez de reemplazarlo) conserva el id real del partner para auditoría.
  //
  // ⚠️ ATA EL MONTO **Y LA VIGENCIA**, y nada más. `expiresAt` dejó de ser decorativo: entra al
  // material firmado (`issueQuoteRef`) y el agente de payout lo hace cumplir. Se le pasa el MISMO
  // `quote.expiresAt` que sale en la respuesta —el que declaró quien cotizó— y no una ventana
  // calculada acá: si fueran dos números, la cotización prometería una vigencia y el desembolso
  // haría cumplir otra. Sigue sin atar la TASA, el BENEFICIARIO ni el uso único (ver el encabezado
  // de `quote-ref.ts`: el uso único necesita almacenamiento y este repo no tiene ninguno).
  return {
    slug: SLUG,
    ...quote,
    quoteId: issueQuoteRef(quote.quoteId, input.amountUsd, quote.expiresAt),
  };
}
