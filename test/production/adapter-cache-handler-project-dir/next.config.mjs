import { createRequire } from 'module'

const require = createRequire(import.meta.url)

/** @type {import('next').NextConfig} */
const nextConfig = {
  adapterPath: require.resolve('./test-adapter.mjs'),
  cacheHandler: require.resolve('./cache-handler.js'),
}

export default nextConfig
