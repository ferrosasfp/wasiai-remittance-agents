# wasiai-remittance-agents

Tres agentes autónomos del corredor de remesas **USDC → PEN** (Estados Unidos → Perú) que **cobran
por su trabajo en USDC sobre `solana-devnet`**, vía x402. Se descubren, se invocan por HTTP y se les
paga por llamada. **Ninguno de los tres toca una chain EVM.**

| agente (slug de cobro) | qué hace | precio | cobra en |
|---|---|---|---|
| `remit-kyc-validator` | KYC/AML: identidad + screening OFAC/PEP/sanciones + datos Travel Rule. Hard-gate: si el KYC no pasa, no hay payout. | 0.02 USDC | `solana-devnet` |
| `remit-corridor-fx-solana` | Cotiza el corredor USDC→PEN: tasa de mercado real + spread declarado + ETA. | 0.03 USDC | `solana-devnet` |
| `remit-cashout-payout-solana` | Cash-out a Perú (Yape/Plin/CCI): la entrega de valor al beneficiario. | 0.03 USDC | `solana-devnet` |

**Estado real.** Los 3 endpoints `/invoke` y los 3 `/manifest` están implementados y en verde
(**463 tests en 21 archivos**, sin red). Ya es real la **cotización FX** —tasa de mercado en vivo,
cascada de dos fuentes independientes, y **fail-closed**: sin tasa que se pueda respaldar, no se
cotiza— y son reales los **manifiestos de cobro**, que no se publican a medias. Todavía **no** son
reales el KYC (Didit) ni el desembolso (TransFi): corren en **fallback determinístico**, tageado como
tal en cada respuesta. El payout **no mueve plata**, a propósito y con un fail-safe que lo impide en
producción.

- **Licencia**: MIT. **Runtime**: Node 22, Next.js App Router, TypeScript strict.
- **Todas las variables de entorno**: [`.env.example`](.env.example) (fuente única).

---

## ¿Dónde está el código que mueve el USDC? (leer esto primero)

**No está en este repo, y es deliberado.** `package.json` no tiene ninguna dependencia de Solana: no
hay `@solana/web3.js`, ni una keypair, ni una llamada a un RPC. Si la tesis es "agentes que cobran en
Solana", vale explicar dónde vive el eslabón que efectivamente cobra.

| | este repo (`wasiai-remittance-agents`) | el gateway (`wasiai-a2a`) |
|---|---|---|
| **rol** | hace el trabajo y **declara** dónde cobrarlo | **ejecuta** el cobro |
| **artefacto** | `GET /api/agents/<agente>/manifest` → bloque `payment` | transferencia SPL de USDC en `solana-devnet` |
| **dato** | `{ method:"x402", chain:"solana-devnet", contract:"<base58 32B>", asset:"USDC" }` | firma y envía la transacción hacia la address de `contract` |
| **claves** | ninguna: la billetera es una variable de entorno, no un secreto | las claves del rail viven allá |

Un agente que quiere cobrar sólo tiene que honrar dos endpoints:

```
POST /api/agents/<agente>/invoke   body = input del step (JSON)  →  200 { result: {...} }
GET  /api/agents/<agente>/manifest                               →  200 { …, payment: {…} }  |  503
```

El operador copia ese bloque `payment` al registro del gateway, y desde ahí el gateway le paga al
agente en cada invocación. **Por qué así:** un agente que firmara sus propios cobros necesitaría una
hot key por agente y reimplementaría el rail una vez por agente. Con este reparto, toda la superficie
de este repo frente al dinero es **una address base58 leída de una variable de entorno** — y el
código que la valida (`src/manifest/wallet-format.ts`) aplica **el mismo criterio que el settle del
consumidor**, no uno propio.

Ese reparto es también la razón de `src/manifest/settle-preconditions.ts`: un **oráculo de test** que
porta, guarda por guarda y en el mismo orden, la secuencia real del gateway (`NO_PAYMENT_FIELD`,
`METHOD_NOT_SUPPORTED`, `CHAIN_NOT_SUPPORTED`, `INVALID_PAY_TO_FORMAT`, `ZERO_PAY_TO`). Permite
afirmar *"este agente cobraría / no cobraría"* **sin cadena y sin fondos**, que es lo que hace
demostrable el fail-closed del cobro dentro de CI.

> ⚠️ **Un `200` del manifiesto NO prueba que el agente cobre.** El manifiesto declara *dónde* cobra;
> que el gateway *pueda* pagarle ahí es configuración del gateway (`SOLANA_ADAPTER_ENABLED`, **default
> OFF**). La prueba positiva está en el paso 5 del runbook, al final de este archivo.

---

## Cómo lo corro

Requiere **Node 22** (ver [`.nvmrc`](.nvmrc) y `engines` en `package.json`). No necesita base de
datos, ni cadena, ni credenciales de nadie.

```bash
nvm use            # opcional: toma la version de .nvmrc
npm install

npm run typecheck  # tsc --noEmit
npm test           # vitest run  →  463 tests, 21 archivos
npm run build      # next build
```

La suite **no toca la red**: las fuentes de FX y las APIs de partner se mockean, y el fail-closed de
los manifiestos se ejercita seteando y borrando las envs dentro de cada test. Por eso corre en limpio,
sin configurar nada. Es lo mismo que corre el CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

### Levantar el servicio

Los `/invoke` arrancan sin ninguna env. Los `/manifest` **necesitan** las 3 envs de `payTo`: sin
ellas responden `503`, que es el comportamiento deseado y no un bug.

```bash
cp .env.example .env.local      # y reemplazar los 3 *_PAYTO por addresses base58 de Solana
npm run dev                     # http://localhost:3030

curl -s -X POST http://localhost:3030/api/agents/remit-corridor-fx/invoke \
     -H 'content-type: application/json' -d '{"amountUsd":100}'
curl -sD- http://localhost:3030/api/agents/remit-kyc-validator/manifest
```

### Variables de entorno

**Están todas en [`.env.example`](.env.example), que es la fuente única.** Este README no repite la
lista a propósito: dos listas se desincronizan y alguien termina copiando la mitad. Lo único que hay
que retener acá es que las 3 `*_PAYTO` son **obligatorias hoy** y no tienen default; todo lo demás
tiene un default razonable o pertenece a la etapa 2 (partners).

### Deploy

Next.js App Router sobre Vercel, proyecto propio. Las envs se setean como variables del proyecto
(Production / Preview), nunca en un archivo del repo: rotar una billetera es editar una variable y
redeployar. El `agent_url` que se registra en el gateway es
`https://<deploy>.vercel.app/api/agents/<agente>/invoke`, y el manifiesto se deriva de ahí:
`manifestUrl = agentUrl.replace(/\/invoke\/?$/, '/manifest')`.

---

## Arquitectura: cómo enchufa un partner

Cada capacidad externa es una interface en `src/providers/types.ts` con **dos** implementaciones:

- el **adapter del partner** (`DiditKycProvider`, `TransFiPayoutProvider`, …), activo sólo con su
  credencial **y** su flag `*_ADAPTER_READY` — la credencial sola no alcanza, para que nadie hable
  con un partner a medio configurar;
- el **fallback determinístico**, que corre sin credenciales y queda **tageado en la salida**
  (`provenance: "local-fallback"`), nunca disfrazado de dato real.

La factory (`getKycProvider()`, `getPayoutProvider()`, …) elige según el entorno. El día que llega el
sandbox del partner se setean dos variables: cero cambio de wiring.

> Los puntos donde falta confirmar la forma exacta de la respuesta del partner están marcados en el
> código: **15 en `src/providers/`** — `TODO(F3-sandbox)` (9, en `payout.ts`) y `TODO(sandbox)` (6,
> en `kyc.ts` y `fx.ts`). Es deuda **declarada**, no olvido: se resuelve contra el sandbox real, y
> hasta entonces cada campo incierto se lee de env y falla ruidoso si el partner lo exige y no está.

Este repo **no tiene `agent-signer` y no emite receipts EIP-712**. El patrón de un agente acá es
`zod input → provider → { result }`: la confianza en el resultado se apoya en el campo `provenance`
—qué método produjo ese dato— y no en una firma del propio agente.

### Pendiente (post-sandbox)

- Mapear los campos exactos de las respuestas de Didit/TransFi (hoy los adapters usan la forma
  documentada + los `TODO(F3-sandbox)`).
- El value-delivery real: movimiento del principal + settle a la wallet del beneficiario, no un
  self-transfer. Ver `remit-cashout-payout`.

---

## Endpoint HTTP (etapa 1 — `remit-corridor-fx`)

```
POST /api/agents/remit-corridor-fx/invoke
body: { "amountUsd": 100, "destCountry": "PE", "payoutMethod": "yape" }  # solo amountUsd es requerido
→ 200 { "result": { "slug", "rate", "feeUsd", "netDeliveredLocal", "localCurrency": "PEN",
                     "etaMinutes", "quoteId", "expiresAt", "provenance",
                     "rateSource", "rateAsOf" } }
→ 400 { "error": "invalid_input", "details": {...} }   # body inválido (ej. amountUsd <= 0)
→ 502 { "error": "quote_unavailable" }                 # ninguna fuente de tasa usable / misconfig
```

### Procedencia de la tasa (cambio de contrato HTTP)

El agente cotiza **sólo** con una tasa de mercado que puede respaldar. `provenance` ya no es una
etiqueta genérica: cada valor mapea 1:1 a un método auditable de obtención de la tasa.

| `provenance` | Qué significa |
|---|---|
| `fx-mid-live` | mid traído EN VIVO de una fuente registrada, en esta cotización |
| `fx-mid-cached` | el mismo mid, servido de la caché en memoria dentro de su ventana de frescura |
| `transfi` | tasa efectiva del corredor, del partner licenciado (etapa 2) |

Dos campos **aditivos** acompañan a toda cotización:

- **`rateSource`** — id de la fuente registrada (`"er-api"`, `"currency-api"`, `"transfi"`).
- **`rateAsOf`** — ISO, fecha del dato **según la fuente**, nunca el momento de servir. Una respuesta
  cacheada conserva la fecha ORIGINAL del dato: si mostrara el momento de servir, mentiría sobre su
  frescura.

> ⚠️ **`"local-fallback"` se RETIRÓ del agente FX.** Antes, cuando el feed fallaba, se cotizaba con la
> constante `STATIC_USD_PEN` (default **3.75**) y se etiquetaba `"local-fallback"`, **igual** que una
> tasa de mercado. Medido el 2026-07-29 contra tres fuentes independientes (`open.er-api.com` 3.4033,
> `currency-api` 3.3956, **BCRP oficial** 3.404), el mercado estaba en **~3.40**: la constante estaba
> **+10.2% por encima**. Cuando ese respaldo entraba, la cotización **prometía más soles de los que el
> mercado da** — en una remesa de $400, **~140 PEN** que alguien tiene que poner. No era un problema de
> etiquetas: era plata. El valor sigue vivo en KYC y payout, que son otro eje.

### Fail-closed: sin tasa verificable NO se cotiza

Si ninguna fuente registrada devuelve una tasa usable **y** no hay caché fresca, el endpoint responde
**`502 quote_unavailable`**. No existe ninguna rama que devuelva "algo igual":

- **La caché vencida NO se sirve.** Al vencer se re-fetchea; si el fetch falla, se falla. Una caché
  vencida es la constante estática con mejor pedigrí: un número que nadie puede respaldar en el
  momento de usarlo.
- **No hay constante de respaldo.** Se eliminó del código.
- Una cotización que nadie puede respaldar es peor que no cotizar: alguien la ata a un desembolso real.

Cada fuente descartada emite un `console.warn` **value-free** (`{ sourceId, code }`, nunca el body de
la fuente ni la URL completa) con uno de estos códigos: `fx_mid_http_<status>`, `fx_mid_fetch_failed`,
`fx_mid_bad_shape`, `fx_mid_no_usable_pen_rate`, `fx_mid_out_of_band`, `fx_mid_stale_data`.

### Fuentes registradas (no URLs libres)

`FX_MID_SOURCES` nombra **ids de un registro en código**, no URLs. Cada fuente trae **su propio
parser**, así que una env que aceptara cualquier URL *parecería* un punto de extensión y no lo sería:
apuntarla a otra fuente daría "shape inválido" para siempre (el patrón del **control muerto**). Sólo
el **host** es sobrescribible. Un id no registrado ⇒ `fx_mid_config_invalid:FX_MID_SOURCES`.

| id | URL canónica | Campo tasa | Campo fecha |
|---|---|---|---|
| `er-api` | `https://open.er-api.com/v6/latest/USD` | `rates.PEN` | `time_last_update_unix` (s) |
| `currency-api` | `https://latest.currency-api.pages.dev/v1/currencies/usd.json` | `usd.pen` | `date` (`YYYY-MM-DD`) |

Toda fuente registrada **debe declarar la fecha de su dato**: sin fecha se trata como shape inválido.
No se puede afirmar frescura de un dato que no dice cuándo se produjo, y "no sé de cuándo es" no puede
colapsar a "es de ahora" (es el caso real de un CDN que sirve un JSON congelado con un 200 reciente).

El **BCRP** (tasa oficial) **no** se usa como fuente de runtime: publica con ~7 días de lag y no
publica fines de semana ni feriados. Sirve como ancla documentada de la banda y verificación de runbook.

Etapa 1 corre 100% con la tasa mid real + spread declarado. TransFi queda para etapa 2.

### Config del FX: por qué cada número es un guard de dinero

Las variables están en [`.env.example`](.env.example) con sus rangos válidos. Lo que importa acá es
**por qué** están validadas.

Todas se leen en **cada cotización**, así que rotarlas surte efecto sin redeploy. Config inválida
**lanza** `fx_mid_config_invalid:<campo>` en vez de cotizar con un guard desactivado: `Number("abc")`
es `NaN`, y comparar contra `NaN` da `false` siempre — un máximo no numérico **desactivaría la banda
en silencio**.

⚠️ **`STATIC_USD_PEN` es OBSOLETA y NO TIENE EFECTO.** Ya no se lee en ningún lado del código. Era la
constante de respaldo (3.75) que cotizaba +10.2% sobre el mercado real; setearla hoy no mueve ninguna
cotización. **Borrala del deploy** para que nadie crea que sigue controlando algo.

⚠️ **El mínimo y la comisión están ATADOS, y no es un detalle**: la comisión no puede superar el
**20%** del mínimo. Si lo supera, `resolveFxConfig()` **lanza** y el agente no cotiza nada. El motivo
es que un mínimo suelto se apaga solo: con la comisión en 6 y el mínimo en 5, el envío mínimo aceptado
entregaría **cero soles** otra vez, con el mínimo ahí escrito sin proteger nada. Para cobrar más
comisión hay que subir el mínimo — que es exactamente la decisión que alguien debería estar tomando a
conciencia. Con los defaults (mínimo 5, comisión 0.50) la comisión es el **10%** en el piso, la mitad
del techo.

⚠️ El **spread** y el **fee** también son guards de dinero, no preferencias: la tasa que recibe el
usuario es `mid * (1 - spread/10000)`, y la banda valida el **mid**, no la tasa emitida. Un spread
negativo cotiza **por encima del mercado** — medido contra un mid de 3.40, `-1000` bps emitía 3.74
(+10.0%), que es el mismo error de la constante 3.75 que esta HU vino a matar, por otra puerta. Por
eso hoy están validados por rango y la **tasa emitida** pasa también por la banda
(`fx_rate_out_of_band`).

Cada default **afirma algo sobre el mundo externo** (evidencia medida el 2026-07-29): las dos fuentes
están vivas y publican USD/PEN con fecha; el feed promete ciclo de ~24 h, así que 48 h tolera **un**
ciclo perdido, no dos; y con el mercado en ~3.40 la banda `[2.50, 5.00]` deja pasar movimiento
cambiario real pero ataja un cero, un negativo, un orden de magnitud, o la tasa de **otra** moneda
(si el feed cambiara y devolviera `PYG` ≈ 7300 o `EUR` ≈ 0.92).

---

## Endpoint HTTP (etapa 1 — `remit-kyc-validator`)

```
POST /api/agents/remit-kyc-validator/invoke
body: { "senderName": "Alice", "senderCountry": "US", "legalId": "<DNI>", "amountUsd": 100,
        "receiverName": "Bob", "receiverCountry": "PE", "purpose": "family support" }
→ 200 { "result": { "slug", "approved", "riskLevel", "reasons",
                     "verificationId", "provenance", "payoutAllowed" } }   # SIN legalId ni travelRuleData
→ 400 { "error": "invalid_input", "details": {...} }   # body inválido (mensajes Zod, sin PII)
→ 502 { "error": "verification_unavailable" }          # falla del provider / misconfig
```

Etapa 1 corre 100% en **fallback KYC** (`provenance: "local-fallback"`): verificación determinística, sin
red real. **Didit queda OFF** (etapa 2): `DIDIT_API_KEY` / `DIDIT_ADAPTER_READY` **sin setear** en el deploy.
**Garantía dura NO-PII:** el output NUNCA expone `legalId` (DNI) ni `travelRuleData` en ninguna respuesta
(200/400/502).

---

## Endpoint HTTP (etapa 1 — `remit-cashout-payout`)

```
POST /api/agents/remit-cashout-payout/invoke
body: { "quoteId": "q1", "amountUsd": 100, "kycVerificationId": "v1",
        "senderIdentity": "<el vendor_data ligado a esa verificación: DNI o wallet address>",
        "beneficiary": { "name": "<PII>", "country": "PE", "method": "yape", "destination": "<Yape/CCI>" },
        "idempotencyKey": "idem-1" }
→ 200 { "result": { "slug", "executed", "status", "payoutId",
                    "deliveredLocal", "txRef", "reason", "provenance" } }  # SIN beneficiary ni travelRuleData
→ 200 { "result": { "executed": false, "status": "blocked", "reason": "kyc_gate_not_passed" } }  # hard-gate KYC (WKH-203: server-side, no del caller) o identidad no coincide (WKH-204)
→ 200 { "result": { "executed": false, "status": "blocked", "reason": "kyc_identity_claim_missing" } }  # falta la identity claim (WKH-204)
→ 400 { "error": "invalid_input", "details": {...} }  # body inválido (mensajes Zod, sin PII)
→ 502 { "error": "payout_unavailable" }               # fail-safe / misconfig del provider
```

> **Nota**: el campo `kycPayoutAllowed` fue **removido del schema** (WKH-203). El hard-gate KYC ahora se **re-deriva server-side** contra Didit: `KycProvider.status(verificationId, identityClaim)` → allowlist `REAL_KYC_PROVENANCES`. (El 2º parámetro es **requerido** desde WKH-204: un opcional se puede olvidar en un call site nuevo y degradaría el binding en silencio; uno requerido **no compila**.) Si código legacy aún envía `kycPayoutAllowed: true`, **Zod lo strippea silenciosamente** (schema sin `.strict()`); el campo no tiene ningún efecto.

### Identity binding — `senderIdentity` (WKH-204)

El hard-gate de WKH-203 confirma que la verificación está **aprobada**, no que sea **del que pide el payout**.
WKH-204 ata las dos cosas: el caller presenta `senderIdentity` y el agente lo compara contra el `vendor_data`
**real** que la fuente autoritativa (Didit) tiene atado a esa verificación. Si no coincide → **blocked**.

- **`senderIdentity`** (`string`, opcional en el schema): el valor que quedó ligado como `vendor_data` a esa
  verificación **en su creación** — el **DNI** si la creó `remit-kyc-validator`, la **wallet address** si la creó
  la app consumidora. La comparación normaliza con `trim()` + `toLowerCase()` (deja el DNI intacto y vuelve el
  address EVM case-insensitive). El valor **nunca** se ecoa en un response ni se loguea.
- **`address`** (`string`, opcional): **DEPRECADO** — puente de compatibilidad con la app consumidora, que hoy
  manda `address` y no `senderIdentity`. Se usa **solo** si `senderIdentity` está ausente (precedencia: gana el
  explícito). No construir features nuevas sobre él.
- **Fail-closed**: sin claim (o claim vacío/whitespace) → `kyc_identity_claim_missing` **sin llamar a Didit**. Si
  la verificación no tiene `vendor_data` contra qué comparar → **blocked** (no se asume que coincide).
- **No-oracle**: "no aprobado" y "aprobado pero no es tuyo" colapsan al **mismo** `reason:
  "kyc_gate_not_passed"`, para no convertir el endpoint en un confirmador de DNIs.

> ⚠️ **Alcance real de esta protección (sin eufemismos).** El binding `kycVerificationId` ↔ `senderIdentity`
> **sube la barra** (deja de ser un ataque de un solo dato) pero **NO constituye prueba criptográfica de
> posesión**: no hay firma ni SIWE, y `senderIdentity` es caller-controlado igual que `kycVerificationId`. Un
> atacante que consiga **ambos** datos pasa. Además, cuando la sesión KYC fue creada con un `vendor_data`
> **público** (ej. una wallet address), la protección de **ese** flujo es **≈nula**: el atacante que quiere
> suplantar a esa víctima ya conoce su address. La prueba de posesión real es una HU de seguimiento.

Etapa 1 corre 100% en **payout MOCK** (`FallbackPayoutProvider`, `provenance:"local-fallback"`,
`deliveredLocal:null`, `txRef:null`): NUNCA mueve plata real. **TransFi queda OFF** (etapa 2):
`TRANSFI_API_KEY` / `TRANSFI_ADAPTER_READY` **sin setear** en el deploy.

**Flag `PAYOUT_ALLOW_MOCK`:** el fail-safe `assertPayoutProviderSafe()` lanza `payout_refused` en
`NODE_ENV=production` sin provider real. Como Vercel fija `NODE_ENV=production`, el deploy de etapa 1 setea
`PAYOUT_ALLOW_MOCK=true` para permitir SOLO el mock. **NO habilita ningún path a desembolso real** (ese sigue
100% gated por `TRANSFI_API_KEY`+`TRANSFI_ADAPTER_READY`). ⚠️ Activar `PAYOUT_ALLOW_MOCK` en cualquier deploy
que no sea el de etapa 1 (mock) es un **incidente de seguridad money-path**.

**Garantía dura NO-PII:** el output NUNCA expone `beneficiary.name`, `beneficiary.destination` (Yape/CCI) ni
`travelRuleData` en ninguna respuesta (200/400/502).

---

## Manifiesto de cobro (`/manifest`)

Cada agente publica **su propia ficha de cobro** en un endpoint hermano de su `/invoke`. Es lo que el
operador copia al registro del gateway para que el agente **cobre por su trabajo**. Antes de esto, el
`payment` de cada agente se escribía a mano en la base, por fuera de toda API: `remit-kyc-validator`
quedó sin ficha y estuvo **cobrando $0 en silencio** (el caller le pagaba al gateway, el paso corría, y
el settle hacia el operador se salteaba sin error).

### URLs

| Método | URL |
|---|---|
| `GET` | `/api/agents/remit-kyc-validator/manifest` |
| `GET` | `/api/agents/remit-corridor-fx/manifest` |
| `GET` | `/api/agents/remit-cashout-payout/manifest` |

Derivación desde el `agentUrl` ya registrado: `manifestUrl = agentUrl.replace(/\/invoke\/?$/, '/manifest')`.

**El `GET` responde `200` o `503`, nada más** (no hay un tercer código para el método soportado). Ambas
respuestas llevan `Cache-Control: no-store`. Otros métodos y otros paths no son parte del contrato y los
resuelve el framework: un `POST` al mismo path devuelve `405`, y un path inexistente devuelve `404` — en
particular el **slug canónico** (`/api/agents/remit-corridor-fx-solana/manifest`) **no es una URL**: las 3
URLs válidas son las de la tabla de arriba, que usan el `pathSlug`.

### `200 OK` — exactamente 7 claves de primer nivel

```json
{
  "manifestVersion": "1",
  "slug": "remit-corridor-fx-solana",
  "name": "remit-corridor-fx-solana",
  "description": "<texto estático, sin PII>",
  "capabilities": ["remittance-fx-quote", "usdc-to-pen", "corridor-pricing"],
  "priceUsdc": 0.03,
  "payment": { "method": "x402", "chain": "solana-devnet", "contract": "<base58 32B>", "asset": "USDC" }
}
```

`payment` tiene exactamente 4 claves (`method`, `chain`, `contract`, `asset`) y **se copia tal cual** al
registro: no hay transformación ni normalización pendiente del lado del consumidor.

### `503 Service Unavailable` — ficha no publicable (fail-closed)

```json
{ "error": "manifest_unavailable", "missing": ["payment.contract"], "invalid": [] }
```

`missing` e `invalid` contienen **nombres de campo, nunca valores**: el valor de la env no se ecoa en el
body ni en los logs (ni truncado, ni hasheado). Ambas claves están siempre presentes. El body de `503`
**nunca** lleva una clave `payment`.

### Semántica fail-closed (por qué no hay "200 a medias")

> **Un `200` con ficha a medias es peor que un error, porque alguien lo copia a un registro y el agente
> termina cobrando $0 en silencio.**

Por eso: sin `payTo` configurado, o con un `payTo` mal formado, el manifiesto **no se emite** (`503`). No
existe ninguna rama de código que devuelva `200` sin un `payment.contract` válido. En particular se
rechaza el **cruce de familias**: una address EVM `0x…` en un slot `solana-devnet` — y los 3 slots son
`solana-devnet`. Es el error más probable del operador al copiar y pegar entre entornos: el
settle la rechazaría con `INVALID_PAY_TO_FORMAT` y el agente cobraría cero igual, pero con un manifiesto
diciendo que todo está bien.

El criterio de formato es el **mismo** que aplica el consumidor (EVM: `0x` + 40 hex y distinta de la
zero-address; Solana: base58 que decodifica a **exactamente 32 bytes**, no "entre 32 y 44 caracteres").

### Envs de `payTo` (sin default, a propósito)

| Agente | Env del `payTo` | Familia esperada |
|---|---|---|
| `remit-kyc-validator` | `REMIT_KYC_VALIDATOR_PAYTO` | Solana (base58, 32 bytes) |
| `remit-corridor-fx` | `REMIT_CORRIDOR_FX_PAYTO` | Solana (base58, 32 bytes) |
| `remit-cashout-payout` | `REMIT_CASHOUT_PAYOUT_PAYTO` | Solana (base58, 32 bytes) |

Detalle completo de las 3 (qué agente, qué red, qué pasa si falta, dónde se setean de verdad):
[`.env.example`](.env.example). **Hoy las 3 apuntan a propósito a la misma billetera** (decisión del
founder); son variables separadas para que darle a cada agente la suya sea cambiar una variable de
entorno, sin tocar ni deployar código. Ninguna dirección vive en el código.

**Ninguna tiene default.** Sin la env (ausente, vacía o sólo whitespace) el endpoint responde `503`: es el
comportamiento deseado, no un bug. La `chain` **no** es configurable: vive como constante de código en
`src/manifest/registry.ts`, tipada como conjunto cerrado (`"avalanche-fuji" | "solana-devnet"`), así que
ninguna variable de entorno puede llevar un manifiesto a mainnet.

### Tabla `pathSlug` → `slug` canónico → chain

| pathSlug (directorio de la ruta) | slug canónico (registro) | chain |
|---|---|---|
| `remit-kyc-validator` | `remit-kyc-validator` | `solana-devnet` |
| `remit-corridor-fx` | `remit-corridor-fx-solana` | `solana-devnet` |
| `remit-cashout-payout` | `remit-cashout-payout-solana` | `solana-devnet` |

> **`pathSlug ≠ slug` en FX y payout es deliberado.** El directorio de la ruta es el histórico porque el
> `agentUrl` ya registrado apunta ahí y **no se toca**; el `slug` que el manifiesto declara es el canónico
> de cobro (`*-solana`). No "corregir" esta asimetría.

### Runbook operativo (el orden importa)

El registro y el deslistado **no los hace este repo**: son **ops `!` humano** en `wasiai-a2a`. Este repo
sólo publica la ficha.

1. **Setear las 3 envs** en Vercel (Production) y redeploy — las 3 son base58 de Solana. Para FX y
   payout: usar las **mismas** addresses que ya declaran las filas `*-solana` en el registro (leerlas de
   `/discover` **antes** de setear; no inventar una segunda verdad). Para el KYC: hoy, por decisión del
   founder, **la misma billetera que las otras dos**; el día que se separe, es esta variable y nada más.
2. **Verificar los 3 manifiestos por `curl`**: `200`, `payment.chain` correcto y `Cache-Control: no-store`.
   Con una env borrada a propósito, confirmar el `503` (prueba viva del fail-closed).
3. **Drift check sin escribir**: comparar el `payment` del manifiesto contra el de `/discover` para los 2
   slugs `*-solana`. Si difieren, **no** se corrige a mano.
   > ⚠️ Este chequeo **no prueba nada sobre el cobro**: coinciden **por construcción**, porque el paso 1
   > manda copiar las addresses **desde esas mismas filas**. Es un chequeo de consistencia documental.
4. **Registrar/actualizar `remit-kyc-validator`** con su `payment` — que ahora declara `solana-devnet`,
   no `avalanche-fuji` (requiere la HU hermana del otro repo). Si la fila registrada quedó con el
   `payment` viejo de Fuji, el manifiesto y el registro dicen cosas distintas y manda el registro.
5. **Probar que el rail de cobro está PRENDIDO** (prueba positiva, no coincidencia de documentos):
   - **Mínimo obligatorio**: `GET /capabilities` del gateway y verificar que `chains[].key` incluye
     `solana-devnet`. Si no está, el adapter Solana está apagado (`SOLANA_ADAPTER_ENABLED`, **default
     OFF**) y el leg downstream se saltea con `CHAIN_NOT_SUPPORTED` para **los 3** agentes (ya no queda
     ninguno cobrando por una chain EVM): cobran **$0**, con manifiesto `200` y todo.
   - **Ideal**: una invocación real en devnet contra cada slug `*-solana` y confirmar en el resultado /
     los logs del gateway que el leg **settleó** (ninguno de los skip-codes `NO_PAYMENT_FIELD`,
     `METHOD_NOT_SUPPORTED`, `CHAIN_NOT_SUPPORTED`, `INVALID_PAY_TO_FORMAT`).
   > **Un `200` del manifiesto NO implica que el rail esté prendido.** El manifiesto declara *dónde*
   > cobra el agente; que el gateway *pueda* pagarle ahí es configuración del gateway, no de este repo.
6. ⚠️ **Deslistar los gemelos Fuji (`remit-corridor-fx`, `remit-cashout-payout`) SÓLO DESPUÉS de que el
   paso 5 haya dado prueba positiva de cobro** (los pasos 2 y 3 no alcanzan: los dos dan verde sin haber
   tocado nunca el rail). Hacerlo antes deja a FX y payout **sin ninguna ruta de cobro**. El deslistado
   es reversible; quedarse sin ruta de cobro no es gratis.

---

## Licencia

MIT — ver [`LICENSE`](LICENSE).
