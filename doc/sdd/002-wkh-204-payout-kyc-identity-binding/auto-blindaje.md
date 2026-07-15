# Auto-Blindaje — WKH-204 (identity binding del payout)

> Errores/defectos hallados y corregidos durante F3. Cada entrada protege HUs futuras del mismo error.
> Los 2 primeros son defectos del **SDD** ya detectados y corregidos por el Architect en el Story File
> (§10); el Dev los **verificó ejecutando** antes de codear en vez de darlos por buenos.

### [2026-07-15] Wave 1 — El `String()`-guard de C8 nacía FAIL-OPEN

- **Error**: el SDD especificaba colapsar un `vendor_data` no-string a `""` con `String(v ?? "")` para
  que cayera en C5 y bloqueara.
- **Causa raíz**: `String(123)` es `"123"`, **no** `""`. Ídem `String({})` = `"[object Object]"`. Solo
  `null`/`[]` colapsan a `""`. ⇒ un `vendor_data: 123` **alcanza la comparación** y un atacante que
  reclame `"123"` **matchea → ALLOW**. El SDD se contradecía a sí mismo (su columna "Nota" decía
  "narrowing", que es lo correcto).
- **Verificado ejecutando** (no leyendo):
  ```
  vendor_data=123  | String()="123"             | typeof-narrow="" | String() bloquea por C5? NO  <-- FAIL-OPEN
  vendor_data={}   | String()="[object Object]" | typeof-narrow="" | String() bloquea por C5? NO  <-- FAIL-OPEN
  vendor_data=null | String()=""                | typeof-narrow="" | String() bloquea por C5? SI
  exploit: vendor_data=123 + claim "123" → String()-guard: MATCH → ALLOW | typeof-narrow: BLOCK
  ```
- **Fix**: `const vendorData = typeof vendorRaw === "string" ? vendorRaw : "";` (`kyc.ts`, C8).
  Test que lo mata: `vendor_data:123` con claim `"123"` → `identityMatches:false`.
  Mutante `typeof`→`String(...)` verificado: **muere**.
- **Aplicar en**: cualquier guard que "sanitice" un valor externo a `""` para bloquear. Regla asentada
  en `project-context.md` → `### PROHIBIDO`. Es la **misma clase** que WKH-198 (`NaN`), WKH-203
  (`approved` no-booleano) y WKH-202 (`vendorData === ""` omite el check): *un valor ausente o de tipo
  inesperado se lee como señal positiva*. Tercera vez del mismo bug en este ecosistema.

### [2026-07-15] Wave 3 — El arrange de los tests estaba sub-enumerado en el SDD

- **Error**: el SDD solo nombraba el arrange de los 6 call sites de `status()` en `kyc.test.ts`.
- **Causa raíz**: un contrato nuevo (param requerido + propiedad requerida) rompe **todos** los
  fixtures y stubs que lo construyen, no solo los call sites. Faltaban: el fixture `valid` de
  `kyc.test.ts` (→ `tsc` **rojo**) y los fixtures `validInput` + stubs de Didit de
  `cashout-payout.test.ts` y `route.test.ts` (→ **13 tests rojos** + 3 huecos).
- **Fix**: arrange completo en los 3 niveles (unit provider / unit agente / route HTTP), enumerado en
  el Story File §10/C2 con archivo, línea y efecto. **Ningún `expect(...)` existente se tocó** — solo
  crecieron los bloques *arrange* (criterio: los asserts son el contrato, el setup no).
- **Aplicar en**: toda HU que agregue un campo requerido a una interface o un param requerido a un
  método → buscar **fixtures y stubs**, no solo call sites, y en los **3 niveles** (el gemelo HTTP
  también). Precedente idéntico: el SDD de WKH-203 se saltó el route → 3 rojos.

### [2026-07-15] Wave 3 — Mutante de truthiness sobrevivía: el `!== true` no estaba testeado

- **Error**: tras cerrar la suite en verde, el mutation testing mostró que
  `identityMatches !== true` → `!identityMatches` (truthiness) **sobrevivía**: 10/11 mutantes muertos.
  Verde no significaba blindado.
- **Causa raíz**: ningún test inyectaba un `identityMatches` **truthy-pero-no-booleano** que llegara al
  gate. No era teórico: `FallbackKycProvider.status()` devuelve un **object literal que NO pasa por
  `assertValidKycStatus()`** → el guard C10 no lo cubre y el `!== true` del gate es la **última** línea
  de defensa (exactamente el motivo de CD-8/anti-WKH-198).
- **Fix**: 2 tests con `vi.spyOn(FallbackKycProvider.prototype, "status")` devolviendo
  `identityMatches: 1` y `approved: 1` (truthy no-booleanos) con `provenance:"didit"` (en la allowlist,
  o sea B1 abriría si el gate no bloquea) → deben dar `blocked` y no ejecutar. Resultado: **12/12
  mutantes muertos** (WKH-203 venía de 8/9; el kill de `approved !== true` fortalece también su gate).
- **Aplicar en**: **todo** gate escrito como `!== true`. Si ningún test inyecta un truthy-no-booleano,
  la estrictez **no está testeada** y el mutante sobrevive: la regla queda documentada pero no
  defendida. Correr el mutante antes de cantar victoria — la suite verde no lo detecta.

---

## Fix-pack (post AR+CR) — 2026-07-15

### [2026-07-15] Fix-pack — El test C6 pasaba por la RAZÓN EQUIVOCADA: la igualdad no estaba defendida

- **Error**: `normalizedVendor === normalizeIdentity(identityClaim)` mutado a **`.startsWith(...)`** o
  **`.includes(...)`** → **108/108 verde, 0 rojos**. Los dos mutantes **sobrevivían** (reproducido
  ejecutando antes de tocar nada). Mi propia ronda de mutación (12/12) **no los había cubierto**.
- **Causa raíz**: el fixture de C6 usaba `vendor_data:"12345678"` vs claim `"99999999"` — **misma
  longitud, sin relación de prefijo ni substring** → `startsWith` e `includes` devuelven `false`
  **igual que `===`**. El test verificaba "no matchea", pero **cualquier** comparación razonable pasa
  ese caso: no discriminaba la **estricta** de las **laxas**.
- **Riesgo real**: el código shipeado era correcto, pero si alguien "flexibiliza" a `includes`, un
  claim `"1"` matchearía **cualquier DNI que contenga un 1** → **bypass total del binding**, y la
  suite **no lo detectaría**.
- **Fix**: claims **prefijo** (`"1234"`) y **substring** (`"2345"`) de `vendor_data:"12345678"`, a nivel
  provider **y** agente. Verificado ejecutando: `===`→`.includes` mata **3** tests, `===`→`.startsWith`
  mata **2** (el substring no mata `startsWith`, como debe ser).
- **Aplicar en**: **toda** comparación de igualdad en un gate. Un fixture de "no matchea" con valores
  **no relacionados** (misma longitud, sin prefijo/substring común) es un **falso verde**: no distingue
  `===` de `startsWith`/`includes`/`localeCompare`. Elegir los negativos **adversarialmente** — que
  sean prefijo/substring/case-variant del positivo. Es la **misma lección** que la entrada de arriba,
  un nivel más arriba: *el mutante que no corrés es la regla que no defendés*.

### [2026-07-15] Fix-pack — Log tautológico: `identityClaimPresent: true` era ciego ante R-5

- **Error**: el warn de C11 emitía `{ branch:"C11", identityClaimPresent: true }` **idéntico** para C5
  (*Didit no ecoó `vendor_data`*) y para C6 (*el claim no matchea*), y `identityClaimPresent` era una
  **tautología**: C11 es **inalcanzable** si el claim no resolvió (`resolveIdentityClaim` → `null` →
  early-return) ⇒ **nunca** podía ser `false`. Cero información, pero **se leía como si fuera dinámico**.
- **Causa raíz**: el SDD/DT-3 pedía *"discriminación fina para ops"* pero el agente **no puede** nombrar
  la rama: el provider le devuelve **solo un booleano** (CD-7, correcto — el `vendor_data` es el DNI).
  Escribí el log **desde lo que el agente tenía a mano**, no desde **lo que ops necesita distinguir**.
- **Riesgo real**: **R-5 es el riesgo top de la HU** — este repo **nunca verificó** contra el sandbox
  que Didit ecoe `vendor_data`. Si no lo ecoa, el binding **bloquea TODO en prod** y ops ve una
  **avalancha de warns idénticos, indistinguibles de un ataque real**.
- **Fix**: discriminador **value-free** en `KycStatusResult.reasons[]` (contrato que **ya** exigía
  value-free): `identity_no_binding` (masivo y parejo = **integración rota**) vs `identity_mismatch`
  (puntual = **ataque**); + `claimSource: "senderIdentity" | "address"` (**sí** dinámico) en lugar de la
  tautología. `reasons` **NO** llega al response (DT-3 no-oracle) — testeado.
- **Aplicar en**: (1) un campo de log **constante** es **peor que nada**: se lee como señal y no lo es —
  si no puede variar, borralo. (2) Si dos ramas con **causas y respuestas operativas opuestas**
  (romper vs atacar) emiten el **mismo** log, el log **no sirve**. (3) Cuando el dato para discriminar
  está del lado equivocado de un borde de PII, la salida es una **etiqueta value-free** cruzando el
  borde, **no** relajar el borde.

### [2026-07-15] Fix-pack — Refs de línea stale: la lección de WKH-203 se repitió en la misma HU

- **Error**: `types.ts` decía *"`vendor_data` es el DNI (**kyc.ts:33**)"* — pero `kyc.ts:33` es un
  `fetch(...)`. El real era `kyc.ts:43`: **mi propia inserción** de `normalizeIdentity` (`kyc.ts:15-23`)
  corrió el archivo ~10 líneas. Ídem *"(L84-90 de este archivo)"*, que ya apuntaba a otro símbolo.
  Además README/`project-context.md` documentaban `KycProvider.status(verificationId)` — la firma
  **pre-WKH-204**, que hoy **no compilaría** (el 2º param es requerido).
- **Causa raíz**: una ref numérica es correcta **solo en el instante en que se escribe**; queda stale al
  **primer insert por encima** — incluso uno **de la misma HU**. WKH-203 ya dejó asentado *"citar
  símbolos, no números"* y **igual** se repitió: la regla estaba escrita pero no **aplicada**.
- **Fix**: citar el **símbolo** (`DiditKycProvider.verify()`) sin número; firma actualizada en ambos
  docs; barrido `grep` por otras refs stale de la firma vieja (0 restantes).
- **Aplicar en**: **nunca** `archivo:línea` en un comentario **de código** (sí en reviews/reports, que
  son point-in-time). Citar el símbolo. Y al cambiar una **firma**, `grep` de la firma vieja en
  `*.md` + `*.ts`: la doc que describe un contrato viejo **miente con confianza** (precedente WKH-202).

---

## Fix-pack #2 (post re-AR) — 2026-07-15

> Cero lógica de producción. Los 2 items son sobre la **honestidad del registro de tests**: dos
> canarios que prometían más de lo que verificaban.

### [2026-07-15] Fix-pack #2 — ⚠️ CORRECCIÓN: mi justificación de la Desviación 1 era FALSA (2ª vez)

- **Lo que declaré**: que nombrar la etiqueta `identity_no_vendor_data` **"rompía el canario CD-7"**
  (citando `expect(JSON.stringify(s)).not.toContain("vendor_data")` de `kyc.test.ts`), y cerré con
  *"No debilité un canario de PII para acomodar una etiqueta — renombré."*
- **Lo que el re-AR probó EJECUTANDO**: hizo el rename **consistente** (producción + las 4
  label-assertions, como haría cualquier rename real) → **122/122 PASAN. Ningún canario se rompía.**
  **Mi afirmación era falsa.** Queda escrito con todas las letras: este es el artefacto que lee el próximo.
- **Causa raíz de la falsedad**: los **dos** canarios `not.toContain("vendor_data")` stubbean un
  `vendor_data` **PRESENTE** — uno con claim que matchea (rama C7, `reasons: []`) y otro con claim
  ajeno (rama C6, `identity_mismatch`). **Ninguno ejercitaba la rama C5**, la única que emite
  `identity_no_binding` — justo la etiqueta en discusión. Razoné sobre el canario **leyéndolo**, no
  corriéndolo, y asumí que cubría una rama que nunca tocaba.
- **La decisión de renombrar SIGUE SIENDO CORRECTA — lo que cambia es el ARGUMENTO**: el motivo válido
  es **higiene de literales** (no meter el literal `vendor_data`, nombre de un campo del partner, en
  una etiqueta que viaja por **logs**), **NO** "rompía el canario". El criterio era bueno; **la
  evidencia era inventada**.
- **Y detrás había un hueco REAL**: la rama C5 **no tenía ningún canario de PII**. El rename a
  `identity_no_vendor_data` habría metido el literal en un `reason` y **nada se habría puesto rojo**.
- **Fix**: canario nuevo de la **rama C5** (`kyc.test.ts` → *"CD-7/C5: sin vendor_data → …"*): stub
  **sin** `vendor_data` → `identity_no_binding` + `not.toContain("vendor_data")`. **Verificado
  MUTANDO** (no leyendo): rename consistente en los 5 archivos → **muere**, y muere en el **assert de
  PII** (`kyc.test.ts:367`), con la label-assertion **pasando**. Mi afirmación **ahora es verdadera**:
  la convertí en verdadera en vez de seguir sosteniéndola.
- **Aplicar en**: 🔴 **SEGUNDA VEZ del mismo error, en dos HUs consecutivas.** En WKH-203 declaré que
  `vi.unstubAllGlobals()` arreglaba un falso verde existente; el AR lo quitó → 15/15 seguían verdes.
  La lección que **yo mismo escribí entonces**, textual: ***"antes de escribir 'esto arreglaba X',
  reproducir X; si no reproduce, el cambio puede seguir siendo correcto pero se documenta como
  preventivo"***. **Estaba escrita y NO la apliqué** — mismo patrón que la entrada de refs stale de
  arriba (*"la regla estaba escrita pero no aplicada"*). Corolario operativo: **"esto rompía X" es una
  afirmación EJECUTABLE — corré el mutante ANTES de escribirla.** Si no reproduce, el cambio se
  documenta como **preventivo/higiene**, que es un argumento perfectamente válido y **no necesita una
  falsedad que lo sostenga**. Y si el canario que citás no cubre la rama que creés → **ese es el bug**,
  no un detalle de redacción.

### [2026-07-15] Fix-pack #2 — Canario con NOMBRE FALSO en la superficie más riesgosa

- **Error**: el test *"el warn NUNCA contiene el claim, el `vendor_data` **ni el `verificationId`**"*
  (`cashout-payout.test.ts`) **no asserteaba el `verificationId`**: solo `12345678`, `99999999` y
  `vendor_data`. **Repro del re-AR**: agregar `verificationId` al objeto del warn de C11 → **122/122
  PASAN**, el mutante **sobrevive**.
- **Causa raíz**: el nombre del test se escribió describiendo la **intención** ("el warn no filtra
  nada"), no el **conjunto de asserts realmente presentes**. Nadie vuelve a leer los asserts: se
  confía en el nombre.
- **Riesgo real**: hoy **no hay fuga** (el warn es `{branch, claimSource, reasons}` y el
  `verificationId` es un handle de sesión, no el DNI) → por eso fue MENOR. Pero era un canario que
  **promete más de lo que verifica**, justo en el warn de C11: **la superficie que yo mismo declaré
  como la más riesgosa del fix-pack** (lo único que ve el `vendor_data` y el claim en el mismo scope).
- **Fix**: `expect(dump).not.toContain("v1")` (el `verificationId` del fixture). Se agregó el
  **assert**, NO se recortó el nombre: el `verificationId` en un log es ruido innecesario del lado
  equivocado del borde, aunque no sea PII. **Verificado MUTANDO**: `verificationId: s.verificationId`
  en el warn → el test **muere**.
- **Aplicar en**: el nombre de un test es un **contrato**, no una descripción de intenciones. Si
  enumera N cosas (*"nunca contiene A, B **ni C**"*), tiene que haber **N asserts**. Un canario que
  promete de más es **peor que no tenerlo**: alguien confía y no revisa. Regla que unifica las
  entradas de los dos fix-packs: **el mutante que no corrés es la regla que no defendés** — y ahora
  también **la frase que no reproducís es la evidencia que no tenés**.

---

## Lecciones de proceso (WKH-204, aplicables a futuras HUs)

### 1. Trampa del `git stash` en una HU sin commits

- **Riesgo**: en un repo sin commits de la HU (cambios unstaged), hacer `git stash` devuelve la
  versión **pre-HU**, no "la HU menos el fix". No hay forma de reproducir un estado "post-F3
  original, pre-fix". **Cinco agentes de esta sesión se la comieron** (WKH-204 AR/CR/re-AR/QA,
  todos intentaron con `git stash`).
- **Regla**: revertir **solo la línea específica** que necesitás aislar (editor + manual revert de
  esa línea), o `git show HEAD:archivo` para comparar. **Nunca `git stash` en una HU unstaged.**

### 2. `git diff` de un archivo untracked retorna vacío — no es evidencia de "cero cambios"

- **Riesgo**: al verificar que un archivo estaba intacto, hacer `git diff archivo` → resultado
  vacío. Eso no significa que no cambió; significa que el archivo **ya no está staged o es
  untracked**.
- **Regla**: diff contra la fuente real: `git show HEAD:archivo | diff - archivo` (pipe), o `git
  diff HEAD -- archivo` (con double dash). **Nunca confíes en `git diff` sin HEAD.**

### 3. Mutation testing ejecutado por DEV pre-entrega — sube el piso del AR

- **Patrón WKH-204**: el dev corrió mutation testing **antes** de entregar (no esperó AR). Encontró
  mutantes que los 79 tests previos no asesinaban (igualdad indefendida, truthiness). ⇒ **AR
  arrancó desde 12/12 mutantes muertos, no desde 0**, y llegó a **27 ejecutados en 3 rondas**. Entre
  dev, AR y re-AR corrieron **48+ mutantes.** Bloque: (dev encontró 2 finos / AR encontró 1 / re-AR
  confirmó). No es una anécdota — es la práctica estándar para money-path que **transfiere.**
- **Regla**: antes de `npm run test`, correr `npm run test -- --coverage` + herramienta de mutación
  (`stryker` o equivalent) en archivos de money-path. Si sobreviven mutantes, documentarlos en F3
  autoegBlindaje y citarlos en AR con el peso que merecen.

### 4. Probes de adversary deben correr en copia aislada

- **Riesgo**: el AR de WKH-204 dejó `src/adv.test.ts`/`adv2.test.ts` transitoriamente en el working
  tree, contaminando la corrida del CR (que rehizo todo con baseline limpio). El re-AR sí lo hizo
  bien (md5 verificado, limpieza explícita).
- **Regla**: **todo** probe de ataque corre en una **rama o carpeta aislada**, nunca en el working
  tree productivo. Si necesitás 2-3 archivos `.test.ts` para un probe, hazlo en `/tmp/probe-XX/` o
  una rama git feature; **nunca comprometás el baseline.** Verificación: `git status` post-probe
  debe estar limpio (salvo el diff esperado de F3).
