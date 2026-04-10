import { createFheGuardHandler } from '@fhe-guard/plugin/server';
import type { NetworkId } from '@fhe-guard/plugin';

export const runtime    = 'nodejs';
export const maxDuration = 30;

const RPC: Partial<Record<NetworkId, string | undefined>> = {
  sepolia: process.env.SEPOLIA_RPC_URL,
  mainnet: process.env.MAINNET_RPC_URL,
};

const EXPLORER: Partial<Record<NetworkId, string>> = {
  sepolia: process.env.SEPOLIA_EXPLORER_API_URL ?? 'https://eth-sepolia.blockscout.com/api/v2',
  mainnet: process.env.MAINNET_EXPLORER_API_URL ?? 'https://eth.blockscout.com/api/v2',
};

export const POST = createFheGuardHandler({
  getRpcUrl:        (n) => RPC[n],
  getExplorerApiUrl: (n) => EXPLORER[n],
  inferenceUrl:     process.env.INFERENCE_URL ?? 'http://localhost:8000',
  inferenceApiKey:  process.env.INFERENCE_API_KEY,
});
