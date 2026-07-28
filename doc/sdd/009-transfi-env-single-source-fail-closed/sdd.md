# SDD 009 · Ambiente de TransFi: una sola fuente de verdad + fail-closed

**Tipo**: fix de configuración del money-path (clase: config-drift entre dos consumidores de la misma env).
**Estado**: código DONE en branch `fix/transfi-env-single-source-fail-closed` (sin push, sin merge).
**Fecha**: 2026-07-27.
**Gates**: `npm run typecheck` OK · `npm test` 195 → **224** tests (11 archivos) · `npm run build` OK.

---

## 1. El defecto (verificado en código, no inferido)

La **misma** env gobernaba dos servicios con defaults **opuestos**:

| Antes | Default sin la env |
|---|---|
| `src/providers/fx.ts:9` | `process.env.TRANSFI_BASE_URL ?? "https://api.transfi.com"` → **PRODUCCIÓN del partner** |
| `src/providers/payout.ts:16` | `process.env.TRANSFI_BASE_URL ?? "https://sandbox-api.transfi.com"` → sandbox |

Sin `TRANSFI_BASE_URL` seteada el repo quedaba **"sandbox a medias"**: el agente de payout hablaba
sandbox y el de FX consultaba la API **productiva** de un partner licenciado. Consecuencias que el
founder no puede controlar desde su lado: se gasta la cuota de TransFi, se ensucian sus métricas, se
disparan sus rate-limits/alertas, y en el peor caso llegan datos reales que el sistema trata como de
prueba.

**Cómo se colaron los dos defaults** (post-mortem, no reproche): WKH-208 cambió el default a sandbox
y su CD-1 lo verificó con `grep -rn "api.transfi.com" src` (ver `003-.../story-WKH-208.md:72`), pero
`fx.ts` estaba **Scope OUT** por DT-3 y conservó el default productivo. El propio SDD anotó la
colisión de envs (`003-.../sdd.md:24`) y aun así el grep dio "OK" porque el hallazgo estaba fuera de
scope. Incluso `project-context.md` documentaba los **dos** defaults contradictorios (L157 sandbox y
L272 producción) sin que eso levantara una bandera.

## 2. Por qué NO se arregló cambiando el default de `fx.ts`

Cambiar `fx.ts` a sandbox arreglaba el síntoma y dejaba el diseño frágil: **dos** lugares con
permiso de opinar sobre el ambiente (pueden divergir de nuevo en la próxima HU con Scope OUT) y un
default que **adivina** el ambiente en silencio.

## 3. El diseño

### 3.1 Fail-closed: `TRANSFI_ENV` es obligatoria (`src/providers/transfi-env.ts:60-82`)

- `TRANSFI_ENV` ∈ `{sandbox, production}`. **No hay default de ningún tipo**, ni siquiera el seguro:
  un default es exactamente lo que produjo el bug.
- Ausente o vacía → `transfi_env_unset` (`:62-68`). Valor fuera del conjunto → `transfi_env_invalid`
  (`:69-72`). No se infiere el ambiente de `NODE_ENV`, del host ni de la presencia de credenciales.
- **Extra**: `TRANSFI_ENV=production` exige `NODE_ENV=production` (`:73-79`). Una máquina de dev/CI
  no le habla a la API productiva de un partner licenciado.

### 3.2 Una sola fuente de verdad, garantizada por el COMPILADOR

`resolveTransFiBaseUrl()` (`transfi-env.ts:92`) es la **única** función del repo que produce un host
de TransFi, y devuelve un tipo **branded** `TransFiBaseUrl` (`:28-31`). Los dos adapters lo reciben
por constructor como parámetro **obligatorio**:

- `TransFiFxProvider` (`fx.ts:61-65`), usado en `fx.ts:69` (`${this.baseUrl}/v1/quotes`).
- `TransFiPayoutProvider` (`payout.ts:108-112`), usado en `payout.ts:121` y `:188`.

Un `string` cualquiera (un default nuevo, un literal hardcodeado, otra env) **no compila** como
argumento. Los dos providers no pueden divergir *por construcción*, no por convención: ninguno de los
dos archivos define ni lee un host, y ambos se abastecen del mismo resolvedor
(`fx.ts:189`, `payout.ts:296`).

Se eligió **inyección por constructor** y no una lectura interna del env en cada adapter porque el
brand convierte "el host viene del resolvedor" en un invariante de tipos: es la variante más fuerte
que el stack puede garantizar sin runtime.

### 3.3 El override legado no puede contradecir al ambiente (`transfi-env.ts:96-139`)

`TRANSFI_BASE_URL` sigue soportada (mock de CI, host dedicado del partner) pero **ya no define el
ambiente** y se valida contra él:

| Caso | Resultado |
|---|---|
| sandbox + host productivo (o al revés) | `transfi_base_url_env_conflict` (`:117-122`) |
| sandbox + host `*.transfi.com` no canónico | `transfi_base_url_unclassified_partner_host` (`:123-129`) |
| production + host que no es del partner | `transfi_base_url_non_partner_host_in_production` (`:130-136`) |
| `http://` a un host remoto | `transfi_base_url_insecure_scheme` (`:108-113`) porque las creds van en un header Basic |
| `http://localhost:4010` | permitido (mock de CI) |
| URL no absoluta | `transfi_base_url_invalid` (`:99-104`) |

### 3.4 Sobre el "assert que verifique que los dos providers coinciden"

Tras el rediseño **no queda un camino en el que puedan diferir**: hay un solo productor de hosts y un
solo env. Un assert de runtime que comparara "el host de fx con el de payout" sería una **tautología**
(compararía el resultado de la misma función consigo mismo). Este repo ya tiene jurisprudencia contra
eso: el `identityClaimPresent: true` que se eliminó por tautológico
(`src/agents/cashout-payout.ts:161-163`). En su lugar la garantía es doble y **observable**:

1. **Test de coincidencia real** (`transfi-env.test.ts` G-15): corre las **dos** factories con el
   mismo env, dispara una request por cada adapter con `fetch` mockeado y exige `origin` idéntico
   (y que no sea el productivo). Es el test que reproduce el bug original si alguien lo reintroduce.
   G-16 verifica lo mismo con un override: una sola env mueve a los dos providers.
2. **Test estructural** (G-17): lee el código de `fx.ts` y `payout.ts` (ignorando comentarios) y falla
   si aparece `TRANSFI_BASE_URL` o un literal `transfi.com`, o si desaparece la llamada a
   `resolveTransFiBaseUrl()`. Un segundo origen de host no puede volver a entrar sin poner rojo el CI.

### 3.5 Relación con `assertPayoutProviderSafe` (el mecanismo que ya existía)

Se **extendió el eje que faltaba, sin crear un mecanismo paralelo y sin tocar el existente**:
`assertPayoutProviderSafe` (`cashout-payout.ts:66-92`) gatea *credenciales* (creds +
`TRANSFI_ADAPTER_READY`, con `PAYOUT_ALLOW_MOCK` para la etapa mock). Ese guard queda **intacto**;
lo nuevo gatea el **ambiente de la URL**, y se resuelve en el mismo punto donde ya se decide "real vs
mock" (`getPayoutProvider()` / `getFxQuoteProvider()`), después del check de creds. Duplicar el
chequeo dentro de `assertPayoutProviderSafe` habría sido redundante: `runCashoutPayout` llama al
factory inmediatamente después (`cashout-payout.ts:201-202`), así que un env sin declarar corta el
flujo igual, mapeado a `502 payout_unavailable` por la ruta.

## 4. Resolución LAZY: por qué no se valida al arrancar

El criterio pedía "error al arrancar **o** al primer uso". Se eligió **primer uso** (cuando se
construye un adapter real), no import-time, por una razón concreta: hoy devnet opera **sin**
credenciales de TransFi y con `PAYOUT_ALLOW_MOCK=true`. Validar en el import voltearía un deploy que
hoy es correcto e inerte (el mock nunca le habla a TransFi, así que no necesita saber el ambiente).
Con resolución lazy el modo devnet **no cambia en nada** y el fail-closed sigue siendo total para el
único path que puede tocar al partner. La mutación M11 (resolver el ambiente antes del check de
creds) pone **43 tests en rojo**: la laziness está protegida por tests, no es un accidente.

## 5. Qué pasa ahora si la variable no está seteada

| Escenario | Antes | Ahora |
|---|---|---|
| Sin creds TransFi (devnet actual) | mock, sin tocar TransFi | **idéntico** (mock, sin tocar TransFi) |
| `TRANSFI_API_KEY` + `READY`, sin `TRANSFI_ENV` | FX pegaba a **`https://api.transfi.com`** | `transfi_env_unset`, el adapter no se construye y **no sale ninguna request** |
| Creds payout + `READY`, sin `TRANSFI_ENV` | payout a sandbox (y FX a producción) | `transfi_env_unset` en ambos, fail-closed simétrico |
| `TRANSFI_ENV=sandbox` | (no existía) | los dos providers en `https://sandbox-api.transfi.com` |

**Migración (operador)**: cualquier deploy que setee credenciales de TransFi debe agregar
`TRANSFI_ENV=sandbox`. Hoy **ningún** deploy tiene creds seteadas (devnet corre en modo mock), así
que el cambio no rompe nada en vuelo. No se tocaron envs, prod, migraciones ni credenciales.

## 6. Archivos

| Archivo | Cambio |
|---|---|
| `src/providers/transfi-env.ts` | **NUEVO** (139 L) — única fuente de verdad + fail-closed + validación del override |
| `src/providers/fx.ts` | `:7` import · `:9-14` comentario del post-mortem (borrado el default productivo de `:9`) · `:61-65` ctor con `baseUrl` branded · `:69` usa `this.baseUrl` · `:186-189` factory resuelve el ambiente |
| `src/providers/payout.ts` | `:13` import · `:15-18` comentario (borrado el default local) · `:108-112` ctor · `:121`, `:188` usan `this.baseUrl` · `:293-296` factory resuelve el ambiente |
| `src/providers/transfi-env.test.ts` | **NUEVO** — 29 tests (G-1..G-18), `fetch` siempre mockeado, cero red |
| `src/providers/fx.test.ts` | `:9-27` mint del host vía el resolvedor real · adapter construido con `SANDBOX_BASE` · el test del factory ahora declara `TRANSFI_ENV` |
| `src/providers/payout.test.ts` | idem (`:10-29` + 19 call sites) |
| `project-context.md` | `:157-158` y `:272-273` documentaban los **dos** defaults contradictorios; ahora documentan `TRANSFI_ENV` y el override |

Sin entradas de `auto-blindaje.md`: no hubo errores de implementación que corregir en esta sesión.

## 7. Evidencia de mutación

Ver `validation.md`: 12 mutaciones, 12 cazadas (11 en rojo por tests, 1 por el typechecker).

## 8. Hallazgos de la misma clase (NO tocados, para backlog)

1. **`DIDIT_BASE_URL` tiene default productivo** (`src/providers/kyc.ts:8`):
   `process.env.DIDIT_BASE_URL ?? "https://verification.didit.me"`. Es un solo lugar (no puede
   divergir), pero el default sigue siendo el host **productivo** del partner: sin la env, un dev con
   `DIDIT_API_KEY` + `DIDIT_ADAPTER_READY=true` le pega a Didit producción. Aplicarle el mismo patrón
   (`DIDIT_ENV` fail-closed) es una HU chica y aditiva.
2. **`TRANSFI_USDC_NETWORK` se lee en dos lugares con criterios distintos**
   (`src/providers/payout.ts:60` sin default vs `:111` con default `base`): hoy son consistentes por
   casualidad (unset → `base` → no es `solana`), pero si `TRANSFI_DEFAULT_NETWORK` cambiara a
   `solana`, el gate del escape-hatch devnet dejaría de seguir al default sin que nada falle. Es la
   misma clase de bug (dos lecturas, un criterio implícito).
