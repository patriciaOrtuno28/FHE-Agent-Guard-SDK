// ── Core ──────────────────────────────────────────────────────
export { AgentGuard, ModelRegistry } from "./AgentGuard.js";
export { FhEVMConnector, BaseConnector, RESTConnector } from "./connectors.js";
export type * from "./types.js";

// ── Generated network artifacts ───────────────────────────────
export * as localhost from "./generated/localhost.js";
export * as sepolia   from "./generated/sepolia.js";

// ── sdkByChainId — keyed lookup for the demo and SDK consumers ─
import * as _localhost from "./generated/localhost.js";
import * as _sepolia   from "./generated/sepolia.js";

export const sdkByChainId = {
  [_localhost.chainId]: _localhost,
  [_sepolia.chainId]:   _sepolia,
} as const;