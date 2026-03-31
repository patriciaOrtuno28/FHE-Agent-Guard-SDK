import type { NextRequest } from 'next/server';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

const redis =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? Redis.fromEnv()
    : null;

const ratelimit = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(
        Number(process.env.SCAN_RATE_LIMIT_MAX ?? 10),
        process.env.SCAN_RATE_LIMIT_WINDOW ?? '60 s',
      ),
      analytics: true,
      prefix: 'scan',
    })
  : null;

function getClientIp(req: NextRequest): string {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return req.headers.get('x-real-ip') ?? 'unknown';
}

export async function checkScanRateLimit(req: NextRequest) {
  if (!ratelimit) {
    return { success: true, limit: 0, remaining: 0, reset: 0 };
  }
  return ratelimit.limit(getClientIp(req));
}