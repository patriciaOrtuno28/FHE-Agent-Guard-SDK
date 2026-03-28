import { NextRequest, NextResponse } from 'next/server';
import type { NetworkId } from '../../../lib/networks';

const RPC_BY_NETWORK: Record<NetworkId, string> = {
  sepolia:   process.env.SEPOLIA_RPC_URL ?? 'https://sepolia.drpc.org',
  mainnet:   process.env.MAINNET_RPC_URL ?? 'https://eth.llamarpc.com',
  localhost: process.env.LOCAL_RPC_URL   ?? 'http://localhost:8545',
};

const CHAIN_NAMES: Record<number, string> = {
  1:        'mainnet',
  11155111: 'sepolia',
  31337:    'localhost',
};

export async function GET(req: NextRequest) {
  const network  = (req.nextUrl.searchParams.get('network') ?? 'sepolia') as NetworkId;
  const rpcUrl   = RPC_BY_NETWORK[network] ?? RPC_BY_NETWORK.sepolia;
  const inferenceUrl = process.env.INFERENCE_URL ?? 'http://localhost:8000';

  const checks: Record<string, boolean> = {};
  let chainId: number | null = null;
  let networkName: string | null = null;

  try {
    const res = await fetch(`${inferenceUrl}/health`, { signal: AbortSignal.timeout(3000) });
    checks.inference = res.ok;
  } catch { checks.inference = false; }

  try {
    const res = await fetch(rpcUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ jsonrpc: '2.0', method: 'eth_chainId', params: [], id: 1 }),
      signal:  AbortSignal.timeout(3000),
    });
    const data = await res.json() as { result?: string };
    if (data.result) {
      checks.rpc = true;
      chainId     = parseInt(data.result, 16);
      networkName = CHAIN_NAMES[chainId] ?? `chain ${chainId}`;
    } else {
      checks.rpc = false;
    }
  } catch { checks.rpc = false; }

  return NextResponse.json({ checks, chainId, network: networkName, timestamp: Date.now() });
}
