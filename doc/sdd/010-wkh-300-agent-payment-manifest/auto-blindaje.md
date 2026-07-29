# Auto-Blindaje — HU-300 (#010): manifiesto de cobro de los 3 agentes `remit-*`

> Registro de los errores cometidos durante F3 y de lo que se aprendió al corregirlos.
> No es un resumen de la HU: es lo que protege a las próximas HUs de repetir estos errores.

---

### [2026-07-28 22:42] Wave 1 — Un mutante que "sobrevive" puede no ser una mutación

- **Error**: el mutante **M3** (cambiar `typeof rawUnknown === "string" ? rawUnknown : ""` por
  `String(rawUnknown ?? "")` en `src/manifest/paytos.ts:17`) **sobrevivió** a la suite completa. La
  reacción por defecto —"falta un test, escribilo"— habría sido incorrecta, y la reacción opuesta
  —"el guard no sirve, sacalo"— también.

- **Causa raíz**: **el mutante era semánticamente equivalente al original bajo el runtime real.**
  `process.env` de Node **convierte a texto en el momento de la asignación** (incluso vía
  `Object.defineProperty`; y rechaza descriptores con getter, así que no hay forma de esquivarlo).
  Entonces, leyendo de `process.env`, el valor **ya es** texto o es `undefined`:

  | valor leído | original | mutante | ¿distingue? |
  |---|---|---|---|
  | `"0x11…"` | `"0x11…"` | `"0x11…"` | no |
  | `undefined` | `""` | `""` | no |

  Convertir a texto lo que ya es texto **es la identidad**. Cualquier mutación que dependa de esa
  conversión es **inerte** mientras la fuente sea `process.env`. Los killers que el Story File
  predecía para M3 (T6 whitespace / T10 formatos inválidos) **no podían matarlo por construcción**,
  no por estar mal escritos.

  > **La distinción difícil, y la lección central de esta entrada:** un mutante que sobrevive tiene
  > **dos** causas posibles, y confundirlas cuesta caro en las dos direcciones:
  > 1. **falta un test** que inyecte el valor que lo distingue → hay un guard sin cubrir; o
  > 2. **la mutación no era una mutación** → el mutante es equivalente bajo el runtime real y ningún
  >    test puede matarlo, porque no hay comportamiento que difiera.
  >
  > Antes de escribir un test nuevo o de tocar el código, hay que **determinar cuál de las dos es**,
  > empíricamente (una prueba chiquita contra el runtime), no por intuición.

- **Fix**: se investigó el runtime en vez de asumir, y se buscó **el valor que sí distingue** las dos
  implementaciones. No es `123` → `"123"` (ese caería igual en `invalid_format`, así que no prueba
  nada): es **un arreglo de un elemento**, porque `String(["0x1111…"])` devuelve **el contenido
  desnudo y válido** — con el mutante, el manifiesto publicaría `ok:true` con un `contract` que nunca
  fue un valor de env legítimo. Esa es la vía de inyección real, y la única forma de ejercitarla es
  **reemplazar el bag de `process.env` entero** (por eso ese test no usa `vi.stubEnv`, y lo dice en un
  comentario). Test en `src/manifest/build.test.ts:100-127`. Con él, M3 muere.

- **⚠️ El error propio, sin suavizar**: **el test que yo había escrito ahí era vacuo.** Inyectaba
  `123` en `process.env`, que el runtime convertía a `"123"`, de modo que **pasaba con cualquier
  implementación** — con el guard y sin el guard. Tenía un nombre que prometía verificar el
  typeof-narrowing y no verificaba nada. Fue el mutante el que lo delató; sin la corrida de mutación,
  ese test habría quedado en la suite dando una sensación de cobertura falsa sobre un guard del
  money-path. **Se reemplazó, no se le agregó otro al lado.**

- **Aplicar en**: (a) cualquier lectura de configuración que use `String(x)`, `x ?? ""`, `!!x` o un
  cast para "normalizar" — verificar primero si el runtime ya normalizó, porque el guard puede ser
  decorativo **o** el test puede ser vacuo; (b) **todo test que afirme un guard de money-path**:
  mutar el guard y confirmar que el test se pone rojo, si no el test no prueba lo que dice su nombre;
  (c) toda corrida de mutación futura: ante un sobreviviente, decidir explícitamente entre "falta
  test" y "mutante equivalente" y **dejar escrito cuál fue**.

---

### [2026-07-28 22:42] Wave 2 — Dos guards que se sostienen mutuamente y ninguno lo dice

- **Error**: no es un bug introducido, es una **trampa latente** que se descubrió al medir el efecto
  real del mutante **M5** (borrar `export const dynamic = "force-dynamic"` de una ruta de manifiesto).

- **Causa raíz**: al borrar la marca, `npm run build` **igual** compiló las 3 rutas como
  `ƒ (Dynamic)`. El motivo es que el handler recibe el pedido (`GET(_req: NextRequest)`), y Next 14
  marca dinámica una ruta que usa el objeto request. O sea: hoy hay **dos** mecanismos que mantienen
  la ruta dinámica —la marca `force-dynamic` y el parámetro del pedido— y **ninguno de los dos
  documenta que depende del otro**. El parámetro, además, se ve como código muerto: está declarado
  con guión bajo y **se ignora por completo a propósito** (es lo que hace cierto AC-8).

- **Fix**: quedan los dos guards (la marca es la que exige la spec, y `T14a` la ancla verificando el
  export), y queda **escrito acá** que son redundantes-pero-acoplados. Referencia:
  `src/app/api/agents/remit-kyc-validator/manifest/route.ts:10` (la marca) y `:15` (el parámetro).

- **Riesgo concreto si no se registra**: alguien "limpia" el parámetro no usado **y** la marca en el
  mismo commit —las dos cosas parecen inofensivas por separado— y la ruta **se congela en build**. El
  `payTo` servido pasa a ser el del momento de compilar: rotar la env en Vercel no surtiría ningún
  efecto y **nadie se entera**, porque la respuesta sigue siendo un `200` bien formado. Es exactamente
  la clase de trampa que, sin registrar, se descubre en producción.

- **Aplicar en**: cualquier ruta futura de este repo que dependa de leer env en tiempo de request; y
  ante cualquier PR que toque `force-dynamic` **o** la firma del handler, verificar en la salida de
  `npm run build` que la ruta siga marcada `ƒ (Dynamic)`.

- **Nota lateral (inocua, pero conviene saberla)**: Next ejecuta el handler durante
  `Collecting page data`, así que un build sin envs imprime `[manifest] not publishable:`. No indica
  ningún problema —la ruta se sirve dinámica igual— y confirma de paso que ese log es value-free.

---

### [2026-07-28 22:42] Wave 3 — Mutar donde la spec cree que vive el código, no donde vive

- **Error**: el Story File atribuye el mutante **M6** (invertir el despacho por familia) al archivo
  `src/manifest/paytos.ts`. Ahí **no está el despacho**: `paytos.ts:25` sólo llama a
  `isValidPayToForFamily(value, entry.family)`. El despacho real vive en
  **`src/manifest/wallet-format.ts:47`**, porque forma parte del port verbatim del criterio del
  consumidor.

- **Causa raíz**: la spec describió la mutación por su **efecto semántico** ("invertir el despacho por
  familia") y la ubicó en el archivo donde ese efecto **se consume**, no donde el código **vive**.

- **Fix**: se aplicó la mutación en `wallet-format.ts:47`, que es donde produce el efecto buscado.
  Murió con 45 tests en rojo, incluyendo T13 en los dos sentidos (EVM en slot Solana y base58 en slot
  EVM) y los tests de dinero que nombran el efecto.

- **Por qué importa, y no es un detalle de forma**: **mutar el lugar equivocado es el error que más
  tiempo hace perder.** Si se hubiera editado `paytos.ts` para forzar ahí una inversión artificial, la
  suite igual se habría puesto roja y el mutante se habría contado como "muerto" **sin haber probado
  nunca el despacho real**. Da rojo, parece que probó algo, y no probó nada. Un mutante sólo cuenta si
  el rojo viene de haber alterado **la línea que toma la decisión**.

- **Aplicar en**: toda corrida de mutación — antes de editar, localizar la línea que **toma la
  decisión** (con `grep`, no de memoria ni confiando en la tabla de la spec) y confirmar que el
  cambio aterrizó ahí (`sha256sum` / `grep` sobre el archivo, no una lectura visual). Si la spec
  apunta a otro archivo, se sigue el código y se anota el desvío.

---

### [2026-07-28 22:42] Waves 0-3 — Restaurar archivos nuevos: `git` no sirve de red de contención

- **Error**: ninguno cometido en esta sesión — se aplicó la precaución desde el arranque, y se deja
  registrada porque el modo de fallar es silencioso.

- **Causa raíz**: **16 de los 18 archivos de esta HU son nuevos (untracked).** Sobre un archivo
  untracked, `git diff` sale **vacío** y `git checkout -- <archivo>` **no restaura nada**: no hay
  versión previa que restaurar. Verificar una mutación "mirando el diff" da un vacío que se lee igual
  que "no hay cambios", y confiar en `git checkout` para revertir **borra trabajo sin commitear**
  (ya pasó antes en este repo).

- **Fix**: para los 7 mutantes se usó, sin excepción: respaldo con `cp` al scratchpad **antes** de
  mutar → aplicar → **confirmar que la mutación aterrizó por `sha256sum` + `grep`** (nunca por lectura
  visual) → confirmar que **el mutante compila** (`npm run typecheck`) antes de contarlo, porque uno
  que rompe la sintaxis pone todo rojo y no prueba nada → correr la suite → restaurar con `cp` desde
  el respaldo → **verificar por hash que el archivo volvió idéntico** → confirmar la suite en verde
  antes del mutante siguiente. Los 3 archivos mutados terminaron con hash idéntico a su respaldo.

- **Aplicar en**: toda corrida de mutación sobre trabajo sin commitear, y en general ante cualquier
  "reversión" durante F3. **`git checkout -- <archivo>` está prohibido** como mecanismo de restauración
  en esta fase.

---

### [2026-07-28 22:42] Wave -1 — Medir el baseline en vez de heredarlo

- **Error**: ninguno; se registra la práctica porque el Story File avisaba de un número desactualizado
  y podría haberse copiado sin verificar.

- **Causa raíz**: el SDD declaraba `224 tests` y el Story File `245`. Un baseline heredado y falso
  hace que una regresión introducida en la HU se lea como "diferencia con el número viejo".

- **Fix**: se midió antes de escribir una línea: **`12 test files, 245 tests passed`** (coincide con el
  número del Architect, no con el del SDD). Cierre de F3: `20 test files, 364 tests passed`, con los
  245 base intactos. En la misma línea, los **fixtures del Story File se verificaron empíricamente**
  antes de construir tests encima (`SOL_OK` → 32 bytes, `SOL_33B` → **33 bytes y pasa la regex laxa**,
  que es justamente lo que vuelve válido a M1, `EVM_SHORT` → 39 hex), y el fixture agregado
  `SOL_OK_2` se verificó igual antes de usarlo. Un fixture que no cumple la propiedad que promete
  convierte su test en decorativo.

- **Aplicar en**: toda HU — medir el baseline en Wave -1 y anotarlo en el report; y verificar toda
  constante de test cuya **propiedad** (no su forma) sea lo que el test afirma.

---

### [2026-07-29 01:05] Fix-pack AR/CR — Portear MEDIA guarda de dinero (BLQ-1)

- **Error**: el oráculo `evaluateSettle` porteó **una** de las **dos** condiciones de la guarda de
  chain del consumidor. El original es `if (!chainKey || !bundle)`
  (`wasiai-a2a/src/lib/downstream-payment.ts:532-546`): (a) el resolver conoce el slug **Y** (b) el
  registry tiene el bundle **inicializado**. El port sólo tenía (a). Consecuencia: el test decía
  textualmente *"remit-corridor-fx-solana COBRARÍA"* y pasaba, cuando en cualquier entorno sin
  `SOLANA_ADAPTER_ENABLED=true` (**default OFF**, `wasiai-a2a/src/adapters/registry.ts:62-75`) esos
  2 agentes **no cobran**.

- **Causa raíz**: al portear una guarda se copió la **forma** (un `if`, un skip-code) en vez de las
  **condiciones**. Un `||` de dos términos donde el segundo depende de configuración del OTRO repo se
  lee fácil como "lo mismo dicho dos veces", y no lo es: el primero es código, el segundo es config.

- **Fix**: `evaluateSettle(payment, initializedChains = PROD_INITIALIZED_CHAINS)` con la guarda 3b
  explícita (`settle-preconditions.ts`), default **medido** contra prod el 2026-07-29
  (`GET /capabilities` → `chains[].key`: `kite-ozone-testnet`, `avalanche-fuji`, `base-sepolia`,
  `solana-devnet`), tests que fijan las dos caras (cobra con la chain inicializada,
  `CHAIN_NOT_SUPPORTED` sin ella) y un test que pinnea el default para que nadie lo cambie sin volver
  a medir. Mutantes M1 (borrar 3b) y M1b (sacar `solana-devnet` del default): **los dos murieron**.

- **Aplicar en**: **todo port de un guard de dinero** — enumerar los términos booleanos del original
  uno por uno y mapear cada uno a una línea del port; si un término depende de configuración del
  entorno del consumidor, **entra como parámetro explícito**, nunca como constante implícita. Y todo
  título de test que diga "COBRA/COBRARÍA" tiene que nombrar la configuración bajo la que eso vale.

---

### [2026-07-29 01:20] Fix-pack AR — Un gate operativo garantizado a dar verde (BLQ-2)

- **Error**: el runbook (README §Runbook-5, sdd §10-5) condicionaba el deslistado de los gemelos Fuji
  —la única ruta de cobro viva de FX/payout— a "confirmar el paso 3", y el paso 3 comparaba el
  `payment` del manifiesto contra el de `/discover`… **que coinciden por construcción**, porque el
  paso 1 manda copiar las addresses desde esas mismas filas. El gate daba verde sin haber tocado
  nunca el rail de cobro.

- **Causa raíz**: se confundió **consistencia documental** con **evidencia de efecto**. Un chequeo
  cuya entrada es la salida de un paso anterior no puede refutar nada.

- **Fix**: paso 5 nuevo = **prueba positiva de cobro** (mínimo: `solana-devnet` presente en
  `chains[].key` de `/capabilities`; ideal: invocación real en devnet con el settle visible), y el
  deslistado pasa a ser el paso 6, condicionado a esa prueba. Se agregó en negrita que **un `200` del
  manifiesto NO implica que el rail esté prendido**, y el §10-3 quedó marcado como chequeo que da
  verde por construcción.

- **Aplicar en**: cualquier runbook con un paso destructivo/irreversible-en-la-práctica. La
  precondición tiene que ser una medición **independiente** de los pasos que la preceden; si su
  entrada la produjo el propio runbook, no es un gate.

---

### [2026-07-29 01:30] Fix-pack CR — Tests vacuos y ramas sin ancla (CR-MNR-1/2/4)

- **Error**: (a) `wallet-format.test.ts` prometía *"detecta la zero-address en cualquier casing"* y su
  caso de casing era **byte-idéntico** al anterior (la zero-address no tiene letras hexadecimales:
  `toUpperCase().replace("0X","0x")` devuelve el mismo string); (b) la rama `catch` de las 3 rutas
  (`route.ts:31-40`) no la ejercitaba **nadie** — se le podía meter ahí un `200` con ficha a medias, o
  sea el bug exacto que la HU vino a matar, y la suite quedaba verde; (c) 2 guardas de
  `readPaymentSpecAccepts` sobrevivían a ser borradas.

- **Causa raíz**: el mismo patrón en tres lugares — se testeó el camino **fácil de alcanzar** y se
  asumió el resto. En (b) además pesó que la rama es defensiva ("no puede pasar"), y una rama que
  "no puede pasar" es exactamente la que nadie mira cuando empieza a pasar.

- **Fix**: (a) el test dejó de prometer casing y **documenta por qué ese camino es inalcanzable**
  (ADDRESS_RE exige la `x` minúscula antes); (b) un test por ruta que hace lanzar a `buildManifest`
  (`vi.doMock` + `vi.resetModules`, con `finally` para no contaminar el resto del archivo) y afirma
  `503` sin `payment`, sin eco del error ni del payTo — mutantes M5/M6/M7 (catch devolviendo `200`
  con ficha a medias): **los tres murieron**; (c) 2 casos nuevos en el auto-test del oráculo — sin
  `method` ni `protocol`, y `chain` no-string que **se coacciona** a un slug conocido (mutantes M3/M4
  muertos).

- **Aplicar en**: toda rama `catch`/defensiva de una ruta HTTP de dinero (hay que forzar el throw,
  no confiar en que no ocurra) y todo test cuyo caso "alternativo" salga de transformar el fixture
  principal: verificar que el valor transformado **no sea igual** al original antes de creerle.

---

### [2026-07-29 01:12] Fix-pack — Mutantes EQUIVALENTES: no perseguirlos (AR MNR-4)

- **Error**: ninguno. Se documenta para que la próxima corrida de mutación **no gaste tiempo** ni,
  peor, escriba tests que afirmen comportamiento sobre caminos inalcanzables.

- **Los dos mutantes equivalentes verificados**:
  1. Borrar el `.toLowerCase()` de `wallet-format.ts:20` (`isZeroAddress`). Corre **después** de
     `isValidEvmAddress`, y la zero-address no tiene ni una letra hexadecimal ⇒ no hay entrada
     alcanzable que distinga las dos versiones. Matarlo exigiría llamar `isZeroAddress("0X000…")`
     directo, que el pipeline nunca produce: sería un test que afirma un camino muerto.
  2. La rama de familia `solana` que exige que una **base58** caiga en el brazo EVM (o al revés) con
     una address que ninguna base58 puede alcanzar. Misma razón: no existe entrada que la distinga.

- **Regla**: un mutante sobreviviente es una señal, **no** una orden. Antes de escribir el test hay
  que responder: *¿existe una entrada ALCANZABLE que distinga original y mutante?* Si no, es
  equivalente: se anota acá y se cierra. Escribir el test igual **empeora** la suite (fija
  comportamiento de código muerto y estorba refactors legítimos).

---

### [2026-07-29 01:35] Fix-pack — Asimetrías CONOCIDAS del port (AR MNR-1 y MNR-3, no se arreglan)

- **Error**: ninguno. Son diferencias **deliberadas** entre el oráculo y el consumidor, y se dejan
  documentadas para que la próxima revisión no las relea como huecos.

- **MNR-3 — no hay análogo Solana de la zero-address**: el manifiesto rechaza la zero-address EVM
  (`ZERO_PAY_TO`) pero no tiene un rechazo equivalente para una base58 "nula" (p.ej. el System
  Program, 32 bytes en cero). Es fiel al consumidor: `downstream-payment.ts` sólo corta el zero-check
  en el brazo EVM (`:218-231`); el brazo Solana (`:255-262`) sólo valida formato. Agregarlo acá
  volvería el manifiesto **más estricto** que el settle, que es la otra forma de mentir.

- **MNR-1 — el `priceUsdc` no está porteado al oráculo**: `evaluateSettle` no evalúa el precio porque
  las guardas del leg tampoco lo hacen; el precio vive en el `payment` del registro, no en la decisión
  de saltear o pagar. El manifiesto lo publica desde `PRICE_USDC` (fuente única) y ahí se agota su
  responsabilidad en esta HU.

- **Regla**: el port es fiel al consumidor **por diseño**. Cualquier chequeo extra que se agregue del
  lado del manifiesto tiene que justificarse como "el settle también lo rechaza", con archivo:línea.

---

### [2026-07-29 01:08] Fix-pack — Una aserción "documental" que también hay que verificar

- **Error**: al reescribir el test vacuo de casing escribí `expect(EVM_ZERO.toUpperCase()).toBe(EVM_ZERO)`
  para documentar que la zero-address no tiene letras. **Rojo**: `toUpperCase()` sí toca la `x` del
  prefijo (`0X0000…`). La afirmación correcta es la del valor original del test viejo
  (`.toUpperCase().replace("0X","0x")`), que es lo que lo volvía vacuo.

- **Causa raíz**: escribí la aserción "de documentación" de memoria, sin correrla, porque parecía
  trivialmente verdadera. Las aserciones que explican **por qué otro test era falso** son
  exactamente las que hay que ejecutar.

- **Fix**: se corrigió a `EVM_ZERO.toUpperCase().replace("0X", "0x")` y se corrió el archivo (15/15).

- **Aplicar en**: cualquier aserción agregada "para dejar constancia" — se corre igual que las demás,
  y si es sobre un string, se verifica el string real, no el que uno cree recordar.

---

*Auto-Blindaje de F3 (Dev) — NexusAgil*
