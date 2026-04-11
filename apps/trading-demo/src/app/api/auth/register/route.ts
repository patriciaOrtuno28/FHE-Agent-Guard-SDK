import { NextRequest, NextResponse } from 'next/server';
import { redis, userKey } from '@/lib/redis';
import { checkRateLimit, registerLimiter } from '@/lib/ratelimit';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const limited = await checkRateLimit(registerLimiter, req);
  if (limited) return limited;

  const body = await req.json() as { wallet?: string; username?: string };
  const { wallet, username } = body;

  if (!wallet || !username) {
    return NextResponse.json({ error: 'Missing wallet or username' }, { status: 400 });
  }

  await Promise.all([
    redis.set(userKey(wallet), username.trim()),
    redis.sadd('users:index', wallet.toLowerCase()),
  ]);
  return NextResponse.json({ ok: true });
}
