/**
 * Local storage provider: one JSONL file per configured path, plus an optional
 * ChromaDB adapter for users who already run a Chroma server.
 *
 * The default `file` engine is deliberately dependency-free: it needs no server,
 * no build step and no network, which is what "data stays on this machine"
 * has to mean to be true.
 *
 * @module dsh-scribe/providers/local
 */

import { join } from 'node:path'
import { JsonlStore } from '../store.js'
import { filterAndPage, MemoryStorageProvider } from './base.js'

/** A provider backed by `JsonlStore` (or ChromaDB when configured). */
export class LocalProvider extends MemoryStorageProvider {
  /**
   * @param id - configured provider name.
   * @param options - `{ config, logger }`.
   */
  constructor(id, options) {
    super(id, options)
    this.engine = this.config?.engine ?? 'file'
    this.delegate = undefined
  }

  /** @returns the on-disk store, created on first use. */
  get store() {
    this.delegate ??= new JsonlStore(join(this.config.path, 'memories.jsonl'))
    return this.delegate
  }

  async add(memory) {
    if (this.engine === 'chromadb') return this.chroma().add(memory)
    await this.store.put(memory)
    return undefined
  }

  async get(id) {
    if (this.engine === 'chromadb') return this.chroma().get(id)
    return (await this.store.get(id)) ?? null
  }

  async delete(id) {
    if (this.engine === 'chromadb') return this.chroma().delete(id)
    return this.store.delete(id)
  }

  async list(options = {}) {
    if (this.engine === 'chromadb') return this.chroma().list(options)
    return filterAndPage(await this.store.all(), options)
  }

  async bulkAdd(memories) {
    if (this.engine === 'chromadb') return this.chroma().bulkAdd(memories)
    await this.store.putMany(memories)
    return { success: memories.length, failed: 0, ids: memories.map((memory) => memory.id) }
  }

  async bulkExport() {
    if (this.engine === 'chromadb') return this.chroma().bulkExport()
    return this.store.all()
  }

  async count() {
    if (this.engine === 'chromadb') return this.chroma().count()
    return (await this.store.all()).length
  }

  async health() {
    if (this.engine === 'chromadb') return this.chroma().health()
    try {
      await this.store.load()
      return true
    } catch (error) {
      this.logger?.warn('local store health check failed: %s', error?.message ?? error)
      return false
    }
  }

  /** Replace the whole collection (used by an import that owns the target). */
  async replaceAll(memories) {
    if (this.engine === 'chromadb') throw new Error('replaceAll is not supported by the chromadb engine')
    await this.store.replaceAll(memories)
  }

  /** Remove every record (rollback of a first import). */
  async clear() {
    if (this.engine === 'chromadb') throw new Error('clear is not supported by the chromadb engine')
    await this.store.destroy()
  }

  /** Disk footprint reported by `memory_status`. */
  async size() {
    if (this.engine === 'chromadb') return 0
    return this.store.size()
  }

  /**
   * Lazily construct the ChromaDB adapter. It is an optional dependency, so a
   * missing package produces an actionable error instead of a load failure.
   * @returns the Chroma adapter.
   */
  chroma() {
    if (this.chromaAdapter === undefined) {
      // Dynamic import keeps `chromadb` optional: the file engine never needs it.
      this.chromaAdapter = import('./chroma.js').then(
        ({ ChromaProvider }) => new ChromaProvider(this.id, { config: this.config, logger: this.logger }),
      )
    }
    return {
      add: async (memory) => (await this.chromaAdapter).add(memory),
      get: async (id) => (await this.chromaAdapter).get(id),
      delete: async (id) => (await this.chromaAdapter).delete(id),
      list: async (options) => (await this.chromaAdapter).list(options),
      bulkAdd: async (memories) => (await this.chromaAdapter).bulkAdd(memories),
      bulkExport: async () => (await this.chromaAdapter).bulkExport(),
      count: async () => (await this.chromaAdapter).count(),
      health: async () => (await this.chromaAdapter).health(),
    }
  }
}
