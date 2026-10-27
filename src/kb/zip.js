/**
 * Minimal ZIP reader for Office Open XML containers.
 *
 * A `.docx` / `.xlsx` / `.pptx` is a ZIP archive of XML parts. Reading it needs
 * no dependency and no native module: parse the end-of-central-directory
 * record, walk the central directory, then inflate only the parts asked for.
 *
 * Deliberately narrow: stored/deflated entries, no encryption, no ZIP64. That
 * covers every Office document a knowledge base is likely to hold.
 *
 * @module dsh-scribe/kb/zip
 */

import { inflateRawSync } from 'node:zlib'

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50

/**
 * Read one entry from a ZIP buffer.
 * @param buffer - the whole archive.
 * @param name - exact entry name, e.g. `word/document.xml`.
 * @returns the entry bytes, or undefined when absent.
 */
export function readZipEntry(buffer, name) {
  const entry = listZipEntries(buffer).find((candidate) => candidate.name === name)
  if (entry === undefined) return undefined
  return inflateEntry(buffer, entry)
}

/**
 * List every entry in a ZIP buffer.
 * @param buffer - the whole archive.
 * @returns `{ name, method, compressedSize, offset }` records.
 */
export function listZipEntries(buffer) {
  const eocd = findEocd(buffer)
  if (eocd === -1) throw new Error('不是有效的 ZIP 容器（缺少目录结束记录）')
  const total = buffer.readUInt16LE(eocd + 10)
  let cursor = buffer.readUInt32LE(eocd + 16)
  const entries = []
  for (let index = 0; index < total; index += 1) {
    if (cursor + 46 > buffer.length) break
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) break
    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const offset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    entries.push({ name, method, compressedSize, offset })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function inflateEntry(buffer, entry) {
  const header = entry.offset
  if (header + 30 > buffer.length) throw new Error(`ZIP 条目越界：${entry.name}`)
  if (buffer.readUInt32LE(header) !== LOCAL_SIGNATURE) throw new Error(`ZIP 条目头损坏：${entry.name}`)
  const nameLength = buffer.readUInt16LE(header + 26)
  const extraLength = buffer.readUInt16LE(header + 28)
  const start = header + 30 + nameLength + extraLength
  const data = buffer.subarray(start, start + entry.compressedSize)
  if (entry.method === 0) return data
  if (entry.method === 8) return inflateRawSync(data)
  throw new Error(`不支持的 ZIP 压缩方式 ${entry.method}（${entry.name}）`)
}

function findEocd(buffer) {
  const minimum = Math.max(0, buffer.length - 0xffff - 22)
  for (let cursor = buffer.length - 22; cursor >= minimum; cursor -= 1) {
    if (buffer.readUInt32LE(cursor) === EOCD_SIGNATURE) return cursor
  }
  return -1
}
