/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['pg', 'playwright-core', '@sparticuz/chromium'],
  },
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals.push('pg-native');
    }
    return config;
  },
};

module.exports = nextConfig;
