# TransFi Off-ramp API — ficha técnica verificada (2026-07-17)

Grounding para reescribir el adapter de payout (`src/providers/payout.ts`), hoy desactualizado en los 4 ejes.
Todo VERIFICADO en docs.transfi.com salvo lo marcado NO CONFIRMADO.

## Base URL
- **Sandbox**: `https://sandbox-api.transfi.com`
- **Producción**: `https://api.transfi.com`
- Se distingue por HOST (no por credenciales). Fuente: docs.transfi.com/docs/api-concepts

## Autenticación — Basic Auth + header `mid`
Cada request lleva:
```
Authorization: Basic base64(usuario:contraseña)
mid: <MEDIO>            # ej. WIIB1V_NA_NA (merchant/sub-merchant id, header en minúscula)
Content-Type: application/json
```
- usuario+contraseña del panel = Basic Auth. El "MEDIO" = header `mid` aparte.
- NO es Bearer, NO es x-api-key. Fuente: docs.transfi.com/docs/creating-transfer-offramp, /reference/create-order

## Endpoint off-ramp — POST /v3/orders con orderType:"offramp"
NO es `/v1/payouts`. Body:
```jsonc
{
  "orderType": "offramp",
  "userId": "UX-...",          // usuario con KYC hecho
  "purposeCode": "...",
  "sourceUrl": "https://...",
  "partnerId": "<idempotency-id>",   // idempotencia (ver abajo)
  "source":      { "currency": "USDCPOLYGON", "walletAddress": "0x...", "amount": 100 },
  "destination": { "currency": "PEN", "paymentType": "bank_transfer",
                   "paymentCode": "<de /v3/payment-methods>", "amount": 380,
                   "additionalPaymentDetails": { /* campos beneficiario PE — descubrir en runtime */ } }
}
```
- **Modelo NO fire-and-forget**: crear orden → TransFi devuelve **`walletAddress` dedicada por orden** → mandar USDC on-chain a esa address → webhook `asset_deposited`→`fund_settled`.
- Status: `GET /v3/orders/{orderId}`.
- Códigos USDC (source.currency): `USDC`(eth), `USDCPOLYGON`, `USDCBASE`, `USDCARB`, `USDCBSC`, `USDCSOL`, `USDCCELO`, `USDCLINEA`, `USDCALGO`, `USDCXLM`, `USDCFUSE`.
  ⚠️ **`USDCAVAX` (Avalanche) NO está en la lista publicada** → verificar vía `list-tokens`. IMPACTA a Chaski (settlea en Avalanche).
- Campos del beneficiario peruano (CCI/banco/doc): **NO CONFIRMADOS** en docs → descubrir vía `GET /v3/payment-methods` (PEN/withdraw) en sandbox.

## Webhooks — estados y firma
- Estados off-ramp (`status`, `entityType:"order"`): `initiated → asset_deposited → fund_settled` (✅) / `fund_failed` / `expired`.
- Firma: header **`X-Transfi-Hmac-Hash`**, HMAC-SHA256 sobre el body CRUDO con el webhook secret, `digest('hex')`. Comparar constant-time (recomendación propia).
- Fuentes: /docs/webhook-events-offramp, /docs/webhook-signature

## PEN / Perú
- PEN payout: ✅ (supported-fiat-currencies, 2ª col). Perú → BANK TRANSFER ✅ (supported-countries). Direccionalidad correcta (payout, no pay-in).

## Idempotencia — campo `partnerId` (NO header)
- Mismo `partnerId` → TransFi devuelve la orden original (no duplica); choque → error `PARTNER_ID_ALREADY_USED`. Dedup del lado de ellos. NO existe header `idempotency-key`.

## Env vars nuevas (reemplazan la sola TRANSFI_API_KEY)
`TRANSFI_USERNAME`, `TRANSFI_PASSWORD`, `TRANSFI_MID`, `TRANSFI_WEBHOOK_SECRET`, `TRANSFI_BASE_URL` (sandbox por default en dev).

## Qué hay que reescribir en el adapter (todos los ejes están mal hoy)
| Aspecto | Scaffold hoy | Real |
|---|---|---|
| Endpoint | `POST /v1/payouts` | `POST /v3/orders` (orderType offramp) |
| Auth | `Bearer TRANSFI_API_KEY` | `Basic base64(user:pass)` + `mid` |
| Idempotencia | header `idempotency-key` | campo `partnerId` |
| Flujo | push payout (1 POST → settled) | create-order → deposit walletAddress → USDC on-chain → webhook fund_settled |
| Status | `GET /v1/payouts/{id}` | `GET /v3/orders/{id}` |

## Cabos sueltos (a resolver en sandbox durante la HU)
1. Campos exactos del beneficiario PE (via /v3/payment-methods).
2. ¿USDC en Avalanche soportado? (list-tokens) — si NO, Chaski debe settlear/bridgear a una red soportada (Base/Polygon) o el sender usa esa red. DECISIÓN DE ARQUITECTURA.
3. Flujo de creación del `userId` (UX-...) con KYC.
4. `purposeCode` válido para remesas a Perú.
