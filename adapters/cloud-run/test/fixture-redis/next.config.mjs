import path from 'node:path'
import { fileURLToPath } from 'node:url'

// node_modules live in the adapter package, two levels up.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/** @type {import('next').NextConfig} */
export default {
  outputFileTracingRoot: root,
  turbopack: { root },
  cacheComponents: true,
}
