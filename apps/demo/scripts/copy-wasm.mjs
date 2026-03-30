/**
 * copy-wasm.mjs — postinstall script
 *
 * Copies the Zama Relayer SDK WASM binaries from node_modules to public/
 * so Next.js serves them at /tfhe_bg.wasm and /kms_lib_bg.wasm.
 * These files are gitignored (too large to commit); this script recreates
 * them after every `pnpm install`.
 */

import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname }                        from 'node:path';
import { fileURLToPath }                        from 'node:url';

const root    = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir  = join(root, 'node_modules', '@zama-fhe', 'relayer-sdk', 'bundle');
const destDir = join(root, 'public');

const files = ['tfhe_bg.wasm', 'kms_lib_bg.wasm', 'workerHelpers.js'];

mkdirSync(destDir, { recursive: true });

let ok = true;
for (const file of files) {
  const src  = join(srcDir, file);
  const dest = join(destDir, file);
  if (!existsSync(src)) {
    console.warn(`[copy-wasm] WARNING: source not found: ${src}`);
    ok = false;
    continue;
  }
  copyFileSync(src, dest);
  console.log(`[copy-wasm] ${file} → public/${file}`);
}

if (ok) console.log('[copy-wasm] Done.');
