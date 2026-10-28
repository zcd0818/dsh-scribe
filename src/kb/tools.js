/**
 * Model-facing knowledge-base tools.
 *
 * `scribe_kb_search` finds the chunk, `scribe_kb_read` returns the exact numbered lines so an
 * answer can quote `kb/路径.md#L12-L40` — the citation convention this
 * workspace already uses. Search alone would leave the model paraphrasing.
 *
 * @module dsh-scribe/kb/tools
 */

import { citationOf } from './chunk.js'
import { formatHit } from './service.js'

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}

/**
 * Install the knowledge tools.
 * @param options - `{ ctx, kb, config, logger }`.
 */
export function installKbTools({ ctx, kb, config, logger }) {
  if (!kb.enabled) return

  ctx.tools.register({
    name: 'scribe_kb_search',
    description:
      'Search the project knowledge base (workspace kb/ first, then shared global knowledge) and return passages with citations. ' +
      'Use it before answering questions about conventions, specs, or past decisions; follow a hit with scribe_kb_read when you need exact wording.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look up, in natural language.' },
        limit: { type: 'integer', description: 'How many passages (1-10, default 5).' },
        scope: {
          type: 'string',
          enum: ['both', 'workspace', 'global'],
          description: 'Which knowledge base to search (default both).',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    timeoutMs: 20_000,
    execute: async (args, exec) => {
      const query = String(args?.query ?? '').trim()
      if (query.length === 0) return '请输入检索内容。'
      const limit = Math.min(10, Math.max(1, Number(args?.limit) || 5))
      const scope = args?.scope === 'workspace' || args?.scope === 'global' ? args.scope : 'both'
      const scopes = scope === 'both' ? ['workspace', 'global'] : [scope]
      const { hits, scanned } = await kb.search(query, { limit, cwd: cwdOf(exec?.agent), scopes })
      if (hits.length === 0) return `知识库里没有匹配「${query}」的段落（已扫描 ${scanned} 块）。`
      return [
        ...hits.map((hit, index) => formatHit(hit, index + 1)),
        '',
        '用 scribe_kb_read 读取原文行号后再引用。',
      ].join('\n')
    },
  })

  ctx.tools.register({
    name: 'scribe_kb_read',
    description:
      'Read a knowledge-base document (optionally a line range) with line numbers, so a citation can point at exact lines.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path as returned by scribe_kb_search, e.g. "kb/设计规范.md" or "设计规范.md".' },
        start: { type: 'integer', description: 'First line (1-based). Defaults to 1.' },
        end: { type: 'integer', description: 'Last line. Defaults to the end of the file.' },
        scope: {
          type: 'string',
          enum: ['workspace', 'global'],
          description: 'Which knowledge base the path belongs to (default workspace).',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    timeoutMs: 15_000,
    execute: async (args, exec) => {
      const path = String(args?.path ?? '').trim()
      if (path.length === 0) return '请提供要读取的路径。'
      const scope = args?.scope === 'global' || path.startsWith('kb-global/') ? 'global' : 'workspace'
      try {
        const result = await kb.read({
          scope,
          path,
          start: args?.start,
          end: args?.end,
          cwd: cwdOf(exec?.agent),
        })
        return [
          `${scope === 'global' ? 'kb-global' : 'kb'}/${result.path}  第 ${result.start}-${result.end} 行（共 ${result.total} 行）`,
          '',
          result.content,
        ].join('\n')
      } catch (error) {
        return `读取失败：${error?.message ?? error}`
      }
    },
  })

  ctx.tools.register({
    name: 'scribe_kb_reindex',
    description:
      'Rebuild the knowledge-base index. Run it after adding or editing documents; a stale index also refreshes on its own TTL.',
    parameters: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['both', 'workspace', 'global'],
          description: 'Which scope to rebuild (default both).',
        },
      },
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    timeoutMs: 60_000,
    execute: async (args, exec) => {
      const scope = args?.scope === 'workspace' || args?.scope === 'global' ? args.scope : undefined
      const result = await kb.reindex({ scope, cwd: cwdOf(exec?.agent) })
      return Object.entries(result)
        .map(([name, index]) => {
          const stats = index.stats ?? {}
          return `${name}: ${Object.keys(index.files ?? {}).length} 个文件 / ${index.chunks?.length ?? 0} 块（新增 ${stats.indexed ?? 0}，复用 ${stats.reused ?? 0}，移除 ${stats.removed ?? 0}，${index.durationMs ?? 0}ms）`
        })
        .join('\n')
    },
  })

  ctx.tools.register({
    name: 'scribe_kb_status',
    description: 'Report what the knowledge base currently has indexed, per scope, and when it was last rebuilt.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: TEXT_OUTPUT,
    execute: async (_args, exec) => {
      const state = await kb.state({ cwd: cwdOf(exec?.agent) })
      if (!state.enabled) return '知识库已关闭。'
      const lines = []
      for (const [scope, info] of Object.entries(state.scopes)) {
        const label = scope === 'workspace' ? '工作区 kb/' : '全局知识库'
        lines.push(
          `${label}: ${info.exists ? '' : '（目录不存在）'}${info.files} 个文件 / ${info.chunks} 块`,
          `  路径: ${info.root}`,
          `  最近更新: ${info.generatedAt ? new Date(info.generatedAt).toISOString().replace('T', ' ').slice(0, 19) : '未建立索引'}`,
        )
        for (const file of info.topFiles.slice(0, 5)) lines.push(`    - ${file.path}（${file.chunks} 块）`)
      }
      return lines.join('\n')
    },
  })

  logger?.debug?.('knowledge base tools installed')
}

function cwdOf(agent) {
  try {
    const cwd = agent?.session?.header?.cwd
    return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
  } catch {
    return undefined
  }
}

export { citationOf }
