// src/app/api/agents/remit-cashout-payout/invoke/route.ts
// Endpoint HTTP del agente remit-cashout-payout. Envuelve runCashoutPayout (lib pura) y honra el
// contrato a2a: POST /invoke → 200 { result: {...} } (legible por data.result ?? data en compose.ts).
// Fork de remit-kyc-validator/invoke/route.ts (mismo repo), cambiando el core KYC por el core Payout.
// CD-6 (eje crítico): NINGÚN response (200/400/502) puede exponer beneficiary.name/destination ni travelRuleData.
import { NextRequest, NextResponse } from "next/server";
import { CashoutPayoutInputSchema, runCashoutPayout } from "@/agents/cashout-payout";

export async function POST(req: NextRequest) {
  const parsed = CashoutPayoutInputSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    // CD-6: SOLO parsed.error.flatten() (mensajes Zod, value-free). NUNCA parsed.data / body crudo /
    // mensajes custom que interpolen el valor recibido (beneficiary.name/destination NO se ecoan).
    return NextResponse.json(
      { error: "invalid_input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const result = await runCashoutPayout(parsed.data);
    return NextResponse.json({ result }, { status: 200 });
  } catch (err) {
    // CD-6: el core puede lanzar payout_refused (fail-safe sin PAYOUT_ALLOW_MOCK) o transfi_adapter_not_ready.
    // Body FIJO opaco + warn SOLO con err.name (nunca err.message / stack / input). Nunca un 500.
    console.warn("[remit-cashout-payout] payout failed:", {
      errorName: err instanceof Error ? err.name : "unknown",
    });
    return NextResponse.json({ error: "payout_unavailable" }, { status: 502 });
  }
}
