/**
 * Knowledge-base indexer.
 *
 * The index is derived data: it can always be rebuilt from the documents, so
 * the writer is a whole-file atomic replace rather than an append log. That
 * keeps "what is indexed" a single readable question and avoids tombstone
 * growth in a store that changes whenever a document does.
 *
 * Incremental behaviour is per file: an unchanged file (same size and mtime)
 * keeps its previous chunks and costs one `stat`.
 *
 * @module dsh-scribe/kb/indexer
 */

import { createHash } from 'node:crypto'
import { readFile, readdir, rename, stat, unlink, writeFile, mkdir } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'

import { chunkMarkdown, matchesAny } from './chunk.js'
import { extractDocument } from './extract.js'

/** Excluded by default: raw material and the drop zone are not curated knowledge. */
export const DEFAULT_EXCLUDE = ['**/原始/**', '**/inbox/**', '**/node_modules/**', '**/.git/**']

/** Text files above this are skipped: a knowledge entry this big wants splitting. */
const MAX_FILE_BYTES = 512 * 1024

/**
 * Binary documents get a much larger ceiling.
 *
 * The 512 KB text limit exists because a huge text file makes useless chunks.
 * A `.docx` of the same size is mostly styling and images, and only its XML
 * body is read — so measuring it against the text limit would skip ordinary
 * meeting notes.
 */
const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024

/**
 * Rebuild one scope's index.
 *
 * @param options - `{ scope, root, include, exclude, chunkOptions, previous, limits, logger }`.
 * @returns `{ scope, root, generatedAt, files, chunks, stats }`.
 */
export async function buildIndex({
  scope,
  root,
  include = ['**/*.md'],
  exclude = DEFAULT_EXCLUDE,
  documents = [],
  extractDir,
  extractEnabled = true,
  chunkOptions,
  previous,
  limits,
  logger,
}) {
  const maxFiles = Number(limits?.maxFiles) || 2000
  const maxChunks = Number(limits?.maxChunks) || 20000
  const startedAt = Date.now()

  const listed = await listDocuments(root)
  const kept = []
  const reusedChunks = []
  const stats = {
    scanned: listed.length,
    indexed: 0,
    skipped: 0,
    reused: 0,
    removed: 0,
    extracted: 0,
    skippedDocuments: [],
    truncated: false,
  }

  const previousFiles = previous?.files ?? {}
  const previousChunks = Array.isArray(previous?.chunks) ? previous.chunks : []
  const chunksByPath = new Map()
  for (const chunk of previousChunks) {
    const list = chunksByPath.get(chunk.path) ?? []
    list.push(chunk)
    chunksByPath.set(chunk.path, list)
  }

  for (const entry of listed) {
    if (kept.length >= maxFiles) {
      stats.truncated = true
      logger?.warn?.('knowledge base file limit reached (%d); remaining files skipped', maxFiles)
      break
    }
    if (matchesAny(entry.rel, exclude)) {
      stats.skipped += 1
      continue
    }
    const extension = extname(entry.rel).toLowerCase()
    const isDocument = extractEnabled && documents.includes(extension)
    if (!isDocument && include.length > 0 && !matchesAny(entry.rel, include)) {
      stats.skipped += 1
      continue
    }
    let info
    try {
      info = await stat(entry.abs)
    } catch {
      stats.skipped += 1
      continue
    }
    const sizeCeiling = isDocument ? MAX_DOCUMENT_BYTES : MAX_FILE_BYTES
    if (!info.isFile() || info.size > sizeCeiling) {
      stats.skipped += 1
      continue
    }
    const fileHash = hashOf(`${info.size}:${info.mtimeMs}:${entry.rel}`)
    const prior = previousFiles[entry.rel]
    if (prior !== undefined && prior.hash === fileHash && chunksByPath.has(entry.rel)) {
      kept.push({ rel: entry.rel, abs: entry.abs, size: info.size, mtimeMs: info.mtimeMs, hash: fileHash, chunks: prior.chunks })
      reusedChunks.push(...chunksByPath.get(entry.rel))
      stats.reused += 1
      continue
    }
    let text
    let extractor
    let extractedPath
    if (isDocument) {
      const extracted = await extractDocument(entry.abs, { logger })
      if (extracted.skipped === true) {
        stats.skipped += 1
        if (stats.skippedDocuments.length < 20) stats.skippedDocuments.push({ path: entry.rel, reason: extracted.reason })
        continue
      }
      text = extracted.text
      extractor = extracted.extractor
      if (extractDir !== undefined) {
        try {
          await mkdir(extractDir, { recursive: true })
          extractedPath = join(extractDir, `${fileHash}.txt`)
          await writeFile(extractedPath, text, 'utf8')
        } catch (error) {
          logger?.warn?.('cannot cache extracted text for %s: %s', entry.rel, error?.message ?? error)
          extractedPath = undefined
        }
      }
      stats.extracted += 1
    } else {
      try {
        text = await readFile(entry.abs, 'utf8')
      } catch (error) {
        logger?.warn?.('knowledge base cannot read %s: %s', entry.rel, error?.message ?? error)
        stats.skipped += 1
        continue
      }
    }
    const chunks = chunkMarkdown(text, chunkOptions).map((chunk) => ({
      id: hashOf(`${scope}:${entry.rel}:${chunk.startLine}:${chunk.content}`),
      scope,
      path: entry.rel,
      absPath: entry.abs,
      heading: chunk.heading,
      content: chunk.content,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      ...(extractor === undefined ? {} : { extracted: true, extractor, ...(extractedPath === undefined ? {} : { extractedPath }) }),
    }))
    kept.push({
      rel: entry.rel,
      abs: entry.abs,
      size: info.size,
      mtimeMs: info.mtimeMs,
      hash: fileHash,
      chunks: chunks.length,
      ...(extractor === undefined ? {} : { extractor }),
    })
    reusedChunks.push(...chunks)
    stats.indexed += 1
  }

  // Anything the manifest knew but the scan no longer sees is gone.
  const present = new Set(kept.map((entry) => entry.rel))
  for (const rel of Object.keys(previousFiles)) {
    if (!present.has(rel)) stats.removed += 1
  }

  // Extracted text is a cache, not a store: drop files no live chunk points at
  // so a renamed or edited document does not leave its old text behind forever.
  if (extractDir !== undefined) {
    const live = new Set(
      reusedChunks.map((chunk) => (typeof chunk.extractedPath === 'string' ? chunk.extractedPath.split(/[\\/]/).pop() : undefined)).filter(Boolean),
    )
    try {
      for (const name of await readdir(extractDir)) {
        if (!name.endsWith('.txt') || live.has(name)) continue
        await unlink(join(extractDir, name)).catch(() => {})
        stats.cachesPruned = (stats.cachesPruned ?? 0) + 1
      }
    } catch {
      // A missing cache directory is simply nothing to prune.
    }
  }

  const chunks = reusedChunks.slice(0, maxChunks)
  if (reusedChunks.length > maxChunks) stats.truncated = true

  return {
    scope,
    root,
    generatedAt: Date.now(),
    durationMs: Date.now() - startedAt,
    files: Object.fromEntries(
      kept.map((entry) => [
        entry.rel,
        {
          hash: entry.hash,
          size: entry.size,
          mtimeMs: entry.mtimeMs,
          chunks: entry.chunks,
          ...(entry.extractor === undefined ? {} : { extractor: entry.extractor }),
        },
      ]),
    ),
    chunks,
    stats,
  }
}

/**
 * Atomically persist one scope index.
 * @param file - absolute index path.
 * @param index - the index object.
 */
export async function writeIndex(file, index) {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify(index), 'utf8')
  await rename(temporary, file)
}

/**
 * Read one scope index, or undefined when it has never been built.
 * @param file - absolute index path.
 * @returns the index or undefined.
 */
export async function readIndex(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Walk a directory for documents, returning POSIX-style relative paths.
 * @param root - absolute directory.
 * @returns `{ rel, abs }` entries, sorted for a stable index.
 */
export async function listDocuments(root) {
  const out = []
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(abs)
        continue
      }
      if (!entry.isFile()) continue
      const rel = abs.slice(root.length).replace(/^[\\/]+/, '').split(/[\\/]/).join('/')
      out.push({ rel, abs })
    }
  }
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
}

function hashOf(input) {
  return createHash('sha1').update(input).digest('hex').slice(0, 16)
}
