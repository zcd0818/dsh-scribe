/**
 * Optional ChromaDB backend.
 *
 * This adapter is **experimental and optional**: it is only reached when a
 * provider sets `engine: "chromadb"`, and it requires the `chromadb` package
 * plus a reachable Chroma server. The default local engine is the dependency-free
 * file store, so a missing package can never break the plugin.
 *
 * Embeddings are supplied by `MemoryService`, never computed here, so the
 * collection is created without an embedding function.
 *
 * @module dsh-scribe/providers/chroma
 */

import { filterAndPage, MemoryStorageProvider } from './base.js'

/** ChromaDB-backed storage. */
export class ChromaProvider extends MemoryStorageProvider {
  /**
   * @param id - configured provider name.
   * @param options - `{ config, logger }`.
   */
  constructor(id, options) {
    super(id, options)
    this.collectionName = this.config?.collection ?? 'dsh_memory'
    this.url = this.config?.url ?? 'http://localhost:8000'
  }

  async #collection() {
    if (this.cached !== undefined) return this.cached
    let ChromaClient
    try {
      ;({ ChromaClient } = await import('chromadb'))
    } catch (error) {
      throw new Error(
        `provider "${this.id}" uses engine "chromadb" but the "chromadb" package is not installed: ` +
          `run \`npm install chromadb\` inside the plugin directory, or set engine: "file". (${error?.message ?? error})`,
      )
    }
    const client = new ChromaClient({ path: this.url })
    this.cached = await client.getOrCreateCollection({ name: this.collectionName })
    return this.cached
  }

  async add(memory) {
    const collection = await this.#collection()
    await collection.add({
      ids: [memory.id],
      documents: [memory.content],
      ...(Array.isArray(memory.embedding) ? { embeddings: [memory.embedding] } : {}),
      metadatas: [flattenMetadata(memory)],
    })
  }

  async get(id) {
    const collection = await this.#collection()
    const result = await collection.get({ ids: [id], include: ['documents', 'metadatas'] })
    const index = result.ids?.indexOf(id) ?? -1
    if (index < 0) return null
    return inflateMemory(result.ids[index], result.documents?.[index], result.metadatas?.[index])
  }

  async delete(id) {
    const collection = await this.#collection()
    await collection.delete({ ids: [id] })
    return true
  }

  async list(options = {}) {
    const all = await this.bulkExport()
    return filterAndPage(all, options)
  }

  async bulkAdd(memories) {
    const collection = await this.#collection()
    let success = 0
    let failed = 0
    const ids = []
    // Chroma rejects oversized batches; 100 keeps payloads small and lets one
    // bad record fail alone.
    for (let offset = 0; offset < memories.length; offset += 100) {
      const batch = memories.slice(offset, offset + 100)
      try {
        await collection.add({
          ids: batch.map((memory) => memory.id),
          documents: batch.map((memory) => memory.content),
          ...(batch.every((memory) => Array.isArray(memory.embedding))
            ? { embeddings: batch.map((memory) => memory.embedding) }
            : {}),
          metadatas: batch.map(flattenMetadata),
        })
        success += batch.length
        ids.push(...batch.map((memory) => memory.id))
      } catch (error) {
        this.logger?.warn('chroma bulkAdd batch failed: %s', error?.message ?? error)
        failed += batch.length
      }
    }
    return { success, failed, ids }
  }

  async bulkExport() {
    const collection = await this.#collection()
    const result = await collection.get({ include: ['documents', 'metadatas'] })
    return (result.ids ?? []).map((id, index) => inflateMemory(id, result.documents?.[index], result.metadatas?.[index]))
  }

  async count() {
    const collection = await this.#collection()
    return collection.count()
  }

  async health() {
    try {
      await this.#collection()
      return true
    } catch (error) {
      this.logger?.warn('chroma health check failed: %s', error?.message ?? error)
      return false
    }
  }
}

function flattenMetadata(memory) {
  return {
    createdAt: Number(memory.createdAt ?? Date.now()),
    source: String(memory.source ?? 'unknown'),
    tags: JSON.stringify(memory.tags ?? []),
    sessionId: String(memory.sessionId ?? ''),
    metadata: JSON.stringify(memory.metadata ?? {}),
  }
}

function inflateMemory(id, document, metadata) {
  const parsed = metadata ?? {}
  return {
    id,
    content: String(document ?? ''),
    createdAt: Number(parsed.createdAt ?? Date.now()),
    source: parsed.source ?? 'unknown',
    tags: safeParse(parsed.tags, []),
    sessionId: parsed.sessionId || undefined,
    metadata: safeParse(parsed.metadata, {}),
    schemaVersion: 1,
  }
}

function safeParse(value, fallback) {
  if (typeof value !== 'string') return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}
