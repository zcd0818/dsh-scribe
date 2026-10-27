/**
 * The storage-provider contract every backend implements.
 *
 * A provider owns durability only. Embedding, deduplication, reranking and
 * formatting belong to `MemoryService`, so a backend never has to know how the
 * harness scores or renders a memory.
 *
 * @module dsh-scribe/providers/base
 */

import { cosineSimilarity, lexicalScore, recencyWeight, truncate } from '../util.js'

/**
 * Rank a candidate set with the configured retrieval mode.
 *
 * Pure and synchronous: callers pass the query vector (when one exists) and
 * the provider only decides ordering. This keeps remote and local providers on
 * one scoring rule, so switching backends does not silently change results.
 *
 * @param query - the query text.
 * @param memories - memory records to rank.
 * @param options - `{ mode, limit, minScore, queryVector, now }`.
 * @returns the ranked, filtered, truncated list.
 */
export function rankMemories(query, memories, options = {}) {
  const mode = options.mode ?? 'hybrid'
  const limit = Math.max(1, Number(options.limit) || 5)
  const minScore = Number.isFinite(options.minScore) ? Number(options.minScore) : 0.18
  const now = Number(options.now) || Date.now()
  const queryVector = Array.isArray(options.queryVector) ? options.queryVector : undefined

  const scored = memories.map((memory) => {
    const lexical = mode === 'recent' ? 0 : lexicalScore(query, memory)
    const vector = queryVector && Array.isArray(memory.embedding) ? cosineSimilarity(queryVector, memory.embedding) : 0
    const recency = recencyWeight(memory.createdAt, now)
    let score
    switch (mode) {
      case 'recent':
        score = recency
        break
      case 'lexical':
        score = lexical
        break
      case 'vector':
        score = vector
        break
      default:
        score = queryVector ? 0.55 * lexical + 0.45 * vector : lexical
        score += 0.05 * recency
        break
    }
    return { memory, score }
  })

  return scored
    .filter((entry) => (mode === 'recent' ? true : entry.score >= minScore))
    .sort((a, b) => b.score - a.score || Number(b.memory.createdAt ?? 0) - Number(a.memory.createdAt ?? 0))
    .slice(0, limit)
    .map((entry) => ({ ...entry.memory, score: Number(entry.score.toFixed(4)) }))
}

/**
 * Base class documenting the provider contract. Subclasses may override every
 * method; the defaults implement the `list`-and-rank pattern that a simple
 * durable store needs.
 */
export class MemoryStorageProvider {
  /**
   * @param id - the configured provider name (the key in `config.providers`).
   * @param options - `{ config, logger }`.
   */
  constructor(id, { config, logger } = {}) {
    this.id = id
    this.config = config
    this.logger = logger
  }

  /** @returns the provider type reported by `memory_status`. */
  get kind() {
    return this.config?.type ?? 'unknown'
  }

  /* eslint-disable no-unused-vars */
  /**
   * Persist one memory.
   * @param memory - the memory record.
   */
  async add(memory) {
    throw new Error(`${this.id}: add() is not implemented`)
  }

  /**
   * Read one memory.
   * @param id - memory id.
   * @returns the memory or null.
   */
  async get(id) {
    throw new Error(`${this.id}: get() is not implemented`)
  }

  /**
   * Delete one memory.
   * @param id - memory id.
   * @returns whether something was deleted.
   */
  async delete(id) {
    throw new Error(`${this.id}: delete() is not implemented`)
  }

  /**
   * List stored memories.
   * @param options - `{ limit, offset, tags, since }`.
   * @returns matching memories, newest first.
   */
  async list(options) {
    throw new Error(`${this.id}: list() is not implemented`)
  }

  /**
   * Persist many memories, best effort.
   *
   * `ids` names the target-side identity of each successfully written record,
   * in input order. A migration journals these so a rollback can delete exactly
   * what it added, even when the target mints its own ids (Bailian does).
   *
   * @param memories - records to write.
   * @returns `{ success, failed, ids? }`.
   */
  async bulkAdd(memories) {
    throw new Error(`${this.id}: bulkAdd() is not implemented`)
  }

  /**
   * Read every memory for migration.
   * @returns all memories.
   */
  async bulkExport() {
    throw new Error(`${this.id}: bulkExport() is not implemented`)
  }

  /** @returns the number of stored memories. */
  async count() {
    throw new Error(`${this.id}: count() is not implemented`)
  }

  /** @returns whether the backend answered a cheap liveness probe. */
  async health() {
    throw new Error(`${this.id}: health() is not implemented`)
  }

  /**
   * Rank memories against a query.
   * @param query - query text.
   * @param options - `{ limit, minScore, mode, queryVector }`.
   * @returns ranked memories.
   */
  async search(query, options = {}) {
    const all = await this.bulkExport()
    return rankMemories(query, all, options)
  }
  /* eslint-enable no-unused-vars */
}

/**
 * Apply the shared list filters (`tags`, `since`) and paging to an array.
 * @param memories - candidate memories.
 * @param options - `{ limit, offset, tags, since }`.
 * @returns the filtered page, newest first.
 */
export function filterAndPage(memories, options = {}) {
  const tags = Array.isArray(options.tags) ? options.tags.filter((tag) => typeof tag === 'string') : []
  const since = Number(options.since) || 0
  const offset = Math.max(0, Number(options.offset) || 0)
  const limit = Number.isFinite(options.limit) ? Math.max(0, Number(options.limit)) : memories.length
  return memories
    .filter((memory) => (since > 0 ? Number(memory.createdAt ?? 0) >= since : true))
    .filter((memory) => (tags.length > 0 ? tags.every((tag) => (memory.tags ?? []).includes(tag)) : true))
    .sort((a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0))
    .slice(offset, offset + limit)
}

/**
 * Build a compact, human-readable preview for listing and tool output.
 * @param memory - memory record.
 * @param max - maximum characters.
 * @returns a single-line preview.
 */
export function preview(memory, max = 120) {
  return truncate(String(memory?.content ?? '').replace(/\s+/g, ' ').trim(), max)
}
