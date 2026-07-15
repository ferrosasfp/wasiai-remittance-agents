# Auto-Blindaje — WKH-203 (gate KYC server-side del agente de payout)

Errores cometidos durante F3 y cómo se corrigieron. Sirve para blindar futuras HUs.

---

### [2026-07-15 F3] Wave 1 — `as any` copiado del code block del Story File viola la Done Definition del mismo Story File

- **Error**: implementé `DiditKycProvider.status()` copiando **verbatim** el bloque de código
  prescrito en §4 W1.2 del Story File, que contiene `(d as any).status`, `(d as any).aml?.hits`,
  `(d as any).session_id`. Eso introdujo **4 `any` explícitos nuevos**.
- **Causa raíz**: **contradicción interna del Story File**. §4 W1.2 prescribe un code block con
  `as any` (heredado del exemplar `verify()`/`payout.ts`, que ya lo usa), pero §13 Done Definition
  exige "**Cero `any` explícito nuevo**" y `project-context.md` (PROHIBIDO) dice "NUNCA `any`
  explícito en TypeScript". Seguir el code block al pie de la letra **falla** el checklist del AR.
  El code block es **ilustrativo de la lógica**, no de la tipificación.
- **Fix**: misma lógica, **cero `any`**, sin cambiar comportamiento (79/79 verde antes y después):
  ```ts
  const d = (await res.json()) as Record<string, unknown>;
  const decision = String(d.status ?? "").toLowerCase();
  const amlHitsRaw = (d.aml as { hits?: unknown } | undefined)?.hits;
  const amlHits = Array.isArray(amlHitsRaw) ? amlHitsRaw.length : 0;
  const echoed = String(d.session_id ?? "");
  ```
  `d` ya es `Record<string, unknown>` → el acceso por key no necesita `any`. `Array.isArray()`
  narrowea `amlHitsRaw` a `unknown[]` → `.length` compila. Los `as any` **preexistentes** de
  `verify()` (kyc.ts:43-45,53) **NO se tocaron** (CD-10: extender ≠ modificar).
- **Aplicar en**: (a) cualquier adapter nuevo que parsee JSON de un partner —
  usar `Record<string, unknown>` + narrowing, no `as any`; (b) **regla general**: cuando un code
  block de un Story File choca con la Done Definition / los guardrails del proyecto, **gana la
  Done Definition** (el code block comunica la lógica, no el estilo) y se **documenta** la
  desviación; (c) señal para el Architect: los code blocks de los Story Files no deberían copiar
  `as any` de exemplars viejos si la Done Definition lo prohíbe.

---

### [2026-07-15 F3] Wave 2 — `vi.stubGlobal` sin `unstubAllGlobals`: higiene de teardown (PREVENTIVO)

> **CORREGIDO post-AR (AR/MNR-3)**: la versión original de esta entrada afirmaba que sin
> `vi.unstubAllGlobals()` el mock de `fetch` "se filtra a L68/L77 → **falso verde**". **Eso era
> falso y el AR lo refutó mecánicamente**: quitando el `vi.unstubAllGlobals()` la suite sigue
> **15/15 en verde**. Los dos tests posteriores lanzan en el paso 2/3 (`assertPayoutProviderSafe()`
> / `getPayoutProvider()`) y **nunca alcanzan el gate KYC**, así que el stub filtrado no llega a
> tener efecto. **No había ningún falso verde existente que arreglar.** El cambio se queda, pero
> por la razón correcta (abajo). Un auto-blindaje con un fundamento inventado es peor que no
> tenerlo: el próximo lo lee como hecho verificado.

- **Situación**: al agregar el mock de `fetch` (`stubDiditDecision`) en el test protegido L57
  (`PROD + PAYOUT_ALLOW_MOCK`), el `describe` solo tenía `afterEach(() => vi.unstubAllEnvs())`.
  `vi.stubGlobal` instala **estado compartido entre tests** que ese `afterEach` no limpiaba.
- **Razón real del cambio — PREVENCIÓN, no corrección**: hoy el leak es **inerte** (ningún test
  posterior alcanza el gate). Pero el stub sobrevive al test que lo instaló, así que **el día que
  alguien agregue al describe un test que SÍ llegue al gate**, ese test correría contra el `fetch`
  mockeado de otro test sin saberlo → ahí sí habría un falso verde. Se cierra ahora que cuesta una
  línea, no cuando ya causó el bug.
- **Fix**: `afterEach` de todo `describe` que use `vi.stubGlobal` limpia **ambos**:
  `vi.unstubAllEnvs()` + `vi.unstubAllGlobals()`. Aplicado en los 3 archivos que ahora mockean
  `fetch` (`kyc.test.ts`, `cashout-payout.test.ts`, `route.test.ts`). Es el patrón que el propio
  Story File prescribe (§4 W1.4 / §11).
- **Aplicar en**: (a) **todo** test futuro que use `vi.stubGlobal` (fetch, Date, crypto…) — en un
  gate de compliance money-path un falso verde es exactamente el fail-open que la HU existe para
  impedir, y no conviene esperar a que se materialice; (b) **regla de registro**: antes de escribir
  "esto arreglaba X", **reproducir X** (acá: revertir la línea y correr la suite). Si no reproduce,
  el cambio puede seguir siendo correcto — pero se documenta como **preventivo**, no como fix.

---

### [2026-07-15 F3] Nota — el rojo de W2 NO fue un error del Dev (estaba previsto)

Al cerrar W2 la suite quedó en **3 rojos**, todos en `route.test.ts` (tests (2), (4) y (6)).
**No es un error**: es exactamente lo que el Story File §10 anticipó (**C1** el test (6) en
`NODE_ENV=production` cae en B3 → `provenance:"n/a"`; **C2** el arrange del fail-safe de payout).
Se cerró en W3 creciendo **solo los arrange** (asserts byte-idénticos). Se documenta para que el AR
no lo lea como drift, y como evidencia de que **el Architect cazó el defecto antes que el Dev**.

**Lección transferible**: cuando un gate nuevo se inserta en un flujo, hay que buscar sus gemelos a
**nivel HTTP/route**, no solo a nivel unit. El SDD hizo el análisis del rango protegido unit y se
salteó el route; el mismo caso estructural vivía en los 2 niveles.

---

## Lecciones de proceso — aplicables a futuras HUs

### [2026-07-15] La trampa del `git stash` en una HU sin commits

- **Trampa**: en un repo sin commits de la HU (cambios unstaged), hacer `git stash` **devuelve la versión pre-HU**, no "la HU menos el fix". No hay forma de reproducir un estado "post-F3 original, pre-fix".
- **Cuatro agentes de la sesión se toparon con esto**.
- **Regla**: revertir **sólo la línea específica** que necesitás aislar, o `git show HEAD:archivo` para comparar. **No usar `git stash` en una HU unstaged.**

### [2026-07-15] `git diff` de un archivo untracked retorna vacío (no es evidencia de "cero cambios")

- **Trampa**: al verificar que un archivo estaba intacto, hacer `git diff archivo` → resultado vacío. Eso no significa "no cambió"; significa que **no está staged o es untracked**.
- **Cuatro agentes intentaron usar esto como verificación de "intacto" y fallaron**.
- **Regla**: diff contra la fuente real: `git show HEAD:archivo` → pipear a `diff`, o `git diff HEAD -- archivo` (con double dash).

### [2026-07-15] Contar números en artefactos: verifica SIEMPRE con comandos

- **Patrón recurrente**: 5 artefactos de diferentes HUs contaron mal. WKH-202: 5→7 imports, 4→5 niveles; WKH-203: 5→7 tests protegidos, 4→5 tests en kyc-validator.test.ts; otras HUs similares.
- **Los agentes que verificaron ejecutando** (`npm run test`, `grep -c`, `git diff -U0 | grep expect`) **acertaron siempre**. Los que contaron **leyendo manualmente**, fallaron.
- **Regla**: números en ACs = ejecuta un comando. `grep -c "it\("`, `npm run test -- --reporter=verbose`, `git diff --stat` — **nunca manual**. Si el número real difiere en F3, **documenta en auto-blindaje inmediatamente** (referencia para F4/retro).

### [2026-07-15] Mutation testing como técnica de AR

- **Hallazgo**: el AR hizo mutation testing — mutó el gate KYC (quitó `=== true`, agregó `if (!s)`, deshabilité ramas) y midió qué tests mueren.
- **Resultado**: 8 de 9 mutaciones **asesinadas por los tests**; 1 superviviente (`!== true` → truthiness) = **redundancia de defensa** (esperada: `assertValidKycStatus()` ya garantiza booleano real).
- **Patrón transferible**: para futuros money-path gates (WKH-168, futuros auth gates), mutation testing probó las teeth de la suite mucho mejor que leerla. Vale como técnica de AR estándar.

### [2026-07-15] Code blocks de Story Files: lógica vs estilo

- **Conflicto**: el Story File prescribía un code block con `(d as any).status`, `(d as any).aml?.hits`. Eso introdujo 4 `any` explícitos nuevos, que violan el checklist "Cero `any` explícito nuevo" de la Done Definition.
- **Resolución**: cuando un code block choca con Done Definition / guardrails, **gana la Done Definition**. El code block comunica la **lógica**, no el **estilo**. Se documenta la desviación y se aplica tipificación real.
- **Aplicar en**: (a) cualquier adapter nuevo que parsee JSON de un partner — usa `Record<string, unknown>` + narrowing; (b) **señal para Architect**: code blocks NO deberían copiar `as any` de exemplars viejos si Done Definition lo prohíbe.
