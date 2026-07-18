# Auto-Blindaje — WKH-212 (Dev / F3)

### [2026-07-17 19:45] Wave 1 — E4 falló por indentación asumida
- **Error**: el `old_string` de E4 usó 6 espacios de indentación (copiado del patrón de las ramas blocked). El return de la rama `executed` está en el top-level de la función (4 espacios), no anidado en un `if`.
- **Causa raíz**: asumir indentación uniforme entre las 3 ramas de retorno. Las 2 blocked están dentro de `if {}` (6 espacios); la executed es el return final de la función (4 espacios).
- **Fix**: reintenté el Edit con 4 espacios de indentación en las keys.
- **Aplicar en**: cualquier edit por string-match sobre returns de una misma función — verificar el nivel de anidación real de CADA punto, no extrapolar del anterior.

### [2026-07-17 19:46] Wave 2 — [STORY-GAP] test de wire-contract fuera de Scope IN se rompió
- **Error**: tras aplicar E1-E4 + los 4 tests nuevos, `vitest` quedó ROJO por 1 test en `src/app/api/agents/remit-cashout-payout/invoke/route.test.ts:101` que asserta `Object.keys(output).sort()` con EXACTAMENTE los 8 campos previos.
- **Causa raíz**: el Story File declaró Scope IN = `cashout-payout.ts` + `cashout-payout.test.ts` y "NO tocar route.ts", pero no listó `route.test.ts`, que codifica el contrato byte-idéntico del wire (los 8 campos). WKH-212 agrega un 9º campo a ese mismo wire → la aserción quedó stale.
- **Fix**: actualicé la aserción para incluir `"depositAddress"` en el set esperado (ahora 9 campos) + `expect(output.depositAddress).toBeNull()` en el path mock. Es la única corrección posible y refleja el contrato que la HU cambia. NO se tocó la lógica de `route.ts`.
- **Aplicar en**: toda HU que agregue/quite un campo de un output serializado debe buscar `Object.keys(...).toEqual([...])` / snapshot tests del contrato en `*/route.test.ts`. El Architect debe incluirlos en el Scope IN cuando el cambio toca el wire.
