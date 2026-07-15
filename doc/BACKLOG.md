# BACKLOG — wasiai-remittance-agents

Tickets y deudas técnicas abiertas que tocan a este repo. Verificables desde el código y los artefactos, no solo en listas efímeras del orquestador.

---

## Gate Fase A — 4 huecos independientes (G1-G4)

| # | Hueco | Ticket | Status | Qué cierra | Por qué se difiere |
|---|-------|--------|--------|-----------|-------------------|
| **G1** | `/api/a2a/payout/submit` sin auth (proxy público) | **WKH-202** | ✅ DONE (merge `3bae588`, `chaski-v2`) | Cualquiera llega al agente | Repo distinto; merge en paralelo completado |
| **G2** | Booleano `kycPayoutAllowed` del caller sin re-verificación | **WKH-203** | ✅ DONE (merge `37728c0`) | Confianza en fuente autoritativa (Didit) | Implementado; await checklist pre-`DIDIT_ADAPTER_READY` |
| **G3** | Nadie verifica que el sender pagó principal USDC | **WKH-168** | 📋 BACKLOG | Value-delivery (quote-lock, principal-in, payout, reconcile) | Diferida deliberadamente; bloquea `TRANSFI_ADAPTER_READY=true` |
| **G4** | KYC no atado a identidad del que pide payout (IDOR-análogo) | **WKH-204** | ✅ DONE (este repo, merge `37728c0`) | Identity binding via `senderIdentity` claim | Implementado; await checklist pre-`DIDIT_ADAPTER_READY` item #3 |
| **G5** | Prueba criptográfica de posesión (SIWE/firma) | **WKH-206** | 📋 BACKLOG (registrada aparte) | Cierre definitivo del vector IDOR-análogo | Diferida: requiere infra nueva (nonce store o equivalent); sin portal autenticado en A2A para anclar |

---

## Bloqueantes de Fase A

**No habilitar `TRANSFI_ADAPTER_READY=true` hasta:**
1. ✅ G1: WKH-202 DONE
2. ✅ G2: WKH-203 DONE + pasar checklist pre-`DIDIT_ADAPTER_READY` (items 1-2)
3. ✅ G4: WKH-204 DONE + pasar checklist pre-`DIDIT_ADAPTER_READY` item #3
4. 📋 G3: WKH-168 DONE (verificar principal-in USDC)
5. 📋 G5: Opcional; WKH-206 si se requiere SIWE real

---

## Cross-repo (consumidor: `chaski-v2`)

| Ticket | Descripción | Owner | Estado | Dependencia con `wasiai-remittance-agents` | Regla operativa |
|--------|---|---|---|---|---|
| **WKH-205** | Consumidor chaski-v2: mandar `senderIdentity` en lugar de `address` hardcodeado | `chaski-v2` / WKH-204 follow-up | 📋 BACKLOG | Diseño paralelo a WKH-204; campos definidos en SDD aquí | No bloquea DONE de WKH-204; pull-based (chaski-v2 adopta cuando esté listo) |
| **cosmético** | `chaski-v2:gateways.ts:127` sigue mandando `kycPayoutAllowed: true` hardcodeado | `chaski-v2` cleanup | 📋 LOW | Campo inerte post-WKH-203 (Zod lo strippea); documentado en WKH-203 done-report §R-5 | Cosmético, no bloquea nada |

---

## Deudas técnicas (Scope IN de este repo)

### AR/MNR-4 — `FallbackKycProvider.status()` asimetría

**Ubicación**: `src/providers/kyc.ts`

**Descripción**: `FallbackKycProvider.status()` devuelve un object literal que **NO pasa por `assertValidKycStatus()`**, mientras `DiditKycProvider.status()` sí. La garantía de que `identityMatches` es estrictamente `true`/`false` tiene dos defensas: `assertValidKycStatus()` y `!== true` en el gate. Para el path Didit; el fallback depende del `!== true`. **Asimetría intencional** (defensa en profundidad), pero vale documentar con un TODO.

**Cómo reproducir el riesgo**: `vi.spyOn(FallbackKycProvider, "status", () => ({identityMatches: 1, ...}))` devuelve truthy no-booleano que pasa el gate. **Testeado en WKH-204 AC-2** (mutante muerto); no es bloqueante.

**Fix recomendado**: Agregar `TODO(WKH-204-follow-up): FallbackKycProvider.status() debería llamar assertValidKycStatus() para paridad con Didit.` en `kyc.ts:XX` (dónde esté el fallback). Cosmético; la defensa ya existe.

**Estado**: LOW (documentado en auto-blindaje), no bloquea.

---

### CR/MNR-4 — Duplicate stubs de `stubDiditDecision()`

**Ubicación**: `src/providers/kyc.test.ts` + `src/agents/cashout-payout.test.ts`

**Descripción**: 16 stubs de `fetch` duplicados en `kyc.test.ts:XX` (nombrados `di1`, `di2`, ..., `di16`); el hermano `stubDiditDecision()` existe en WKH-203 (`kyc.test.ts:80-115`) y podría reutilizarse en ambos archivos. Código repetido, sin divergencia lógica.

**Cómo reproducir**: `grep -n "vi.stubGlobal.*fetch" src/providers/kyc.test.ts src/agents/cashout-payout.test.ts` → listará los duplicados.

**Fix recomendado**: Exportar `stubDiditDecision(status, amlHits)` como helper reutilizable desde `kyc.test.ts:80-115` con parámetros, reusarlo en `cashout-payout.test.ts`. Cosmético; todos los tests pasan.

**Estado**: LOW (documented in CR/MNR-4), no bloquea.

---

### README.md + project-context.md — Compat chaski-v2 documentación

**Ubicación**: `README.md:120-130` + `project-context.md:XX`

**Descripción**: Documentación refiere `KycProvider.status(verificationId)` — firma **pre-WKH-204**. WKH-204 agregó el param `senderIdentity` que es **requerido** en la firma, pero **opcional en el input HTTP** (DT-2 legacy compat). Documentos necesitan aclararse: la firma cambió, el schema no (por compat).

**Cómo reproducir**: `grep -n "status(verificationId)" README.md project-context.md` → encontrará referencias stale.

**Fix recomendado**: Actualizar ejemplos a `KycProvider.status(verificationId, senderIdentity)` y anotar que `senderIdentity` es requerido en el interface, pero opcional en el input HTTP (fallback a `address` legado). 1-2 líneas.

**Estado**: LOW (cosmético, documentación), no bloquea.

---

## Verificación del checklist pre-`DIDIT_ADAPTER_READY=true`

**Este checklist debe pasarse ANTES de setear `DIDIT_ADAPTER_READY=true` en producción.** Viven en `src/providers/kyc.ts:69-89`.

| Item | Descripción | Responsable | Estado | Evidencia |
|------|---|---|---|---|
| **1. R-1 compat v2↔v3** | `session_id` creado por `POST /v2/session/` (verify()) consultable por `GET /v3/.../decision/` | Operaciones (sandbox Didit) | ⏳ PENDING | Test manual: crear, consultar, verificar echo correcto |
| **2. Forma de `aml.hits`** | Payload contiene `aml.hits` (no `aml.total_hits`, no `aml: null`), cuenta correcta | Operaciones (sandbox Didit) | ⏳ PENDING | Test manual: KYC con hits AML, verificar `Array.isArray()` contea bien |
| **3. `vendor_data` echo (R-5, nuevo WKH-204)** | `vendor_data` creado en verify() está en decision response | Operaciones (sandbox Didit) | ⏳ PENDING | Test manual: crear con `vendor_data="123-45"`, consultar, verificar presente |

**Prerequisito para Fase A en producción**: items 1-3 TODOS verde.

---

## Notas operativas

- **No duplicar checklist**: WKH-203 y WKH-204 comparten items 1-2; WKH-204 agrega item 3. El operador debe verificar la lista completa **antes del primer `DIDIT_ADAPTER_READY=true` en prod**.
- **G3 separado**: WKH-168 (value-delivery) es independiente del checklist de Didit — es una regla de negocio, no una integración de partner.
- **WKH-206 registrada**: la repo contiene sólo el binding sin criptografía; WKH-206 (SIWE) vive aparte (NO VERIFICABLE en disco). Agregada a este BACKLOG como referencia de completitud.

---

*Revisado en DONE de WKH-204 (2026-07-15). Próxima actualización: cuando WKH-205/WKH-206/WKH-168 cambien de estado.*
