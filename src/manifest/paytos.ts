// src/manifest/paytos.ts
// ÚNICA fábrica de `PayTo` del repo. Fail-closed: si el valor no es una address que el settle del
// consumidor aceptaría, no se produce ningún `PayTo` y el manifiesto no se emite.
//
// Nunca lanza. NUNCA loguea ni devuelve el valor leído del entorno.

import { isValidPayToForFamily, isZeroAddress } from "./wallet-format";
import type { ManifestEntry, PayTo, PayToResolution } from "./types";

export function resolvePayTo(entry: ManifestEntry): PayToResolution {
  // (1) Lectura EN TIEMPO DE LLAMADA, nunca en el scope del módulo: si se leyera al importar, el
  // manifiesto serviría un payTo congelado y rotar la env no surtiría efecto (AC-7).
  const rawUnknown: unknown = process.env[entry.payToEnv];

  // (2) typeof-narrowing. PROHIBIDO `String(x ?? "")`: `String(123)` es "123", no "" → fail-open.
  // (Bug histórico real de este repo, WKH-204.)
  const raw = typeof rawUnknown === "string" ? rawUnknown : "";

  // (3) El trim va ANTES del check de vacío: "   " es AUSENTE, no un valor.
  const value = raw.trim();
  if (value === "") return { ok: false, reason: "missing" };

  // (4) Acá muere el cruce de familias: una `0x…` en un slot solana falla isValidSolanaAddress (el
  // `0`/`x` no están en el charset base58) y una base58 en un slot evm falla ADDRESS_RE.
  if (!isValidPayToForFamily(value, entry.family)) return { ok: false, reason: "invalid_format" };

  // (5) La zero-address tiene formato válido pero el leg downstream corta con ZERO_PAY_TO.
  if (entry.family === "evm" && isZeroAddress(value)) return { ok: false, reason: "zero_address" };

  // (6) El ÚNICO `as PayTo` de todo el repo.
  return { ok: true, payTo: value as PayTo };
}
