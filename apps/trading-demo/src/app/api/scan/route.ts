import { NextRequest } from 'next/server';
import { createFheGuardHandler } from '@fhe-guard/plugin/server';
import type { NetworkId } from '@fhe-guard/plugin';
import { checkRateLimit, scanLimiter } from '@/lib/ratelimit';

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

const _scanHandler = createFheGuardHandler({
  getRpcUrl:         (n) => RPC[n],
  getExplorerApiUrl: (n) => EXPLORER[n],
  inferenceUrl:      process.env.INFERENCE_URL ?? 'http://localhost:8000',
  inferenceApiKey:   process.env.INFERENCE_API_KEY,
});

export async function POST(req: NextRequest): Promise<Response> {
  const limited = await checkRateLimit(scanLimiter, req);
  if (limited) return limited;
  return _scanHandler(req);
}
