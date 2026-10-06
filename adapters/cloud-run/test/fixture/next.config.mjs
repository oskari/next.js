import path from 'node:path'
import { fileURLToPath } from 'node:url'

// node_modules live in the adapter package, two levels up.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/** @type {import('next').NextConfig} */
export default {
  outputFileTracingRoot: root,
  turbopack: { root },
  images: {
    formats: ['image/avif', 'image/webp'],
    // The smoke test serves a remote image from a local HTTP server.
    remotePatterns: [{ protocol: 'http', hostname: '127.0.0.1' }],
    dangerouslyAllowLocalIP: true,
  },
  async redirects() {
    return [{ source: '/old', destination: '/', permanent: false }]
  },
  async rewrites() {
    return [{ source: '/alias', destination: '/blog/alias' }]
  },
  async headers() {
    return [{ source: '/', headers: [{ key: 'x-custom', value: 'yes' }] }]
  },
}
