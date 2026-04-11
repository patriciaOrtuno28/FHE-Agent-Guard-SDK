import { NextResponse } from 'next/server';
import { redis, userKey } from '@/lib/redis';

export const runtime = 'nodejs';

export async function GET() {
  // Scan all user:* keys directly — handles accounts registered before the
  // users:index set was introduced, so no data is ever missed.
  const keys = await redis.keys('user:*');
  if (!keys.length) return NextResponse.json({ users: [] });

  const wallets   = keys.map((k) => k.replace('user:', ''));
  const usernames = await Promise.all(wallets.map((w) => redis.get<string>(userKey(w))));

  const users = wallets
    .map((wallet, i) => ({ wallet, username: usernames[i] ?? null }))
    .filter((u) => u.username !== null) as { wallet: string; username: string }[];

  // Backfill the index for any wallets that were missing from it
  if (wallets.length) {
    await redis.sadd('users:index', ...wallets);
  }

  return NextResponse.json({ users });
}
