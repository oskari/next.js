/**
 * `cacheHandlers` entry for `'use cache'` and `'use cache: remote'`, backed by
 * Redis. Each entry is stored as one value: a 4-byte metadata length, the
 * metadata JSON, then the serialized bytes. Without REDIS_URL it is Next.js'
 * own in-memory default handler.
 */
import type { CacheEntry, CacheHandler } from 'next/cache.js'
import { createDefaultCacheHandler } from 'next/dist/server/lib/cache-handlers/default.js'
import {
  areTagsExpired,
  areTagsStale,
  getClient,
  getTagsExpiration,
  keys,
  redisConfigured,
  syncTags,
  ttlSeconds,
  updateTags,
} from './store.js'

type Metadata = Omit<CacheEntry, 'value'>

// Reads wait for an in-flight write of the same key from this instance.
const pendingSets = new Map<string, Promise<void>>()

function streamFromBuffer(buffer: Buffer) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(buffer))
      controller.close()
    },
  })
}

// Next.js' built-in handler at the framework's default `cacheMaxMemorySize`.
let localHandler: CacheHandler | undefined
function local() {
  return (localHandler ??= createDefaultCacheHandler(50 * 1024 * 1024))
}

const handler: CacheHandler = {
  async get(cacheKey, softTags) {
    if (!redisConfigured()) return local().get(cacheKey, softTags)
    const redis = await getClient()
    if (!redis) return undefined
    await pendingSets.get(cacheKey)

    try {
      const raw = await redis.getBuffer(keys.useCache(cacheKey))
      if (!raw) return undefined
      const metadataLength = raw.readUInt32BE(0)
      const metadata: Metadata = JSON.parse(
        raw.subarray(4, 4 + metadataLength).toString('utf8')
      )

      // Next.js checks `expire` itself, and soft tags through getExpiration.
      if (areTagsExpired(metadata.tags, metadata.timestamp)) return undefined
      const revalidate = areTagsStale(metadata.tags, metadata.timestamp)
        ? -1
        : metadata.revalidate

      return {
        ...metadata,
        revalidate,
        value: streamFromBuffer(raw.subarray(4 + metadataLength)),
      }
    } catch (err) {
      console.error('[cloud-run] Redis use cache get failed', cacheKey, err)
      return undefined
    }
  },

  async set(cacheKey, pendingEntry) {
    if (!redisConfigured()) return local().set(cacheKey, pendingEntry)
    const redis = await getClient()
    let resolvePending = () => {}
    pendingSets.set(
      cacheKey,
      new Promise<void>((resolve) => (resolvePending = resolve))
    )

    try {
      const entry = await pendingEntry
      // An `expire: 0` entry is dynamic and regenerated on every read.
      if (!redis || entry.expire === 0) {
        await entry.value.cancel()
        return
      }
      // A stream that errors mid-render rejects here, so incomplete values
      // are never stored.
      const value = Buffer.from(await new Response(entry.value).arrayBuffer())
      const { value: _, ...metadata } = entry
      const metadataBuffer = Buffer.from(JSON.stringify(metadata))
      const header = Buffer.alloc(4)
      header.writeUInt32BE(metadataBuffer.length)

      await redis.set(
        keys.useCache(cacheKey),
        Buffer.concat([header, metadataBuffer, value]),
        'EX',
        ttlSeconds(entry.expire)
      )
    } catch (err) {
      console.error('[cloud-run] Redis use cache set failed', cacheKey, err)
    } finally {
      resolvePending()
      pendingSets.delete(cacheKey)
    }
  },

  async refreshTags() {
    if (!redisConfigured()) return local().refreshTags()
    const redis = await getClient()
    if (!redis) return
    try {
      await syncTags(redis)
    } catch (err) {
      // Keep serving with the last known tag state.
      console.error('[cloud-run] Redis tag refresh failed', err)
    }
  },

  async getExpiration(tags) {
    if (!redisConfigured()) return local().getExpiration(tags)
    return getTagsExpiration(tags)
  },

  async updateTags(tags, durations) {
    if (!redisConfigured()) return local().updateTags(tags, durations)
    await updateTags(await getClient(), tags, durations)
  },
}

export default handler
