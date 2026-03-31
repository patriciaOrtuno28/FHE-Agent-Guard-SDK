import { NextRequest } from 'next/server';
import { AgentGuard, FhEVMConnector } from '@fhe-guard/sdk';
import { NETWORKS, type NetworkId } from '../../../lib/networks';

export const runtime = 'nodejs';
export const maxDuration = 30;

const RPC_BY_NETWORK: Partial<Record<NetworkId, string>> = {
  sepolia: process.env.SEPOLIA_RPC_URL,
  mainnet: process.env.MAINNET_RPC_URL,
};

const EXPLORER_API_BY_NETWORK: Partial<Record<NetworkId, string>> = {
  sepolia: process.env.SEPOLIA_EXPLORER_API_URL ?? 'https://eth-sepolia.blockscout.com/api/v2',
  mainnet: process.env.MAINNET_EXPLORER_API_URL ?? 'https://eth.blockscout.com/api/v2',
};

function sse(controller: ReadableStreamDefaultController, data: unknown) {
  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`));
}

export async function POST(req: NextRequest) {
  let body: { target?: string; network?: NetworkId; enabledConnectors?: string[] };
  try {
    body = await req.json() as typeof body;
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { target, network = 'sepolia', enabledConnectors = ['fhevm'] } = body;

  if (!target || !/^0x[0-9a-fA-F]{40}$/.test(target)) {
    return Response.json({ error: 'Invalid Ethereum address' }, { status: 400 });
  }

  const rpcUrl = RPC_BY_NETWORK[network];
  if (!rpcUrl) {
    return Response.json(
      { error: `No RPC configured for network: ${network}.` },
      { status: 500 },
    );
  }

  const chainId = NETWORKS.find((n) => n.id === network)?.chainId;
  const explorerApiUrl = EXPLORER_API_BY_NETWORK[network] ?? '';
  const inferenceUrl = process.env.INFERENCE_URL ?? 'http://localhost:8000';
  const inferenceApiKey = process.env.INFERENCE_API_KEY;

  if (!inferenceApiKey) {
    return Response.json(
      { error: 'Missing INFERENCE_API_KEY in server environment' },
      { status: 500 },
    );
  }

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const connectors = [];

        if (enabledConnectors.includes('fhevm')) {
          connectors.push(
            new FhEVMConnector({
              rpcUrl,
              chainId,
              explorerApiUrl,
            }),
          );
        }

        if (connectors.length === 0) {
          sse(controller, { type: 'error', message: 'No connectors enabled' });
          controller.close();
          return;
        }

        const guard = new AgentGuard({
          rpcUrl,
          model: { kind: 'random-forest', artifact: 'base', threshold: 7 },
          connectors,
          inferenceServerUrl: inferenceUrl,
          inferenceApiKey,
          onAnomaly: async (ctx) => {
            sse(controller, {
              type: 'anomaly',
              subject: ctx.subject,
              result: {
                label: ctx.result.label,
                encryptedScore: ctx.result.encryptedScore.toString(),
              },
            });
          },
        });

        guard.onEvent((ev) => {
          if (ev.type === 'fetch_start') return;
          if (ev.type === 'features_merged') {
            sse(controller, { type: 'features_merged', features: ev.features });
            return;
          }
          sse(controller, ev);
        });

        sse(controller, { type: 'scan_start', subject: target, timestamp: Date.now() });

        const result = await guard.run(target);

        sse(controller, {
          type: 'scan_complete',
          result: {
            label: result.label,
            encryptedScore: result.encryptedScore.toString(),
            decision: result.decision.toString(),
            computedAt: result.computedAt,
            rawScore: result.rawScore ?? null,
            rawRisk: result.rawRisk ?? null,
          },
        });
      } catch (err) {
        sse(controller, {
          type: 'error',
          message: err instanceof Error ? err.message : 'Scan failed',
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}