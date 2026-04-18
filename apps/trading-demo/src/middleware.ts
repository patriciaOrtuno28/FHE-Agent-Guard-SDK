import { type NextRequest, NextResponse } from 'next/server';

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? 'http://localhost:3000';

/**
 * - Sets COOP + COEP headers on every response (required for SharedArrayBuffer
 *   used by the Zama Relayer SDK WASM threading model).
 * - Adds CORS headers on /api/* routes, restricting to ALLOWED_ORIGIN.
 * - Handles CORS preflight (OPTIONS) so browsers don't block cross-origin fetches.
 */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const { method } = req;
  const isApi = pathname.startsWith('/api/');

  // ── CORS preflight ────────────────────────────────────────────────────────
  if (isApi && method === 'OPTIONS') {
    const origin = req.headers.get('origin') ?? '';
    const headers = new Headers();
    headers.set('Cross-Origin-Opener-Policy',  'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
    headers.set('Cross-Origin-Resource-Policy', 'same-origin');

    if (origin === ALLOWED_ORIGIN) {
      headers.set('Access-Control-Allow-Origin',  origin);
      headers.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      headers.set('Access-Control-Allow-Headers', 'Content-Type');
      headers.set('Access-Control-Max-Age',       '86400');
      headers.set('Vary', 'Origin');
    }

    return new NextResponse(null, { status: 204, headers });
  }

  const res = NextResponse.next();

  // ── COOP / COEP / CORP (all routes) ──────────────────────────────────────
  res.headers.set('Cross-Origin-Opener-Policy',  'same-origin');
  res.headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
  res.headers.set('Cross-Origin-Resource-Policy', 'same-origin');

  // ── CORS (API routes only) ────────────────────────────────────────────────
  if (isApi) {
    const origin = req.headers.get('origin') ?? '';
    if (origin === ALLOWED_ORIGIN) {
      res.headers.set('Access-Control-Allow-Origin',  origin);
      res.headers.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      res.headers.set('Access-Control-Allow-Headers', 'Content-Type');
      res.headers.set('Vary', 'Origin');
    }
  }

  return res;
}

export const config = {
  matcher: '/:path*',
};
