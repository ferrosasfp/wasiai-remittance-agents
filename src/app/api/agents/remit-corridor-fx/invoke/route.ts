// src/app/api/agents/remit-corridor-fx/invoke/route.ts
// Endpoint HTTP del agente remit-corridor-fx. Envuelve runCorridorFx (lib pura) y honra el
// contrato a2a: POST /invoke → 200 { result: {...} } (legible por data.result ?? data en compose.ts).
// Fork de cobraya-credit-scorer SIN receipt EIP-712 (este repo no tiene agent-signer).
import { NextRequest, NextResponse } from "next/server";
import { CorridorFxInputSchema, runCorridorFx } from "@/agents/corridor-fx";
import { AMOUNT_ABOVE_MAXIMUM_CODE, AMOUNT_BELOW_MINIMUM_CODE } from "@/providers/fx";

/**
 * Rechazos de POLÍTICA DEL MONTO: son 4xx (el caller mandó un monto fuera de lo que este agente
 * cotiza) y cada uno viaja con SU límite, para que el caller sepa hacia dónde corregir sin
 * bisección. La tabla existe para que agregar o mover una punta sea una fila y no un bloque
 * `if` copiado: dos bloques gemelos divergen en el primer arreglo que toque a uno solo.
 *
 * El código NO se colapsa: "muy chico" y "muy grande" se corrigen en direcciones opuestas.
 */
const AMOUNT_POLICY_ERRORS = [
  { code: AMOUNT_BELOW_MINIMUM_CODE, limitField: "minSendUsd" },
  { code: AMOUNT_ABOVE_MAXIMUM_CODE, limitField: "maxSendUsd" },
] as const;

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
    // WKH-314: "mandaste muy poco" (y ahora "pediste demasiado") es un error del CALLER, no una
    // indisponibilidad nuestra. Aplanarlo en el 502 de abajo le diría "volvé más tarde" a alguien
    // cuyo reintento no va a funcionar NUNCA hasta que cambie el monto. Y el límite viaja en la
    // respuesta: sin eso, el caller tiene que descubrirlo por bisección.
    const message = err instanceof Error ? err.message : "";
    const policy = AMOUNT_POLICY_ERRORS.find((entry) => message.startsWith(`${entry.code}:`));
    if (policy !== undefined) {
      const limit = Number(message.slice(policy.code.length + 1));
      return NextResponse.json(
        {
          error: policy.code,
          // Un límite no numérico se OMITE en vez de mandarse: `JSON.stringify(NaN)` es `null`, y
          // "el máximo es null" es peor que "no vino el dato".
          ...(Number.isFinite(limit) ? { [policy.limitField]: limit } : {}),
        },
        { status: 400 },
      );
    }
    // El core puede lanzar por assertValidQuote (NaN/monto inválido) o misconfig de env
    // (transfi_adapter_not_ready). Nunca un 500 crudo. Warn estructurado sin stack (patrón cobraya).
    console.warn("[remit-corridor-fx] quote failed:", {
      errorName: err instanceof Error ? err.name : "unknown",
    });
    return NextResponse.json({ error: "quote_unavailable" }, { status: 502 });
  }
}
