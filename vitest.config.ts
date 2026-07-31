import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    env: {
      // Secreto de firma de las referencias de cotización (`providers/quote-ref.ts`), FIJO para toda
      // la suite. Sin esto cada archivo usaría el secreto EFÍMERO por proceso, que es correcto en
      // dev pero hace que una referencia emitida en un archivo no se pueda verificar en otro.
      // Está acá y no en un `beforeEach` por archivo para que no exista la variante "un archivo se
      // olvidó de setearlo y sus tests pasan por la rama equivocada".
      // 🔴 NO es un default de producción: en producción el secreto NO tiene default y su ausencia
      // LANZA (`quote_binding_secret_unset`). El test que lo prueba lo desactiva explícitamente con
      // `vi.stubEnv("QUOTE_BINDING_SECRET", "")`.
      QUOTE_BINDING_SECRET: "vitest-quote-binding-secret-no-usar-en-ningun-deploy",
    },
  },
});
