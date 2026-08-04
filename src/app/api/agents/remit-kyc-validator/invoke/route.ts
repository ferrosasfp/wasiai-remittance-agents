// src/app/api/agents/remit-kyc-validator/invoke/route.ts
// Endpoint HTTP del agente remit-kyc-validator. Envuelve runKycValidator (lib pura) y honra el
// contrato a2a: POST /invoke → 200 { result: {...} } (legible por data.result ?? data en compose.ts).
// Fork de remit-corridor-fx/invoke/route.ts (mismo repo), cambiando el core FX por el core KYC.
// CD-6 (eje crítico): NINGÚN response (200/400/502) puede exponer legalId ni travelRuleData.
import { NextRequest, NextResponse } from "next/server";
import { KycInputSchema, runKycValidator } from "@/agents/kyc-validator";
import { guardInvokeAuth } from "@/auth/invoke-auth";

export async function POST(req: NextRequest) {
  // Va ANTES de leer el body a propósito: sin credencial no se parsea nada del caller (CD-6 se
  // refuerza, no se afloja). Con `INVOKE_AUTH_SECRET` sin configurar devuelve `null` SIEMPRE.
  const unauthorized = guardInvokeAuth(req, "remit-kyc-validator");
  if (unauthorized !== null) return unauthorized;

  const parsed = KycInputSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    // CD-6: SOLO parsed.error.flatten() (mensajes Zod, value-free). NUNCA parsed.data / body crudo /
    // mensajes custom que interpolen el valor recibido (el legalId NO se ecoa).
    return NextResponse.json(
      { error: "invalid_input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const result = await runKycValidator(parsed.data);
    return NextResponse.json({ result }, { status: 200 });
  } catch (err) {
    // CD-6: el core puede lanzar por getKycProvider() misconfig (didit_adapter_not_ready) o error del
    // provider. Body FIJO opaco + warn SOLO con err.name (nunca err.message / stack / input). Nunca un 500.
    console.warn("[remit-kyc-validator] verify failed:", {
      errorName: err instanceof Error ? err.name : "unknown",
    });
    return NextResponse.json({ error: "verification_unavailable" }, { status: 502 });
  }
}
