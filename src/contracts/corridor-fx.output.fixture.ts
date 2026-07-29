// FIXTURE DE CONTRATO — ORIGEN (provider). WKH-227 / HU-SOL-24.
// Captura el OUTPUT canónico de runCorridorFx() con la tasa mid mockeada. NO editar a mano:
// regenerar corriendo contracts/contracts.provider.test.ts (ver doc). El consumer (chaski-v3)
// vendorea una COPIA con header "COPIA PINNEADA, NO SE EDITA".
//
// REGENERADO 2026-07-29 (WKH-301) — el output pasó de 9 a 11 claves:
//  · `provenance` dejó de ser `"local-fallback"`: ese valor etiquetaba por igual una tasa de
//    mercado y la constante `STATIC_USD_PEN` (3.75, +10.2% sobre el mercado real). Ahora vale
//    `"fx-mid-live"` o `"fx-mid-cached"`, que mapean 1:1 a un método auditable.
//  · se agregaron `rateSource` (id de la fuente registrada) y `rateAsOf` (fecha del dato SEGÚN
//    LA FUENTE, nunca el momento de servir).
// Cómo se regeneró: correr `runCorridorFx({ amountUsd: 100 })` con `TRANSFI_API_KEY=""` y el feed
// mockeado en PEN 3.8 con fecha reciente, y copiar la salida.

import type { CorridorFxOutput } from "../agents/corridor-fx";

// Valores de la salida REAL de runCorridorFx({ amountUsd: 100 }) con el mid mockeado en PEN 3.8 y
// TRANSFI_API_KEY="". AC-5: FIAT (rate/feeUsd/netDeliveredLocal) queda `number`, NO se convierte a
// string/bigint. `quoteId`, `expiresAt` y `rateAsOf` son runtime-generados — su forma es lo anclado
// (string); el contract test ancla por keys + typeof, no por el valor exacto.
export const corridorFxOutputFixture: CorridorFxOutput = {
  slug: "remit-corridor-fx",
  rate: 3.705,
  feeUsd: 0.5,
  netDeliveredLocal: 368.65,
  localCurrency: "PEN",
  etaMinutes: 30,
  quoteId: "fxmid-1753142400000",
  expiresAt: "2026-07-22T00:10:00.000Z",
  provenance: "fx-mid-live",
  rateSource: "er-api",
  rateAsOf: "2026-07-22T00:00:00.000Z",
};
