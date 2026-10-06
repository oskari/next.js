/**
 * `cacheHandler` (singular) backed by Redis: ISR and route responses, the
 * `fetch`/`unstable_cache` data cache and optimized images.
 *
 * Entries missing from Redis fall back to the build's prerendered seeds on
 * local disk, read through Next.js' own file-system cache so the seed format
 * always matches the installed Next.js version.
 */
import FileSystemCacheModule from 'next/dist/server/lib/incremental-cache/file-system-cache.js'
import type {
  CacheHandler,
  CacheHandlerContext,
  CacheHandlerValue,
} from 'next/dist/server/lib/incremental-cache/index.js'
import {
  areTagsExpired,
  areTagsStale,
  deserialize,
  getClient,
  keys,
  serialize,
  syncTags,
  ttlSeconds,
  updateTags,
  DEFAULT_TTL_SECONDS,
} from './store.js'

type GetContext = Parameters<CacheHandler['get']>[1]
type SetContext = Parameters<CacheHandler['set']>[2]
type Value = Parameters<CacheHandler['set']>[1]

const FileSystemCache = ((FileSystemCacheModule as any).default ??
  FileSystemCacheModule) as new (ctx: any) => CacheHandler

const CACHE_TAGS_HEADER = 'x-next-cache-tags'

export default class RedisCacheHandler {
  private readonly seeds: CacheHandler

  constructor(ctx: CacheHandlerContext) {
    this.seeds = new FileSystemCache({
      ...ctx,
      flushToDisk: false,
      maxMemoryCacheSize: 0,
    })
  }

  async get(key: string, ctx: GetContext): Promise<CacheHandlerValue | null> {
    const isFetch = ctx.kind === 'FETCH'
    let entry: CacheHandlerValue | null = null
    const redis = await getClient()

    if (redis) {
      try {
        const results = await redis
          .pipeline()
          .get(isFetch ? keys.fetch(key) : keys.response(key))
          .get(keys.tagsVersion)
          .exec()
        const [[, raw], [, version]] = results as [
          [Error | null, string | null],
          [Error | null, string | null],
        ]
        await syncTags(redis, version)
        if (raw) entry = deserialize<CacheHandlerValue>(raw)
      } catch (err) {
        console.error('[cloud-run] Redis cache get failed', key, err)
      }
    }

    if (!entry && !isFetch && ctx.kind !== 'IMAGE') {
      entry = await this.seeds.get(key, ctx)
    }
    if (!entry) return null

    return isFetch
      ? this.checkFetchTags(entry, ctx)
      : this.checkResponseTags(entry)
  }

  async set(key: string, data: Value, ctx: SetContext) {
    const redis = await getClient()
    if (!redis) return
    const isFetch = 'fetchCache' in ctx && ctx.fetchCache === true
    const cacheControl = isFetch
      ? undefined
      : (ctx as { cacheControl?: CacheHandlerValue['cacheControl'] })
          .cacheControl
    const entry: CacheHandlerValue = {
      lastModified: Date.now(),
      value: data,
      cacheControl,
    }
    try {
      await redis.set(
        isFetch ? keys.fetch(key) : keys.response(key),
        serialize(entry),
        'EX',
        isFetch ? DEFAULT_TTL_SECONDS : ttlSeconds(cacheControl?.expire)
      )
    } catch (err) {
      console.error('[cloud-run] Redis cache set failed', key, err)
    }
  }

  async revalidateTag(
    tags: string | string[],
    durations?: { expire?: number }
  ) {
    await updateTags(
      await getClient(),
      typeof tags === 'string' ? [tags] : tags,
      durations
    )
  }

  resetRequestCache() {}

  private checkFetchTags(entry: CacheHandlerValue, ctx: GetContext) {
    const tags =
      ctx.kind === 'FETCH' ? [...(ctx.tags ?? []), ...(ctx.softTags ?? [])] : []
    if (areTagsExpired(tags, entry.lastModified)) return null
    // A negative lastModified makes Next.js treat the entry as stale: it is
    // served and refetched in the background.
    if (areTagsStale(tags, entry.lastModified)) {
      return { ...entry, lastModified: -1 }
    }
    return entry
  }

  private checkResponseTags(entry: CacheHandlerValue) {
    const value = entry.value as { headers?: Record<string, unknown> } | null
    const header = value?.headers?.[CACHE_TAGS_HEADER]
    if (typeof header !== 'string') return entry
    const tags = header.split(',')

    if (areTagsExpired(tags, entry.lastModified)) return null
    if (areTagsStale(tags, entry.lastModified)) {
      // Serve stale and regenerate in the background by backdating the entry
      // past its revalidate time but within its expire time. Without a known
      // window, report a miss so the page regenerates now.
      const { revalidate, expire } = entry.cacheControl ?? {}
      if (
        typeof revalidate !== 'number' ||
        (typeof expire === 'number' && expire <= revalidate)
      ) {
        return null
      }
      return { ...entry, lastModified: Date.now() - revalidate * 1000 - 1 }
    }
    return entry
  }
}
