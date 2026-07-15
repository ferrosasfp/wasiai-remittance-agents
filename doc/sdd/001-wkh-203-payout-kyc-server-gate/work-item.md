# Work Item — [WKH-203] El agente de payout no debe confiar en `kycPayoutAllowed` del caller

## Resumen
`remit-cashout-payout` hoy usa un booleano (`kycPayoutAllowed`) que manda el **caller** como único
hard-gate de compliance KYC antes de ejecutar un desembolso. Cualquier caller que mande `true`
desactiva el gate — y el consumidor real (`chaski-v2`) ya lo hace, hardcodeado. Esta HU mueve la
decisión de "¿este KYC habilita payout?" a una re-verificación **server-side** contra una fuente
autoritativa, en vez de confiar en el input. Es **G2** de los 3 huecos del gate de Fase A (habilitar
payout real); no la habilita por sí sola.

## Sizing
- SDD_MODE: full (requiere decisión de arquitectura no trivial — ver DT-1)
- Estimación: L (incertidumbre alta: la resolución depende de si Didit expone un endpoint de status
  por `verificationId`, o si hay que construir la primera pieza de persistencia del repo — hoy CERO)
- Branch sugerido: `feat/001-wkh-203-payout-kyc-server-gate`
- **Override esperado del orquestador**: money-path + compliance gate → mínimo QUALITY, sin importar
  lo que hubiera dado el sizing automático.

## Skills Router (máx. 2)
- `money-path-security` (fail-safes, fail-closed, IDOR-like trust-the-caller)
- `a2a-agent-provider-pattern` (patrón `zod → provider adapter/fallback → result` de este repo)

## Acceptance Criteria (EARS)

- **AC-1**: WHEN `remit-cashout-payout` recibe una invocación cuyo `kycVerificationId` no puede
  confirmarse como KYC aprobado por la fuente autoritativa server-side (Didit real, o el mecanismo
  que decida F2), en `NODE_ENV=production`, the system SHALL responder
  `{ executed: false, status: "blocked", reason: "kyc_gate_not_passed" }` (o un `reason` equivalente
  explícito) sin invocar `provider.execute()`.
- **AC-2 (fail-closed)**: IF el input incluye `kycPayoutAllowed: true` pero el agente NO puede
  re-derivar/confirmar server-side que el KYC de `kycVerificationId` está aprobado, THEN the system
  SHALL bloquear el payout — el booleano del input NUNCA SHALL, por sí solo, habilitar la ejecución.
- **AC-3**: the system SHALL determinar el gate de compliance exclusivamente a partir de una fuente
  autoritativa server-side (re-verificación por `kycVerificationId`); el campo `kycPayoutAllowed` del
  input NO SHALL ser la única señal usada para esa decisión.
- **AC-4 (no-regresión)**: WHILE los fail-safes existentes de `assertPayoutProviderSafe()`
  (`TRANSFI_API_KEY`+`TRANSFI_ADAPTER_READY`, `PAYOUT_ALLOW_MOCK`, `ALLOW_FALLBACK_PAYOUT`) siguen
  vigentes, the system SHALL preservar exactamente su comportamiento actual — ninguno de los 5 tests
  de fail-safe ya existentes en `cashout-payout.test.ts` SHALL cambiar de resultado.
- **AC-5 (continuidad CD-6)**: IF el nuevo gate produce un bloqueo o un error, THEN the system SHALL
  responder sin exponer `beneficiary.name`, `beneficiary.destination` ni `travelRuleData` en ningún
  código de respuesta (200/400/502).
- **AC-6 (compat, condicional a DT-4)**: WHERE un caller existente (ej. `chaski-v2`) sigue enviando
  `kycPayoutAllowed` en el body, the system SHALL aceptar el request sin devolver `400 invalid_input`
  por ese campo — `[NEEDS CLARIFICATION]`: si el campo se elimina del schema (rompe compat, requiere
  update cross-repo posterior) o se mantiene pero se ignora — decisión de F2 (ver DT-4).

## Scope IN
- `src/agents/cashout-payout.ts` (+ `src/agents/cashout-payout.test.ts`)
- `src/app/api/agents/remit-cashout-payout/invoke/route.ts` (+ su `route.test.ts`) — solo si el
  mecanismo de re-verificación requiere cambios de shape de error/respuesta
- `src/providers/types.ts` — posible extensión de `KycProvider` (ej. método de re-verificación por
  `verificationId`), SOLO si F2 elige esa dirección (ver DT-1a)
- `src/providers/kyc.ts` — posible extensión de `DiditKycProvider`/`FallbackKycProvider` con el
  método nuevo, SOLO si F2 elige DT-1a. El comportamiento existente de `verify()` NO se modifica.
- `.env.example` (archivo nuevo — HOY NO EXISTE en el repo) si F2 agrega env vars nuevas
- `project-context.md` (raíz) — actualizar si esta HU agrega env vars o cambia el patrón de agente

## Scope OUT
- **Repo `chaski-v2` completo** — incluye `src/infrastructure/a2a/gateways.ts:127`
  (`kycPayoutAllowed: true, // DT-5: sintetizado`, confirmado en disco). El cleanup de ese envío
  hardcodeado es trabajo cross-repo POSTERIOR a que este gate exista. NO se toca.
- **Repo `wasiai-a2a`** (el gateway/protocolo) — no se toca.
- El demo live: `agentshop-*`, `wasiai-agentshop.vercel.app`, la PWA `chaski-ai.vercel.app`.
- `src/agents/kyc-validator.ts` y `src/agents/corridor-fx.ts` — su comportamiento (`isPayoutAllowed`,
  `REAL_KYC_PROVENANCES`, etc.) NO se modifica. Su provider (`src/providers/kyc.ts`) sí puede
  **extenderse** (nuevo método), no cambiar el existente.
- `WKH-168` (value-delivery / principal-in, G3 del gate) — diferida, fuera de esta HU.
- El flag `PAYOUT_ALLOW_MOCK` y la etapa mock del deploy — no se toca su semántica.
- Habilitar el path de payout real (`TRANSFI_API_KEY`+`TRANSFI_ADAPTER_READY`) — PROHIBIDO en esta HU
  (ver CD-5).
- `resolveTravelRuleData()` como TODO completo — sigue siendo el stub de WKH-168 salvo que F2 decida
  que el mecanismo de esta HU lo toca tangencialmente (ver DT-2).

## Decisiones técnicas (DT-N)

- **DT-1 [NEEDS CLARIFICATION → F2]**: `kycPayoutAllowed` deja de ser autoritativo. Dos caminos
  posibles para la re-verificación server-side, ninguno obvio sin acceso al sandbox de Didit:
  - **(a) Re-verificar contra Didit por `verificationId`**: extender `KycProvider` con un método de
    consulta de estado (ej. `status(verificationId)`), análogo al patrón ya usado en
    `PayoutProvider.status()` (`src/providers/payout.ts:44-60`). No requiere agregar persistencia
    nueva al repo cuando el `provenance` es real (`didit`). Depende de que Didit exponga un endpoint
    de consulta por `session_id` apto (a confirmar — mismo TODO ya presente en `DiditKycProvider`,
    `src/providers/kyc.ts:14-16,36`).
  - **(b) Store de verificaciones**: `kyc-validator` persiste el resultado (incl. `payoutAllowed`) al
    aprobar; `cashout-payout` lo lee por `verificationId`. Más robusto (no depende de que el partner
    tenga un status endpoint apto para esto) pero es la **primera pieza de persistencia del repo**
    (hoy: cero DB/KV, confirmado en `package.json` — sin deps de Supabase/Postgres/Redis).
  - Para `provenance: "local-fallback"` (dev/CI, no producción): no hay partner externo que consultar
    en ninguna de las dos opciones — el comportamiento fail-closed en producción ya lo cubre (el
    fallback nunca corre en prod sin `ALLOW_FALLBACK_*`), así que esto no bloquea la decisión.

- **DT-2**: `resolveTravelRuleData()` (`cashout-payout.ts:125-133`) es HOY un STUB (`TODO(WKH-168/
  sandbox)`) que devuelve datos sintéticos vacíos — **no** es un canal ya funcional para recuperar
  nada real por `kycVerificationId`. F2 debe decidir si el mecanismo de re-verificación de esta HU
  reusa/toca ese código o si son cosas separadas. Default: esta HU NO resuelve el TODO de Travel Rule
  real (eso es WKH-168/sandbox); solo resuelve el gate booleano de compliance.

- **DT-3**: Comportamiento fail-closed obligatorio — si el agente no puede re-verificar (partner
  caído, timeout, provenance no reconocido, mecanismo no disponible), el resultado default DEBE ser
  bloquear el payout (nunca "asumir true"). Consistente con el patrón ya usado en `isPayoutAllowed()`
  de `kyc-validator.ts` (`REAL_KYC_PROVENANCES` como allowlist explícita, `src/agents/kyc-validator.ts:54-68`).

- **DT-4 [NEEDS CLARIFICATION → F2]**: `CashoutPayoutInputSchema.kycPayoutAllowed` — eliminarlo del
  schema (rompe compat inmediata con `chaski-v2`, que hoy lo manda siempre; requiere update cross-repo
  posterior, fuera de esta HU) vs mantenerlo pero ignorarlo en la decisión (compatible con callers
  existentes, pero deja un campo mentiroso/no-autoritativo en el contrato público). Trade-off dejado
  explícitamente a F2 por decisión del humano — no hay preferencia dada.

## Constraint Directives (CD-N)

- **CD-1 (invariante de seguridad, OBLIGATORIA)**: PROHIBIDO debilitar, saltear o volver
  condicionales los fail-safes de `assertPayoutProviderSafe()` (`src/agents/cashout-payout.ts:48-72`):
  el chequeo `TRANSFI_API_KEY`+`TRANSFI_ADAPTER_READY`, el gate `PAYOUT_ALLOW_MOCK` en producción, el
  gate `ALLOW_FALLBACK_PAYOUT` en dev. Son invariantes money-path vigentes. Esta HU **agrega** un gate
  nuevo (KYC re-verificado server-side), no reemplaza ni relaja los existentes.
- **CD-2 (cross-repo, OBLIGATORIA)**: PROHIBIDO modificar el repo `chaski-v2` o cualquier archivo del
  demo live que puedan estar viendo los jurados del grant Team1 (`agentshop-*`,
  `wasiai-agentshop.vercel.app`, PWA `chaski-ai.vercel.app`) desde esta HU.
- **CD-3**: OBLIGATORIO preservar en verde los 5 tests de fail-safe ya existentes en
  `cashout-payout.test.ts` (líneas 23-83) tal cual están escritos hoy — el hard-gate legacy
  (`kycPayoutAllowed` booleano) puede cambiar de semántica/implementación, pero
  `assertPayoutProviderSafe()` y sus tests NO.
- **CD-4**: PROHIBIDO exponer PII (`beneficiary.name`, `beneficiary.destination`, `travelRuleData`) en
  cualquier response nuevo o modificado (200/400/502) — continuidad de la garantía CD-6 ya documentada
  en la cabecera de `route.ts`.
- **CD-5**: PROHIBIDO habilitar el path de payout real (`TRANSFI_API_KEY`+`TRANSFI_ADAPTER_READY`
  configurados y activos) como parte de esta HU. El objetivo es cerrar el gate de compliance, NO
  encender Fase A.
- **CD-6**: PROHIBIDO agregar una dependencia de persistencia (DB/KV) sin que quede explícita en el
  SDD de F2 como decisión consciente (ver DT-1b) — no agregarla "de paso" ni sin justificar por qué
  la opción (a) no alcanzaba.

## Riesgos de seguridad (categorías obligatorias)
- **Money-path**: hoy NO explotable en prod (gated por `assertPayoutProviderSafe`), pero se vuelve
  explotable el día que TransFi esté configurado real — esta HU es precondición de seguridad para
  ese día.
- **Compliance gate bypass (trust-the-caller, análogo a IDOR)**: cualquier caller puede fabricar
  `kycPayoutAllowed: true` sin haber pasado KYC real. Confirmado en producción hoy:
  `chaski-v2/src/infrastructure/a2a/gateways.ts:127` — `kycPayoutAllowed: true, // DT-5: sintetizado
  (la autoridad WKH-180 ya se validó en ConfirmAndSend)`. Es decir, el cliente asume que otra capa
  (WKH-180, client-side/otro repo) ya validó, pero el server nunca lo confirma — cero verificación
  server-side end-to-end.
- **Fail-open silencioso**: riesgo de que el nuevo mecanismo de re-verificación, ante un error/timeout
  del partner, termine "abriendo" el gate en vez de cerrarlo. Debe testearse explícitamente (ver DT-3
  y plan de tests AC-2).
- **PII leakage**: cualquier response nuevo (bloqueo, error de re-verificación) debe respetar CD-6/CD-4.
- **Cross-repo drift**: cerrar WKH-203 NO "arregla" `chaski-v2` — solo hace que su envío
  hardcodeado/mentiroso deje de tener efecto sobre la decisión real. El cleanup del comentario
  `DT-5: sintetizado` en `chaski-v2` queda pendiente como trabajo cross-repo separado (fuera de scope).

## Análisis de paralelismo
- **G1 = WKH-202** corre AHORA en paralelo en el repo `chaski-v2` (endpoint `/api/a2a/payout/submit`
  proxy sin auth). Repo distinto, sin colisión de archivos con esta HU.
- Misma superficie conceptual del gate de Fase A: G1 = quién puede llamar al submit; G2 (esta HU) = si
  el payout confía ciegamente en un booleano del caller. **Son complementarios, no redundantes**:
  cerrar solo G1 deja el booleano igual de forjable por cualquier caller ahora-autenticado; cerrar solo
  G2 deja el submit abierto a callers no autenticados que de todos modos podrían forjar el booleano
  (hoy, sin auth). Ninguno de los dos por sí solo cierra el gate de Fase A.
- **G3 = WKH-168** (value-delivery / principal-in) diferida — no bloquea ni es bloqueada por esta HU.
- **Recomendación**: WKH-202 (repo `chaski-v2`) y WKH-203 (este repo) pueden avanzar F2 EN PARALELO —
  no hay dependencia técnica entre ambas (repos y archivos distintos). El gate de Fase A ("habilitar
  payout real") solo se declara cerrado cuando **ambas** (más WKH-168, diferida) estén DONE.

## Plan de tests (≥1 por AC)
- **AC-1**: test unit en `cashout-payout.test.ts` — `kycVerificationId` no re-verificable/no aprobado
  en `NODE_ENV=production` → `{ executed: false, status: "blocked", reason: "kyc_gate_not_passed" }`,
  y `provider.execute()` (spy/mock) NUNCA es invocado.
- **AC-2**: test — `kycPayoutAllowed: true` en el input PERO la re-verificación server-side falla/no
  confirma aprobación → bloqueado igual (fail-closed), demostrando que el booleano del input no basta.
- **AC-3**: test — el mecanismo de verificación se mockea para devolver una decisión que CONTRADICE el
  booleano del input (ej. input dice `false` pero la fuente autoritativa confirma aprobado, o
  viceversa) y se verifica que la decisión final sigue a la fuente autoritativa, no al input
  — semántica final exacta sujeta a lo que decida F2 (DT-1/DT-4).
- **AC-4**: correr sin modificar los 5 tests existentes de fail-safe en `cashout-payout.test.ts`
  (líneas 23-83) — regresión, deben seguir en verde exactamente como están.
- **AC-5**: test en `route.test.ts` — cualquier response de bloqueo o error nuevo no contiene
  `beneficiary.name`/`destination` ni `travelRuleData` en el JSON serializado (mismo patrón que
  `kyc-validator.test.ts:16-22`, `JSON.stringify(out)).not.toContain(...)`).
- **AC-6**: test de compatibilidad de schema — un body con `kycPayoutAllowed` presente (valor
  cualquiera) sigue siendo aceptado sin `400 invalid_input` por ese campo — sujeto a la decisión DT-4.

## Missing Inputs
- `[bloqueante, resuelto en F2]` DT-1: mecanismo exacto de re-verificación server-side (extender
  `KycProvider` con `status()` vs. store de verificaciones nuevo). Depende de si Didit expone un
  endpoint de consulta por `session_id` — no confirmable sin sandbox; F2/Architect debe decidir con
  la info disponible en el código (`DiditKycProvider`, TODOs existentes) y dejarlo `[TBD]` de mapeo
  exacto de campos si aplica (mismo patrón que ya usa el resto del repo).
- `[bloqueante, resuelto en F2]` DT-4: eliminar vs. mantener-ignorando el campo `kycPayoutAllowed` del
  schema de input.
- `[SIN PRODUCT CONTEXT]` no existe `product-context.md` en este repo — contexto de negocio mínimo
  inferido y documentado en `project-context.md` (sección "Contexto de Negocio").
