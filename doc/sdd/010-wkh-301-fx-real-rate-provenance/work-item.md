# Work Item — [WKH-301] El agente de FX debe consultar una fuente real de tipo de cambio y declarar su procedencia sin ambigüedad

## Resumen
`remit-corridor-fx` hoy expone un campo `provenance` en su respuesta, pero ese campo colapsa dos
casos muy distintos bajo el mismo valor `"local-fallback"`: (a) una tasa mid real obtenida en vivo de
`open.er-api.com` + spread declarado, y (b) una constante hardcodeada (`STATIC_USD_PEN`, default
`3.75`) cuando esa consulta falla. Un consumidor (Chaski, el orquestador `wasiai-a2a`, o un humano)
no puede hoy distinguir "tasa de mercado" de "número inventado" mirando `provenance`, y por eso nadie
lo mira. Esta HU redefine la taxonomía de `provenance`, y define comportamiento fail-closed cuando no
hay ninguna fuente en vivo disponible: nunca servir la constante estática como si fuera una cotización
usable. El proveedor contratado (TransFi) sigue bloqueado por credenciales — fuera de alcance
activarlo; sí queda en alcance dejar el punto de enchufe listo por configuración.

## Sizing
- Smart Sizing: **QUALITY** — toca el money-path (monto de remesa entregado al beneficiario), tiene
  precedente directo de HUs `full` en este mismo repo sobre el mismo eje fail-closed/fail-open
  (WKH-203, WKH-204, WKH-208, WKH-196 en el repo hermano), y un fix mal hecho acá se traduce en PEN
  de menos (o de más) entregados a una persona real.
- SDD_MODE: **full**
- Estimación: **M** — un archivo central (`src/providers/fx.ts`) + ajustes de tipos (`types.ts`) +
  reescritura de varios tests de `fx.test.ts`/`corridor-fx.test.ts`/`route.test.ts` para cubrir la
  nueva rama fail-closed y la nueva taxonomía; sin nueva infraestructura (sigue sin DB).
- Branch sugerido: `feat/010-wkh-301-fx-real-rate-provenance`

## Acceptance Criteria (EARS)

- **AC-1**: WHEN `remit-corridor-fx` arma una cotización a partir de una tasa USD→PEN obtenida en vivo
  (fetch exitoso a la fuente configurada, o servida desde el cache en memoria mientras esté dentro de
  su ventana de frescura declarada), the system SHALL devolver un `provenance` que identifica sin
  ambigüedad que la tasa es de mercado/en vivo, con un valor DISTINTO de cualquier valor usado para
  el caso estático/local — en toda respuesta 200.

- **AC-2**: IF ninguna de las fuentes en vivo configuradas devuelve una tasa PEN usable (falla de red,
  timeout, respuesta no-2xx, o un shape sin un número PEN positivo) AND no existe una tasa cacheada
  dentro de su ventana de frescura, THEN the system SHALL fallar el request (mapeado al patrón 502
  opaco ya existente en este repo, ej. `{ error: "fx_unavailable" }`) en lugar de devolver 200 con una
  cotización armada a partir de la constante estática hardcodeada (`STATIC_USD_PEN`) presentada como
  si fuera usable.

- **AC-3**: The system SHALL exponer el endpoint de la fuente en vivo de FX como configuración por
  variable de entorno (nunca hardcodeada en el código fuente), de modo que activar el proveedor
  contratado (TransFi) cuando lleguen credenciales, o cambiar/agregar una fuente en vivo sin
  contrato, sea un cambio de configuración y no una reescritura del provider.

- **AC-4**: WHILE el adapter real de TransFi está activo (key + `TRANSFI_ADAPTER_READY=true` +
  `TRANSFI_ENV` seteados, vía el factory `getFxQuoteProvider()` existente), the system SHALL seguir
  devolviendo `provenance: "transfi"` sin cambios de comportamiento respecto de hoy (esta HU no toca
  el camino ya-real).

- **AC-5**: IF la fuente en vivo responde con un shape que no puede parsearse a una tasa PEN positiva
  y finita, THEN the system SHALL loguear un warning value-free (solo nombre de la fuente + motivo de
  falla, nunca el body de la respuesta ni datos del caller) antes de aplicar el comportamiento
  fail-closed de AC-2 — mismo patrón que el resto del repo (`console.warn`, nunca `err.message`/stack).

## Scope IN
- `src/providers/fx.ts` — `FallbackFxProvider`, `getUsdToPenMid()`: nueva taxonomía de `provenance`,
  remoción/gateo del camino que hoy sirve `STATIC_USD_PEN` como cotización 200 "normal", URL de la
  fuente en vivo configurable por env.
- `src/providers/types.ts` — posible endurecimiento del tipo `Provenance`/`FxQuote` (hoy `Provenance`
  es `string` suelto; evaluar un allowlist tipado, mismo patrón que `REAL_KYC_PROVENANCES` en
  `kyc.ts`) — decisión de Architect en F2.
- `src/agents/corridor-fx.ts` — revisión de que el error fail-closed de AC-2 se propaga limpio (hoy
  `runCorridorFx` no atrapa nada, delega al `route.ts`).
- `src/app/api/agents/remit-corridor-fx/invoke/route.ts` — confirmar/ajustar el mapeo del nuevo error
  al 502 opaco existente (mismo patrón que ya usan los otros dos agentes).
- Tests: `src/providers/fx.test.ts`, `src/agents/corridor-fx.test.ts`,
  `src/app/api/agents/remit-corridor-fx/invoke/route.test.ts` — cobertura de la rama fail-closed y de
  la nueva taxonomía (incluye mutation-testing del guard, precedente WKH-204).
- Variables de entorno nuevas/renombradas (documentar en `project-context.md`, tarea de Architect en
  F2 — este work-item NO edita `project-context.md`, ver regla de alcance de esta sesión).

## Scope OUT
- Activar el adapter real de TransFi (`TransFiFxProvider`) — credenciales bloqueadas, sin cambios;
  sigue detrás de `TRANSFI_ADAPTER_READY` + `TRANSFI_ENV`.
- Cualquier cambio en `remit-cashout-payout` para que consuma/valide el `provenance` del quote que
  recibe (`PayoutInput.quoteId` hoy no carga esa información) — es una HU de seguimiento propia si el
  founder la quiere, no se infiere acá.
- Cualquier cambio en `chaski-v2` o en el orquestador `wasiai-a2a` para que actúen sobre
  `provenance` (ninguno de los dos vive en este repo; `chaski-v2` está explícitamente prohibido de
  tocar desde acá, ver `project-context.md`).
- Contratar/activar un proveedor de FX de pago (Fixer.io, currencylayer, exchangerate-api.com de
  pago, etc.) — el founder pidió fuentes "sin contrato".
- Corredores/monedas distintos de USD→PEN.
- UI o presentación humana del `provenance` (no hay UI en este repo).

## Decisiones técnicas (DT-N)

- **DT-1 (la decisión pedida por el founder — fail vs. degradado)**: cuando NINGUNA fuente en vivo
  está disponible y no hay cache fresco, el agente SHALL **fallar** (no devolver 200 con la constante
  estática). Justificación: (1) `STATIC_USD_PEN` no tiene ninguna garantía de frescura — puede
  divergir de mercado sin que nadie lo note, y es exactamente el "número inventado presentado como
  real" que el founder prohibió; (2) mismo patrón fail-closed ya establecido en este repo para
  decisiones de dinero cuando la fuente autoritativa "no sabe" (WKH-203: `kyc_gate_unavailable` → 502,
  nunca fail-open; WKH-208/getPayoutProvider: readiness fail-loud); (3) el costo de disponibilidad es
  bajo y recuperable (un timeout de FX se resuelve en segundos con un retry del caller), mientras que
  el costo de un monto de remesa mal calculado es dinero real entregado de más o de menos a una
  persona. Se descarta la alternativa "degradado, decide el consumidor" como comportamiento por
  DEFAULT porque el propio founder documentó que el campo ya existe hoy y nadie lo mira — un
  `provenance` degradado silencioso repite el mismo problema un nivel más abajo.

- **DT-2 (fuente en vivo primaria)**: mantener `open.er-api.com` (ya integrada, gratuita, sin
  contrato/API key) como fuente primaria en lugar de reemplazarla. Cambiarla no resuelve el problema
  de esta HU (que es de taxonomía + comportamiento de falla, no de "la fuente actual está mal") y el
  founder pidió explícitamente no usar fuentes con contrato. **Limitación honesta de esta
  investigación**: este agente Analyst no tiene herramienta de navegación web en esta sesión —
  cualquier fuente alternativa (ej. tipo de cambio oficial del BCRP para PEN específicamente,
  Frankfurter.app, exchangerate-api.com free tier) queda listada como candidata a **verificar con
  acceso a internet real en F2** (ver Missing Inputs), no como confirmada.

- **DT-3 (config, no reescritura)**: el endpoint de la fuente en vivo se lee de una env var nueva
  (ej. `FX_MID_RATE_URL`, nombre final a definir en F2), con default = `open.er-api.com` para no
  romper el comportamiento actual sin configuración. Mismo patrón ya usado para
  `resolveTransFiBaseUrl()`/`TRANSFI_BASE_URL`: así, el día que lleguen credenciales de TransFi o se
  sume/cambie una fuente sin contrato, es un cambio de env, no de código.

- **DT-4 (taxonomía aditiva, no reemplazo in-situ)**: los valores de `provenance` se EXPANDEN (nuevo
  valor para "en vivo", ej. `"fx-mid-live"` o similar — nombre final en F2), no se renombra
  `"transfi"` (AC-4). Si Architect decide además renombrar/retirar `"local-fallback"`, debe tratarlo
  como cambio de contrato HTTP (documentarlo — CD-4), porque `chaski-v2` es un consumidor externo que
  hoy puede estar leyendo ese string literal.

## Constraint Directives (CD-N)

- **CD-1**: PROHIBIDO que dos orígenes de dato distintos ("obtenido en vivo de una fuente de mercado"
  vs. "constante estática hardcodeada") compartan el mismo valor de `provenance` en la respuesta. Cada
  valor de `provenance` DEBE mapear 1:1 a un método de obtención concreto y auditable.

- **CD-2**: PROHIBIDO introducir una rama de fallback "silenciosa" que devuelva 200 con un monto
  calculado sin una fuente en vivo verificable (ni logueada, ni marcada) por detrás. OBLIGATORIO:
  si todas las fuentes en vivo configuradas fallan y no hay cache fresco, el agente falla (AC-2/DT-1)
  — no hay una tercera rama "devolver algo igual".

- **CD-3**: OBLIGATORIO que la URL de la fuente en vivo del fallback sea configurable por env var, no
  hardcodeada (AC-3/DT-3) — mismo patrón que `resolveTransFiBaseUrl()`.

- **CD-4**: PROHIBIDO tratar un renombrado/retiro de un valor de `provenance` existente
  (`"transfi"`, `"local-fallback"`) como un cambio no-breaking. Cualquier cambio de ESOS dos valores
  debe documentarse explícitamente en el SDD como cambio de contrato HTTP, dado que `chaski-v2`
  (fuera de este repo, no tocable desde acá) es consumidor real.

## Missing Inputs

- **[bloqueante, cross-sesión]** No hay herramienta de navegación web disponible en esta sesión de
  Analyst para verificar en vivo candidatas a fuente en vivo secundaria (ej. si el BCRP publica un
  endpoint machine-readable del tipo de cambio oficial USD/PEN, si `open.er-api.com` en la práctica
  refresca cada 24h como documenta `exchangerate-api.com` — dato relevante para definir la "ventana de
  frescura" de AC-1/AC-2). Resolver en F2 con una sesión que tenga acceso a internet real (Architect,
  o confirmación directa del founder).
- **[resuelto en F2]** Nombre final de los nuevos valores de `provenance` (taxonomía) y de la env var
  de la URL configurable (DT-3/DT-4).
- **[resuelto en F2]** Ventana de frescura ("¿hasta cuándo una tasa cacheada sigue contando como
  `provenance` en vivo?") — hoy `CACHE_MS = 5 * 60_000` está hardcodeado; confirmar si se mantiene o
  se vuelve configurable.
- **[resuelto en F2]** Si `Provenance` pasa de `string` suelto a un union/allowlist tipado (mismo
  patrón que `REAL_KYC_PROVENANCES` en `src/providers/kyc.ts`) para evitar que un typo en el código
  cree un valor de `provenance` nuevo sin querer.
- **[bloqueante, dependencia de merge]** El branch `fix/transfi-env-single-source-fail-closed` (fila
  009 de `_INDEX.md`, "código DONE, sin merge") ya modifica `src/providers/fx.ts` (lee
  `resolveTransFiBaseUrl()`/`TRANSFI_ENV`). El branch de WKH-301 debe basarse en ese trabajo ya
  mergeado a `main` (o rebasear explícitamente sobre él) para evitar un conflicto de merge en el mismo
  archivo — Architect/orquestador debe confirmar el orden de merge antes de F2.

## Análisis de paralelismo
- **No bloquea** a WKH-235/WKH-236 (filas 007/008, `in progress`): esas HUs son de REGISTRO del agente
  en Solana en el repo `wasiai-a2a` (self-serve `POST /agents`), no tocan `src/providers/fx.ts` de
  este repo. Pueden avanzar en paralelo sin conflicto de archivos.
- **Depende de/debe secuenciarse con** la fila 009 (fix `TRANSFI_ENV` single-source, código DONE sin
  merge): comparte archivo (`src/providers/fx.ts`). Recomendación: mergear la fila 009 primero, o
  ramear WKH-301 explícitamente sobre ese branch, para no duplicar el trabajo de resolver el conflicto
  dos veces.
- No bloquea el pipeline de payout (`remit-cashout-payout`) ya que el contrato `PayoutInput` no
  cambia en esta HU (Scope OUT).
