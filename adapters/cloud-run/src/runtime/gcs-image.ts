/**
 * Cache handler for optimized images (`/_next/image`) backed by Cloud
 * Storage, copied into the container as `.cloud-run-runtime/gcs-image.mjs`
 * and loaded by `./image.mjs` when `NEXT_CLOUD_RUN_IMAGE_CACHE_BUCKET` is set.
 *
 * It implements the `get`/`set` half of Next.js' `CacheHandler` that
 * `ImageOptimizerCache` calls for `IMAGE` entries, so Next.js still computes
 * `isStale` from `lastModified` and `value.revalidate` exactly as it does for
 * any custom image cache handler (`max(revalidate, minimumCacheTTL)`, which is
 * also how the default on-disk cache expires entries). Stale entries are
 * served with `x-nextjs-cache: STALE` and regenerated in the background.
 *
 * Entries live outside the instance (no RAM on Cloud Run's in-memory
 * filesystem, no Memorystore memory) and are shared by every instance and
 * service that runs this container image with the same bucket.
 *
 * Only two calls of the GCS JSON API are used, with plain `fetch`: a media
 * download and a media upload of one object per entry:
 *
 *   [4-byte big-endian metadata length][metadata JSON][image bytes]
 *
 * The object name is `<prefix><cache key>`. Next's image cache key is already
 * a hash of the source URL, width, quality, output format and Next's image
 * cache format version, so it is safe as an object name. It is deliberately
 * not scoped by buildId: optimized images don't depend on the build (Next's
 * own disk cache in `.next/cache/images` outlives builds too), statically
 * imported images have content-hashed URLs, and a changed file at the same
 * public URL is picked up when its entry goes stale, as with `next start`.
 *
 * Nothing here deletes objects: eviction relies on a lifecycle rule on the
 * bucket (e.g. delete objects older than 30 days). Entries are rewritten
 * whenever they are regenerated after going stale, which resets their age,
 * so images that are still requested survive while unused ones age out. Keep
 * the lifecycle age above `images.minimumCacheTTL` (and the upstream
 * `max-age` of remote images), or entries are deleted before they would go
 * stale and get re-optimized more often than needed.
 *
 * Every Cloud Storage call fails open: errors and timeouts
 * (`NEXT_CLOUD_RUN_GCS_TIMEOUT` ms, 2000 by default, covering auth and the
 * whole transfer) turn a `get` into a miss and a `set` into a no-op, logged
 * at most once a minute. After a timeout or network error Cloud Storage is
 * bypassed for a few seconds so a hanging bucket costs at most one timeout
 * per request rather than one for the read plus one for the write.
 */

const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token'
const DEFAULT_ENDPOINT = 'https://storage.googleapis.com'
const DEFAULT_PREFIX = 'images/'
const DEFAULT_TIMEOUT_MS = 2000
/** How long Cloud Storage is skipped after it timed out or was unreachable. */
const BYPASS_MS = 10_000
const LOG_INTERVAL_MS = 60_000
/** Refresh access tokens this long before they expire. */
const TOKEN_EXPIRY_MARGIN_MS = 60_000
const FORMAT_VERSION = 1

export interface GcsImageCacheOptions {
  bucket: string
  /** Object name prefix; a trailing `/` is added when missing. */
  prefix?: string
  /** JSON API endpoint. Requests are unauthenticated unless it's the default. */
  endpoint?: string
  timeoutMs?: number
}

interface EntryMetadata {
  v: number
  etag: string
  upstreamEtag: string
  extension: string
  revalidate?: number
  cacheControl?: { revalidate?: number | false; expire?: number }
  lastModified: number
}

interface ImageValue {
  kind: 'IMAGE'
  etag: string
  upstreamEtag: string
  buffer: Buffer
  extension: string
  revalidate?: number
}

/** The handler from the environment, or undefined when no bucket is set. */
export function gcsImageCacheFromEnv(
  env: NodeJS.ProcessEnv = process.env
): GcsImageCache | undefined {
  const bucket = env.NEXT_CLOUD_RUN_IMAGE_CACHE_BUCKET?.trim()
  if (!bucket) return
  const timeoutMs = Number(env.NEXT_CLOUD_RUN_GCS_TIMEOUT)
  return new GcsImageCache({
    bucket: bucket.replace(/^gs:\/\//, '').replace(/\/+$/, ''),
    prefix: env.NEXT_CLOUD_RUN_IMAGE_CACHE_PREFIX,
    endpoint: env.NEXT_CLOUD_RUN_GCS_ENDPOINT || undefined,
    timeoutMs: timeoutMs > 0 ? timeoutMs : undefined,
  })
}

export class GcsImageCache {
  readonly bucket: string
  readonly prefix: string
  readonly endpoint: string
  readonly timeoutMs: number
  private readonly authenticate: boolean
  private token: { value: string; expiresAt: number } | undefined
  private tokenPromise: Promise<string> | undefined
  private bypassUntil = 0
  private lastLog = 0
  private suppressedLogs = 0

  constructor({ bucket, prefix, endpoint, timeoutMs }: GcsImageCacheOptions) {
    this.bucket = bucket
    prefix = (prefix ?? DEFAULT_PREFIX).replace(/^\/+/, '')
    this.prefix = prefix && !prefix.endsWith('/') ? `${prefix}/` : prefix
    this.endpoint = (endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, '')
    this.authenticate = this.endpoint === DEFAULT_ENDPOINT
    this.timeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  get location() {
    return `gs://${this.bucket}/${this.prefix}`
  }

  objectName(key: string) {
    return this.prefix + key
  }

  async get(key: string, _ctx?: unknown) {
    const name = this.objectName(key)
    const object = await this.request('read', name, async (signal, headers) => {
      const res = await fetch(
        `${this.endpoint}/storage/v1/b/${encodeURIComponent(
          this.bucket
        )}/o/${encodeURIComponent(name)}?alt=media`,
        { headers, signal }
      )
      if (res.status === 404) {
        await res.body?.cancel()
        return null
      }
      await assertOk(res)
      return Buffer.from(await res.arrayBuffer())
    })
    if (!object) return null

    const entry = decode(object)
    if (!entry) {
      this.log(`ignoring malformed cache object ${name}`)
      return null
    }
    const { meta, buffer } = entry
    const value: ImageValue = {
      kind: 'IMAGE',
      etag: meta.etag,
      upstreamEtag: meta.upstreamEtag,
      buffer,
      extension: meta.extension,
      revalidate: meta.revalidate,
    }
    return {
      lastModified: meta.lastModified,
      value,
      cacheControl: meta.cacheControl,
    }
  }

  async set(
    key: string,
    data: ImageValue | { kind: string } | null,
    ctx?: { cacheControl?: EntryMetadata['cacheControl'] }
  ) {
    if (data?.kind !== 'IMAGE') return
    const image = data as ImageValue
    const name = this.objectName(key)
    const body = encode(
      {
        v: FORMAT_VERSION,
        etag: image.etag,
        upstreamEtag: image.upstreamEtag,
        extension: image.extension,
        revalidate: image.revalidate,
        cacheControl: ctx?.cacheControl,
        lastModified: Date.now(),
      },
      image.buffer
    )
    await this.request('write', name, async (signal, headers) => {
      const res = await fetch(
        `${this.endpoint}/upload/storage/v1/b/${encodeURIComponent(
          this.bucket
        )}/o?uploadType=media&name=${encodeURIComponent(name)}`,
        {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/octet-stream' },
          body,
          signal,
        }
      )
      await assertOk(res)
      await res.body?.cancel()
      return true
    })
  }

  // The rest of Next's CacheHandler interface; images have no tags.
  async revalidateTag() {}
  resetRequestCache() {}

  /**
   * Runs one Cloud Storage call under a single deadline that covers the
   * access token and the full transfer. Resolves to null instead of throwing.
   */
  private async request<T>(
    op: 'read' | 'write',
    name: string,
    call: (signal: AbortSignal, headers: Record<string, string>) => Promise<T>
  ): Promise<T | null> {
    if (Date.now() < this.bypassUntil) return null
    const signal = AbortSignal.timeout(this.timeoutMs)
    try {
      const headers: Record<string, string> = {}
      if (this.authenticate) {
        headers.authorization = `Bearer ${await abortable(
          this.accessToken(),
          signal
        )}`
      }
      return await call(signal, headers)
    } catch (err) {
      if (err instanceof HttpError) {
        if (err.status === 401) this.token = undefined
      } else {
        // Timed out or unreachable: don't make every request wait for it.
        this.bypassUntil = Date.now() + BYPASS_MS
      }
      this.log(`image cache ${op} failed for ${name}`, err)
      return null
    }
  }

  /** The service account's token from the metadata server, cached. */
  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value
    this.tokenPromise ??= (async () => {
      const res = await fetch(METADATA_TOKEN_URL, {
        headers: { 'metadata-flavor': 'Google' },
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      await assertOk(res)
      const { access_token, expires_in } = (await res.json()) as {
        access_token?: string
        expires_in?: number
      }
      if (!access_token) throw new Error('metadata server returned no token')
      this.token = {
        value: access_token,
        expiresAt:
          Date.now() + (expires_in ?? 0) * 1000 - TOKEN_EXPIRY_MARGIN_MS,
      }
      return access_token
    })().finally(() => {
      this.tokenPromise = undefined
    })
    return this.tokenPromise
  }

  private log(message: string, err?: unknown) {
    const now = Date.now()
    if (now - this.lastLog < LOG_INTERVAL_MS) {
      this.suppressedLogs++
      return
    }
    const suppressed = this.suppressedLogs
    this.lastLog = now
    this.suppressedLogs = 0
    console.error(
      `[cloud-run] ${message} (${this.location})${
        err ? `: ${err instanceof Error ? err.message : String(err)}` : ''
      }${suppressed ? ` [${suppressed} similar errors suppressed]` : ''}`
    )
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

async function assertOk(res: Response) {
  if (res.ok) return
  const body = await res.text().catch(() => '')
  throw new HttpError(
    res.status,
    `HTTP ${res.status}${body ? ` ${body.slice(0, 200).trim()}` : ''}`
  )
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort))
  })
}

export function encode(meta: EntryMetadata, image: Buffer) {
  const json = Buffer.from(JSON.stringify(meta))
  const header = Buffer.alloc(4)
  header.writeUInt32BE(json.length)
  return Buffer.concat([header, json, image])
}

export function decode(
  object: Buffer
): { meta: EntryMetadata; buffer: Buffer } | null {
  if (object.length < 4) return null
  const length = object.readUInt32BE(0)
  if (4 + length > object.length) return null
  try {
    const meta = JSON.parse(
      object.subarray(4, 4 + length).toString('utf8')
    ) as EntryMetadata
    if (
      meta?.v !== FORMAT_VERSION ||
      typeof meta.etag !== 'string' ||
      typeof meta.extension !== 'string' ||
      typeof meta.lastModified !== 'number'
    ) {
      return null
    }
    return { meta, buffer: object.subarray(4 + length) }
  } catch {
    return null
  }
}
