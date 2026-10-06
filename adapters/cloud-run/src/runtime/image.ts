/**
 * `/_next/image` for the runtime server, copied into the container as
 * `.cloud-run-runtime/image.mjs` and loaded on the first image request.
 *
 * It mirrors `NextNodeServer.handleNextImageRequest` on top of Next.js' own
 * image optimizer (`next/dist/server/image-optimizer`), resolved from the
 * app's `next` install like the entrypoints, so validation, fetching,
 * resizing with sharp, caching and response headers match `next start`.
 * This file is the only place the adapter depends on those internals.
 */
import type http from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type * as ImageOptimizer from 'next/dist/server/image-optimizer.js'
import type { ImagesEntry } from '../manifest.js'

type Query = Record<string, string | string[]>
type ImageCacheEntry = NonNullable<
  Awaited<ReturnType<ImageOptimizer.ImageOptimizerCache['get']>>
>
type ImageParams = ImageOptimizer.ImageParamsResult
interface ImageValue {
  kind: 'IMAGE'
  buffer: Buffer
  etag: string
  upstreamEtag: string
  extension: string
}
interface Optimized {
  value: ImageValue
  revalidate: number
}

export interface ImageHandlerOptions {
  images: ImagesEntry
  appRoot: string
  projectDir: string
  distDir: string
  /** The server's own request handling, used to fetch local images. */
  handleRequest: (
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) => Promise<void>
  waitUntil: (promise: Promise<unknown>) => void
}

export async function createImageHandler({
  images,
  appRoot,
  projectDir,
  distDir,
  handleRequest,
  waitUntil,
}: ImageHandlerOptions) {
  const nextRequire = createRequire(path.join(projectDir, 'package.json'))
  const {
    ImageOptimizerCache,
    ImageError,
    fetchExternalImage,
    fetchInternalImage,
    imageOptimizer,
    sendResponse,
  } = nextRequire(
    'next/dist/server/image-optimizer'
  ) as typeof import('next/dist/server/image-optimizer.js')
  const { getExtension } = nextRequire(
    'next/dist/server/serve-static'
  ) as typeof import('next/dist/server/serve-static.js')

  const nextConfig = images.nextConfig as any
  const imagesConfig = nextConfig.images as ImagesEntry['nextConfig']['images']

  // With `images.customCacheHandler`, optimized images go through the app's
  // `cacheHandler` (e.g. the Redis handler, shared by all instances) instead
  // of the instance's local `<distDir>/cache/images`.
  let cacheHandler: any
  if (images.cacheHandler) {
    const mod = await import(
      pathToFileURL(path.join(appRoot, images.cacheHandler)).href
    )
    const CacheHandler = mod.default?.default ?? mod.default ?? mod
    cacheHandler = new CacheHandler({
      dev: false,
      flushToDisk: nextConfig.experimental.isrFlushToDisk,
      serverDistDir: path.join(distDir, 'server'),
      maxMemoryCacheSize: nextConfig.cacheMaxMemorySize,
      revalidatedTags: [],
      _requestHeaders: {},
    })
  }
  const cache = new ImageOptimizerCache({ distDir, nextConfig, cacheHandler })

  // Concurrent requests for the same image share one optimization.
  const inflight = new Map<string, Promise<Optimized>>()
  let warnedOptimizeError = false

  function optimize(
    cacheKey: string,
    params: ImageParams,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    previousCacheEntry: ImageCacheEntry | null
  ) {
    let promise = inflight.get(cacheKey)
    if (promise) return promise
    promise = (async () => {
      const upstream = params.isAbsolute
        ? await fetchExternalImage(
            params.href,
            imagesConfig.dangerouslyAllowLocalIP,
            imagesConfig.maximumResponseBody,
            imagesConfig.maximumRedirects
          )
        : await fetchInternalImage(
            params.href,
            req,
            res,
            imagesConfig.maximumResponseBody,
            async (internalReq, internalRes) => {
              if (internalReq.url === req.url) {
                throw new Error(
                  'Invariant attempted to optimize _next/image itself'
                )
              }
              await handleRequest(internalReq, internalRes)
            }
          )
      const { buffer, contentType, maxAge, etag, upstreamEtag, error } =
        await imageOptimizer(upstream, params, nextConfig, {
          isDev: false,
          previousCacheEntry: previousCacheEntry as any,
        })
      if (error && !warnedOptimizeError) {
        // Next.js serves the original image when sharp fails or is missing.
        warnedOptimizeError = true
        console.warn(
          '[cloud-run] image optimization failed, serving the original image:',
          error instanceof Error ? error.message : error
        )
      }
      const optimized: Optimized = {
        value: {
          kind: 'IMAGE',
          buffer,
          etag,
          upstreamEtag,
          extension: getExtension(contentType) as string,
        },
        revalidate: maxAge,
      }
      // Like Next's ResponseCache, persist before responding so the next
      // request (on any instance, with a shared cacheHandler) is a hit.
      await cache.set(cacheKey, optimized.value as any, {
        cacheControl: { revalidate: maxAge, expire: undefined },
      })
      return optimized
    })().finally(() => inflight.delete(cacheKey))
    inflight.set(cacheKey, promise)
    return promise
  }

  return async function handleImage(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    query: Query
  ) {
    const params = ImageOptimizerCache.validateParams(
      req,
      query,
      nextConfig,
      false
    )
    if ('errorMessage' in params) {
      res.statusCode = 400
      return res.end(params.errorMessage)
    }
    const cacheKey = ImageOptimizerCache.getCacheKey(params)

    try {
      let optimized: Optimized
      let xCache: 'MISS' | 'HIT' | 'STALE'
      const cached = await cache.get(cacheKey)
      if (cached?.value?.kind === 'IMAGE') {
        // Serve the cached image; regenerate a stale one in the background.
        optimized = {
          value: cached.value as ImageValue,
          revalidate: cached.cacheControl?.revalidate || 0,
        }
        xCache = cached.isStale ? 'STALE' : 'HIT'
        if (cached.isStale) {
          waitUntil(optimize(cacheKey, params, req, res, cached))
        }
      } else {
        optimized = await optimize(cacheKey, params, req, res, null)
        xCache = 'MISS'
      }

      sendResponse(
        req,
        res,
        params.href,
        optimized.value.extension,
        optimized.value.buffer,
        optimized.value.etag,
        params.isStatic,
        xCache,
        imagesConfig as any,
        optimized.revalidate,
        false
      )
    } catch (err) {
      if (err instanceof ImageError) {
        res.statusCode = err.statusCode
        return res.end(err.message)
      }
      throw err
    }
  }
}
