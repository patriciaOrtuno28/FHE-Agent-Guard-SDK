import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { redis } from '@/lib/redis';
import { checkRateLimit, inviteLimiter } from '@/lib/ratelimit';

export const runtime = 'nodejs';

export interface TradeInvite {
  id: string;
  from: string;         // wallet (lowercase)
  fromUsername: string;
  to: string;           // wallet (lowercase)
  toUsername: string;
  offer: string;        // human-readable trade offer
  fheHandle: string;    // sender's encrypted score handle
  aclExpiryMs: number;  // unix ms when off-chain ACL window closes
  status: 'pending' | 'score_seen' | 'accepted' | 'declined';
  createdAt: number;
}

export async function POST(req: NextRequest) {
  const limited = await checkRateLimit(inviteLimiter, req);
  if (limited) return limited;

  const body = await req.json() as Partial<Omit<TradeInvite, 'id' | 'status' | 'createdAt'>>;

  if (!body.from || !body.to || !body.offer || !body.fheHandle || !body.aclExpiryMs) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  const invite: TradeInvite = {
    id: randomUUID(),
    from:          body.from.toLowerCase(),
    fromUsername:  body.fromUsername ?? body.from.slice(0, 8),
    to:            body.to.toLowerCase(),
    toUsername:    body.toUsername   ?? body.to.slice(0, 8),
    offer:         body.offer,
    fheHandle:     body.fheHandle,
    aclExpiryMs:   body.aclExpiryMs,
    status:        'pending',
    createdAt:     Date.now(),
  };

  // Store as object — Upstash auto-serializes; do NOT JSON.stringify manually.
  await redis.set(`invite:${invite.id}`, invite);

  return NextResponse.json({ ok: true, id: invite.id });
}

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get('wallet')?.toLowerCase();
  const type   = req.nextUrl.searchParams.get('type') ?? 'received'; // 'received' | 'sent'
  if (!wallet) return NextResponse.json({ invites: [] });

  // Scan all invite:* keys and filter — avoids any index inconsistency.
  const keys = await redis.keys('invite:*');
  if (!keys.length) return NextResponse.json({ invites: [] });

  const raws = await Promise.all(keys.map((k) => redis.get<TradeInvite>(k)));
  const invites = raws
    .filter((inv): inv is TradeInvite => inv !== null)
    .filter((inv) => (type === 'sent' ? inv.from === wallet : inv.to === wallet))
    .sort((a, b) => b.createdAt - a.createdAt);

  return NextResponse.json({ invites });
}
