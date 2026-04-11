import { NextRequest, NextResponse } from 'next/server';
import type { NetworkId } from '@fhe-guard/plugin';

export const runtime = 'nodejs';

const RPC_BY_NETWORK: Partial<Record<NetworkId, string | undefined>> = {
  sepolia: process.env.SEPOLIA_RPC_URL,
  mainnet: process.env.MAINNET_RPC_URL,
};

const CHAIN_NAMES: Record<number, string> = {
  1:        'mainnet',
  11155111: 'sepolia',
};

/**
 * Health check endpoint suitable for uptime monitors (UptimeRobot, BetterStack, etc.).
 *
 * Returns 200 when all checks pass, 503 when any check fails — so monitors
 * can detect outages by watching for non-2xx responses.
 *
 * Query params:
 *   network — "sepolia" (default) | "mainnet"
 */
export async function GET(req: NextRequest) {
  const network      = (req.nextUrl.searchParams.get('network') ?? 'sepolia') as NetworkId;
  const rpcUrl       = RPC_BY_NETWORK[network];
  const inferenceUrl = process.env.INFERENCE_URL ?? 'http://localhost:8000';

  if (!rpcUrl) {
    return NextResponse.json({
      ok:        false,
      checks:    { inference: false, rpc: false },
      chainId:   null,
      network:   null,
      error:     `Missing RPC URL for network: ${network}`,
      timestamp: Date.now(),
    }, { status: 503 });
  }

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
      checks.rpc  = true;
      chainId     = parseInt(data.result, 16);
      networkName = CHAIN_NAMES[chainId] ?? `chain ${chainId}`;
    } else {
      checks.rpc = false;
    }
  } catch { checks.rpc = false; }

  const allOk = Object.values(checks).every(Boolean);

  return NextResponse.json(
    { ok: allOk, checks, chainId, network: networkName, timestamp: Date.now() },
    { status: allOk ? 200 : 503 },
  );
}
