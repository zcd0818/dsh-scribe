/**
 * Embedding support for semantic retrieval.
 *
 * The plugin deliberately does not bundle a local model. It reuses whatever the
 * user already pointed the harness at: when `embedding.endpoint` names an
 * OpenAI-compatible `/v1/embeddings` route (the same provider the conversation
 * uses), vectors are generated there and cached on disk. When no route is
 * configured, every consumer falls back to lexical ranking and nothing leaves
 * the machine.
 *
 * @module dsh-scribe/embeddings
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Vector cache + endpoint client. */
export class Embedder {
  /**
   * @param options - `{ config, logger, cacheFile }`.
   */
  constructor({ config, logger, cacheFile }) {
    this.config = config
    this.logger = logger
    this.cacheFile = cacheFile
    this.cache = new Map()
    this.loading = undefined
    this.dirty = false
  }

  /** @returns whether an embeddings route is configured. */
  get enabled() {
    return typeof this.config?.endpoint === 'string' && this.config.endpoint.length > 0
  }

  /** @returns the model id used for embedding requests. */
  get model() {
    return this.config?.model ?? 'text-embedding-v3'
  }

  /**
   * Embed one text, returning `undefined` when no route is configured or the
   * call fails (callers then degrade to lexical ranking).
   * @param text - text to embed.
   * @param signal - optional cancellation.
   * @returns the vector or undefined.
   */
  async embed(text, signal) {
    if (!this.enabled) return undefined
    const key = cacheKey(this.model, text)
    await this.#loadCache()
    const cached = this.cache.get(key)
    if (cached) return cached

    const vectors = await this.embedMany([text], signal)
    return vectors[0]
  }

  /**
   * Embed several texts in one request.
   * @param texts - texts to embed.
   * @param signal - optional cancellation.
   * @returns vectors in input order (empty when unavailable).
   */
  async embedMany(texts, signal) {
    if (!this.enabled || texts.length === 0) return []
    await this.#loadCache()
    const keys = texts.map((text) => cacheKey(this.model, text))
    const missing = []
    for (let index = 0; index < keys.length; index += 1) {
      if (!this.cache.has(keys[index])) missing.push(index)
    }
    if (missing.length > 0) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), Number(this.config.timeoutMs) || 15_000)
      const forward = () => controller.abort()
      signal?.addEventListener('abort', forward, { once: true })
      try {
        const response = await fetch(resolveEmbeddingsUrl(this.config.endpoint), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
          },
          body: JSON.stringify({ model: this.model, input: missing.map((index) => texts[index]) }),
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`)
        const payload = await response.json()
        const data = Array.isArray(payload?.data) ? payload.data : []
        for (let position = 0; position < missing.length; position += 1) {
          const vector = data[position]?.embedding
          if (Array.isArray(vector)) {
            this.cache.set(keys[missing[position]], vector)
            this.dirty = true
          }
        }
        if (this.dirty) await this.#persist()
      } catch (error) {
        this.logger?.warn('embedding request failed, falling back to lexical ranking: %s', error?.message ?? error)
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', forward)
      }
    }
    return keys.map((key) => this.cache.get(key))
  }

  async #loadCache() {
    if (this.cacheLoaded) return
    this.loading ??= (async () => {
      try {
        const text = await readFile(this.cacheFile, 'utf8')
        const parsed = JSON.parse(text)
        for (const [key, vector] of Object.entries(parsed?.vectors ?? {})) {
          if (Array.isArray(vector)) this.cache.set(key, vector)
        }
      } catch {
        // A missing or unreadable cache is simply an empty cache.
      }
      this.cacheLoaded = true
    })()
    await this.loading
  }

  async #persist() {
    const vectors = Object.fromEntries(this.cache)
    const temporary = `${this.cacheFile}.${process.pid}.tmp`
    try {
      await mkdir(dirname(this.cacheFile), { recursive: true })
      await writeFile(temporary, JSON.stringify({ model: this.model, vectors }), 'utf8')
      await rename(temporary, this.cacheFile)
      this.dirty = false
    } catch (error) {
      this.logger?.warn('embedding cache write failed: %s', error?.message ?? error)
    }
  }
}

function cacheKey(model, text) {
  return createHash('sha256').update(`${model}\u0000${text}`).digest('hex').slice(0, 32)
}

function resolveEmbeddingsUrl(endpoint) {
  const base = String(endpoint).replace(/\/+$/, '')
  if (/\/embeddings$/.test(base)) return base
  if (/\/v\d+$/.test(base)) return `${base}/embeddings`
  return `${base}/v1/embeddings`
}

/**
 * Build an embedder rooted at the plugin's data directory.
 * @param config - resolved plugin configuration.
 * @param logger - plugin logger.
 * @returns the embedder.
 */
export function createEmbedder(config, logger) {
  return new Embedder({
    config: config.embedding,
    logger,
    cacheFile: join(config.dataDir, 'embeddings.json'),
  })
}
