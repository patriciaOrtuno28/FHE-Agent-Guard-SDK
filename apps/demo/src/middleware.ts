import { type NextRequest, NextResponse } from 'next/server';

/**
 * Set COOP + COEP headers on every response.
 * These are required for SharedArrayBuffer, which the Zama Relayer SDK needs
 * to initialise its WASM threading model. Without them the browser refuses to
 * create shared memory and the WASM instantiation fails with a page-count error.
 */
export function middleware(req: NextRequest) {
  const res = NextResponse.next();
  res.headers.set('Cross-Origin-Opener-Policy',  'same-origin');
  res.headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
  res.headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return res;
}

export const config = {
  matcher: '/:path*',
};
