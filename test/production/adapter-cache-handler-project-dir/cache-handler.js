// Records that Next.js loaded this handler, then behaves as an empty cache.
module.exports = class CacheHandler {
  constructor() {
    globalThis.__testCacheHandlerLoaded = true
  }

  async get() {
    return null
  }

  async set() {}

  async revalidateTag() {}

  resetRequestCache() {}
}
