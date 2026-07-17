# Auto-Blindaje — WKH-208 (F3 Dev)

### [2026-07-17] W2 — `git checkout` borró un archivo NO commiteado durante un mutation self-check
- **Error**: para restaurar `payout.ts` tras mutar `partnerId` (mutation self-check (c)) usé
  `git checkout src/providers/payout.ts`. Como la rama estaba en `main`/branch sin commitear el trabajo
  de W0/W1, el checkout revirtió el archivo al estado de HEAD (el scaffold viejo de WKH-172), no a mi
  reescritura.
- **Causa raíz**: `git checkout <file>` restaura desde el índice/HEAD, no desde el working tree. Con
  trabajo sin commitear, es destructivo. Mezclé "revertir una mutación puntual" con "restaurar a HEAD".
- **Fix**: reescribí `payout.ts` completo y, para el resto de los mutation self-checks, usé una **copia
  de respaldo** (`cp payout.ts scratchpad/payout.bak.ts` → mutar con `sed/perl` → `cp bak → payout.ts`).
  Nunca más `git checkout` sobre archivos con cambios sin commitear.
- **Aplicar en**: cualquier mutation testing / experimento destructivo sobre archivos no commiteados —
  respaldar con `cp` a scratchpad, no confiar en git. Regla: si `git status` muestra el archivo como
  modificado y NO hay commit, `git checkout` de ese archivo PIERDE el trabajo.

### [2026-07-17] W2 — `mock.calls[0]` posiblemente `undefined` bajo `noUncheckedIndexedAccess`
- **Error**: el typecheck (no los tests) falló en `payout.test.ts` al destructurar
  `const [url, init] = fetchMock.mock.calls[0]` — TS2488/TS2532 (el índice puede ser `undefined`).
- **Causa raíz**: `tsconfig` strict con acceso por índice chequeado. Los tests PASABAN (142) pero el
  gate real es `npm run typecheck` COMPLETO (incluye `*.test.ts`) — lección WKH-196, no basta el build.
- **Fix**: aserción non-null en el acceso ya garantizado por el ARRANGE (`fetchMock.mock.calls[0]!`).
  Es un test que ya ejecutó el `fetch`, así que `calls[0]` existe por construcción.
- **Aplicar en**: cualquier test nuevo que inspeccione `mock.calls[i]` / acceso por índice en este repo
  (strict). Correr `npm run typecheck` (no solo `npm run test`) antes de dar una wave por cerrada.
