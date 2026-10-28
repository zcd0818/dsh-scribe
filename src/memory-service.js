/**
 * `MemoryService` — the one object the session layer, the tools, and the
 * migration flow share.
 *
 * It owns what a backend should not have to know: normalization,
 * deduplication, embedding, retention, model reranking, and prompt formatting.
 * Storage itself is delegated to a `StorageProvider`.
 *
 * @module dsh-scribe/memory-service
 */

import { createProvider } from './providers/factory.js'
import { createEmbedder } from './embeddings.js'
import { activeProvider } from './config.js'
import {
  MEMORY_SCHEMA_VERSION,
  byNewest,
  contentHash,
  getPath,
  isoDate,
  newMemoryId,
  normalizeContent,
  oneLine,
  truncate,
} from './util.js'

/** Facade over one active provider plus embedding and ranking policy. */
export class MemoryService {
  /**
   * @param options - `{ ctx, config, logger }`.
   */
  constructor({ ctx, config, logger }) {
    this.ctx = ctx
    this.config = config
    this.logger = logger
    this.embedder = createEmbedder(config, logger)
    this.providers = new Map()
    this.hashes = new Map()
    this.lastCreatedAt = 0
    this.readyPromise = undefined
  }

  /** @returns the provider that owns new memories. */
  get provider() {
    return this.providerFor(this.config.defaultProvider)
  }

  /**
   * Resolve (and cache) one configured provider.
   * @param id - configured provider name.
   * @returns the provider instance.
   */
  providerFor(id) {
    let provider = this.providers.get(id)
    if (provider === undefined) {
      provider = createProvider(id, this.config, this.logger)
      this.providers.set(id, provider)
    }
    return provider
  }

  /** @returns the active provider entry from configuration. */
  get providerConfig() {
    return activeProvider(this.config)
  }

  /** Load the active provider once; safe to call from every entry point. */
  async ready() {
    this.readyPromise ??= this.#hydrate().catch((error) => {
      this.readyPromise = undefined
      throw error
    })
    return this.readyPromise
  }

  async #hydrate() {
    const all = await this.provider.bulkExport()
    this.hashes = new Map()
    for (const memory of all) {
      const hash = memory.hash ?? contentHash(memory.content)
      if (!this.hashes.has(hash)) this.hashes.set(hash, memory.id)
      const createdAt = Number(memory.createdAt ?? 0)
      if (createdAt > this.lastCreatedAt) this.lastCreatedAt = createdAt
    }
  }

  /**
   * Store one memory.
   * @param input - `{ content, source, tags, sessionId, metadata }`.
   * @returns `{ memory, duplicate }`.
   */
  async add(input) {
    await this.ready()
    const content = normalizeContent(input.content)
    if (content.length === 0) throw new Error('memory content is empty after normalization')

    const hash = contentHash(content)
    const existing = this.hashes.get(hash)
    if (existing !== undefined) {
      return { duplicate: true, memory: { id: existing, content, hash } }
    }

    const embedding = await this.#embedQuietly(content)
    // Wall-clock timestamps collide when several memories are written in one
    // millisecond (a migration, a burst of tool calls); a monotonic stamp keeps
    // "newest first" a total order instead of a stable-sort accident.
    const now = Date.now()
    const createdAt = now > this.lastCreatedAt ? now : this.lastCreatedAt + 1
    this.lastCreatedAt = createdAt
    const memory = {
      id: newMemoryId(),
      content: truncate(content, 4000),
      createdAt,
      source: input.source ?? 'user-explicit',
      tags: normalizeTags(input.tags),
      ...(input.sessionId === undefined ? {} : { sessionId: String(input.sessionId) }),
      metadata: { ...(input.metadata ?? {}) },
      hash,
      schemaVersion: MEMORY_SCHEMA_VERSION,
      ...(embedding === undefined ? {} : { embedding }),
    }

    await this.provider.add(memory)
    this.hashes.set(hash, memory.id)
    await this.#prune()
    return { duplicate: false, memory }
  }

  /**
   * Retrieve the memories most relevant to a query.
   *
   * Order: cheap candidate ranking first, then an optional single model call to
   * rerank the candidate head. A failed or slow model call returns the
   * candidate order, so retrieval never blocks a session on the network.
   *
   * @param query - the query text.
   * @param options - `{ limit, minScore, mode, agent, rerank }`.
   * @returns ranked memories.
   */
  async search(query, options = {}) {
    await this.ready()
    const limit = Math.max(1, Number(options.limit) || this.config.injectLimit)
    const mode = options.mode ?? this.config.retrieval.mode
    const minScore = Number.isFinite(options.minScore) ? options.minScore : this.config.retrieval.minScore
    const queryVector = query.trim().length === 0 ? undefined : await this.#embedQuietly(query)

    const candidates = await this.provider.search(query, {
      mode,
      limit: Math.max(limit, this.config.retrieval.candidateLimit),
      minScore: mode === 'recent' ? 0 : Math.min(minScore, 0.05),
      queryVector,
    })

    const shouldRerank =
      options.rerank !== false &&
      this.config.retrieval.llmRerank &&
      candidates.length > limit &&
      typeof query === 'string' &&
      query.trim().length > 0 &&
      options.agent !== undefined

    const ranked = shouldRerank
      ? await this.#rerank(options.agent, query, candidates, limit)
      : candidates.slice(0, limit)

    return ranked.filter((memory) => memory !== undefined).slice(0, limit)
  }

  /**
   * Most recent memories, used for session-start injection where no query exists yet.
   * @param options - `{ limit }`.
   * @returns newest memories.
   */
  async recent(options = {}) {
    await this.ready()
    const limit = Math.max(1, Number(options.limit) || this.config.injectLimit)
    return byNewest(await this.provider.list({ limit })).slice(0, limit)
  }

  /**
   * Read one memory.
   * @param id - memory id.
   * @returns the memory or null.
   */
  async get(id) {
    await this.ready()
    return this.provider.get(id)
  }

  /**
   * Delete one memory.
   * @param id - memory id.
   * @returns whether it existed.
   */
  async delete(id) {
    await this.ready()
    const memory = await this.provider.get(id)
    const removed = await this.provider.delete(id)
    if (removed && memory?.hash) this.hashes.delete(memory.hash)
    return removed
  }

  /**
   * List memories for display.
   * @param options - `{ limit, offset, tags, since }`.
   * @returns memories newest first.
   */
  async list(options = {}) {
    await this.ready()
    return this.provider.list(options)
  }

  /** @returns the number of stored memories. */
  async count() {
    await this.ready()
    return this.provider.count()
  }

  /** @returns whether the active backend answers. */
  async health() {
    try {
      return await this.provider.health()
    } catch (error) {
      this.logger.warn('provider health check threw: %s', error?.message ?? error)
      return false
    }
  }

  /**
   * Snapshot used by `scribe_memory_status` and the `/scribe status` command.
   * @returns counts, size, date range, and backend health.
   */
  async status() {
    await this.ready()
    const all = await this.provider.bulkExport()
    const dates = all.map((memory) => Number(memory.createdAt ?? 0)).filter((value) => value > 0)
    return {
      provider: this.config.defaultProvider,
      type: this.provider.kind,
      count: all.length,
      health: await this.health(),
      embedding: this.embedder.enabled ? 'enabled' : 'lexical fallback',
      autoInject: this.config.autoInject,
      oldest: dates.length > 0 ? isoDate(Math.min(...dates)) : undefined,
      newest: dates.length > 0 ? isoDate(Math.max(...dates)) : undefined,
    }
  }

  /**
   * Render memories as the text of the memory prompt section.
   *
   * One line per memory, date-first, capped by `injectMaxChars`; the section is
   * dropped entirely when there is nothing to say, so a fresh install does not
   * pay for an empty heading.
   *
   * @param memories - memories to render.
   * @param options - `{ maxChars, total }`.
   * @returns the section text, or an empty string.
   */
  formatForPrompt(memories, options = {}) {
    if (!Array.isArray(memories) || memories.length === 0) return ''
    const maxChars = Number(options.maxChars) || this.config.injectMaxChars
    const lines = []
    for (const memory of memories) {
      const tags = memory.tags?.length ? ` (${memory.tags.slice(0, 2).join(', ')})` : ''
      lines.push(`- [${isoDate(memory.createdAt)}]${tags} ${oneLine(memory.content, 160)}`)
    }
    const total = Number(options.total) || memories.length
    const more = total > memories.length ? `\n（共 ${total} 条；用 scribe_memory_search 检索更多）` : ''
    const body = truncate(lines.join('\n'), Math.max(80, maxChars - more.length))
    return `## 长期记忆（来自之前与你协作的会话）\n\n${body}${more}`
  }

  /** Remove duplicates and enforce the retention cap. */
  async #prune() {
    const max = Number(this.config.retention.maxMemories) || 0
    const ttlDays = Number(this.config.retention.ttlDays) || 0
    if (max <= 0 && ttlDays <= 0) return
    const all = await this.provider.bulkExport()
    const now = Date.now()
    const expired =
      ttlDays > 0 ? all.filter((memory) => now - Number(memory.createdAt ?? 0) > ttlDays * 86_400_000) : []
    const survivors = all.filter((memory) => !expired.includes(memory))
    const overflow = max > 0 ? byNewest(survivors).slice(max) : []
    const remove = [...expired, ...overflow]
    if (remove.length === 0) return
    // `bulkExport` order is provider-defined, so delete by id rather than assuming paging.
    for (const memory of remove) {
      await this.provider.delete(memory.id)
      if (memory.hash) this.hashes.delete(memory.hash)
    }
    this.logger.debug('pruned %d memories (cap=%d, ttlDays=%d)', remove.length, max, ttlDays)
  }

  async #embedQuietly(text) {
    if (!this.embedder.enabled) return undefined
    try {
      return await this.embedder.embed(text)
    } catch (error) {
      this.logger.warn('embedding failed: %s', error?.message ?? error)
      return undefined
    }
  }

  /**
   * Ask the session's own model to reorder the candidate head.
   *
   * One short prompt, a JSON array answer, and a hard timeout. Any deviation
   * (no model route, a timeout, unparseable output) returns the unmodified
   * candidate order, so this can only improve relevance — never block a turn.
   *
   * @param agent - the requesting agent (supplies the routed model).
   * @param query - the query text.
   * @param candidates - ranked candidates.
   * @param limit - how many to keep.
   * @returns the reranked prefix, or the original candidates.
   */
  async #rerank(agent, query, candidates, limit) {
    const llm = this.ctx.get('llm')
    if (llm === undefined || typeof llm.stream !== 'function') return candidates.slice(0, limit)
    const route = resolveRoute(agent, this.ctx)
    if (route === undefined) return candidates.slice(0, limit)

    const listing = candidates
      .slice(0, this.config.retrieval.candidateLimit)
      .map((memory, index) => `${index}. ${oneLine(memory.content, 120)}`)
      .join('\n')
    const prompt = [
      '你是记忆检索的排序器。根据查询，从候选记忆里挑出最相关的条目，按相关度从高到低返回它们的编号。',
      '只输出一个 JSON 数组，例如 [3,0,7]，不要解释。若没有相关条目，输出 []。',
      '',
      `查询：${query}`,
      '',
      '候选：',
      listing,
    ].join('\n')

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.config.retrieval.llmTimeoutMs)
    try {
      let text = ''
      const options = {
        provider: route.provider,
        model: route.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        maxTokens: 128,
        temperature: 0,
        signal: controller.signal,
        ...(agent?.session?.id ? { sessionId: agent.session.id } : {}),
      }
      for await (const chunk of llm.stream(options)) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
        if (chunk?.type === 'finish') break
      }
      const order = parseIndexOrder(text)
      if (order.length === 0) return candidates.slice(0, limit)
      const picked = []
      for (const index of order) {
        const memory = candidates[index]
        if (memory !== undefined && !picked.includes(memory)) picked.push(memory)
        if (picked.length >= limit) break
      }
      return picked.length > 0 ? picked : candidates.slice(0, limit)
    } catch (error) {
      this.logger.debug('model rerank skipped: %s', error?.message ?? error)
      return candidates.slice(0, limit)
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Build the memory service for one plugin mount.
 * @param options - `{ ctx, config, logger }`.
 * @returns the service.
 */
export function createMemoryService(options) {
  return new MemoryService(options)
}

/**
 * Resolve the provider/model the session's requests actually use.
 * @param agent - live agent, when available.
 * @param ctx - plugin context.
 * @returns `{ provider, model }` or undefined.
 */
export function resolveRoute(agent, ctx) {
  const header = safeCall(() => agent?.session?.requestHeader())
  const configured = getPath(header, ['config'])
  if (typeof configured?.provider === 'string' && typeof configured?.model === 'string') {
    return { provider: configured.provider, model: configured.model }
  }
  const options = agent?.options
  if (typeof options?.provider === 'string' && typeof options?.model === 'string' && options.provider && options.model) {
    return { provider: options.provider, model: options.model }
  }
  const selection = safeCall(() => ctx.get('agentDefaultModel')?.currentSelection())
  const provider = selection?.provider ?? selection?.providerId
  const model = selection?.model ?? selection?.modelId
  if (typeof provider === 'string' && typeof model === 'string') return { provider, model }
  return undefined
}

function safeCall(fn) {
  try {
    return fn()
  } catch {
    return undefined
  }
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return []
  return [...new Set(tags.filter((tag) => typeof tag === 'string' && tag.trim().length > 0).map((tag) => tag.trim()))]
}

function parseIndexOrder(text) {
  const match = /\[[\s\S]*?\]/.exec(String(text ?? ''))
  if (match === null) return []
  try {
    const parsed = JSON.parse(match[0])
    if (!Array.isArray(parsed)) return []
    return parsed.filter((value) => Number.isInteger(value) && value >= 0)
  } catch {
    return []
  }
}
