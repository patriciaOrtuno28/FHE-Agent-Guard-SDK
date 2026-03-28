/** @type {import('next').NextConfig} */
const config = {
  transpilePackages: ['@fhe-guard/sdk'],
  experimental: {
    serverComponentsExternalPackages: ['ethers'],
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
