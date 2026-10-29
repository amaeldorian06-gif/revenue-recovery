import type { NextConfig } from 'next';

const config: NextConfig = {
  serverExternalPackages: ['@electric-sql/pglite'],
  // `next dev` (proof walks) writes its own dist so it can never clobber the
  // production build that `next start` serves from the shared workspace.
  distDir: process.env.NEXT_DEV_DIST === '1' ? '.next-dev' : '.next',
  poweredByHeader: false,
  async headers() {
    return [{
      source: '/(.*)',
      headers: [
        { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
      ],
    }];
  },
};

export default config;
