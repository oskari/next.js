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
}
