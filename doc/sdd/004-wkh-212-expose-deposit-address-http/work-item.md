# Work Item — [WKH-212] Exponer `depositAddress` en la salida HTTP de remit-cashout-payout

## Resumen
WKH-208 (DONE) agregó `depositAddress` a `PayoutResult` (el tipo interno que devuelven los
providers de payout, real TransFi y mock) para soportar el modelo create-order ASYNC de TransFi
(el sender manda el USDC on-chain a una address dedicada por orden). Pero ese campo se pierde en
el camino: `CashoutPayoutOutput` (el contrato HTTP que consume `chaski-v2`, WKH-211) no lo declara
ni lo mapea. Esta HU propaga `depositAddress` de forma ADITIVA hasta la respuesta HTTP del agente,
sin tocar la lógica de payout ni el adapter TransFi.

## Sizing
- SDD_MODE: mini (cambio aditivo acotado a 1 archivo de lógica + verificación de 2 más; sin lógica
  nueva, sin decisiones de negocio; el repo mantiene SDD ligero pero completo por convención de
  rigor money-path-adjacente — ver DT-2)
- Estimación: S
- Branch sugerido: `feat/004-wkh-212-expose-deposit-address-http`

## Acceptance Criteria (EARS)
- AC-1: WHEN el provider de payout (`TransFiPayoutProvider.execute()`) devuelve un `PayoutResult`
  con `depositAddress` no-null, the system SHALL incluir ese mismo valor en el campo
  `depositAddress` de `CashoutPayoutOutput` que devuelve `runCashoutPayout()`.
- AC-2: WHEN el provider activo es `FallbackPayoutProvider` (mock, `PAYOUT_ALLOW_MOCK`/dev), the
  system SHALL devolver `depositAddress: null` en `CashoutPayoutOutput`, sin lanzar error y sin
  alterar ningún otro campo del output.
- AC-3: WHILE el gate KYC bloquea el payout antes de llamar al provider (`identityClaim === null`
  → `reason: "kyc_identity_claim_missing"`, o `isKycGatePassed()` retorna `false` →
  `reason: "kyc_gate_not_passed"`), the system SHALL incluir `depositAddress: null` en el output
  (no hubo intento de payout, no existe address que propagar).
- AC-4: WHEN un cliente (ej. `chaski-v2`, WKH-211) hace `POST /api/agents/remit-cashout-payout/invoke`,
  the system SHALL serializar `depositAddress` dentro de `{ result: {...} }` usando el mismo
  `NextResponse.json({ result })` existente en `route.ts:22` — sin requerir cambios en ese archivo,
  porque el campo viaja ya incluido en el objeto `result` que retorna `runCashoutPayout()`.
- AC-5: IF `depositAddress` no aplica (mock o gate bloqueado), THEN the system SHALL emitir la key
  `depositAddress` con valor explícito `null` (nunca `undefined`/ausente), para que el shape de
  `CashoutPayoutOutput` sea consistente entre las 3 ramas de retorno (blocked x2 + executed) y los
  consumidores puedan distinguir "sin address" de "campo no soportado por esta versión del agente".

## Scope IN
- `src/agents/cashout-payout.ts:50-59` — `CashoutPayoutOutput` type: agregar
  `depositAddress: string | null`.
- `src/agents/cashout-payout.ts:208-217` — rama `kyc_identity_claim_missing`: agregar
  `depositAddress: null`.
- `src/agents/cashout-payout.ts:225-234` — rama `kyc_gate_not_passed`: agregar
  `depositAddress: null`.
- `src/agents/cashout-payout.ts:248-257` — mapeo del `result` real del provider: agregar
  `depositAddress: result.depositAddress`.
- `src/agents/cashout-payout.test.ts` — actualizar/agregar asserts de `depositAddress` en las 3
  ramas (executed real, blocked x2, y mock).
- Verificación (sin edición): `src/app/api/agents/remit-cashout-payout/invoke/route.ts:20-22` —
  confirmar que `NextResponse.json({ result })` serializa el campo nuevo sin cambios de código.
- Verificación (sin edición): `src/providers/payout.ts` — `PayoutResult.depositAddress` ya está
  correctamente poblado por `TransFiPayoutProvider` (línea 149) y `FallbackPayoutProvider`
  (líneas 194, 205) desde WKH-208. No se toca.

## Scope OUT
- Lógica del adapter TransFi (`src/providers/payout.ts`) — WKH-208, ya aprobado, NO se modifica.
- Máquina de estados de value-delivery (quote-lock → principal-in → payout → reconcile → refund) —
  WKH-168, fuera de scope.
- Cualquier flujo de dinero real / activación de `TRANSFI_ADAPTER_READY=true` — flags quedan OFF,
  mock sigue siendo el default en dev/CI.
- Endpoints o campos nuevos fuera de `CashoutPayoutOutput.depositAddress` (ej. no se agrega
  `depositAddress` a `KycStatusResult` ni a `FxQuote`).
- Consumo real del `depositAddress` en `chaski-v2` (eso es WKH-211, en el otro repo — esta HU solo
  desbloquea que el dato exista en el wire).

## Decisiones técnicas (DT-N)
- DT-1: `depositAddress` se agrega como campo NUEVO y siempre presente (con valor `null` cuando no
  aplica) en `CashoutPayoutOutput`, en vez de un campo `?: string` opcional-ausente. Un consumidor
  legado que no lo lea sigue funcionando igual (ignora la key extra); uno nuevo (chaski-v2) puede
  distinguir `null` (sin address, ej. mock/blocked) de un string real, sin ambigüedad de "no vino
  porque el agente es viejo" vs "no vino porque no aplica".
- DT-2: SDD_MODE `mini` (no `bugfix` liso) pese a que el cambio es mecánico: el archivo
  `cashout-payout.ts` es el output HTTP de un agente money-path (CD-6 de `route.ts` ya protege PII
  en esa misma respuesta), y el repo mantiene el patrón de founding rigor de WKH-203/204/208 (todas
  `full`). Un `mini` da trazabilidad (work-item + ACs EARS) sin el overhead de un SDD completo para
  un cambio de 1 archivo de lógica sin decisiones de negocio nuevas.

## Constraint Directives (CD-N)
- CD-1: OBLIGATORIO — el cambio es 100% ADITIVO. `CashoutPayoutOutput` no puede perder, renombrar
  ni cambiar el tipo de ningún campo existente (`slug`, `executed`, `status`, `payoutId`,
  `deliveredLocal`, `txRef`, `reason`, `provenance`). Cualquier consumidor existente que ignore
  `depositAddress` debe seguir recibiendo una respuesta byte-idéntica en el resto de las keys.
- CD-2: PROHIBIDO tocar `src/providers/payout.ts` (adapter TransFi ni `FallbackPayoutProvider`) —
  esa lógica es de WKH-208, ya aprobada y con AC-4 (smoke sandbox) pendiente por separado. Este
  work item NO reabre esa superficie.
- CD-3: PROHIBIDO activar o mencionar cambios de flags de producción (`PAYOUT_ALLOW_MOCK`,
  `TRANSFI_ADAPTER_READY`, `ALLOW_FALLBACK_PAYOUT`) — el mock sigue siendo el default; esta HU no
  cambia ningún comportamiento de negocio, solo la forma del output.
- CD-4: OBLIGATORIO — las 3 ramas de retorno de `runCashoutPayout()` (executed real, blocked por
  `kyc_identity_claim_missing`, blocked por `kyc_gate_not_passed`) deben incluir explícitamente
  `depositAddress` (nunca omitirlo en una rama y agregarlo en otra) — evita que TypeScript infiera
  un shape inconsistente entre ramas del mismo tipo de retorno.

## Missing Inputs
- Ninguno bloqueante. El shape de `PayoutResult.depositAddress` ya está confirmado en código
  (WKH-208, `types.ts:112-123`), y las 2 implementaciones de `PayoutProvider` ya lo pueblan
  correctamente. No hay preguntas pendientes para el humano.

## Análisis de paralelismo
- Esta HU DESBLOQUEA WKH-211 (chaski-v2, otro repo): el cliente necesita leer `depositAddress` del
  HTTP response para mostrarle al sender adónde mandar el USDC on-chain. Sin este fix, WKH-211
  está bloqueada aunque la data ya exista en el backend (WKH-208).
- No bloquea ni depende de ninguna otra HU de este repo (001-003 están DONE). Puede ejecutarse en
  paralelo con cualquier trabajo en `remit-corridor-fx` o `remit-kyc-validator` (archivos distintos,
  sin overlap).
- No tiene dependencia con el AC-4 pendiente de WKH-208 (smoke test sandbox) — el mapeo funciona
  igual con el provider real o con el mock; el smoke test de WKH-208 valida el JSON real que
  devuelve el sandbox de TransFi, no el contrato HTTP de este agente.
