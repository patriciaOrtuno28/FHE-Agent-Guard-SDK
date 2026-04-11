import { NextRequest, NextResponse } from 'next/server';
import { redis, userKey } from '@/lib/redis';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get('wallet');
  if (!wallet) {
    return NextResponse.json({ username: null });
  }

  const username = await redis.get<string>(userKey(wallet));
  return NextResponse.json({ username: username ?? null });
}

export async function DELETE(req: NextRequest) {
  const body = await req.json() as { wallet?: string };
  const { wallet } = body;

  if (!wallet) {
    return NextResponse.json({ error: 'Missing wallet' }, { status: 400 });
  }

  await Promise.all([
    redis.del(userKey(wallet)),
    redis.srem('users:index', wallet.toLowerCase()),
  ]);
  return NextResponse.json({ ok: true });
}
