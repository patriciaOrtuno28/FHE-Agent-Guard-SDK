import { Ratelimit } from '@upstash/ratelimit';
import { NextRequest, NextResponse } from 'next/server';
import { redis } from './redis';

// ── Limiters ──────────────────────────────────────────────────────────────────

/** /api/scan — 5 scans per minute per IP (each scan hits RPC + inference). */
export const scanLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(5, '1 m'),
  prefix:  'rl:scan',
});

/** /api/auth/register — 3 registrations per 10 minutes per IP. */
export const registerLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(3, '10 m'),
  prefix:  'rl:register',
});

/** /api/trade/invite POST — 20 invites per hour per IP. */
export const inviteLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(20, '1 h'),
  prefix:  'rl:invite',
});

/** /api/events GET — 30 requests per minute per IP (each call makes 2 RPC getLogs calls). */
export const eventsLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(30, '1 m'),
  prefix:  'rl:events',
});

// ── Helper ────────────────────────────────────────────────────────────────────

function getIp(req: NextRequest): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0].trim() ??
    req.headers.get('x-real-ip') ??
    '127.0.0.1'
  );
}

/**
 * Check a rate limiter for the request's IP.
 * Returns a 429 NextResponse if the limit is exceeded, otherwise null.
 */
export async function checkRateLimit(
  limiter: Ratelimit,
  req: NextRequest,
): Promise<NextResponse | null> {
  const ip = getIp(req);
  const { success, limit, remaining, reset } = await limiter.limit(ip);

  if (!success) {
    return NextResponse.json(
      { error: 'Too many requests. Please try again later.' },
      {
        status: 429,
        headers: {
          'X-RateLimit-Limit':     String(limit),
          'X-RateLimit-Remaining': String(remaining),
          'X-RateLimit-Reset':     String(reset),
          'Retry-After':           String(Math.ceil((reset - Date.now()) / 1000)),
        },
      },
    );
  }

  return null;
}
