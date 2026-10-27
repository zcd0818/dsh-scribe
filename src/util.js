/**
 * Pure helpers shared by the store, the providers, and the session layer:
 * identifiers, content hashing, tokenization, similarity scoring, and text
 * truncation. Everything here is synchronous and side-effect free so it can be
 * unit-tested without a Harness process.
 *
 * @module dsh-scribe/util
 */

import { createHash, randomUUID } from 'node:crypto'

/** Schema version stamped on every stored memory. */
export const MEMORY_SCHEMA_VERSION = 1

/**
 * Create one memory identifier.
 * @returns a stable, sortable-ish opaque id.
 */
export function newMemoryId() {
  return `mem_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
}

/**
 * Hash memory content for deduplication.
 * @param content - normalized content text.
 * @returns a short hex digest.
 */
export function contentHash(content) {
  return createHash('sha256').update(String(content)).digest('hex').slice(0, 20)
}

/**
 * Normalize content for storage and hashing: collapse whitespace, trim, and
 * drop control characters that would break prompt rendering.
 * @param content - raw content.
 * @returns normalized text.
 */
export function normalizeContent(content) {
  return String(content ?? '')
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Truncate text at a character budget without cutting a surrogate pair.
 * @param text - source text.
 * @param max - maximum characters.
 * @returns the (possibly) truncated text, with an ellipsis when cut.
 */
export function truncate(text, max) {
  const value = String(text ?? '')
  if (!Number.isFinite(max) || max <= 0 || value.length <= max) return value
  let end = max - 1
  const code = value.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end -= 1
  return `${value.slice(0, end).trimEnd()}…`
}

/**
 * Tokenize text for lexical scoring: lowercase latin runs plus CJK bigrams.
 * Chinese has no word delimiters, so bigrams are the cheapest useful unit.
 * @param text - source text.
 * @returns the token multiset as an array.
 */
export function tokenize(text) {
  const normalized = String(text ?? '').toLowerCase()
  const tokens = []
  for (const run of normalized.match(/[a-z0-9][a-z0-9_.+/#-]{1,}/g) ?? []) tokens.push(run)
  for (const run of normalized.match(/[\u3400-\u4dbf\u4e00-\u9fff]+/g) ?? []) {
    if (run.length === 1) tokens.push(run)
    for (let index = 0; index + 1 < run.length; index += 1) tokens.push(run.slice(index, index + 2))
  }
  return tokens
}

/**
 * Lexical relevance of one memory against a query, in `[0, 1]`.
 *
 * A query token that appears in the memory contributes 1; tokens that only
 * appear in the memory's tags contribute slightly less. The score is the
 * matched share of distinct query tokens, so a short query is not drowned out
 * by a long memory.
 *
 * @param query - the query text.
 * @param memory - a memory record with `content` and `tags`.
 * @returns the lexical score.
 */
export function lexicalScore(query, memory) {
  const queryTokens = [...new Set(tokenize(query))]
  if (queryTokens.length === 0) return 0
  const body = new Set(tokenize(memory?.content ?? ''))
  const tags = new Set(tokenize((memory?.tags ?? []).join(' ')))
  let matched = 0
  for (const token of queryTokens) {
    if (body.has(token)) matched += 1
    else if (tags.has(token)) matched += 0.6
  }
  return matched / queryTokens.length
}

/**
 * Cosine similarity of two equal-length vectors.
 * @param a - first vector.
 * @param b - second vector.
 * @returns similarity in `[-1, 1]`, or 0 for unusable input.
 */
export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index]
    normA += a[index] * a[index]
    normB += b[index] * b[index]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/**
 * Recency weight in `[0, 1]`: 1 for a memory from today, halving each half-life.
 * @param createdAt - epoch milliseconds.
 * @param now - reference time in epoch milliseconds.
 * @param halfLifeDays - days for the weight to halve.
 * @returns the recency weight.
 */
export function recencyWeight(createdAt, now, halfLifeDays = 14) {
  const ageDays = Math.max(0, (now - Number(createdAt || 0)) / 86_400_000)
  if (!Number.isFinite(ageDays) || halfLifeDays <= 0) return 0
  return 2 ** (-ageDays / halfLifeDays)
}

/**
 * Sort a list of memories newest first without mutating the input.
 * @param memories - memory records.
 * @returns a new sorted array.
 */
export function byNewest(memories) {
  return [...memories].sort((a, b) => Number(b?.createdAt ?? 0) - Number(a?.createdAt ?? 0))
}

/**
 * Collapse whitespace into a single line for table-like output.
 * @param text - source text.
 * @param max - maximum characters.
 * @returns single-line text.
 */
export function oneLine(text, max = 160) {
  return truncate(
    String(text ?? '')
      .replace(/\s+/g, ' ')
      .trim(),
    max,
  )
}

/**
 * Format an epoch millisecond timestamp as `YYYY-MM-DD`.
 * @param value - epoch milliseconds.
 * @returns the date, or `unknown`.
 */
export function isoDate(value) {
  const date = new Date(Number(value))
  return Number.isNaN(date.getTime()) ? 'unknown' : date.toISOString().slice(0, 10)
}

/**
 * Format a byte count for humans.
 * @param bytes - byte count.
 * @returns a short string such as `12.5 MB`.
 */
export function formatBytes(bytes) {
  const value = Number(bytes) || 0
  if (value < 1024) return `${value} B`
  const units = ['KB', 'MB', 'GB']
  let scaled = value / 1024
  let unit = 0
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024
    unit += 1
  }
  return `${scaled.toFixed(1)} ${units[unit]}`
}

/**
 * Whether a value is a plain object.
 * @param value - candidate.
 * @returns true for `{}`-like values.
 */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read a path out of a nested object, returning undefined on a missing link.
 * @param value - root value.
 * @param path - dotted path segments.
 * @returns the value or undefined.
 */
export function getPath(value, path) {
  let current = value
  for (const key of path) {
    if (current === null || current === undefined) return undefined
    current = current[key]
  }
  return current
}
