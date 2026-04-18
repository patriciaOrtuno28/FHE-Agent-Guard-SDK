import { withSentryConfig } from '@sentry/nextjs';

const isProd = process.env.NODE_ENV === 'production';

// Extract the exact ingest host from the DSN so connect-src is as tight as possible.
// DSN format: https://<key>@<host>/<project-id>
const sentryHost = (() => {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
  if (!dsn) return '';
  try {
    const host = new URL(dsn.replace(/^https:\/\/[^@]+@/, 'https://')).host;
    return ` https://${host}`;
  } catch {
    return ' https://*.ingest.sentry.io https://*.ingest.de.sentry.io';
  }
})();

const csp = isProd
  ? [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://vercel.live",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      `connect-src 'self' https://relayer.testnet.zama.org https://zama-mpc-testnet-public-efd88e2b.s3.eu-west-1.amazonaws.com https://vercel.live wss://ws-us3.pusher.com${sentryHost}`,
      "worker-src 'self' blob:",
      "frame-src 'self' blob: https://vercel.live",
      "child-src 'self' blob: https://vercel.live",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "upgrade-insecure-requests",
    ].join('; ')
  : [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      `connect-src 'self' http://localhost:3001 ws://localhost:3001 https://relayer.testnet.zama.org https://zama-mpc-testnet-public-efd88e2b.s3.eu-west-1.amazonaws.com${sentryHost}`,
      "worker-src 'self' blob:",
      "child-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ');

/** @type {import('next').NextConfig} */
const config = {
  transpilePackages: ['@fhe-guard/plugin', '@fhe-guard/sdk'],
  experimental: {
    serverComponentsExternalPackages: ['ethers'],
    instrumentationHook: true,
  },
  async headers() {
    return [
      {
        // WASM files must not be cached — Chrome's disk cache corrupts large
        // binary files, causing ERR_CACHE_READ_FAILURE on subsequent loads.
        source: '/:path*.wasm',
        headers: [
          { key: 'Content-Type',   value: 'application/wasm' },
          { key: 'Cache-Control',  value: 'no-store, no-cache' },
          // WASM modules must be cross-origin-accessible when COEP is active
          { key: 'Cross-Origin-Resource-Policy', value: 'cross-origin' },
        ],
      },
      {
        source: '/(.*)',
        headers: [
          { key: 'Cross-Origin-Opener-Policy',   value: 'same-origin' },
          { key: 'Cross-Origin-Embedder-Policy',  value: 'credentialless' },
          { key: 'Cross-Origin-Resource-Policy',  value: 'same-origin' },
          { key: 'Content-Security-Policy',        value: csp },
          { key: 'Referrer-Policy',               value: 'strict-origin-when-cross-origin' },
          { key: 'X-Content-Type-Options',         value: 'nosniff' },
          { key: 'X-Frame-Options',                value: 'DENY' },
          {
            key: 'Permissions-Policy',
            value: [
              'camera=()',
              'microphone=()',
              'geolocation=()',
              'payment=()',
              'usb=()',
              'interest-cohort=()',
            ].join(', '),
          },
        ],
      },
    ];
  },
  webpack(webpackConfig) {
    webpackConfig.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return webpackConfig;
  },
};

export default withSentryConfig(config, {
  // Only upload source maps and run Sentry build-time steps when DSN is configured.
  silent: true,
  disableLogger: true,
  widenClientFileUpload: true,
  hideSourceMaps: true,
  // Disable automatic instrumentation injection — we use instrumentation.ts instead.
  autoInstrumentServerFunctions: false,
  // Suppress webpack warnings when SENTRY_DSN is not set (local dev without Sentry).
  dryRun: !process.env.NEXT_PUBLIC_SENTRY_DSN,
});
