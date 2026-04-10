import { type NextRequest, NextResponse } from 'next/server';

/**
 * Set COOP + COEP headers on every response.
 * Required for SharedArrayBuffer, which the Zama Relayer SDK uses for
 * its WASM threading model.
 */
export function middleware(req: NextRequest) {
  const res = NextResponse.next();
  res.headers.set('Cross-Origin-Opener-Policy',   'same-origin');
  res.headers.set('Cross-Origin-Embedder-Policy',  'credentialless');
  res.headers.set('Cross-Origin-Resource-Policy',  'same-origin');
  return res;
}

export const config = {
  matcher: '/:path*',
};
