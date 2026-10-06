import type { NextAdapter } from 'next'

type BuildCompleteContext = Parameters<
  NonNullable<NextAdapter['onBuildComplete']>
>[0]

export interface FunctionEntry {
  type: string
  /** Entrypoint path relative to the container root. */
  entry: string
  maxDuration?: number
}

/**
 * Written by the adapter at build time and read by the runtime server.
 * Paths are relative to the container root (the mirrored repo root).
 */
export interface CloudRunManifest {
  version: 1
  nextVersion: string
  buildId: string
  basePath: string
  i18n?: BuildCompleteContext['config']['i18n']
  relativeProjectDir: string
  distDir: string
  /** Whether the app was built with Turbopack. */
  turbopack: boolean
  routing: BuildCompleteContext['routing']
  /** URL pathname → function that serves it. */
  functions: Record<string, FunctionEntry>
  middleware?: FunctionEntry
  /** URL pathname → file path relative to the static directory. */
  staticFiles: Record<string, string>
  notFound?: FunctionEntry
  error?: FunctionEntry
  /** Set when `/_next/image` is served (the default loader, optimized). */
  images?: ImagesEntry
}

export interface ImagesEntry {
  /** URL pathname of the optimizer, including basePath. */
  pathname: string
  /**
   * The parts of the Next.js config that Next's image optimizer reads:
   * `basePath`, `images`, and the `experimental.imgOpt*`/`isrFlushToDisk`
   * flags.
   */
  nextConfig: {
    basePath: string
    images: BuildCompleteContext['config']['images']
    experimental: Record<string, unknown>
    cacheMaxMemorySize?: number
  }
  /**
   * `cacheHandler` relative to the container root, when
   * `images.customCacheHandler` routes optimized images through it.
   */
  cacheHandler?: string
}
