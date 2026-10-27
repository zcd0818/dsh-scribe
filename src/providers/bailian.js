/**
 * Bailian (Alibaba Cloud Model Studio) long-term memory provider.
 *
 * Wired against the documented HTTP contract of the memory library API
 * (`/api/v2/apps/memory/...`):
 *
 * - `POST /add`                    — write one memory (`custom_content` stores it verbatim)
 * - `POST /memory_nodes/search`    — semantic recall
 * - `GET  /memory_nodes`           — paged list (+ `total`)
 * - `DELETE /memory_nodes/{id}`    — delete one node
 *
 * Service address is `https://{WorkspaceId}.{region}.maas.aliyuncs.com/api/v2/apps/memory`,
 * or any explicit `endpoint` for a compatible service. The API requires a
 * `user_id` (its isolation key) and an API key from the same business space.
 *
 * Note: this API extracts facts from conversations. This provider always writes
 * with `custom_content`, because a memory here is already a finished summary —
 * re-extracting it would blur what the user decided to remember.
 *
 * @module dsh-scribe/providers/bailian
 */

import { MemoryStorageProvider, filterAndPage } from './base.js'

/** Default memory-library base path on the business-space host. */
const MEMORY_PATH = '/api/v2/apps/memory'

/** Bailian memory storage. */
export class BailianProvider extends MemoryStorageProvider {
  /**
   * @param id - configured provider name.
   * @param options - `{ config, logger }`.
   */
  constructor(id, options) {
    super(id, options)
    const config = this.config ?? {}
    this.apiKey = config.apiKey ?? ''
    this.userId = config.userId ?? 'dsh'
    this.libraryId = config.memoryLibraryId ?? ''
    this.projectId = config.projectId ?? ''
    this.planVersion = config.planVersion ?? 'pro'
    this.minScore = Number.isFinite(config.minScore) ? Number(config.minScore) : 0.3
    this.pageSize = clampInt(config.pageSize, 1, 100, 50)
    this.maxPages = clampInt(config.maxPages, 1, 200, 20)
    this.timeoutMs = Number(config.timeoutMs) || 15_000
    this.endpoint = resolveEndpoint(config)

    if (this.apiKey.length === 0) {
      throw new Error(
        `provider "${id}" is a Bailian provider without an apiKey: set providers.${id}.apiKey to a literal, "$ENV_NAME" or "env:ENV_NAME"`,
      )
    }
    if (this.endpoint === undefined) {
      throw new Error(
        `provider "${id}" needs providers.${id}.workspaceId (e.g. "llm-xxxxxxxx") or an explicit providers.${id}.endpoint`,
      )
    }
  }

  async #request(path, { method = 'POST', body, query } = {}) {
    const url = new URL(`${this.endpoint}${path}`)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      })
      const text = await response.text()
      if (!response.ok) {
        // The service answers failures with `{code, message, request_id}`.
        throw new Error(`HTTP ${response.status} ${text.slice(0, 300)}`)
      }
      if (text.trim().length === 0) return {}
      try {
        return JSON.parse(text)
      } catch {
        throw new Error(`response is not JSON: ${text.slice(0, 200)}`)
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /** Request extras shared by every call that scopes to one library/project. */
  get #scope() {
    return {
      ...(this.libraryId ? { memory_library_id: this.libraryId } : {}),
      ...(this.projectId ? { project_id: this.projectId } : {}),
    }
  }

  async add(memory) {
    const payload = await this.#request('/add', {
      body: {
        user_id: this.userId,
        custom_content: memory.content,
        meta_data: {
          dsh_id: memory.id,
          createdAt: memory.createdAt,
          source: memory.source,
          tags: memory.tags ?? [],
          ...(memory.sessionId ? { sessionId: memory.sessionId } : {}),
          ...(memory.metadata ?? {}),
        },
        ...this.#scope,
      },
    })
    const node = Array.isArray(payload?.memory_nodes) ? payload.memory_nodes[0] : undefined
    return node?.memory_node_id === undefined ? memory : { ...memory, remoteId: node.memory_node_id }
  }

  async get(id) {
    const all = await this.bulkExport()
    return all.find((memory) => memory.id === id) ?? null
  }

  async delete(id) {
    await this.#request(`/memory_nodes/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      query: this.libraryId ? { memory_library_id: this.libraryId } : {},
    })
    return true
  }

  async list(options = {}) {
    return filterAndPage(await this.bulkExport(), options)
  }

  async bulkAdd(memories) {
    let success = 0
    let failed = 0
    const ids = []
    for (const memory of memories) {
      try {
        const stored = await this.add(memory)
        // The target's own node id is what a rollback has to delete.
        ids.push(stored.remoteId ?? memory.id)
        success += 1
      } catch (error) {
        failed += 1
        this.logger?.warn('bailian add failed for %s: %s', memory.id, error?.message ?? error)
      }
    }
    return { success, failed, ids }
  }

  async bulkExport() {
    const collected = []
    for (let page = 1; page <= this.maxPages; page += 1) {
      const payload = await this.#request('/memory_nodes', {
        method: 'GET',
        query: { user_id: this.userId, page_size: this.pageSize, page_num: page, ...this.#scope },
      })
      const nodes = Array.isArray(payload?.memory_nodes) ? payload.memory_nodes : []
      collected.push(...nodes.map(fromNode))
      const total = Number(payload?.total)
      if (nodes.length === 0) break
      if (Number.isFinite(total) && collected.length >= total) break
      if (nodes.length < this.pageSize) break
    }
    return collected
  }

  async count() {
    const payload = await this.#request('/memory_nodes', {
      method: 'GET',
      query: { user_id: this.userId, page_size: 1, page_num: 1, ...this.#scope },
    })
    const total = Number(payload?.total)
    return Number.isFinite(total) ? total : (payload?.memory_nodes?.length ?? 0)
  }

  async health() {
    try {
      await this.count()
      return true
    } catch (error) {
      this.logger?.warn('bailian health check failed: %s', error?.message ?? error)
      return false
    }
  }

  async search(query, options = {}) {
    const text = String(query ?? '').trim()
    const limit = Math.max(1, Number(options.limit) || 5)
    if (text.length === 0) {
      // No query means "session start": the service wants recent memories.
      const all = await this.bulkExport()
      return filterAndPage(all, { limit })
    }
    const payload = await this.#request('/memory_nodes/search', {
      body: {
        user_id: this.userId,
        messages: [{ role: 'user', content: text }],
        top_k: limit,
        min_score: Number.isFinite(options.minScore) ? Number(options.minScore) : this.minScore,
        plan_version: this.planVersion,
        ...this.#scope,
      },
    })
    const nodes = Array.isArray(payload?.memory_nodes) ? payload.memory_nodes : []
    return nodes.map(fromNode)
  }
}

/**
 * Build the memory-library base URL from config.
 * @param config - the provider entry.
 * @returns the base URL without a trailing slash, or undefined when unconfigured.
 */
export function resolveEndpoint(config) {
  if (typeof config?.endpoint === 'string' && config.endpoint.trim().length > 0) {
    return config.endpoint.trim().replace(/\/+$/, '')
  }
  const workspaceId = typeof config?.workspaceId === 'string' ? config.workspaceId.trim() : ''
  if (workspaceId.length === 0) return undefined
  const region = config?.region ?? 'cn-beijing'
  return `https://${workspaceId}.${region}.maas.aliyuncs.com${MEMORY_PATH}`
}

/**
 * Project one API memory node onto the plugin's memory shape.
 * @param node - `memory_nodes[]` entry.
 * @returns a memory record.
 */
export function fromNode(node) {
  const metadata = isRecord(node?.meta_data) ? node.meta_data : {}
  const seconds = Number(node?.created_at)
  return {
    id: String(node?.memory_node_id ?? metadata.dsh_id ?? ''),
    content: String(node?.content ?? ''),
    createdAt: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : Date.now(),
    source: typeof metadata.source === 'string' ? metadata.source : 'import',
    ...(typeof metadata.sessionId === 'string' && metadata.sessionId ? { sessionId: metadata.sessionId } : {}),
    tags: Array.isArray(metadata.tags) ? metadata.tags.map(String) : [],
    metadata,
    ...(Number.isFinite(Number(node?.score)) ? { score: Number(node.score) } : {}),
    schemaVersion: 1,
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clampInt(value, min, max, fallback) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.floor(parsed)))
}
