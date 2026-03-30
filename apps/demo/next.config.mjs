/** @type {import('next').NextConfig} */
const config = {
  transpilePackages: ['@fhe-guard/sdk'],
  experimental: {
    serverComponentsExternalPackages: ['ethers'],
  },
  // Required for SharedArrayBuffer, which the Zama SDK needs for WASM threads.
  // Without these headers, WebAssembly.Memory can't be shared and the SDK
  // initialises WASM with wrong page counts, causing an instantiate() error.
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Cross-Origin-Opener-Policy',   value: 'same-origin' },
          { key: 'Cross-Origin-Embedder-Policy',  value: 'credentialless' },
          { key: 'Cross-Origin-Resource-Policy',  value: 'same-origin' },
        ],
      },
    ];
  },
  webpack(webpackConfig) {
    // ESM workspace packages use `.js` extensions in imports that point to `.ts`
    // source files. Teach webpack to check `.ts` first before `.js`.
    webpackConfig.resolve.extensionAlias = {
      '.js':  ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return webpackConfig;
  },
};

export default config;
