import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  DIDIT_LIVE_BASE_URL,
  resolveDiditBaseUrl,
  resolveDiditEnvironment,
} from "./didit-env";
import { DiditKycProvider, FallbackKycProvider, getKycProvider } from "./kyc";

// ⚠️ CERO red real en este archivo: nunca se llama a `verify()`/`status()`, solo se RESUELVE el host.
// Ninguna aserción puede tocar el host de Didit (que es precisamente el bug que este módulo cierra).

// Snapshot/restore MANUAL (no `vi.stubEnv`), igual que transfi-env.test.ts: varios casos necesitan la
// env AUSENTE, no vacía — "sin setear" es justo el estado que antes apuntaba a producción.
const MANAGED_ENVS = [
  "DIDIT_ENV",
  "DIDIT_BASE_URL",
  "DIDIT_API_KEY",
  "DIDIT_ADAPTER_READY",
  "NODE_ENV",
] as const;

let envSnapshot: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  envSnapshot = {};
  for (const k of MANAGED_ENVS) envSnapshot[k] = process.env[k];
  // Punto de partida: TODAS ausentes. Es el estado del bug original.
  for (const k of MANAGED_ENVS) setEnv(k, undefined);
});

afterEach(() => {
  for (const k of MANAGED_ENVS) setEnv(k, envSnapshot[k]);
});

// ── 1. FAIL-CLOSED: sin DIDIT_ENV no se resuelve NINGÚN host ────────────────────────────────────
describe("resolveDiditEnvironment / resolveDiditBaseUrl — fail-closed", () => {
  it("DIDIT_ENV ausente → throw didit_env_unset (NUNCA un host adivinado)", () => {
    expect(() => resolveDiditEnvironment()).toThrow(/^didit_env_unset/);
    // El assert anti-regresión del fix: tampoco se puede obtener una URL.
    expect(() => resolveDiditBaseUrl()).toThrow(/^didit_env_unset/);
  });

  it("DIDIT_ENV ausente → el error NO contiene el host productivo del partner", () => {
    // Mismo criterio que transfi-env.test.ts: el mensaje guía al operador sin publicar el host.
    try {
      resolveDiditBaseUrl();
      throw new Error("debería haber lanzado");
    } catch (e) {
      expect((e as Error).message).not.toContain("didit.me");
    }
  });

  it("DIDIT_ENV en blanco → throw igual que ausente", () => {
    setEnv("DIDIT_ENV", "   ");
    expect(() => resolveDiditBaseUrl()).toThrow(/^didit_env_unset/);
  });

  it('DIDIT_ENV="sandbox" → throw: Didit NO publica un host de sandbox', () => {
    // No es un typo: es la expectativa equivocada más probable (TransFi sí tiene sandbox). El modo
    // de prueba de Didit es el free tier sobre el MISMO host, vía DIDIT_API_KEY/DIDIT_WORKFLOW_ID.
    setEnv("DIDIT_ENV", "sandbox");
    expect(() => resolveDiditBaseUrl()).toThrow(/^didit_env_invalid:sandbox/);
  });

  it("DIDIT_ENV inválida → throw con el valor ecoado (config de conjunto cerrado, no es secreto)", () => {
    setEnv("DIDIT_ENV", "produccion");
    expect(() => resolveDiditEnvironment()).toThrow(/^didit_env_invalid:produccion/);
  });

  it("case/espacios se normalizan (' LIVE ' → live)", () => {
    setEnv("DIDIT_ENV", " LIVE ");
    setEnv("NODE_ENV", "production");
    expect(resolveDiditEnvironment()).toBe("live");
  });
});

// ── 2. live exige NODE_ENV=production (espejo de transfi_env_production_outside_node_prod) ──────
describe("resolveDiditBaseUrl — live", () => {
  it("live + NODE_ENV=production → host canónico de Didit", () => {
    setEnv("DIDIT_ENV", "live");
    setEnv("NODE_ENV", "production");
    expect(resolveDiditBaseUrl()).toBe(DIDIT_LIVE_BASE_URL);
  });

  it("live + NODE_ENV=test → throw (un build de dev/CI no crea verificaciones reales con PII)", () => {
    setEnv("DIDIT_ENV", "live");
    setEnv("NODE_ENV", "test");
    expect(() => resolveDiditBaseUrl()).toThrow(/^didit_env_live_outside_node_prod/);
  });

  it("live + NODE_ENV ausente → throw", () => {
    setEnv("DIDIT_ENV", "live");
    expect(() => resolveDiditBaseUrl()).toThrow(/^didit_env_live_outside_node_prod/);
  });

  it("live + host NO-Didit → throw (un mock que responda Approved bypassea el gate de compliance)", () => {
    setEnv("DIDIT_ENV", "live");
    setEnv("NODE_ENV", "production");
    setEnv("DIDIT_BASE_URL", "https://mock.example.com");
    expect(() => resolveDiditBaseUrl()).toThrow(/^didit_base_url_non_didit_host_in_live/);
  });

  it("live + subdominio de didit.me → permitido (override legítimo)", () => {
    setEnv("DIDIT_ENV", "live");
    setEnv("NODE_ENV", "production");
    setEnv("DIDIT_BASE_URL", "https://apx.didit.me/");
    expect(resolveDiditBaseUrl()).toBe("https://apx.didit.me"); // trailing slash normalizado
  });
});

// ── 3. mock exige una URL propia y NO puede apuntar a Didit ─────────────────────────────────────
describe("resolveDiditBaseUrl — mock", () => {
  it("mock + localhost → apunta al mock (http permitido solo en localhost)", () => {
    setEnv("DIDIT_ENV", "mock");
    setEnv("DIDIT_BASE_URL", "http://localhost:9999/didit");
    expect(resolveDiditBaseUrl()).toBe("http://localhost:9999/didit");
  });

  it("mock SIN DIDIT_BASE_URL → throw (no hay host de mock canónico que asumir)", () => {
    setEnv("DIDIT_ENV", "mock");
    expect(() => resolveDiditBaseUrl()).toThrow(/^didit_base_url_required_for_mock/);
  });

  it("mock apuntando al Didit REAL → throw env_conflict (el incidente, invertido)", () => {
    setEnv("DIDIT_ENV", "mock");
    setEnv("DIDIT_BASE_URL", DIDIT_LIVE_BASE_URL);
    expect(() => resolveDiditBaseUrl()).toThrow(/^didit_base_url_env_conflict/);
  });

  it("http fuera de localhost → throw (la api-key y la PII no viajan en claro)", () => {
    setEnv("DIDIT_ENV", "mock");
    setEnv("DIDIT_BASE_URL", "http://mock.interno.example/didit");
    expect(() => resolveDiditBaseUrl()).toThrow(/^didit_base_url_insecure_scheme:http/);
  });

  it("DIDIT_BASE_URL no absoluta → throw", () => {
    setEnv("DIDIT_ENV", "mock");
    setEnv("DIDIT_BASE_URL", "/api/mock");
    expect(() => resolveDiditBaseUrl()).toThrow(/^didit_base_url_invalid/);
  });
});

// ── 4. El factory: la rama inerte NO necesita DIDIT_ENV; la rama real SÍ ────────────────────────
describe("getKycProvider — el fail-closed solo muerde a quien va a hablarle a Didit", () => {
  it("sin DIDIT_API_KEY y sin DIDIT_ENV → FallbackKycProvider (el deploy devnet sigue inerte y OK)", () => {
    // Regresión CRÍTICA: si el resolve se hiciera al importar el módulo (o antes del guard de la
    // key), este caso —que es el deploy actual— pasaría a explotar sin ninguna env nueva seteada.
    expect(getKycProvider()).toBeInstanceOf(FallbackKycProvider);
  });

  it("con key + readiness pero SIN DIDIT_ENV → throw didit_env_unset (no se construye el adapter)", () => {
    setEnv("DIDIT_API_KEY", "k");
    setEnv("DIDIT_ADAPTER_READY", "true");
    expect(() => getKycProvider()).toThrow(/^didit_env_unset/);
  });

  it("con key + readiness + DIDIT_ENV=mock + URL → DiditKycProvider apuntando al mock", () => {
    setEnv("DIDIT_API_KEY", "k");
    setEnv("DIDIT_ADAPTER_READY", "true");
    setEnv("DIDIT_ENV", "mock");
    setEnv("DIDIT_BASE_URL", "http://localhost:9999/didit");
    expect(getKycProvider()).toBeInstanceOf(DiditKycProvider);
  });

  it("key sin readiness → sigue ganando didit_adapter_not_ready (guard previo intacto)", () => {
    setEnv("DIDIT_API_KEY", "k");
    setEnv("DIDIT_ENV", "mock");
    setEnv("DIDIT_BASE_URL", "http://localhost:9999/didit");
    expect(() => getKycProvider()).toThrow(/^didit_adapter_not_ready/);
  });
});

// ── 5. Canario: el literal productivo vive en UN solo lugar ─────────────────────────────────────
describe("única fuente de verdad (anti-regresión del literal duplicado)", () => {
  it("el host productivo NO aparece hardcodeado en ningún otro archivo del repo", () => {
    // Este es el canario del fix: el bug era ESTE literal con un `??` productivo. Si reaparece en
    // código, el fix se perdió aunque todo lo demás siga verde.
    // `--untracked` es OBLIGATORIO: sin él, un archivo nuevo todavía sin `git add` sería invisible
    // y el canario pasaría en falso justo cuando más importa.
    const hits = execFileSync(
      "git",
      ["grep", "--untracked", "-l", "-F", "verification.didit.me", "--", "*.ts", "*.tsx"],
      { cwd: process.cwd(), encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
    // Solo el módulo dueño del literal y este test pueden mencionarlo.
    expect(hits.sort()).toEqual(["src/providers/didit-env.test.ts", "src/providers/didit-env.ts"]);
  });
});
