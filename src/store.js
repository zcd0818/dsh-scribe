/**
 * Durable, append-oriented JSONL storage used by the local provider.
 *
 * The file is the single source of truth: `load()` parses it once, every
 * mutation appends a full record (last write wins per id), and compaction
 * rewrites the file atomically through a temporary sibling. All writes are
 * serialized through one promise chain so concurrent tool calls from several
 * agents cannot interleave a read-modify-write.
 *
 * @module dsh-scribe/store
 */

import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'

/** One durable JSONL collection. */
export class JsonlStore {
  /**
   * @param file - absolute path of the `.jsonl` file.
   */
  constructor(file) {
    this.file = file
    this.records = new Map()
    this.loaded = false
    this.loading = undefined
    this.queue = Promise.resolve()
    this.dirty = 0
  }

  /** Load the file into memory once; concurrent callers share one read. */
  async load() {
    if (this.loaded) return
    this.loading ??= this.#readAll().finally(() => {
      this.loading = undefined
      this.loaded = true
    })
    return this.loading
  }

  async #readAll() {
    await mkdir(dirname(this.file), { recursive: true })
    let handle
    try {
      handle = await open(this.file, 'r')
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    await handle.close()
    const lines = createInterface({ input: createReadStream(this.file, { encoding: 'utf8' }), crlfDelay: Infinity })
    for await (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      let record
      try {
        record = JSON.parse(trimmed)
      } catch {
        // A torn final line from an interrupted append is expected; skip it.
        continue
      }
      if (record && typeof record.id === 'string') {
        // A tombstone is how `delete` stays append-only; replaying it must
        // remove the record rather than resurrect it as a live entry.
        if (record.deleted === true) this.records.delete(record.id)
        else this.records.set(record.id, record)
      }
    }
  }

  /**
   * Read one record.
   * @param id - record id.
   * @returns the record or undefined.
   */
  async get(id) {
    await this.load()
    return this.records.get(id)
  }

  /**
   * Read every record.
   * @returns a fresh array.
   */
  async all() {
    await this.load()
    return [...this.records.values()]
  }

  /**
   * Insert or replace one record and append it.
   * @param record - a JSON-serializable record with a string `id`.
   * @returns the stored record.
   */
  async put(record) {
    await this.load()
    this.records.set(record.id, record)
    this.dirty += 1
    await this.#append(record)
    return record
  }

  /**
   * Insert or replace many records in one serialized write.
   * @param records - records to upsert.
   * @returns the number written.
   */
  async putMany(records) {
    if (records.length === 0) return 0
    await this.load()
    const payload = records.map((record) => {
      this.records.set(record.id, record)
      return `${JSON.stringify(record)}\n`
    })
    this.dirty += records.length
    await this.#enqueue(() => this.#appendRaw(payload.join('')))
    return records.length
  }

  /**
   * Delete one record by appending a tombstone.
   * @param id - record id.
   * @returns whether a record was removed.
   */
  async delete(id) {
    await this.load()
    if (!this.records.delete(id)) return false
    this.dirty += 1
    await this.#append({ id, deleted: true, deletedAt: Date.now() })
    return true
  }

  /**
   * Delete many records at once.
   * @param ids - record ids.
   * @returns the number removed.
   */
  async deleteMany(ids) {
    await this.load()
    const payload = []
    let removed = 0
    for (const id of ids) {
      if (this.records.delete(id)) {
        removed += 1
        payload.push(`${JSON.stringify({ id, deleted: true, deletedAt: Date.now() })}\n`)
      }
    }
    this.dirty += removed
    if (removed > 0) await this.#enqueue(() => this.#appendRaw(payload.join('')))
    return removed
  }

  /**
   * Replace the whole collection with `records` through an atomic rewrite.
   * @param records - the complete new collection.
   */
  async replaceAll(records) {
    await this.load()
    this.records = new Map(records.map((record) => [record.id, record]))
    this.dirty += records.length
    await this.#enqueue(async () => {
      const temporary = `${this.file}.${process.pid}.tmp`
      await mkdir(dirname(this.file), { recursive: true })
      await writeLines(temporary, records)
      await rename(temporary, this.file)
      this.dirty = 0
    })
  }

  /** Total size of the backing file in bytes. */
  async size() {
    try {
      const info = await stat(this.file)
      return info.size
    } catch {
      return 0
    }
  }

  /** Remove the backing file (used by rollback of an import). */
  async destroy() {
    this.records.clear()
    this.loaded = false
    await rm(this.file, { force: true })
  }

  async #append(record) {
    const line = `${JSON.stringify(record)}\n`
    await this.#enqueue(() => this.#appendRaw(line))
  }

  async #appendRaw(text) {
    await mkdir(dirname(this.file), { recursive: true })
    const handle = await open(this.file, 'a')
    try {
      await handle.appendFile(text, 'utf8')
    } finally {
      await handle.close()
    }
  }

  #enqueue(task) {
    const next = this.queue.then(task, task)
    this.queue = next.catch(() => {})
    return next
  }
}

async function writeLines(file, records) {
  await new Promise((resolve, reject) => {
    const stream = createWriteStream(file, { encoding: 'utf8' })
    stream.on('error', reject)
    stream.on('finish', resolve)
    for (const record of records) stream.write(`${JSON.stringify(record)}\n`)
    stream.end()
  })
}

/**
 * Append one JSON line to a log file, creating parents as needed.
 * @param file - absolute path.
 * @param value - JSON-serializable value.
 */
export async function appendJsonLine(file, value) {
  await mkdir(dirname(file), { recursive: true })
  const handle = await open(file, 'a')
  try {
    await handle.appendFile(`${JSON.stringify(value)}\n`, 'utf8')
  } finally {
    await handle.close()
  }
}

export { join }
