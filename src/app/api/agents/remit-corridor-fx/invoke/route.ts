// src/app/api/agents/remit-corridor-fx/invoke/route.ts
// Endpoint HTTP del agente remit-corridor-fx. Envuelve runCorridorFx (lib pura) y honra el
// contrato a2a: POST /invoke → 200 { result: {...} } (legible por data.result ?? data en compose.ts).
// Fork de cobraya-credit-scorer SIN receipt EIP-712 (este repo no tiene agent-signer).
import { NextRequest, NextResponse } from "next/server";
import { CorridorFxInputSchema, runCorridorFx } from "@/agents/corridor-fx";

export async function POST(req: NextRequest) {
  const parsed = CorridorFxInputSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const result = await runCorridorFx(parsed.data);
    return NextResponse.json({ result }, { status: 200 });
  } catch (err) {
    // El core puede lanzar por assertValidQuote (NaN/monto inválido) o misconfig de env
    // (transfi_adapter_not_ready). Nunca un 500 crudo. Warn estructurado sin stack (patrón cobraya).
    console.warn("[remit-corridor-fx] quote failed:", {
      errorName: err instanceof Error ? err.name : "unknown",
    });
    return NextResponse.json({ error: "quote_unavailable" }, { status: 502 });
  }
}
