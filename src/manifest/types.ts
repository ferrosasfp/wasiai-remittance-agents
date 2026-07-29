// src/manifest/types.ts
// Tipos del módulo de manifiesto de cobro (HU-300). Ninguna I/O, ninguna lógica: sólo el contrato.
//
// POR QUÉ EL BRANDED TYPE: `AgentPaymentSpec["contract"]` es `PayTo`, no `string`. Un `string`
// cualquiera —un literal nuevo, un `process.env.X ?? ""`— NO COMPILA en esa posición. El compilador,
// y no la revisión de código, garantiza que ninguna dirección llegue al manifiesto sin haber pasado
// por la validación de formato. El patrón ya existe en el repo: `TransFiBaseUrl` en
// `src/providers/transfi-env.ts:28-31`.

// Brand nominal: un `string` NO es asignable a `PayTo`. Sólo resolvePayTo() (paytos.ts) produce uno.
declare const payToBrand: unique symbol;
export type PayTo = string & { readonly [payToBrand]: "agent-pay-to" };

export type ChainFamily = "evm" | "solana";

/** Conjunto CERRADO. Mainnet no es representable: CD-3 por construcción, no por disciplina. */
export type ManifestChain = "avalanche-fuji" | "solana-devnet";

export interface AgentPaymentSpec {
  method: "x402";
  chain: ManifestChain;
  contract: PayTo;
  asset: "USDC";
}

export interface AgentManifest {
  manifestVersion: "1";
  slug: string;
  name: string;
  description: string;
  capabilities: readonly string[];
  priceUsdc: number;
  payment: AgentPaymentSpec;
}

export interface ManifestEntry {
  readonly pathSlug: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly capabilities: readonly string[];
  readonly chain: ManifestChain;
  readonly family: ChainFamily;
  readonly asset: "USDC";
  readonly payToEnv: string;
  readonly priceUsdc: number;
}

export type ManifestFailureReason = "missing" | "invalid_format" | "zero_address" | "unknown_agent";

export type PayToResolution =
  | { readonly ok: true; readonly payTo: PayTo }
  | { readonly ok: false; readonly reason: Exclude<ManifestFailureReason, "unknown_agent"> };

export type ManifestResult =
  | { readonly ok: true; readonly manifest: AgentManifest }
  | {
      readonly ok: false;
      readonly missing: readonly string[];
      readonly invalid: readonly string[];
      readonly reason: ManifestFailureReason;
    };
