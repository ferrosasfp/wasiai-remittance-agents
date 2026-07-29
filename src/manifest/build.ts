// src/manifest/build.ts
// Arma el manifiesto de un agente, o el resultado fail-closed que impide publicarlo.
//
// Sin I/O de ningún tipo. Sin `async`. Sin `try/catch` que trague. Nunca lanza.
// La única fuente de datos es `registry.ts` (constantes de código) + `process.env` (sólo el payTo,
// y sólo a través de `resolvePayTo`).
//
// INVARIANTE CENTRAL DE LA HU: no existe ninguna rama que devuelva `ok:true` sin un
// `payment.contract` branded (es decir, sin una address que el settle del consumidor aceptaría).
// El branded `PayTo` lo garantiza el compilador: un `string` no compila en esa posición.

import { findEntry } from "./registry";
import { resolvePayTo } from "./paytos";
import type { ManifestResult } from "./types";

export function buildManifest(pathSlug: string): ManifestResult {
  const entry = findEntry(pathSlug);
  if (entry === undefined) {
    // No puede pasar hoy (las rutas son directorios estáticos que pasan un literal); existe para
    // que la función sea TOTAL y nunca lance.
    return { ok: false, missing: ["agent"], invalid: [], reason: "unknown_agent" };
  }

  const resolved = resolvePayTo(entry);
  if (!resolved.ok) {
    if (resolved.reason === "missing") {
      return { ok: false, missing: ["payment.contract"], invalid: [], reason: "missing" };
    }
    // invalid_format | zero_address: el campo existe pero no es publicable.
    return { ok: false, missing: [], invalid: ["payment.contract"], reason: resolved.reason };
  }

  return {
    ok: true,
    manifest: {
      manifestVersion: "1",
      slug: entry.slug,
      name: entry.name,
      description: entry.description,
      capabilities: entry.capabilities,
      priceUsdc: entry.priceUsdc,
      payment: {
        method: "x402",
        chain: entry.chain,
        contract: resolved.payTo,
        asset: entry.asset,
      },
    },
  };
}
