# Story File — [WKH-209] HU-SOL-3 · remit-agents: off-ramp TransFi USDCSOL (Solana)

> **Contrato autocontenido para el Dev.** Si algo no está acá, no se hace. Guía mecánica.
> Fuente: `work-item.md` (HU_APPROVED) + `sdd.md` (SPEC_APPROVED). SDD_MODE: **mini**.

---

## 0. Contexto compacto (qué se construye y por qué)

El adapter de payout TransFi (`src/providers/payout.ts`) **ya soporta** `network=solana`:
- El diccionario `TRANSFI_USDC_CURRENCY` ya mapea `solana → "USDCSOL"` (payout.ts:29, **verificado**).
- `execute()` ya resuelve la red por env (`TRANSFI_USDC_NETWORK`) antes de armar el body.
- `depositAddress` ya es pass-through opaco (`readString`, sin validar formato → propaga base58 igual que `0x…`).

**No hay código de producción que escribir.** El trabajo es:
1. **W0** — 2 tests nuevos que cubren el branch `solana` (AC-1 currency, AC-2 base58 pass-through) + verificar (sin editar) que las otras redes y el fail-loud siguen verdes.
2. **W1** — 2 ediciones de doc (`project-context.md`, `README.md`) para documentar `TRANSFI_USDC_NETWORK=solana`.

---

## 1. Scope IN (lista exhaustiva de archivos a tocar)

| Archivo | Wave | Acción |
|---|---|---|
| `src/providers/payout.test.ts` | W0 | **AGREGAR** 2 `it(...)` dentro del `describe("TransFiPayoutProvider.execute — contrato HTTP", …)`. Cero edición de tests existentes. |
| `project-context.md` | W1 | Editar 1 línea (L158) — agregar `solana → USDCSOL`. |
| `README.md` | W1 | Agregar 1 línea en la sección "Env vars" (L46-51). |

**FUERA de scope (NO tocar):** `src/providers/payout.ts` (sin cambio esperado — si aparece un gap real, PARÁ y escalá, no improvises), `getPayoutProvider()`, cualquier fail-safe money-path.

---

## 2. Anti-Hallucination Checklist (verificar ANTES de escribir nada)

- [ ] **Baseline verde**: correr `npm run test` → debe dar **9 files / 149 tests passed**. Correr `npm run typecheck` (`tsc --noEmit`) → **limpio**. Si el baseline NO está verde, PARÁ y avisá — no arranques sobre rojo.
- [ ] **Regla de oro (CD-2)**: los 149 tests existentes pasan **SIN tocar ninguna assertion**. Solo se **AGREGAN** `it(...)`. Al cierre los 149 previos quedan **byte-idénticos**.
- [ ] **CD-1**: PROHIBIDO modificar `resolveSourceCurrency()` o el diccionario `TRANSFI_USDC_CURRENCY` (payout.ts:23-35). Ya soporta `solana → "USDCSOL"`.
- [ ] **CD-4**: PROHIBIDO tocar `getPayoutProvider()`, `TRANSFI_ADAPTER_READY`, `assertPayoutProviderSafe`, `PAYOUT_ALLOW_MOCK` (fail-safes money-path).
- [ ] **CD-3**: PROHIBIDO apuntar a un sandbox TransFi real. Todo test usa `stubFetch(...)` con fixtures mockeados. Cero red real, cero plata real.
- [ ] **CD-5** (anti-recurrente, ref WKH-208 auto-blindaje#2 + WKH-196): al indexar `fetchMock.mock.calls[0]` usar aserción **non-null**: `fetchMock.mock.calls[0]![1]?.body`. Bajo `noUncheckedIndexedAccess` el índice es `T | undefined` → **los tests pasan pero `tsc` falla**. El gate de cierre es `npm run typecheck` **COMPLETO** (incluye `*.test.ts`), NO alcanza con `npm run test`.
- [ ] **Patrón real de invocación** (verificado en payout.test.ts): es `new TransFiPayoutProvider(CREDS).execute(input)`, **no** un `execute(input)` suelto. `CREDS = { username: "u", password: "p", mid: "m" }` ya está definido en L42. `input` ya existe en el archivo.

---

## 3. W0 — Cobertura de test del branch `solana` (AC-1, AC-2; verificar AC-3, AC-5)

**Archivo único:** `src/providers/payout.test.ts`.
**Ubicación:** dentro del `describe("TransFiPayoutProvider.execute — contrato HTTP", …)` (empieza en L80; tiene su `afterEach` con `vi.unstubAllGlobals()` + `vi.unstubAllEnvs()`). Agregar los 2 `it(...)` junto a los happy-path de otras redes (después de L170 es un buen lugar).

**Fixture base58 (usar exacto):** `7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU`
(no contiene `0x`, no coincide con los fixtures `0xdeposit`/`0xdep` existentes → sirve para probar pass-through real).

### T-1 (AC-1) — solana resuelve `source.currency` a `USDCSOL`
Copiar el patrón `polygon` (payout.test.ts:152-160), cambiando red y currency esperada:

```ts
it("AC-6 feliz: solana → source.currency USDCSOL", async () => {
  const fetchMock = stubFetch({ orderId: "ord-1", walletAddress: "0xdep" });
  vi.stubEnv("TRANSFI_USDC_NETWORK", "solana");
  await new TransFiPayoutProvider(CREDS).execute(input);
  const body = JSON.parse(fetchMock.mock.calls[0]![1]?.body as string) as {
    source: { currency: string };
  };
  expect(body.source.currency).toBe("USDCSOL");
});
```

### T-2 (AC-2) — `depositAddress` base58 pass-through intacto
El fixture pone el base58 en `depositAddress` (el provider lee `readString(d, ["depositAddress","walletAddress"])`):

```ts
it("AC-2: solana → depositAddress base58 pass-through intacto", async () => {
  stubFetch({
    orderId: "ord-1",
    depositAddress: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
  });
  vi.stubEnv("TRANSFI_USDC_NETWORK", "solana");
  const r = await new TransFiPayoutProvider(CREDS).execute(input);
  expect(r.depositAddress).toBe("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
});
```

- Valida pass-through **byte-idéntico** (sin `0x`, sin transformar ni truncar).
- **NO** valida formato base58 (DT-2: `depositAddress` es pass-through opaco por diseño — no hay narrowing de formato hoy y esta HU no lo agrega).

### AC-3 / AC-5 (verificación, CERO edición)
Correr la suite completa y confirmar que **sin tocarlos**:
- Los happy-path `polygon`→`USDCPOLYGON` (L152-160) y `base`→`USDCBASE` (L162-170) siguen verdes → cero regresión (AC-3, CD-2).
- El fail-loud `avalanche` (L143-150) sigue lanzando `transfi_unsupported_network_avalanche` **sin** llamar a `fetch` → AC-5, el fail-loud no se debilita al sumar Solana.

**Gate W0 (ambos obligatorios):**
- [ ] `npm run test` verde → **149 + 2 = 151** tests passed.
- [ ] `npm run typecheck` (`tsc --noEmit`) **limpio** (CD-5 — completo, incluye los `.test.ts`).

---

## 4. W1 — Documentación de `TRANSFI_USDC_NETWORK=solana` (AC-4)

### Edición 1 — `project-context.md:158`
Fila actual:
```
| `TRANSFI_USDC_NETWORK` | red del USDC del `source`; default `base` → `USDCBASE`. Fail-loud si fuera del allowlist. |
```
Editar para citar `solana → USDCSOL` como valor soportado explícito, p. ej.:
```
| `TRANSFI_USDC_NETWORK` | red del USDC del `source`; default `base` → `USDCBASE`; `solana` → `USDCSOL`. Fail-loud si fuera del allowlist. |
```

### Edición 2 — `README.md` sección "Env vars" (L46-51)
Agregar **una línea** clara indicando que `TRANSFI_USDC_NETWORK=solana` (→ `USDCSOL`) es un valor válido del off-ramp, junto a los existentes. (El README no tiene tabla de payout; basta una línea consistente con `project-context.md`.)

**Coherencia (verificar, no editar código):** el texto de ambos docs debe ser consistente con el diccionario real `TRANSFI_USDC_CURRENCY` en `payout.ts:29` (`solana: "USDCSOL"`).

**Gate W1:** sin gate de tooling (son docs). Solo verificación de coherencia texto ↔ `payout.ts:29`.

---

## 5. Patrones a seguir (exemplars verificados)

| Uso | Exemplar (path:línea real, confirmado con Read) |
|---|---|
| Test happy-path por red (`stubFetch` + `vi.stubEnv` + assert `source.currency`) | `src/providers/payout.test.ts:152-160` (polygon), `:162-170` (base) |
| Test pass-through de `depositAddress` | `src/providers/payout.test.ts:127-135` (AC-3, `0xdeposit`) |
| Test fail-loud red no soportada (sin `fetch`) | `src/providers/payout.test.ts:143-150` (avalanche) |
| `stubFetch` helper + `mock.calls[0]![1]?.body` non-null | `src/providers/payout.test.ts:28-32`, `:114`, `:156`, `:166` |
| `afterEach` unstub (globals + envs) | `src/providers/payout.test.ts:81-84` |
| `CREDS` / `input` ya definidos | `src/providers/payout.test.ts:42` (CREDS); `input` en scope del archivo |
| Diccionario currency (NO tocar, CD-1) | `src/providers/payout.ts:23-35` (`solana: "USDCSOL"` L29) |
| Fila env var a extender | `project-context.md:158` |

---

## 6. Tests requeridos (≥1 por AC)

| AC | Test | Estado |
|---|---|---|
| AC-1 | T-1 (nuevo) — `body.source.currency === "USDCSOL"` con `TRANSFI_USDC_NETWORK=solana` | **agregar** |
| AC-2 | T-2 (nuevo) — fixture base58 `7xKX…AsU` llega intacto a `PayoutResult.depositAddress` | **agregar** |
| AC-3 | `payout.test.ts:152-170` (polygon/base) | **verificar verde, sin tocar** |
| AC-4 | `project-context.md` + `README.md` | verificación manual (docs) |
| AC-5 | `payout.test.ts:143-150` (avalanche fail-loud) | **verificar verde, sin tocar** |

---

## 7. Definition of Done

- [ ] `npm run test` verde → **151** tests (149 previos + 2 nuevos).
- [ ] `npm run typecheck` (`tsc --noEmit`) **limpio** (CD-5, gate completo incluyendo `.test.ts`).
- [ ] Los **149 tests existentes** quedan **sin tocar** (byte-idénticos) — cero regresión (CD-2).
- [ ] `src/providers/payout.ts` **sin ningún cambio** (CD-1, CD-4).
- [ ] `project-context.md:158` documenta `solana → USDCSOL`.
- [ ] `README.md` (Env vars) menciona `TRANSFI_USDC_NETWORK=solana`.
- [ ] **CD-6** (anti-recurrente, ref WKH-212 auto-blindaje "STORY-GAP"): correr un `grep -rn "Object.keys(.*).toEqual" src` (aserciones de contrato de wire / snapshots en `*.route.test.ts`). Esta HU cambia solo el **valor** de `depositAddress` (schema ya expuesto por WKH-212), **no** el schema → **no debe romperse** ningún `Object.keys`. Si aparece un rojo de contrato → scope mal medido, **escalar, no editar a ciegas**.
- [ ] Sin `.env.example` ni `vercel.json` nuevos (no se introducen — el repo documenta env vars en README/project-context por convención WKH-203..212).

---

## 8. Notas de riesgo (para el Dev)

- El fixture base58 elegido es intencional: **no** contiene `0x` y **no** coincide con `0xdeposit`/`0xdep` — así el pass-through es genuino, no un falso positivo.
- Si al escribir T-1/T-2 el provider **no** produce `USDCSOL` o **transforma** el `depositAddress`, eso sería un gap real de código NO esperado por el grounding F0 → **PARÁ y escalá** (posible edición de `payout.ts` fuera del plan). Según el SDD esto no debería pasar.
- Founder-only follow-up (NO bloquea esta HU): creds/IDs reales del sandbox TransFi Solana (`TRANSFI_USER_ID`, `TRANSFI_SOURCE_WALLET_ADDRESS`, deposit address real) — smoke test contra sandbox es follow-up, mismo estado que el AC-4 smoke de WKH-208.
