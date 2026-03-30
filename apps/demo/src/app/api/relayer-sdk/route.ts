/**
 * Serves the Zama Relayer SDK UMD bundle to the browser.
 *
 * @zama-fhe/relayer-sdk/bundle is a thin wrapper that reads from window.relayerSDK,
 * which is set by the real UMD bundle (bundle/relayer-sdk-js.umd.cjs) when it executes.
 * Next.js cannot import that file via webpack, so we serve it on-demand here and
 * let fhe.ts inject it as a <script> tag.
 */

import { readFileSync } from 'node:fs';
import { join }         from 'node:path';

export const runtime = 'nodejs';

// Read once and cache for the lifetime of the server process.
let _bundle: string | null = null;

function getBundle(): string {
  if (!_bundle) {
    const umdPath = join(
      process.cwd(),
      'node_modules',
      '@zama-fhe',
      'relayer-sdk',
      'bundle',
      'relayer-sdk-js.umd.cjs',
    );
    _bundle = readFileSync(umdPath, 'utf-8');
  }
  return _bundle;
}

export function GET() {
  try {
    const bundle = getBundle();
    return new Response(bundle, {
      headers: {
        'Content-Type':  'application/javascript',
        // no-cache: browser must revalidate on every request so a stale UMD
        // can never outlive a server restart or SDK upgrade.
        'Cache-Control': 'no-cache',
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(`console.error("Failed to load Zama SDK: ${msg.replace(/"/g, "'")}");`, {
      status: 500,
      headers: { 'Content-Type': 'application/javascript' },
    });
  }
}
