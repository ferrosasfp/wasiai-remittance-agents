# Work Item — [WKH-204] Atar el KYC re-verificado a la identidad de quien pide el payout (G4)

> F0+F1 (NexusAgil QUALITY) · Repo: `wasiai-remittance-agents` · Origen: hallazgo R-2 del F2 de
> WKH-203 (`doc/sdd/001-wkh-203-payout-kyc-server-gate/done-report.md:69`), ratificado por el
> founder como HU propia. Es **G4** de los 4 huecos del gate de Fase A (G1=WKH-202 ✅,
> G2=WKH-203 ✅, G3=WKH-168 diferida, G4=esta HU).

---

## Resumen

WKH-203 (merge `37728c0`, mergeada) cerró que el agente de payout confíe en un booleano del
**caller** para decidir compliance: ahora re-deriva `isKycGatePassed()` consultando Didit por
`kycVerificationId`. Pero ese gate confirma **que la verificación está aprobada**, no **que sea de
quien pide el payout**. Un caller que invoque `remit-cashout-payout` directo (salteando la DApp
`chaski-v2`, que sí hace su propio ownership check) puede pasar el `kycVerificationId` aprobado de
**otra persona** y recibir el payout en su propio `beneficiary`. Es un IDOR-análogo. Esta HU
diseña e implementa el binding `kycVerificationId` ↔ identidad de quien pide el payout, **sin**
violar CD-7 (el `KycStatusResult` no puede exponer PII/`vendor_data` crudo) y **sin** debilitar
ningún fail-safe money-path existente.

---

## Sizing

- **SDD_MODE**: full
- **Estimación**: L (mismo punto de partida que WKH-203; el espacio de diseño de DT-1 —
  cómo probar identidad sin violar CD-7 — es más abierto que el de WKH-203, y toca 2 agentes
  publicados si la opción elegida modifica `verify()`)
- **Sizing override esperado**: money-path + compliance gate + IDOR-análogo + PII → QUALITY como
  mínimo, sin importar lo que un sizing automático sugiera
- **Branch sugerido**: `feat/002-wkh-204-payout-kyc-identity-binding`

---

## Hechos verificados en disco (grounding, 2026-07-15, post-WKH-203 `37728c0`)

Todos releídos por mí, no asumidos del input del orquestador:

1. **`CashoutPayoutInputSchema` no tiene ningún campo de identidad del sender**
   (`src/agents/cashout-payout.ts:18-33`): `quoteId`, `amountUsd`, `kycVerificationId`,
   `beneficiary{name,country,method,destination}`, `idempotencyKey`. `kycPayoutAllowed` fue
   eliminado (WKH-203/DT-4).
2. **`KycStatusResult` (`src/providers/types.ts:37-42`) no expone `vendor_data`**: es
   `{approved, verificationId, provenance, reasons}`, deliberadamente angosto por CD-7 ("NO incluye
   travelRuleData ni ningún campo derivado del legalId/DNI"). Hoy no hay contra qué comparar.
3. **Tensión central — las convenciones de `vendor_data` son incompatibles entre repos**:
   - Este repo: `DiditKycProvider.verify()` (`src/providers/kyc.ts:33`) crea la sesión con
     `vendor_data: input.legalId` → **`vendor_data` = DNI = PII**.
   - `chaski-v2`: crea sus sesiones con `vendor_data` = wallet address (no-PII), y por eso su check
     `d.vendorData.toLowerCase() !== address.toLowerCase()`
     (`chaski-v2/src/infrastructure/payout/authority.ts:83`) funciona sin exponer PII.
   - Exponer `vendorData` crudo en `KycStatusResult` para replicar ese check acá **violaría CD-7**
     (filtraría el DNI). Ver DT-1.
4. **`verify()` es Scope OUT / CD-10 declarado en WKH-203** (intocable en esa HU). Cambiar
   `vendor_data` en la creación de sesión toca `verify()`, que también usa `remit-kyc-validator`
   (`src/agents/kyc-validator.ts`) — otro agente publicado. Ver DT-1(d) y CD-7 de esta HU.
5. **Límite honesto verificado, no se puede tapar**: cualquier campo de identidad agregado al
   input lo controla el caller. Sin prueba criptográfica de posesión (firma / SIWE), esta HU sube
   la barra (el atacante necesita el `verificationId` **y** la identidad que matchea) pero **no
   cierra el vector del todo**. Es la misma limitación documentada en
   `chaski-v2/src/infrastructure/payout/authority.ts:76-82` (MNR-B, "este binding ownership solo
   tiene fuerza real cuando `address` proviene de un caller AUTENTICADO... un replay de un
   verificationId Approved robado con `address=vendorData` (dato conocido) pasaría este check") y
   en `chaski-v2/src/infrastructure/kyc-auth.ts:6-7` ("NO prueba posesión de wallet... SIWE queda
   deferred"). Ver §"Qué cierra / Qué NO cierra".
6. **Precedente útil no citado por el orquestador, encontrado en grounding**:
   `chaski-v2/src/infrastructure/kyc-auth.ts` (WKH-179) ya implementa un token HMAC stateless
   (`issueSessionToken`/`verifySessionToken`, `node:crypto`, sin DB) que ata una sesión Didit a su
   caller. No prueba wallet-ownership, pero prueba **posesión de un secreto emitido junto con la
   verificación** — más fuerte que comparar un campo caller-controlado contra otro
   caller-controlado. Es candidato de diseño para DT-1(c) (ver abajo). Confirmado real y en
   producción en `chaski-v2`, no hipotético.

---

## Acceptance Criteria (EARS)

> El mecanismo exacto del binding (qué campo/forma trae el "identity claim") es DT-1, abierto a F2
> a propósito (ver sección DT). Los AC describen el comportamiento observable exigido, no el "cómo".

- **AC-1** (Event-driven): WHEN `runCashoutPayout()` recibe un `kycVerificationId` cuya
  identidad ligada (según la fuente autoritativa / el mecanismo de binding elegido en F2) NO
  coincide con la identidad reclamada por quien pide el payout, THE system SHALL bloquear el
  payout (`executed: false`, `status: "blocked"`, `reason` auditable y libre de PII) AND SHALL
  NOT invocar `PayoutProvider.execute()`.

- **AC-2** (Unwanted condition): IF el chequeo de identidad no puede confirmarse por cualquier
  motivo (claim ausente, mismatch, error/timeout del provider al resolver la identidad), THEN THE
  system SHALL bloquear por defecto (fail-closed) — sin ninguna rama "else → allow", replicando el
  patrón de 10 ramas fail-closed (B1-B10) que WKH-203 dejó en `isKycGatePassed()`.

- **AC-3** (Ubiquitous): THE system SHALL NOT incluir `beneficiary.name`, `beneficiary.destination`,
  `legalId`/DNI, `vendor_data` crudo, ni `travelRuleData` en ningún response body (200/400/502),
  incluyendo los nuevos códigos de bloqueo que agregue esta HU (CD-6/CD-7 preservadas).

- **AC-4** (Ubiquitous): THE system SHALL preservar sin modificar el comportamiento de
  `assertPayoutProviderSafe()`, las 10 ramas B1-B10 de `isKycGatePassed()`, la allowlist única
  `REAL_KYC_PROVENANCES` (`src/providers/kyc.ts:13`), y la comparación estricta `approved !== true`
  (CD-8/anti-WKH-198) — el binding nuevo se agrega, no reemplaza ni relaja el gate de WKH-203.

- **AC-5** (Event-driven, DT-2 pendiente de resolución en F2): WHEN un caller invoca el endpoint
  SIN el nuevo input de identidad que introduzca esta HU (caller legado, pre-WKH-204), THE system
  SHALL responder de forma determinística y documentada — el comportamiento exacto (bloqueo
  fail-closed por default vs. período de gracia) es DT-2, pero en cualquier caso NO SHALL exponer
  PII ni permitir un payout sin el chequeo de identidad.

- **AC-6** (Ubiquitous, documentación): THE SDD/README de esta HU SHALL declarar explícitamente
  que el binding implementado NO constituye prueba criptográfica de posesión (no hay
  firma/SIWE) — ningún artefacto de esta HU puede afirmar que el vector IDOR-análogo queda
  cerrado por completo.

`[NEEDS CLARIFICATION]` — el mecanismo exacto de AC-1/AC-2/AC-5 (DT-1, DT-2) se resuelve en F2.
El Analyst no lo prescribe para no invadir el rol del Architect.

---

## Scope IN

- `src/agents/cashout-payout.ts` (+ `cashout-payout.test.ts`) — el binding se aplica en/antes de
  `isKycGatePassed()` o en un chequeo hermano nuevo.
- `src/providers/types.ts` — posible extensión de `KycStatusResult` / nueva forma de consulta que
  NO exponga PII (ver DT-1).
- `src/providers/kyc.ts` (+ `kyc.test.ts`) — posible lógica de comparación **interna** al provider
  (nunca expuesta cruda al agente/caller).
- `src/app/api/agents/remit-cashout-payout/invoke/route.ts` (+ `route.test.ts`) — si el input HTTP
  cambia de forma.
- `README.md` — si cambia el contrato público del endpoint (nuevo campo de input).
- `project-context.md` — si se establece un patrón nuevo (ej. env var de secret compartido, o
  convención de "identity claim").
- **Condicional, solo si DT-1 concluye que hace falta**: `src/agents/kyc-validator.ts` /
  `src/providers/kyc.ts::verify()` — si la opción elegida cambia `vendor_data` en la creación de
  sesión. Requiere justificación explícita y análisis de impacto cross-agente (CD-7 de esta HU).

## Scope OUT

- **`chaski-v2`** (consumidor): su update para mandar el campo/claim nuevo (si aplica) es
  cross-repo POSTERIOR — se documenta el impacto de compat acá, pero no se toca.
- **`wasiai-a2a`** (gateway).
- El demo live (`agentshop-*`, `wasiai-agentshop.vercel.app`, `chaski-ai.vercel.app`).
- **WKH-168** (G3, verificación de que el sender pagó el principal) — diferida, no se toca.
- El flag `PAYOUT_ALLOW_MOCK` y la etapa mock del payout.
- Prueba criptográfica de posesión completa (SIWE / firma de wallet) — ver §"Qué cierra / Qué NO
  cierra". Candidata a HU de seguimiento si F2 concluye que es necesaria.
- El checklist pendiente de WKH-203 (`R-1`, compat Didit v2↔v3; `DIDIT_ADAPTER_READY`) — sigue
  igual de bloqueado, no lo toca esta HU.

---

## Decisiones técnicas (DT-N)

### DT-1 — CENTRAL: cómo probar la identidad sin violar CD-7 (NO resuelta acá, es de F2)

La tensión: `vendor_data` de este repo = DNI (PII); el patrón de `chaski-v2` (comparar
`vendor_data` contra una identidad caller-controlada) filtraría PII si se replica literal.
Opciones a evaluar por el Architect (no vinculantes, no exhaustivas):

- **(a) Comparación interna al provider, expone solo booleano.** El provider (`kyc.ts`) recibe
  la identity claim del caller como parámetro de `status()` (o un método nuevo) y hace la
  comparación contra el `vendor_data` real DENTRO del provider — el agente y el response HTTP
  nunca ven `vendor_data` crudo, solo `{approved, identityMatches: boolean}`. Menor cambio de
  superficie; requiere decidir contra qué compara si `vendor_data = legalId` (¿el caller manda el
  DNI también? ¿eso no es igual de sensible?).
- **(b) Comparación de hashes.** El input trae un hash (SHA-256 u otro) de una identity claim; se
  compara contra un hash del `vendor_data` real. Evita exponer el DNI en claro en el transporte,
  pero el hash de un DNI es reversible por fuerza bruta (espacio de 8 dígitos) — evaluar si de
  verdad protege o es seguridad-teatro.
- **(c) Token de posesión estilo `chaski-v2/kyc-auth.ts` (WKH-179).** Un HMAC stateless
  (`node:crypto`, sin DB — compatible con CD-11/cero-persistencia) emitido junto con la
  verificación KYC y exigido en el momento del payout. Precedente real, ya construido y en
  producción en el repo hermano. Requiere: (i) decidir QUIÉN emite el token (¿`remit-kyc-validator`
  al momento de `verify()`? necesitaría devolverlo en su output), (ii) un secret compartido entre
  los 2 agentes (`KYC_SESSION_SECRET`-equivalente), (iii) analizar si esto es "vía DB" — NO, es
  stateless, compatible con CD-11. Analyst recomienda evaluar esta opción primero: menor blast
  radius (no toca `verify()` de forma que afecte el `vendor_data`), y prueba posesión de un
  secreto en vez de comparar campos caller-controlados.
- **(d) Cambiar `vendor_data` en `verify()` a un valor no-PII** (análogo a `chaski-v2`, ej. un
  identificador del sender que no sea el DNI). Toca `verify()` (Scope OUT/CD-10 de WKH-203) y
  afecta a `remit-kyc-validator`, agente publicado independiente — alto impacto cross-agente, debe
  justificarse explícitamente si se elige.

**El Analyst NO decide esta DT** (instrucción explícita del orquestador: "NO la resuelvas vos, es
F2"). Se documenta el espacio de opciones para que el Architect diseñe con contexto completo.

### DT-2 — comportamiento con callers legados (sin el input nuevo)

Si F2 concluye que hace falta un campo de input nuevo, decidir: ¿bloqueo fail-closed inmediato
para callers que no lo manden (recomendado por default money-path), o período de gracia? Recomendación
tentativa del Analyst (no vinculante): fail-closed desde el día 1 — es money-path y hoy el path real
sigue gated por `assertPayoutProviderSafe()`, así que no hay tráfico productivo real que se rompa.

### DT-3 — si el mecanismo elegido requiere estado compartido entre agentes

Si DT-1(c) se elige, el secret compartido (`KYC_SESSION_SECRET`-equivalente) es una env var nueva
que deben conocer AMBOS agentes (`remit-kyc-validator` y `remit-cashout-payout`) — evaluar cómo
se distribuye sin romper CD-11 (cero persistencia). Un HMAC con secret en env es stateless y no
requiere DB, pero es una decisión consciente que debe documentarse en `project-context.md`.

---

## Constraint Directives (CD-N)

- **CD-1 (money-path, heredada, re-declarada acá con más fuerza)**: PROHIBIDO debilitar, saltear o
  volver condicional `assertPayoutProviderSafe()` (`TRANSFI_API_KEY`+`TRANSFI_ADAPTER_READY`,
  `PAYOUT_ALLOW_MOCK`, `ALLOW_FALLBACK_PAYOUT`). Esta HU agrega un gate NUEVO, no relaja ninguno
  existente.
- **CD-2 (aislamiento de repos)**: PROHIBIDO tocar `chaski-v2`, `wasiai-a2a`, o cualquier activo del
  demo live (`agentshop-*`, `wasiai-agentshop.vercel.app`, `chaski-ai.vercel.app`) desde este repo.
  Lectura read-only permitida (referencia); escritura prohibida.
- **CD-3 (no romper WKH-203)**: PROHIBIDO alterar el comportamiento de las 10 ramas fail-closed
  (B1-B10) de `isKycGatePassed()`, la allowlist única `REAL_KYC_PROVENANCES` (`src/providers/kyc.ts:13`,
  consumida por 2 agentes — PROHIBIDO duplicarla), o la comparación estricta `approved !== true`.
  PROHIBIDO "alinear" ese comparador con la truthiness `!kyc.approved` de `kyc-validator.ts:55` — la
  divergencia es intencional (CD-8 de WKH-203, anti-WKH-198).
- **CD-4 (PII, CD-6/CD-7 heredadas + reforzadas)**: PROHIBIDO exponer en cualquier response
  (200/400/502) `beneficiary.name`/`destination`, `legalId`/DNI, `vendor_data` crudo, o
  `travelRuleData`. El chequeo de identidad NUEVO de esta HU es exactamente el punto donde este
  riesgo es más alto — cualquier diseño que filtre `vendor_data` (aunque sea en un log, un mensaje
  de error, o un campo `reason`) es una violación CD-7 nueva, no un riesgo preexistente.
- **CD-5 (fail-closed obligatorio)**: el chequeo de identidad nuevo SHALL seguir el mismo patrón
  B1-B10: cada ambigüedad tiene una rama explícita de bloqueo; PROHIBIDO un default "else → allow".
- **CD-6 (no sobre-prometer)**: PROHIBIDO que cualquier artefacto de esta HU (work-item, SDD,
  README, comentarios de código) afirme que el vector IDOR-análogo queda "cerrado" sin la
  calificación "sube la barra, no prueba posesión criptográfica". Ver §"Qué cierra / Qué NO cierra".
- **CD-7 (impacto cross-agente)**: si el diseño de F2 toca `verify()` (`src/providers/kyc.ts`) o
  cambia la forma de `vendor_data` en la creación de sesión, DEBE: (a) justificar explícitamente
  por qué las opciones que no tocan `verify()` no alcanzan, (b) analizar el impacto en
  `remit-kyc-validator` (`src/agents/kyc-validator.ts`), (c) preservar compat de `KycInput`/`KycResult`
  para ese agente.
- **CD-8 (cero persistencia consciente)**: PROHIBIDO introducir una capa de persistencia (DB/KV)
  sin que sea una decisión EXPLÍCITA y documentada — el repo es cero-persistencia por diseño
  (CD-11 de WKH-203). Si el mecanismo elegido requiere estado compartido, debe resolverse
  stateless (ej. HMAC con secret en env) o documentar por qué no alcanza.
- **CD-9**: cero `any` explícito nuevo (heredado; WKH-203 dejó el repo en cero).
- **CD-10 (nunca 500)**: cualquier error nuevo introducido por el chequeo de identidad se mapea a
  502 con body opaco, igual que el resto de `route.ts` (heredado, no se debilita).

---

## Categorías de riesgo de seguridad (obligatorio)

| Categoría | Aplica | Detalle |
|---|---|---|
| **Money-path** | SÍ | El agente ejecuta (o ejecutaría, una vez `TRANSFI_ADAPTER_READY=true`) un desembolso real de PEN. Hoy inerte por `assertPayoutProviderSafe()`, pero el diseño debe ser correcto AHORA — no "arreglarlo después". |
| **IDOR-análogo** | SÍ (es el hallazgo central) | Un `kycVerificationId` Approved de otra persona, pasado por un caller directo (sin pasar por `chaski-v2`), hoy autoriza un payout hacia el `beneficiary` que decide el atacante. Esta HU sube la barra; no la cierra del todo (ver abajo). |
| **PII / compliance (CD-7)** | SÍ | El mecanismo de binding es, por construcción, el punto de mayor riesgo de filtrar `vendor_data`/DNI si se diseña mal. Cualquier response que devuelva ese dato es una violación NUEVA, no heredada. |
| **Cross-agente** | Condicional | Si DT-1 concluye que hay que tocar `verify()`, el radio de impacto se extiende a `remit-kyc-validator`, otro agente publicado y facturable. |

---

## Qué cierra / Qué NO cierra (obligatorio, sin sobre-prometer)

### Cierra (objetivo de esta HU, una vez implementada)
- Sube la barra material del ataque: hoy CUALQUIER `kycVerificationId` Approved ajeno pasa el gate
  sin fricción adicional (basta con conocer/robar un solo dato). Post-WKH-204, el atacante necesita
  ADEMÁS una identity claim (o token de posesión, según DT-1) que matchee la identidad ligada a esa
  verificación — deja de ser un ataque de un solo dato.
- Cierra la confianza implícita "cualquiera que sepa el id de una verificación Approved es su
  dueño", que es exactamente el hueco que `isKycGatePassed()` (WKH-203) dejó documentado como
  riesgo residual R-2.

### NO cierra (límite honesto, verificado, no se puede tapar)
- **Prueba criptográfica de posesión.** Ningún campo de identidad que viaje en el input HTTP deja
  de ser caller-controlado sin una firma (SIWE o equivalente). Si el atacante conoce/roba AMBOS
  datos a la vez (el `verificationId` aprobado Y la identity claim que lo ata), sigue pasando. Es
  la misma limitación que `chaski-v2/src/infrastructure/kyc-auth.ts:6-7` documenta explícitamente
  ("NO prueba posesión de wallet... SIWE queda deferred") y el mismo R1/MNR-B que el AR de WKH-202
  **probó ejecutando** contra `authority.ts` (Didit `Approved` sin `vendor_data` → el check se
  omite → pasó con `amountUsd: 999999`).
- **No habilita la Fase A por sí sola.** El gate de Fase A tiene 4 huecos independientes: G1
  (WKH-202 ✅) + G2 (WKH-203 ✅) + G3 (WKH-168, diferida — nadie verifica que el sender pagó el
  principal) + G4 (esta HU). Cerrar G4 sin G3 deja abierto: un atacante con SU PROPIO KYC
  `Approved` (y ahora también con SU PROPIA identity claim, matcheando) puede seguir pidiendo un
  payout con monto/beneficiario arbitrarios sin haber pagado el principal. **No setear
  `TRANSFI_ADAPTER_READY=true` hasta que G3 también esté DONE.**
- **Sigue bloqueada por `assertPayoutProviderSafe()`.** Hoy el path real no es explotable (nadie
  setea `TRANSFI_API_KEY`+`TRANSFI_ADAPTER_READY`). Esta HU es precondición de la Fase A, no una
  urgencia de incidente activo.

### Recomendación del Analyst sobre una HU de seguimiento (no vinculante)
Dado el límite anterior, si F2 concluye que el binding no-criptográfico (DT-1 a/b/c/d) es
insuficiente para el nivel de riesgo aceptado, recomiendo abrir una HU de seguimiento explícita
para prueba de posesión real (SIWE / firma de wallet aplicada al flujo A2A, no al browser) en vez
de inflar el scope de esta HU. Motivo: SIWE en un contexto A2A stateless (sin sesión de navegador,
sin `chaski-v2` en el medio necesariamente) es un cambio de arquitectura mayor que amerita su
propio F1/F2, no un anexo de esta HU. El Architect debe ratificar o refutar esta recomendación en
F2 con evidencia.

---

## Missing Inputs

- **[bloqueante, resuelto en F2]** DT-1: mecanismo exacto de binding identidad↔verificación sin
  violar CD-7. Ver opciones (a)-(d) arriba.
- **[bloqueante, resuelto en F2]** DT-2: comportamiento exacto para callers legados sin el input
  nuevo (si aplica).
- **[no bloqueante, resuelto en F2 o backlog]** DT-3: si el mecanismo requiere secret compartido
  entre 2 agentes, cómo se distribuye sin DB.
- **[NEEDS CLARIFICATION, no bloqueante]**: el orquestador mencionó que "WKH-205 está abierta en
  `chaski-v2`, repo distinto" como contexto de paralelismo. No encontré ningún artefacto
  (`doc/sdd/**/*WKH-205*`) en `chaski-v2` que lo confirme — puede estar en un estado previo a F1 o
  en otro formato. No bloquea esta HU (repos distintos, sin colisión de archivos), pero si
  WKH-205 termina definiendo CÓMO `chaski-v2` manda el nuevo campo/claim de identidad, hay una
  dependencia de **diseño** (no de archivos) entre ambas — el Architect de F2 debería confirmar el
  estado real de WKH-205 antes de cerrar DT-1, para no diseñar un contrato que después no matchee
  lo que el consumidor real puede mandar.

---

## Análisis de paralelismo

- **Este repo (`wasiai-remittance-agents`)**: no hay otras HUs abiertas (`_INDEX.md` tiene 1 sola
  fila, WKH-203 DONE). Sin riesgo de colisión de archivos.
- **`chaski-v2`**: WKH-205 mencionada como abierta (no verificada por mí, ver Missing Inputs). Repo
  distinto → sin colisión de archivos con esta HU. Posible dependencia de DISEÑO (no de código) si
  WKH-205 define el lado consumidor del binding.
- **G3/WKH-168**: diferida, no bloquea el trabajo de esta HU, pero SÍ bloquea que cerrar G4 habilite
  la Fase A completa (ver §"Qué cierra / Qué NO cierra").
- **Esta HU NO bloquea** a WKH-168 (G3) — son huecos independientes del mismo gate, ambos deben
  cerrar mano a mano para que la Fase A quede completa, pero no hay dependencia técnica entre
  ellas (distintos archivos, distinta lógica).

---

## Plan de tests (≥1 test por AC)

| AC | Test(s) mínimo(s) |
|---|---|
| AC-1 | `cashout-payout.test.ts`: identity claim NO coincide con la identidad ligada al `kycVerificationId` (mock del mecanismo elegido en F2) → `{executed:false, status:"blocked"}` + spy `provider.execute` nunca invocado. |
| AC-2 | `cashout-payout.test.ts` / `kyc.test.ts`: claim ausente → blocked; provider del chequeo de identidad lanza/timeout → blocked (fail-closed, no "asumir true"); idealmente mutation-testing del check nuevo (mismo patrón que AR de WKH-203, que mató 8/9 mutaciones del gate). |
| AC-3 | `route.test.ts`: `JSON.stringify(response.body)` NO contiene `legalId`/`vendor_data`/`travelRuleData`/`beneficiary.name`/`beneficiary.destination`, para los 3 status codes que puede emitir el endpoint (200 blocked, 400, 502). |
| AC-4 | Suite de regresión: los tests existentes de WKH-203 (79/79 hoy) siguen verdes con asserts intactos (`git diff -U0` sobre los archivos de test para confirmar que las aserciones no cambiaron, solo el arrange si hace falta agregar el mock del binding nuevo). |
| AC-5 | `cashout-payout.test.ts` / `route.test.ts`: caller sin el input nuevo → comportamiento determinístico según DT-2 (test se escribe una vez DT-2 esté resuelta en F2). |
| AC-6 | Revisión F4 (QA): grep del SDD/README de esta HU por la frase de calificación obligatoria ("no prueba criptográfica de posesión" o equivalente) — checklist de documentación, no test de código. |

**Gate de verificación**: `npm run typecheck` (cubre `*.test.ts`, NO usar solo `npm run build` —
precedente WKH-196) + `npm run test`. Baseline a preservar: 79/79 verde.

---

*Generado por nexus-analyst — F0+F1. Próximo paso: orquestador presenta este work-item al humano
para el gate `HU_APPROVED`.*
