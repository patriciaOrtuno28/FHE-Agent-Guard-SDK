/**
 * @fhe-guard/plugin/server
 *
 * Server-only Next.js route handler factories.
 * Import this from API route files (e.g. app/api/scan/route.ts) only — never from
 * client components. Importing this in a client component will cause a build
 * error because it transitively pulls in Node.js built-ins.
 */

import { readFileSync } from 'node:fs';
import { join }         from 'node:path';
import type { NextRequest } from 'next/server';
import { AgentGuard, FhEVMConnector } from '@fhe-guard/sdk';
import { NETWORKS, type NetworkId } from '../lib/networks.js';

export type { NetworkId };

export interface FheGuardHandlerConfig {
  /** Returns the RPC URL for the given network, or undefined if not configured. */
  getRpcUrl: (network: NetworkId) => string | undefined;
  /** Returns the block explorer API URL for the given network. */
  getExplorerApiUrl: (network: NetworkId) => string | undefined;
  /** URL of the inference server. */
  inferenceUrl: string;
  /** API key for the inference server. */
  inferenceApiKey: string | undefined;
  /**
   * Optional async rate-limit check. Return true to allow the request,
   * false to reject with 429. Keeps the plugin free of Redis/Upstash deps.
   */
  checkRateLimit?: (req: NextRequest) => Promise<boolean>;
}

function sse(controller: ReadableStreamDefaultController, data: unknown) {
  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`));
}

/**
 * Factory that produces a Next.js Route Handler for the /api/scan SSE endpoint.
 *
 * Usage in apps/trading-demo/src/app/api/scan/route.ts:
 * ```ts
 * import { createFheGuardHandler } from '@fhe-guard/plugin/server';
 * export const runtime = 'nodejs';
 * export const maxDuration = 30;
 * export const POST = createFheGuardHandler({ ... });
 * ```
 */
export function createFheGuardHandler(cfg: FheGuardHandlerConfig) {
  return async function POST(req: NextRequest) {
    if (cfg.checkRateLimit) {
      const allowed = await cfg.checkRateLimit(req);
      if (!allowed) {
        return Response.json({ error: 'Rate limit exceeded' }, { status: 429 });
      }
    }

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

    const rpcUrl = cfg.getRpcUrl(network);
    if (!rpcUrl) {
      return Response.json(
        { error: `No RPC configured for network: ${network}` },
        { status: 500 },
      );
    }

    if (!cfg.inferenceApiKey) {
      return Response.json({ error: 'Missing INFERENCE_API_KEY' }, { status: 500 });
    }

    const chainId       = NETWORKS.find((n) => n.id === network)?.chainId;
    const explorerApiUrl = cfg.getExplorerApiUrl(network) ?? '';

    const stream = new ReadableStream({
      async start(controller) {
        try {
          const connectors = [];

          if (enabledConnectors.includes('fhevm')) {
            connectors.push(new FhEVMConnector({ rpcUrl, chainId, explorerApiUrl }));
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
            inferenceServerUrl: cfg.inferenceUrl,
            inferenceApiKey: cfg.inferenceApiKey,
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
              label:          result.label,
              encryptedScore: result.encryptedScore.toString(),
              decision:       result.decision.toString(),
              computedAt:     result.computedAt,
              rawScore:       result.rawScore ?? null,
              rawRisk:        result.rawRisk ?? null,
            },
          });
        } catch (err) {
          sse(controller, {
            type:    'error',
            message: err instanceof Error ? err.message : 'Scan failed',
          });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type':    'text/event-stream',
        'Cache-Control':   'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      },
    });
  };
}

export interface RelayerHandlerConfig {
  /**
   * Override the path to the UMD bundle.
   * Defaults to node_modules/@zama-fhe/relayer-sdk/bundle/relayer-sdk-js.umd.cjs
   * resolved relative to process.cwd() (i.e. the consuming app's root).
   */
  bundlePath?: string;
}

/**
 * Factory that produces a Next.js Route Handler for the /api/relayer-sdk GET endpoint.
 * Serves the Zama Relayer SDK UMD bundle from node_modules so the browser can load it.
 *
 * Usage in apps/trading-demo/src/app/api/relayer-sdk/route.ts:
 * ```ts
 * import { createRelayerHandler } from '@fhe-guard/plugin/server';
 * export const runtime = 'nodejs';
 * export const GET = createRelayerHandler();
 * ```
 */
export function createRelayerHandler(cfg: RelayerHandlerConfig = {}) {
  let _bundle: string | null = null;

  function getBundle(): string {
    if (!_bundle) {
      const umdPath = cfg.bundlePath ?? join(
        process.cwd(),
        'node_modules',
        '@zama-fhe',
        'relayer-sdk',
        'bundle',
        'relayer-sdk-js.umd.cjs',
      );
      _bundle = readFileSync(umdPath, 'utf-8');
    }
    return _bundle;
  }

  return function GET() {
    try {
      return new Response(getBundle(), {
        headers: {
          'Content-Type':  'application/javascript',
          'Cache-Control': 'no-cache',
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return new Response(
        `console.error("Failed to load Zama SDK: ${msg.replace(/"/g, "'")}");`,
        { status: 500, headers: { 'Content-Type': 'application/javascript' } },
      );
    }
  };
}
