/**
 * Hybrid provider: a cloud primary mirrored by a local store.
 *
 * Writes go to both, reads prefer the local mirror (fast, always available) and
 * merge in anything the primary has that the mirror lacks. A cloud outage
 * therefore degrades to local memory instead of losing the session's context.
 *
 * @module dsh-scribe/providers/hybrid
 */

import { MemoryStorageProvider, filterAndPage, rankMemories } from './base.js'

/** Cloud primary + local mirror. */
export class HybridProvider extends MemoryStorageProvider {
  /**
   * @param id - configured provider name.
   * @param options - `{ config, logger, primary, mirror }`.
   */
  constructor(id, options) {
    super(id, options)
    this.primary = options.primary
    this.mirror = options.mirror
  }

  async add(memory) {
    const results = await Promise.allSettled([this.primary.add(memory), this.mirror.add(memory)])
    const primary = results[0]
    if (primary.status === 'rejected') {
      // The mirror write already succeeded; report it instead of failing the save.
      this.logger?.warn('hybrid primary write failed, kept local copy: %s', primary.reason?.message ?? primary.reason)
    }
  }

  async get(id) {
    return (await this.mirror.get(id)) ?? (await this.primary.get(id))
  }

  async delete(id) {
    const results = await Promise.allSettled([this.primary.delete(id), this.mirror.delete(id)])
    return results.some((result) => result.status === 'fulfilled' && result.value === true)
  }

  async list(options = {}) {
    const merged = await this.#merged()
    return filterAndPage(merged, options)
  }

  async bulkAdd(memories) {
    const [primary, mirror] = await Promise.allSettled([
      this.primary.bulkAdd(memories),
      this.mirror.bulkAdd(memories),
    ])
    const mirrorResult = mirror.status === 'fulfilled' ? mirror.value : { success: 0, failed: memories.length }
    if (primary.status === 'rejected') {
      this.logger?.warn('hybrid bulkAdd primary failed: %s', primary.reason?.message ?? primary.reason)
      return mirrorResult
    }
    // The primary owns identity when it answered; its ids are what a rollback
    // of this target has to delete.
    return primary.value.success > 0 ? primary.value : mirrorResult
  }

  async bulkExport() {
    return this.#merged()
  }

  async count() {
    return (await this.#merged()).length
  }

  async health() {
    const [primary, mirror] = await Promise.allSettled([this.primary.health(), this.mirror.health()])
    return (primary.status === 'fulfilled' && primary.value === true) || (mirror.status === 'fulfilled' && mirror.value === true)
  }

  async search(query, options = {}) {
    // Rank the merged set once so mirror-only and primary-only hits compare on
    // the same scale instead of being concatenated by source.
    return rankMemories(query, await this.#merged(), options)
  }

  async #merged() {
    const [primary, mirror] = await Promise.allSettled([this.primary.bulkExport(), this.mirror.bulkExport()])
    const byId = new Map()
    for (const result of [mirror, primary]) {
      if (result.status !== 'fulfilled') continue
      for (const memory of result.value) {
        if (!byId.has(memory.id)) byId.set(memory.id, memory)
      }
    }
    return [...byId.values()]
  }
}
