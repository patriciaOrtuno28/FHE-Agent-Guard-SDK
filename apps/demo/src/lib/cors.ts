import type { NextRequest } from 'next/server';

const allowedOrigin = process.env.ALLOWED_ORIGIN;

export function buildCorsHeaders(req: NextRequest, methods: string) {
  const origin = req.headers.get('origin');

  if (!allowedOrigin || !origin || origin !== allowedOrigin) {
    return {};
  }

  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
    Vary: 'Origin',
  };
}

export function preflight(req: NextRequest, methods: string) {
  const headers = buildCorsHeaders(req, methods);
  if (!Object.keys(headers).length) {
    return new Response(null, { status: 403 });
  }
  return new Response(null, { status: 204, headers });
}