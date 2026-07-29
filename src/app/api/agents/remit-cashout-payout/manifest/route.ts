// src/app/api/agents/remit-cashout-payout/manifest/route.ts
// Ficha de cobro del agente, hermana de /invoke. Wrapper fino sobre buildManifest (lib pura):
// misma forma que `src/app/api/agents/remit-cashout-payout/invoke/route.ts` (body de error fijo y
// opaco, console.warn sólo con datos value-free, nunca un 500).
//
// PATH_SLUG es el directorio HISTÓRICO; el slug canónico que publica el manifiesto es
// `remit-cashout-payout-solana` (lo resuelve el registry). La asimetría es deliberada.
import { NextRequest, NextResponse } from "next/server";
import { buildManifest } from "@/manifest/build";

// Next 14: sin esto el GET se evalúa en BUILD y sirve el payTo congelado del momento de compilar
// (rotar la env en Vercel no surtiría efecto). Es un fail-open silencioso — ver AC-7.
export const dynamic = "force-dynamic";

const PATH_SLUG = "remit-cashout-payout";
const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(_req: NextRequest) {
  try {
    const result = buildManifest(PATH_SLUG);
    if (!result.ok) {
      // value-free: nombre de campo + razón, NUNCA el valor de la env.
      console.warn("[manifest] not publishable:", {
        slug: PATH_SLUG,
        field: "payment.contract",
        reason: result.reason,
      });
      return NextResponse.json(
        { error: "manifest_unavailable", missing: result.missing, invalid: result.invalid },
        { status: 503, headers: NO_STORE },
      );
    }
    return NextResponse.json(result.manifest, { status: 200, headers: NO_STORE });
  } catch (err) {
    console.warn("[manifest] unexpected failure:", {
      slug: PATH_SLUG,
      errorName: err instanceof Error ? err.name : "unknown",
    });
    return NextResponse.json(
      { error: "manifest_unavailable", missing: [], invalid: [] },
      { status: 503, headers: NO_STORE },
    );
  }
}
