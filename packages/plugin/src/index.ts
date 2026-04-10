// Context
export { FheGuardProvider, useFheGuardContext } from './context/FheGuardProvider.js';

// Components
export { FheGuardGate } from './components/FheGuardGate.js';

// Hooks
export { useFheGuard } from './hooks/useFheGuard.js';

// FHE client utilities (browser-only)
export {
  encryptUint64,
  decryptAnomalyScore,
  isFheSupported,
  resetFhevmInstance,
  handleToHex32,
} from './lib/fhe.js';

// Network configuration
export { NETWORKS, networkByChainId } from './lib/networks.js';

// Types
export type {
  FheGuardConfig,
  FheGuardState,
  ScanResult,
  ScanStatus,
} from './types.js';

export type { NetworkId } from './lib/networks.js';
