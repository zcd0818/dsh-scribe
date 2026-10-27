/**
 * Knowledge-base service.
 *
 * Two scopes, one contract:
 * - `workspace` indexes the current project's `kb/` directory (the convention
 *   this workspace already documents in AGENTS.md);
 * - `global` indexes `<dataDir>/kb/global`, so a fact that outlives one project
 *   still has a home.
 *
 * A workspace hit outranks a global hit for the same query, because the project
 * you are in is the better default scoping. Indexes are derived data kept under
 * `dataDir/kb`; documents are never modified.
 *
 * @module dsh-scribe/kb/service
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, resolve } from 'node:path'

import { isPlainObject } from '../config.js'
import { lexicalScore, oneLine, truncate } from '../util.js'
import { extractionCapabilities } from './extract.js'
import { buildIndex, readIndex, writeIndex } from './indexer.js'
import { citationOf } from './chunk.js'

/** Read as UTF-8 and chunked by heading: documents and code, never binaries. */
const DEFAULT_INCLUDE = [
  '**/*.md',
  '**/*.markdown',
  '**/*.txt',
  '**/*.rst',
  '**/*.json',
  '**/*.yaml',
  '**/*.yml',
  '**/*.toml',
  '**/*.csv',
  '**/*.sql',
  '**/*.html',
  '**/*.js',
  '**/*.ts',
  '**/*.py',
  '**/*.go',
  '**/*.rs',
  '**/*.sh',
]

/** Scope weights: the project you are in wins ties against shared knowledge. */
const SCOPE_WEIGHT = { workspace: 1, global: 0.88 }

export class KbService {
  /**
   * @param options - `{ config, logger }`.
   */
  constructor({ config, logger }) {
    this.config = config
    this.logger = logger
    this.indexes = new Map()
    this.pending = new Map()
    this.settings = normalizeSettings(config.knowledgeBase, config.dataDir)
  }

  /** @returns whether the knowledge base is enabled at all. */
  get enabled() {
    return this.settings.enabled
  }

  /** Absolute directory of one scope, resolved per active working directory. */
  rootOf(scope, cwd) {
    if (scope === 'global') return this.settings.globalRoot
    const base = typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd()
    // A per-workspace override lets one project keep its documents anywhere
    // (the picker in Settings writes this map) without changing the default.
    const override = this.settings.overrides[base]
    const configured = typeof override === 'string' && override.length > 0 ? override : this.settings.workspaceRoot
    return isAbsolute(configured) ? configured : resolve(base, configured)
  }

  /** Index file path for one scope (workspace indexes are per working directory). */
  indexFileOf(scope, cwd) {
    if (scope === 'global') return join(this.settings.indexDir, 'global.json')
    const key = createHash('sha1').update(this.rootOf(scope, cwd)).digest('hex').slice(0, 12)
    return join(this.settings.indexDir, `workspace-${key}.json`)
  }

  /**
   * Ensure an index exists and is fresh enough to answer a query.
   *
   * Freshness is a TTL rather than a filesystem watch: a stale read costs one
   * rebuild, while a watcher costs a listener per workspace forever.
   *
   * @param scope - `workspace` or `global`.
   * @param options - `{ cwd, force }`.
   * @returns the index.
   */
  async ensure(scope, options = {}) {
    if (!this.enabled) return emptyIndex(scope, this.rootOf(scope, options.cwd))
    const root = this.rootOf(scope, options.cwd)
    const file = this.indexFileOf(scope, options.cwd)
    const key = file
    const cached = this.indexes.get(key)
    if (!options.force && cached !== undefined && Date.now() - cached.generatedAt < this.settings.refreshSeconds * 1000) {
      return cached
    }
    if (this.pending.has(key)) return this.pending.get(key)

    const task = (async () => {
      const previous = cached ?? (await readIndex(file))
      if (!options.force && previous !== undefined && Date.now() - previous.generatedAt < this.settings.refreshSeconds * 1000) {
        this.indexes.set(key, previous)
        return previous
      }
      const exists = await dirExists(root)
      if (!exists) {
        const empty = emptyIndex(scope, root)
        this.indexes.set(key, empty)
        return empty
      }
      const index = await buildIndex({
        scope,
        root,
        include: scope === 'global' ? this.settings.globalInclude : this.settings.include,
        documents: this.settings.documents,
        extractEnabled: this.settings.extractEnabled,
        extractDir: join(this.settings.indexDir, 'extracted'),
        exclude: this.settings.exclude,
        chunkOptions: this.settings.chunk,
        previous,
        limits: this.settings.limits,
        logger: this.logger,
      })
      await writeIndex(file, index)
      this.indexes.set(key, index)
      this.logger?.debug?.('knowledge index %s: %d files, %d chunks (%dms)', scope, Object.keys(index.files).length, index.chunks.length, index.durationMs)
      return index
    })().finally(() => this.pending.delete(key))

    this.pending.set(key, task)
    return task
  }

  /**
   * Rebuild one or both scopes now.
   * @param options - `{ scope, cwd }`; `scope` omitted rebuilds both.
   * @returns the refreshed indexes.
   */
  async reindex({ scope, cwd } = {}) {
    const scopes = scope === undefined ? ['workspace', 'global'] : [scope]
    const result = {}
    for (const name of scopes) {
      const root = this.rootOf(name, cwd)
      // Creating the directory is the point for the global scope: "rebuild"
      // on a folder that does not exist yet should leave a usable empty one,
      // not a permanent error.
      if (name === 'global' && !(await dirExists(root))) {
        try {
          await mkdir(root, { recursive: true })
        } catch (error) {
          this.logger?.warn?.('cannot create global knowledge directory %s: %s', root, error?.message ?? error)
        }
      }
      result[name] = await this.ensure(name, { cwd, force: true })
    }
    return result
  }

  /**
   * Read a scope's stored index without building it.
   *
   * The settings page lists every registered workspace; building all of them
   * just to show a count would be a multi-second stall, so the page peeks and
   * offers an explicit rebuild instead.
   *
   * @param options - `{ scope, cwd }`.
   * @returns `{ root, exists, files, chunks, generatedAt }`.
   */
  async peek({ scope = 'workspace', cwd } = {}) {
    const root = this.rootOf(scope, cwd)
    const file = this.indexFileOf(scope, cwd)
    const index = this.indexes.get(file) ?? (await readIndex(file))
    return {
      root,
      exists: await dirExists(root),
      files: index === undefined ? 0 : Object.keys(index.files ?? {}).length,
      chunks: index?.chunks?.length ?? 0,
      generatedAt: index?.generatedAt || undefined,
    }
  }

  /**
   * Search both scopes and return citation-ready hits.
   * @param query - natural-language query.
   * @param options - `{ limit, cwd, scopes, minScore }`.
   * @returns `{ hits, scanned }` with hits ordered by relevance.
   */
  async search(query, options = {}) {
    const text = String(query ?? '').trim()
    if (text.length === 0) return { hits: [], scanned: 0 }
    const limit = Math.max(1, Math.min(20, Number(options.limit) || 5))
    const scopes = options.scopes ?? ['workspace', 'global']
    const minScore = Number.isFinite(options.minScore) ? options.minScore : this.settings.minScore

    const scored = []
    let scanned = 0
    for (const scope of scopes) {
      const index = await this.ensure(scope, { cwd: options.cwd })
      for (const chunk of index.chunks) {
        scanned += 1
        const score = lexicalScore(text, { content: chunk.content, tags: [chunk.heading, chunk.path] }) * SCOPE_WEIGHT[scope]
        if (score < minScore) continue
        scored.push({ ...chunk, score: Number(score.toFixed(4)) })
      }
    }
    scored.sort((a, b) => b.score - a.score)
    return { hits: scored.slice(0, limit), scanned }
  }

  /**
   * Read a document (or a line range) so the caller can quote exact text.
   * @param options - `{ scope, path, start, end, cwd }`.
   * @returns `{ path, scope, lines, start, end, total, content }`.
   */
  async read({ scope = 'workspace', path: relPath, start, end, cwd } = {}) {
    const root = this.rootOf(scope, cwd)
    const normalized = String(relPath ?? '').replace(/^kb-global\//, '').replace(/^kb\//, '')
    if (normalized.length === 0) throw new Error('缺少文件路径')
    if (normalized.includes('..')) throw new Error('路径不能包含 ..')
    const abs = join(root, normalized)
    let text
    if (this.settings.documents.includes(extname(normalized).toLowerCase())) {
      // A binary document has no readable lines of its own: serve the cached
      // extraction so a citation still points at something the caller can quote.
      const index = await this.ensure(scope, { cwd })
      const chunk = index.chunks.find((candidate) => candidate.path === normalized && typeof candidate.extractedPath === 'string')
      if (chunk === undefined) {
        throw new Error('该文档还没有抽取正文，请先在知识库里重建索引（或缺少 PDF 解析依赖）')
      }
      text = await readFile(chunk.extractedPath, 'utf8')
    } else {
      text = await readFile(abs, 'utf8')
    }
    const lines = text.split('\n')
    const from = Math.max(1, Number(start) || 1)
    const to = Math.min(lines.length, Number(end) || lines.length)
    const window = []
    for (let line = from; line <= to; line += 1) window.push({ n: line, text: lines[line - 1] })
    return {
      path: normalized,
      scope,
      start: from,
      end: to,
      total: lines.length,
      lines: window,
      content: window.map((entry) => `${String(entry.n).padStart(4, ' ')}│ ${entry.text}`).join('\n'),
    }
  }

  /**
   * Build the compact digest injected at session start.
   *
   * The workspace convention already names `INDEX.md` as the one file worth
   * reading: one line per entry. That is exactly the shape a prompt section
   * wants, so it is injected verbatim (trimmed) and falls back to a file list
   * when a scope has no index of its own.
   *
   * @param options - `{ cwd }`.
   * @returns the section text, or an empty string when nothing is indexed.
   */
  async digest({ cwd } = {}) {
    if (!this.enabled) return ''
    const parts = []
    for (const scope of ['workspace', 'global']) {
      const root = this.rootOf(scope, cwd)
      if (!(await dirExists(root))) continue
      const index = await this.ensure(scope, { cwd })
      const label = scope === 'workspace' ? '工作区知识库（kb/）' : '全局知识库'
      const body = await this.#digestBody(scope, root, index)
      if (body.length === 0) continue
      parts.push(`### ${label}\n${body}`)
    }
    if (parts.length === 0) return ''
    const text = `## 知识库目录\n\n${parts.join('\n\n')}\n\n（用 kb_search 检索全文，用 kb_read 读原文并给出 kb/路径.md#L行号 引用）`
    return truncate(text, this.settings.injectMaxChars)
  }

  async #digestBody(scope, root, index) {
    const indexPath = join(root, 'INDEX.md')
    try {
      const text = await readFile(indexPath, 'utf8')
      const lines = text
        .split('\n')
        .map((line) => line.trimEnd())
        .filter((line) => line.trim().length > 0 && !line.startsWith('<!--'))
      const kept = lines.slice(0, this.settings.injectIndexLines)
      const suffix = lines.length > kept.length ? `\n…（INDEX.md 共 ${lines.length} 行）` : ''
      return `${kept.join('\n')}${suffix}`
    } catch {
      // No INDEX.md: fall back to a short file listing so the model still knows
      // what exists.
    }
    const paths = Object.keys(index.files)
    if (paths.length === 0) return ''
    const shown = paths.slice(0, this.settings.injectIndexLines)
    const suffix = paths.length > shown.length ? `\n…（共 ${paths.length} 个文件）` : ''
    return `${shown.map((path) => `- ${path}`).join('\n')}${suffix}`
  }

  /**
   * Snapshot for the settings page and `kb_status`.
   * @param options - `{ cwd }`.
   * @returns `{ enabled, refreshSeconds, scopes }`.
   */
  async state({ cwd } = {}) {
    const scopes = {}
    for (const scope of ['workspace', 'global']) {
      const root = this.rootOf(scope, cwd)
      const index = await this.ensure(scope, { cwd })
      const files = Object.keys(index.files ?? {})
      scopes[scope] = {
        overridden: scope === 'workspace' && typeof this.settings.overrides[resolve(root)] === 'string',
        root,
        exists: await dirExists(root),
        files: files.length,
        chunks: index.chunks?.length ?? 0,
        generatedAt: index.generatedAt ?? undefined,
        durationMs: index.durationMs ?? undefined,
        topFiles: files.slice(0, 8).map((path) => ({ path, chunks: index.files[path]?.chunks ?? 0 })),
      }
    }
    return {
      enabled: this.enabled,
      refreshSeconds: this.settings.refreshSeconds,
      include: this.settings.include,
      extract: {
        enabled: this.settings.extractEnabled,
        documents: this.settings.documents,
        capabilities: await extractionCapabilities(),
      },
      scopes,
    }
  }
}

/**
 * Build the knowledge service for one plugin mount.
 * @param options - `{ config, logger }`.
 * @returns the service.
 */
export function createKbService(options) {
  return new KbService(options)
}

function normalizeSettings(raw, dataDir) {
  const settings = isPlainObject(raw) ? raw : {}
  const workspace = isPlainObject(settings.workspace) ? settings.workspace : {}
  const global = isPlainObject(settings.global) ? settings.global : {}
  const chunk = isPlainObject(settings.chunk) ? settings.chunk : {}
  const extract = isPlainObject(settings.extract) ? settings.extract : {}
  const limits = isPlainObject(settings.limits) ? settings.limits : {}
  return {
    enabled: settings.enabled !== false,
    workspaceRoot: typeof workspace.root === 'string' && workspace.root.length > 0 ? workspace.root : 'kb',
    overrides: isPlainObject(workspace.overrides) ? workspace.overrides : {},
    globalRoot: typeof global.root === 'string' && global.root.length > 0 ? global.root : join(dataDir, 'kb', 'global'),
    indexDir: join(dataDir, 'kb', 'indexes'),
    include: Array.isArray(workspace.include) && workspace.include.length > 0 ? workspace.include : DEFAULT_INCLUDE,
    exclude: Array.isArray(workspace.exclude) ? workspace.exclude : undefined,
    globalInclude: Array.isArray(global.include) && global.include.length > 0 ? global.include : DEFAULT_INCLUDE,
    chunk: {
      maxChars: Number(chunk.maxChars) || 1200,
      minChars: Number(chunk.minChars) || 80,
    },
    extractEnabled: extract.enabled !== false,
    documents: Array.isArray(extract.documents) && extract.documents.length > 0 ? extract.documents : ['.docx', '.xlsx', '.pptx', '.pdf'],
    limits: {
      maxFiles: Number(limits.maxFiles) || 2000,
      maxChunks: Number(limits.maxChunks) || 20000,
    },
    refreshSeconds: Number(settings.refreshSeconds) || 300,
    minScore: Number(settings.minScore) || 0.12,
    injectIndexLines: Number(settings.injectIndexLines) || 30,
    injectMaxChars: Number(settings.injectMaxChars) || 1100,
  }
}

function emptyIndex(scope, root) {
  return { scope, root, generatedAt: 0, files: {}, chunks: [], stats: { scanned: 0, indexed: 0, skipped: 0, reused: 0, removed: 0 } }
}

async function dirExists(path) {
  try {
    const info = await stat(path)
    return info.isDirectory()
  } catch {
    return false
  }
}

/**
 * Render one hit for a model-facing tool result.
 * @param hit - a hit from `search`.
 * @param index - 1-based position.
 * @returns a multi-line string with citation.
 */
export function formatHit(hit, index) {
  const heading = hit.heading ? `「${hit.heading}」` : ''
  return `${index}. ${citationOf(hit)} ${heading}\n   ${oneLine(hit.content, 220)}`
}
