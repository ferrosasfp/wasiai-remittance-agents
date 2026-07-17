# Report — HU [WKH-208] Reescribir el adapter de payout de TransFi a la API REAL (sandbox e2e, sin plata real)

## Resumen ejecutivo

**Código DONE + validación live PENDIENTE.** El adapter `TransFiPayoutProvider` (`src/providers/payout.ts`) se rescribió completamente contra el contrato HTTP real de TransFi off-ramp: `POST /v3/orders` con `Basic auth + mid`, idempotencia vía campo `partnerId`, flujo async (devuelve `depositAddress`, estado terminal via webhook futuro). Los 4 ejes verificados en F2 contra spec + 145 tests verdes (123→145, +22 tests nuevos AC-1..8, mockeados). **AC-4 (smoke real en sandbox) está PENDIENTE y gateado al founder** — crear una orden real en `sandbox-api.transfi.com` con credenciales reales es una acción que el classifier bloquea para el agente. Sin ese smoke, los nombres JSON exactos de `orderId`/`depositAddress` quedan por confirmar (parseo defensivo + `TODO(F3)` en el código).

---

## Pipeline ejecutado

| Fase | Status | Fecha | Notas |
|------|--------|-------|-------|
| **F0** | DONE | 2026-07-17 | project-context.md verificado; `doc/transfi-offramp-api-spec.md` grounded |
| **F1** | DONE ✅ HU_APPROVED | 2026-07-17 | work-item.md (27.6K) + 8 ACs + DT-1/DT-5 cerrados; Missing Inputs claros |
| **F2** | DONE ✅ SPEC_APPROVED | 2026-07-17 | sdd.md (36.6K) + DT-2 **cerrada = Base** + env var swap (2 archivos) mapeado; readiness check ✅ |
| **F2.5** | DONE | 2026-07-17 | story-WKH-208.md (24.6K) — contrato autocontenido; 10 secciones; anti-hallucination checklist; §7 F3-items |
| **F3-W0** | DONE | 2026-07-17 | `types.ts` + `payout.ts` (allowlist + default sandbox) + `project-context.md` documentado; `npm run typecheck` rojo esperado (returns sin `depositAddress` aún) |
| **F3-W1** | DONE | 2026-07-17 | `TransFiPayoutProvider` reescrito (auth Basic+mid, `POST /v3/orders`, `status()` `GET /v3/orders/{id}`, `normalizeStatus` exportado, `FallbackPayoutProvider` con `depositAddress:null`); `cashout-payout.ts` L66-67 `hasReal` swap; `npm run typecheck` **limpio** |
| **F3-W2** | DONE | 2026-07-17 | `payout.test.ts` + `cashout-payout.test.ts` migrados (AC-1..8 + factory + blast-radius test:507); hardening CD-12; **145 PASS / 0 FAIL** (`npx vitest run`), baseline +22 tests |
| **F3-W3** | **BLOCKED** (AC-4) | — | Smoke sandbox gateado — requiere creds reales en `.env.local` + `TRANSFI_ADAPTER_READY=true` + orden real en `sandbox-api.transfi.com`. Orquestador/founder ejecuta en el siguiente pazo. |
| **AR** | ✅ APROBADO | 2026-07-17 | **0 BLOQUEANTES** · 2 MENORs: (a) MNR-A: mutation self-check `git checkout` sin backup → fix copia respaldo; (b) MNR-B: `noUncheckedIndexedAccess` en access a `mock.calls[0]` → aserción non-null. |
| **CR** | ✅ APROBADO | 2026-07-17 | **0 BLOQUEANTES** · 1 MENOR: MNR-C (cierre) — `_INDEX.md` pendiente actualizar |
| **Fix-pack** | DONE | 2026-07-17 | 2/3 MENORs cerrados en W2 (MNR-A, MNR-B); MNR-C pendiente (cierre de docs) |
| **F4-QA** | ✅ APROBADO (parcial) | 2026-07-17 | **7/8 ACs validadas** (mockeadas + verdes). **AC-4 PENDIENTE** (smoke sandbox real). |

---

## Acceptance Criteria — resultado final

| AC | Status | Evidencia |
|----|--------|-----------|
| **AC-1** | ✅ PASS | Headers auth: `Basic base64(user:pass)` + `mid` (no `Bearer`). Test `payout.test.ts` AC-1. |
| **AC-2** | ✅ PASS | `POST /v3/orders` con `orderType:"offramp"` + `partnerId===input.idempotencyKey` (byte-idéntico). Test `payout.test.ts` AC-2. |
| **AC-3** | ✅ PASS | `2xx` → `status:"submitted"` forzado (nunca leer del POST); `depositAddress` devuelto. Adversarial: mock `fund_settled` en POST NO produce `settled`. Test `payout.test.ts` AC-3. |
| **AC-4** | ⛔ BLOQUEADO (no bloqueante del cierre técnico) | Smoke sandbox real PENDIENTE. Ver §8 checklist. |
| **AC-5** | ✅ PASS | Factory: sin 3 vars → `FallbackPayoutProvider`; sin `READY` → throw; con las 3 + `READY=true` → adapter real. Test `payout.test.ts` + `cashout-payout.test.ts:507` migrado. |
| **AC-6** | ✅ PASS | Red no soportada (ej. `avalanche`) → throw `transfi_unsupported_network_*` sin llamar `fetch`. Allowlist estático (§5.4 story-file). Test `payout.test.ts` AC-6. |
| **AC-7** | ✅ PASS | HTTP error (4xx/5xx, incl. `PARTNER_ID_ALREADY_USED`) → throw tipado `transfi_payout_error_<status>`. Test `payout.test.ts` AC-7. |
| **AC-8** | ✅ PASS | `normalizeStatus()` mapea: `initiated`/`asset_deposited`→`"submitted"`; `fund_settled`→`"settled"`; `fund_failed`/`expired`→`"failed"`; desconocido→`"submitted"`. Test `payout.test.ts` AC-8. |

---

## Hallazgos finales

### BLOQUEANTEs
- **Ninguno.** El AR y CR no encontraron defectos de arquitectura o seguridad en el contrato HTTP. Los 2 MENORs de AR (mutation testing / typecheck) fueron autodetectados y cerrados en W2.

### MENORs (estado post-fix-pack)
| # | Encontrado en | Descripción | Estado |
|---|---|---|---|
| **MNR-A** | AR (W2 dev) | Mutation self-check: `git checkout` de archivo no commiteado revirtió cambios. Fix: respaldar con `cp` a scratchpad antes de mutations. | ✅ CERRADO (aplicado en W2) |
| **MNR-B** | AR (W2 dev) | Typecheck: `noUncheckedIndexedAccess` en `mock.calls[0]` access → aserción non-null necesaria. | ✅ CERRADO (aplicado en W2) |
| **MNR-C** | CR (docs) | `_INDEX.md` pendiente actualizar con status DONE + fecha + links. | ✅ CERRADO (cierre de HU) |

---

## Auto-Blindaje consolidado

Lecciones aplicadas + nuevas del pipeline WKH-208:

| Fuente | Lección | Aplicación en WKH-208 |
|--------|---------|----------------------|
| **WKH-196** | `npm run build` excluye `*.test.ts` → usar `tsc --noEmit` en gate | CD-10: gate = `typecheck` (completo) + `test`. 145 PASS obtenidos por vitest directo. |
| **WKH-203/204** | Fail-safe con `!== true` estricto, nunca truthiness | CD-3: factory + `assertPayoutProviderSafe` preservan byte-a-byte (`TRANSFI_ADAPTER_READY === "true"` estricto, `!!` en cada var). |
| **WKH-203/204** | Mutation testing: `String(x??"")` nace fail-open (coercitivo) | Parseo defensivo en `orderId`/`depositAddress`: narrowing por tipo, no `String()`. Campo ausente/no-string → `null`/throw (CD-5/AC-3 adversarial). |
| **WKH-208 (nuevo)** | `git checkout <file>` sin commit = destructivo | Respaldar con `cp` a scratchpad antes de mutation testing. Nunca `git checkout` sobre cambios sin commit. |
| **WKH-208 (nuevo)** | `noUncheckedIndexedAccess` en access a mock calls | Aserción non-null (`[0]!`) para accesos garantizados por construcción. `npm run typecheck` SIEMPRE (no confiar solo en test suite pass). |
| **WKH-207 (referencia)** | RLS app-layer: checks de ownership en `service.ts` | Hereda de `project-context`: `a2a_agent_keys` filtro por `owner_ref`. Fuera de scope WKH-208 (es el agente interno). |

---

## Archivos modificados

### Dominio: Tipos & Contratos (1 archivo)
- **`src/providers/types.ts`** — `PayoutResult += depositAddress: string | null` (aditivo, DT-4)

### Dominio: Adapter HTTP + Fallback (3 archivos)
- **`src/providers/payout.ts`** (líneas 1-180 reescritas)
  - `TRANSFI_DEFAULT_NETWORK = "base"` (DT-2, default sandbox)
  - `TRANSFI_USDC_CURRENCY` allowlist (resolveSourceCurrency, AC-6)
  - `transfiHeaders()` — Basic+mid auth (AC-1, CD-8)
  - `TransFiPayoutProvider` reescrito: `POST /v3/orders` offramp + `GET /v3/orders/{id}` (AC-2, AC-3)
  - `normalizeStatus()` exportado (mapeo §5.5 AC-8, CD-7)
  - `FallbackPayoutProvider` — `depositAddress:null` en ambos métodos
  - `getPayoutProvider()` — 3 env vars, no 1 (CD-6, AC-5, DT-5)

### Dominio: Money-path fail-safe (1 archivo)
- **`src/agents/cashout-payout.ts`** (línea 66-67)
  - `hasReal = !!TRANSFI_USERNAME && !!TRANSFI_PASSWORD && !!TRANSFI_MID && TRANSFI_ADAPTER_READY === "true"` (DT-5, CD-3)
  - Resto intacto (fail-safes byte-a-byte)

### Dominio: Tests (2 archivos)
- **`src/providers/payout.test.ts`** (+22 tests vs 7 previos)
  - Factory: 3 vars (AC-5, CD-12)
  - AC-1: headers auth Basic+mid
  - AC-2: `POST /v3/orders` + `partnerId=idempotencyKey`
  - AC-3: `2xx` → `status:"submitted"` + adversarial `fund_settled` POST
  - AC-6: red no soportada throw sin `fetch` call
  - AC-7: HTTP error throw tipado
  - AC-8: `normalizeStatus()` directa (tabla 6 estados)
  - Baseline: `assertValidPayout` + `FallbackPayoutProvider` extendidos

- **`src/agents/cashout-payout.test.ts`** (test:507 migrado + CD-12 hardening)
  - Test:507 PROD + `PAYOUT_ALLOW_MOCK` + 3 vars sin `READY` → throw `transfi_adapter_not_ready` (era el test que ROMPÍA con el swap de env vars)
  - CD-12: `vi.stubEnv()` explícito (no confiar en AUSENCIA de vars)
  - Resto: hardening en stubs fallback (14 ubicaciones, íntegras pero deterministas)

### Dominio: Configuración & Documentación (2 archivos)
- **`project-context.md`** (§Env Vars, si existe, o `.nexus/project-context.md`)
  - Documentar: `TRANSFI_USERNAME/PASSWORD/MID/WEBHOOK_SECRET`, `TRANSFI_BASE_URL` (default sandbox), `TRANSFI_USDC_NETWORK` (default base), `TRANSFI_SOURCE_WALLET_ADDRESS`, `TRANSFI_PURPOSE_CODE` (ver F3-items §7)
  - CD-2: solo nombres/roles, sin valores

- **`doc/sdd/_INDEX.md`** (fila 003, cierre de HU)
  - Status: DONE (código) — smoke sandbox pendiente
  - Links: work-item, sdd, story-file, done-report

### Scope OUT (no tocados, CD-9)
- `src/providers/fx.ts` (reescritura diferida a HU propia — DT-3)
- `fx.test.ts`, `corridor-fx.test.ts`, route.test.ts (legacy `TRANSFI_API_KEY` preservado)

---

## Métricas de tests

| Métrica | Baseline | Cierre | Delta |
|---------|----------|--------|-------|
| Total PASS | 123 | 145 | +22 (AC-1..8 mockeados) |
| Total FAIL | 0 | 0 | 0 ✅ |
| Suites | 9 | 9 | 0 (ninguna quebrada) |
| Typecheck | limpio | limpio | ✅ |
| Gate (`npm run typecheck` + `npm run test`) | — | **PASS** | ✅ |

**Nota:** Los +22 tests son los nuevos casos de AC-1..8 (mockeados contra `fetch`). La mutación self-check del mutation testing se ejecutó en W2 (no deja tests permanentes en la suite — es una herramienta de verificación).

---

## ⛔ Pendiente para cierre TOTAL (founder, gateado): SMOKE SANDBOX (AC-4)

La HU de código está DONE. Para cerrar el cierre TOTAL del Done Definition (story-file §10), falta **AC-4**:

### Acción requerida
Con las credenciales reales de sandbox de TransFi en `.env.local`:
```
TRANSFI_USERNAME=<real>
TRANSFI_PASSWORD=<real>
TRANSFI_MID=<real>
TRANSFI_ADAPTER_READY=true
TRANSFI_BASE_URL=https://sandbox-api.transfi.com
```

Correr el smoke script (ver abajo) para:
1. ✅ Confirmar **NO auth 401** (Basic+mid funciona contra sandbox)
2. ✅ Confirmar endpoint **`POST /v3/orders` existe** (no 404)
3. ✅ Capturar **nombres JSON exactos** de `orderId` + `depositAddress` en la respuesta (hoy `TODO(F3)`)
4. ✅ Descubrir **F3-items**:
   - `paymentCode` (vía `GET /v3/payment-methods`)
   - `additionalPaymentDetails` shape para beneficiario PE
   - `purposeCode` válido
   - Soporte de red (`list-tokens` → confirma `USDCBASE` en la lista)
   - Flujo de `userId` (probable HU de seguimiento — mapping Didit KYC → TransFi userId)
   - Monto PEN `destination.amount` (hoy NO viaja en `PayoutInput` — si TransFi lo exige, HU de seguimiento extiende `PayoutInput`)

### Checklist AC-4
- [ ] Credenciales sandbox en `.env.local` (el founder las copia del ticket de TransFi)
- [ ] Correr script smoke (ver abajo)
- [ ] POST devuelve `2xx` con `orderId` + `walletAddress` (alias `depositAddress`)
- [ ] GET `/v3/orders/{id}` devuelve status `initiated` (o equivalente de inicio)
- [ ] Documentar en el done-report (redactando creds/amounts — CD-2/CD-11):
  - Host sandbox + endpoint confirmados
  - Respuesta parcial (sin PII)
  - Nombres JSON reales de `orderId`/`depositAddress`
- [ ] Resolver F3-items (llenar los `TODO(F3)` del código si aplica)
- [ ] Si algún F3-item **BLOQUEA** (ej. Avalanche realmente no está soportado, o `userId` requiere flujo nuevo), crear ticket de seguimiento

### Script smoke (archivo auxiliar, NO permanente en repo)
```bash
# scratchpad/wkh208-sandbox-smoke.sh
#!/bin/bash
set -eo pipefail
# Requiere .env.local con TRANSFI_USERNAME/PASSWORD/MID/ADAPTER_READY=true

BASE="${TRANSFI_BASE_URL:-https://sandbox-api.transfi.com}"
USER="${TRANSFI_USERNAME:?}"
PASS="${TRANSFI_PASSWORD:?}"
MID="${TRANSFI_MID:?}"

BASIC="$(echo -n "$USER:$PASS" | base64)"

echo "=== POST /v3/orders (create offramp order) ==="
echo "Auth: Basic ***; mid: $MID"

ORDER_ID="test-idem-$(date +%s%N)-$$"  # garantizar unicidad
RESPONSE=$(curl -s -X POST "$BASE/v3/orders" \
  -H "Authorization: Basic $BASIC" \
  -H "mid: $MID" \
  -H "Content-Type: application/json" \
  -d @- << EOF
{
  "orderType": "offramp",
  "partnerId": "$ORDER_ID",
  "userId": "UX-test-placeholder",
  "purposeCode": "BNFT",
  "source": {
    "currency": "USDCBASE",
    "walletAddress": "0x1234567890123456789012345678901234567890",
    "amount": 10
  },
  "destination": {
    "currency": "PEN",
    "paymentType": "bank_transfer",
    "paymentCode": "05011000",
    "amount": 35,
    "additionalPaymentDetails": {
      "accountNumber": "123456789",
      "accountHolderName": "Test Beneficiary",
      "bankCode": "002"
    }
  }
}
EOF
)

echo "Response: $RESPONSE" | jq '.' 2>/dev/null || echo "Response (raw): $RESPONSE"

# Extractnames de orderId/walletAddress
ORDER_ID_RETURNED=$(echo "$RESPONSE" | jq -r '.orderId // .id // "MISSING"' 2>/dev/null || echo "PARSE_ERROR")
WALLET_ADDR=$(echo "$RESPONSE" | jq -r '.walletAddress // .depositAddress // "MISSING"' 2>/dev/null || echo "PARSE_ERROR")

echo ""
echo "=== Resumen ==="
echo "orderId: $ORDER_ID_RETURNED"
echo "walletAddress/depositAddress: $WALLET_ADDR"

if [[ "$ORDER_ID_RETURNED" != "MISSING" && "$WALLET_ADDR" != "MISSING" ]]; then
  echo ""
  echo "=== GET /v3/orders/{orderId} (consulta de estado) ==="
  STATUS_RESP=$(curl -s -X GET "$BASE/v3/orders/$ORDER_ID_RETURNED" \
    -H "Authorization: Basic $BASIC" \
    -H "mid: $MID")
  echo "Status response: $STATUS_RESP" | jq '.' 2>/dev/null || echo "Status (raw): $STATUS_RESP"
fi

echo ""
echo "✅ Smoke completado. Resolver F3-items desde la respuesta."
```

---

## Decisiones diferidas a backlog

| Ticket | Epica/HU | Detalle |
|--------|----------|---------|
| **WKH-XXX (a crear)** | Webhook receiver async | Recibir + validar `X-Transfi-Hmac-Hash` sobre `fund_settled`, actualizar `remittance_settlements` (WKH-207). Vive en `chaski-v2` (DT-1). **Depende:** esta HU (W0-W2 DONE); **Bloqueada por:** AC-4 smoke (descubrir nombres JSON reales). |
| **WKH-XXX (a crear)** | Envío on-chain USDC → `depositAddress` | Wallet plataforma manda USDC a la address dedicada que devuelve la orden. No existe hoy en ningún repo. **Depende:** webhook + reconciliación. |
| **WKH-168 (pendiente en `chaski-v2`)** | Settlement Avalanche → Base | Chaski hoy settlea principal en Avalanche (WKH-168); DT-2 decretó Base como red de off-ramp. Follow-up: migrar settlement a Base (infraestructura `BaseEip3009Adapter` ya existe). |
| **WKH-XXX (a crear)** | FX adapter real (`fx.ts`) | Mismo bug Bearer/endpoint; requiere verificar endpoint real de quote. Diferido a HU propia (DT-3). |

---

## Lecciones para próximas HUs

1. **Git safety en mutation testing sin commits** — `git checkout <file>` sobre cambios no commiteados es destructivo (restaura desde HEAD, no working tree). Respaldar con `cp` a scratchpad antes de experimentos. Aplicable a cualquier HU que use mutation testing / destructive experimentation.

2. **Typecheck debe ser completo (incluir tests)** — `npm run build` excluye `*.test.ts` (lección WKH-196, replicada en WKH-208). El gate es `npm run typecheck` SIEMPRE, no solo build. Hereda CD-10: verificar cada wave por `typecheck` antes de cerrar (incluso si los tests pasan).

3. **Test determinismo con env vars** — Tests que dependen de la AUSENCIA de env vars pierden determinismo si esas vars terminan en el `.env.local` del repo/CI. Usar `vi.stubEnv(...)` explícito con CD-12 (hereda de WKH-208). Aplica especialmente a factory patterns con fallbacks.

4. **Allowlist estático vs. runtime queries** — Validación de redes soportadas: allowlist estático (confirmado en F3, sin I/O en hot-path) es superior a `list-tokens` en cada `execute()` (añade latencia + punto de falla). DT-6: la lista publicada es la fuente; F3 la confirma/extiende (no inventa). Aplicable a cualquier adapter que dependa de lista "autorizada" de valores.

5. **Contrato HTTP debe ser verificado against spec real (no a ciegas)** — El error "histórico" de WKH-172 (`/v1/payouts` + `Bearer`) fue construir a ciegas. WKH-208 corrige: 4 ejes (endpoint, auth, idempotencia, flujo) checkeados contra `doc/transfi-offramp-api-spec.md` ANTES de F3. Regla: especificación escrita → verificada por Read → citada en SDD §1 Context Map (con líneas). Sin eso, el Dev reconstruye a ciegas.

---

## Sign-off

| Rol | Status | Fecha |
|-----|--------|-------|
| Architect (SDD, F2) | ✅ SPEC_APPROVED | 2026-07-17 |
| Dev (F3, W0-W3) | ✅ DONE (código W0-W2) | 2026-07-17 |
| Adversary (AR) | ✅ APROBADO (0 BLQ, 2 MNR → cerrados) | 2026-07-17 |
| QA (CR) | ✅ APROBADO (0 BLQ, 1 MNR → cerrado) | 2026-07-17 |
| QA (F4, AC-1..8) | ✅ APROBADO (7/8 ACs, AC-4 pendiente) | 2026-07-17 |
| **Docs (cierre HU)** | ✅ DONE | 2026-07-17 |

---

**Estado final:** `DONE (código y validación mockeada) — AC-4 smoke sandbox diferido a siguiente pazo (founder, gateado).`

*Generado por nexus-docs — fase DONE. Orquestador presenta reporte al humano. AC-4 requiere acción manual del founder en el siguiente paso (credenciales + sandbox live).*
