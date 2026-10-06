/**
 * Shared Redis (Memorystore) state for the cache handlers: the client, key
 * layout, value serialization and the tag invalidation store.
 *
 * Runtime environment:
 *   REDIS_URL                redis://host:6379 or rediss:// for in-transit
 *                            encryption (Memorystore's private IP)
 *   REDIS_CA_CERT            PEM CA certificate for rediss:// (optional)
 *   NEXT_REDIS_KEY_PREFIX    key prefix (default "next")
 *   NEXT_REDIS_DEFAULT_TTL   TTL in seconds for entries without an expire
 *                            time (default 30 days)
 */
import { Redis } from 'ioredis'

const prefix = process.env.NEXT_REDIS_KEY_PREFIX || 'next'
const buildId = process.env.NEXT_CLOUD_RUN_BUILD_ID || 'default'
export const DEFAULT_TTL_SECONDS =
  Number(process.env.NEXT_REDIS_DEFAULT_TTL) || 30 * 24 * 60 * 60

// Responses and 'use cache' entries reference the build's assets, so they
// are scoped to the build. Tags are shared across builds.
export const keys = {
  response: (key: string) => `${prefix}:${buildId}:r:${key}`,
  fetch: (key: string) => `${prefix}:f:${key}`,
  useCache: (key: string) => `${prefix}:${buildId}:u:${key}`,
  tags: `${prefix}:tags`,
  tagsVersion: `${prefix}:tags:version`,
}

let client: Redis | null | undefined
let lastErrorLog = 0

let initialConnection: Promise<unknown> | undefined

/**
 * The Redis client while it is connected, else null. Handlers treat null as
 * a cache miss, so an unreachable Redis degrades to rendering instead of
 * stalling requests while the client reconnects in the background. Only the
 * first connection after startup is waited for, briefly.
 */
/**
 * Whether this process should use Redis: the deployed server with REDIS_URL.
 * Otherwise the handlers fall back to Next.js' own local caches, so one build
 * works with or without Memorystore.
 */
export function redisConfigured() {
  // Build-time prerendering also goes through the handlers; only the
  // deployed server should read and write the shared cache.
  return (
    process.env.NEXT_PHASE !== 'phase-production-build' &&
    !!process.env.REDIS_URL
  )
}

export async function getClient(): Promise<Redis | null> {
  if (client === undefined) {
    client = createClient()
    initialConnection = client
      ? Promise.race([
          new Promise((resolve) => client!.once('ready', resolve)),
          new Promise((resolve) => setTimeout(resolve, 2000).unref()),
        ])
      : undefined
  }
  if (client && client.status !== 'ready') await initialConnection
  return client?.status === 'ready' ? client : null
}

function createClient(): Redis | null {
  if (!redisConfigured()) return null
  const url = process.env.REDIS_URL!
  const redis = new Redis(url, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: Number(process.env.NEXT_REDIS_COMMAND_TIMEOUT) || 1000,
    connectTimeout: 5000,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
    tls:
      url.startsWith('rediss://') && process.env.REDIS_CA_CERT
        ? { ca: process.env.REDIS_CA_CERT }
        : undefined,
  })
  redis.on('error', (err) => {
    // Reconnect attempts fail repeatedly during an outage; log once a minute.
    if (Date.now() - lastErrorLog > 60_000) {
      lastErrorLog = Date.now()
      console.error(
        '[cloud-run] Redis unavailable, serving without the shared cache:',
        err.message
      )
    }
  })
  return redis
}

/** TTL for an entry: its expire time when known, else the default. */
export function ttlSeconds(expire: number | undefined) {
  return typeof expire === 'number' && Number.isFinite(expire) && expire > 0
    ? Math.ceil(expire)
    : DEFAULT_TTL_SECONDS
}

// JSON with Buffer and Map support, for incremental cache values.
export function serialize(value: unknown): string {
  return JSON.stringify(value, function (this: any, key, replaced) {
    const raw = this[key]
    if (Buffer.isBuffer(raw)) return { $b: raw.toString('base64') }
    if (raw instanceof Map) return { $m: [...raw.entries()] }
    return replaced
  })
}

export function deserialize<T>(text: string): T {
  return JSON.parse(text, (_key, value) => {
    if (value && typeof value === 'object') {
      if (typeof value.$b === 'string') return Buffer.from(value.$b, 'base64')
      if (Array.isArray(value.$m)) return new Map(value.$m)
    }
    return value
  })
}

interface TagState {
  stale?: number
  expired?: number
}

/**
 * Tag invalidations, mirroring Next.js' built-in semantics: a tag marked
 * `expired` makes entries older than it a miss; `stale` serves them while
 * regenerating in the background.
 *
 * All tags live in one Redis hash, and a version counter lets each instance
 * re-read it only after some instance changed it.
 */
const tagStates = new Map<string, TagState>()
let syncedVersion: string | null = null

export async function syncTags(redis: Redis, version?: string | null) {
  const current =
    version === undefined ? await redis.get(keys.tagsVersion) : version
  if (current === syncedVersion) return
  const all = await redis.hgetall(keys.tags)
  tagStates.clear()
  for (const [tag, state] of Object.entries(all)) {
    tagStates.set(tag, JSON.parse(state))
  }
  syncedVersion = current
}

export async function updateTags(
  redis: Redis | null,
  tags: string[],
  durations?: { expire?: number }
) {
  if (tags.length === 0) return
  const now = Date.now()
  if (redis) await syncTags(redis).catch(() => {})
  const updates: Record<string, string> = {}
  for (const tag of tags) {
    const state: TagState = { ...tagStates.get(tag) }
    if (durations) {
      state.stale = now
      if (durations.expire !== undefined) {
        state.expired = now + durations.expire * 1000
      }
    } else {
      state.expired = now
    }
    tagStates.set(tag, state)
    updates[tag] = JSON.stringify(state)
  }
  if (!redis) {
    // The invalidation still applies on this instance.
    console.error(
      '[cloud-run] Redis unavailable; tag invalidation not shared:',
      tags.join(', ')
    )
    return
  }
  await redis.multi().hset(keys.tags, updates).incr(keys.tagsVersion).exec()
}

export function areTagsExpired(tags: string[], timestamp: number) {
  const now = Date.now()
  return tags.some((tag) => {
    const expired = tagStates.get(tag)?.expired
    return typeof expired === 'number' && expired <= now && expired > timestamp
  })
}

export function areTagsStale(tags: string[], timestamp: number) {
  return tags.some((tag) => (tagStates.get(tag)?.stale ?? 0) > timestamp)
}

export function getTagsExpiration(tags: string[]) {
  return Math.max(0, ...tags.map((tag) => tagStates.get(tag)?.expired ?? 0))
}
