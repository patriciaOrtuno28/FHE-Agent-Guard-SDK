import { defineConfig } from 'tsup';

export default defineConfig([
  // Client/React entry — no Node.js modules
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    dts: true,
    // Preserve the 'use client' directive so Next.js App Router treats this
    // bundle as a Client Module. tsup strips directive strings by default.
    banner: { js: '"use client";' },
    external: ['react', 'react-dom', 'next', 'next/server'],
    noExternal: ['@fhe-guard/sdk'],
    splitting: false,
    sourcemap: true,
    clean: true,
    outDir: 'dist',
  },
  // Server entry — may import Node.js built-ins via SDK
  {
    entry: { 'server/index': 'src/server/index.ts' },
    format: ['esm'],
    dts: true,
    external: ['react', 'react-dom', 'next', 'next/server', 'node:fs', 'node:path'],
    noExternal: ['@fhe-guard/sdk'],
    splitting: false,
    sourcemap: true,
    outDir: 'dist',
  },
]);
