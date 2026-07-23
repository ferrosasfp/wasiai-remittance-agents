// FIXTURE DE CONTRATO — ORIGEN (provider). WKH-227 / HU-SOL-24, sync: 2026-07-22.
// Captura el OUTPUT canónico de runCorridorFx() en fallback determinístico. NO editar a mano:
// regenerar corriendo contracts/contracts.provider.test.ts (ver doc). El consumer (chaski-v3)
// vendorea una COPIA con header "COPIA PINNEADA, NO SE EDITA".

import type { CorridorFxOutput } from "../agents/corridor-fx";

// Valores de la salida REAL de runCorridorFx({ amountUsd: 100 }) con el fallback FX (mid mockeado
// PEN 3.8, TRANSFI_API_KEY=""). AC-5: FIAT (rate/feeUsd/netDeliveredLocal) queda `number`, NO se
// convierte a string/bigint. `quoteId` y `expiresAt` son runtime-generados (Date.now()) — su forma
// es lo anclado (string); el contract test ancla por keys + typeof, no por el valor exacto.
export const corridorFxOutputFixture: CorridorFxOutput = {
  slug: "remit-corridor-fx",
  rate: 3.705,
  feeUsd: 0.5,
  netDeliveredLocal: 368.65,
  localCurrency: "PEN",
  etaMinutes: 30,
  quoteId: "fallback-1753142400000",
  expiresAt: "2026-07-22T00:10:00.000Z",
  provenance: "local-fallback",
};
