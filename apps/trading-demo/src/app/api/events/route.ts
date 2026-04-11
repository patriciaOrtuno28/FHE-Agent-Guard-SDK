import { NextRequest, NextResponse } from 'next/server';
import { createPublicClient, http, parseAbiItem } from 'viem';
import { sepolia } from 'viem/chains';
import { checkRateLimit, eventsLimiter } from '@/lib/ratelimit';

export const runtime = 'nodejs';

// Events emitted by AnomalyAgent — no sensitive data, all plaintext fields.
const SCORE_SUBMITTED = parseAbiItem('event ScoreSubmitted(address indexed subject, uint256 timestamp)');
const SCORE_EVALUATED = parseAbiItem('event ScoreEvaluated(address indexed subject, uint256 timestamp)');

const CONTRACT_ADDRESS = process.env.NEXT_PUBLIC_TRUST_SCORE_AGENT_SEPOLIA as `0x${string}` | undefined;

/**
 * GET /api/events
 *
 * Returns recent ScoreSubmitted and ScoreEvaluated events from AnomalyAgent.
 * Suitable for an activity feed or a simple event indexer.
 *
 * Query params:
 *   limit     — max events to return per type (default 50, max 200)
 *   fromBlock — earliest block to scan (default: latest - 10 000)
 */
export async function GET(req: NextRequest) {
  const limited = await checkRateLimit(eventsLimiter, req);
  if (limited) return limited;

  const rpcUrl = process.env.SEPOLIA_RPC_URL;

  if (!rpcUrl) {
    return NextResponse.json({ error: 'SEPOLIA_RPC_URL not configured' }, { status: 503 });
  }

  if (!CONTRACT_ADDRESS) {
    return NextResponse.json({ error: 'Contract address not configured' }, { status: 503 });
  }

  const rawLimit = parseInt(req.nextUrl.searchParams.get('limit') ?? '50', 10);
  const limit    = Math.min(isNaN(rawLimit) ? 50 : rawLimit, 200);

  const client = createPublicClient({
    chain:     sepolia,
    transport: http(rpcUrl),
  });

  // Scan the last ~10 000 blocks (~33 hours on Sepolia at 12 s/block).
  let fromBlock: bigint;
  try {
    const latest  = await client.getBlockNumber();
    const rawFrom = req.nextUrl.searchParams.get('fromBlock');
    fromBlock = rawFrom ? BigInt(rawFrom) : (latest > 10_000n ? latest - 10_000n : 0n);
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to fetch latest block', detail: String(err) },
      { status: 502 },
    );
  }

  try {
    const [submitted, evaluated] = await Promise.all([
      client.getLogs({
        address:   CONTRACT_ADDRESS,
        event:     SCORE_SUBMITTED,
        fromBlock,
        toBlock:   'latest',
      }),
      client.getLogs({
        address:   CONTRACT_ADDRESS,
        event:     SCORE_EVALUATED,
        fromBlock,
        toBlock:   'latest',
      }),
    ]);

    // Merge, sort descending by block number, apply limit.
    const events = [
      ...submitted.map((l) => ({
        type:        'ScoreSubmitted' as const,
        subject:     l.args.subject as string,
        blockNumber: Number(l.blockNumber),
        txHash:      l.transactionHash,
        timestamp:   l.args.timestamp ? Number(l.args.timestamp) : null,
      })),
      ...evaluated.map((l) => ({
        type:        'ScoreEvaluated' as const,
        subject:     l.args.subject as string,
        blockNumber: Number(l.blockNumber),
        txHash:      l.transactionHash,
        timestamp:   l.args.timestamp ? Number(l.args.timestamp) : null,
      })),
    ]
      .sort((a, b) => b.blockNumber - a.blockNumber)
      .slice(0, limit);

    return NextResponse.json({ events, fromBlock: fromBlock.toString() });
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to fetch contract events', detail: String(err) },
      { status: 502 },
    );
  }
}
