import { NextRequest, NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import type { TradeInvite } from '../route';

export const runtime = 'nodejs';

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const { id } = params;
  const body = await req.json() as { status: TradeInvite['status'] };

  const invite = await redis.get<TradeInvite>(`invite:${id}`);
  if (!invite) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  invite.status = body.status;
  await redis.set(`invite:${id}`, invite);

  return NextResponse.json({ ok: true });
}
