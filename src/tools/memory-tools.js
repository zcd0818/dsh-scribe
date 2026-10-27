/**
 * Model-facing memory tools.
 *
 * The session-start section only ever carries a handful of memories, so the
 * model needs a way to ask for more: these tools are the deliberate-retrieval
 * layer. Every definition is a plain object — no package import — so the bundle
 * runs against the Host with builtins only.
 *
 * @module dsh-scribe/tools/memory-tools
 */

import { formatBytes, isoDate, oneLine } from '../util.js'
import { formatPlan, planMigration, readMigrations, rollbackMigration, runMigration } from '../migration/migrate.js'

/** Output contract shared by every memory tool: one text block. */
const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}

/**
 * Install every memory tool on the plugin context.
 * @param options - `{ ctx, service, config, logger }`.
 */
export function installMemoryTools({ ctx, service, config, logger }) {
  ctx.tools.register({
    name: 'memory_save',
    description:
      'Save one durable memory for future sessions: a decision, a convention, a user preference, or an unresolved todo. ' +
      'Use this when the user says to remember something, or when you reach a conclusion that should survive this session. ' +
      'Do not save transient task state or restate the conversation.',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The memory itself, at most a few hundred characters. One fact per call.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional labels, e.g. ["project:foo", "decision"].',
        },
      },
      required: ['content'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    execute: async (args, exec) => {
      const content = String(args?.content ?? '').trim()
      if (content.length === 0) return '未保存：content 为空。'
      const { memory, duplicate } = await service.add({
        content,
        source: 'user-explicit',
        tags: args?.tags,
        sessionId: exec?.agent?.session?.id,
        metadata: { cwd: cwdOf(exec?.agent) },
      })
      return duplicate
        ? `已存在相同记忆（${memory.id}），未重复写入。`
        : `已保存记忆 ${memory.id}：${oneLine(memory.content, 120)}`
    },
  })

  ctx.tools.register({
    name: 'memory_search',
    description:
      'Search long-term memory written by earlier sessions. Use it when the current task may depend on past decisions, ' +
      'conventions, or user preferences that are not already in the injected memory block.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you are trying to recall, in natural language.' },
        limit: { type: 'integer', description: 'How many memories to return (1-20, default 5).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    timeoutMs: 30_000,
    execute: async (args, exec) => {
      const query = String(args?.query ?? '').trim()
      if (query.length === 0) return '请输入查询内容。'
      const limit = clampInt(args?.limit, 1, 20, 5)
      const memories = await service.search(query, { limit, agent: exec?.agent })
      if (memories.length === 0) return `没有找到与「${oneLine(query, 60)}」相关的记忆。`
      return memories
        .map((memory, index) => {
          const tags = memory.tags?.length ? ` (${memory.tags.slice(0, 3).join(', ')})` : ''
          return `${index + 1}. [${isoDate(memory.createdAt)}]${tags} ${oneLine(memory.content, 400)}\n   id: ${memory.id}`
        })
        .join('\n')
    },
  })

  ctx.tools.register({
    name: 'memory_list',
    description: 'List the most recent long-term memories, newest first. Use it to see what is stored before saving a duplicate.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'How many to list (1-50, default 10).' },
        offset: { type: 'integer', description: 'Skip this many entries (default 0).' },
      },
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    execute: async (args) => {
      const limit = clampInt(args?.limit, 1, 50, 10)
      const offset = clampInt(args?.offset, 0, 100_000, 0)
      const memories = await service.list({ limit, offset })
      if (memories.length === 0) return '记忆为空。'
      return memories
        .map(
          (memory, index) =>
            `${offset + index + 1}. [${isoDate(memory.createdAt)}] ${oneLine(memory.content, 160)}\n   id: ${memory.id}`,
        )
        .join('\n')
    },
  })

  ctx.tools.register({
    name: 'memory_forget',
    description: 'Delete one memory by id. Only do this when the user asks to forget it, or when the memory is verifiably wrong.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The memory id shown by memory_list or memory_search.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    execute: async (args) => {
      const id = String(args?.id ?? '').trim()
      if (id.length === 0) return '请提供要删除的记忆 id。'
      const removed = await service.delete(id)
      return removed ? `已删除记忆 ${id}。` : `没有找到记忆 ${id}，未删除任何内容。`
    },
  })

  ctx.tools.register({
    name: 'memory_status',
    description: 'Report which memory backend is active, how many memories are stored, and whether it is reachable.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: TEXT_OUTPUT,
    execute: async () => {
      const status = await service.status()
      const lines = [
        `后端: ${status.provider} (${status.type})`,
        `记忆条数: ${status.count}`,
        `可用性: ${status.health ? '正常' : '不可达'}`,
        `嵌入: ${status.embedding}`,
        `自动注入: ${status.autoInject ? '开启' : '关闭'}`,
      ]
      if (status.oldest) lines.push(`时间范围: ${status.oldest} 至 ${status.newest}`)
      const local = config.providers[config.defaultProvider]
      if (local?.type === 'local') {
        const size = await service.provider.size?.().catch(() => 0)
        if (size) lines.push(`本地占用: ${formatBytes(size)}`)
      }
      return lines.join('\n')
    },
  })

  ctx.tools.register({
    name: 'memory_migrate',
    description:
      'Copy memories from the active provider to another configured provider. Requires the user to approve the operation; ' +
      'nothing is written before that approval. Shows the plan first, then migrates, then records an undoable journal entry.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Target provider id from config.providers, e.g. "bailian".' },
        limit: { type: 'integer', description: 'Optional cap on how many memories to copy (default: all).' },
      },
      required: ['to'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    timeoutMs: 300_000,
    execute: async (args, exec) => {
      const to = String(args?.to ?? '').trim()
      if (to.length === 0) return '请提供目标 provider id。'
      if (to === config.defaultProvider) return `目标 provider 与当前 provider 相同（${to}），无需迁移。`
      if (config.providers[to] === undefined) {
        return `未知 provider「${to}」。已配置：${Object.keys(config.providers).join(', ')}`
      }

      const plan = await planMigration({ service, config, from: config.defaultProvider, to })
      if (plan.source.count === 0) return `源 provider「${plan.from}」没有记忆，无需迁移。`

      const approved = await requestApproval({
        ctx,
        logger,
        agent: exec?.agent,
        toolName: 'memory_migrate',
        reason: formatPlan(plan),
        en: `Copy ${plan.source.count} memories from ${plan.from} to ${plan.to}?`,
        zh: `要把 ${plan.source.count} 条记忆从 ${plan.from} 迁移到 ${plan.to} 吗？`,
      })
      if (!approved) return '用户未批准迁移，未写入任何数据。'

      const progress = []
      const record = await runMigration({
        service,
        config,
        logger,
        from: plan.from,
        to: plan.to,
        ids: Number(args?.limit) > 0 ? (await service.providerFor(plan.from).bulkExport()).slice(0, Number(args.limit)).map((m) => m.id) : undefined,
        onProgress: ({ done, total }) => progress.push(`${done}/${total}`),
      })

      return [
        `迁移完成：${record.status}`,
        `  ${record.from} → ${record.to}`,
        `  成功 ${record.successCount} 条，失败 ${record.failedCount} 条，耗时 ${(record.durationMs / 1000).toFixed(1)} 秒`,
        `  迁移 id: ${record.id}（可回滚）`,
        record.failedCount > 0 ? '  有失败项，可重试或使用 memory_migrate_rollback 撤销本次新增。' : '',
      ]
        .filter((line) => line.length > 0)
        .join('\n')
    },
  })

  ctx.tools.register({
    name: 'memory_migrate_rollback',
    description:
      'Undo a migration by deleting exactly the memories that migration added to its target. Requires user approval.',
    parameters: {
      type: 'object',
      properties: {
        migration_id: { type: 'string', description: 'The migration id reported by memory_migrate.' },
      },
      required: ['migration_id'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    timeoutMs: 120_000,
    execute: async (args, exec) => {
      const migrationId = String(args?.migration_id ?? '').trim()
      if (migrationId.length === 0) {
        const journal = await readMigrations(config)
        if (journal.length === 0) return '没有迁移记录。'
        return ['最近的迁移：', ...journal.slice(0, 5).map((entry) => `  ${entry.id}  ${entry.from} → ${entry.to}  ${entry.status}  ${entry.timestamp}`)].join('\n')
      }
      const approved = await requestApproval({
        ctx,
        logger,
        agent: exec?.agent,
        toolName: 'memory_migrate_rollback',
        reason: `回滚迁移 ${migrationId}：只删除这次迁移写入目标端的新增记录。`,
        en: `Roll back migration ${migrationId}?`,
        zh: `要回滚迁移 ${migrationId} 吗？`,
      })
      if (!approved) return '用户未批准回滚，未删除任何数据。'
      const result = await rollbackMigration({ service, config, logger, migrationId })
      return [
        `已回滚迁移 ${migrationId}。`,
        `  删除 ${result.removed} 条，跳过 ${result.declined} 条。`,
      ].join('\n')
    },
  })
}

/**
 * Ask the user through the approval service. Fails closed: no answerer, a
 * denied policy, or a rejection all mean "not approved".
 * @param options - `{ ctx, logger, agent, toolName, reason, en, zh }`.
 * @returns whether the user approved this exact operation.
 */
async function requestApproval({ ctx, logger, agent, toolName, reason, en, zh }) {
  const approval = ctx.get('approval')
  if (approval === undefined || typeof approval.request !== 'function') {
    logger.warn('approval service unavailable; refusing %s', toolName)
    return false
  }
  if (agent === undefined) {
    logger.warn('no agent for %s approval; refusing', toolName)
    return false
  }
  try {
    const outcome = await approval.request({
      agent,
      toolName,
      reason,
      displayReason: { en, zh },
    })
    logger.debug('%s approval outcome: %s', toolName, outcome)
    return outcome === 'allowed-once'
  } catch (error) {
    logger.warn('%s approval failed: %s', toolName, error?.message ?? error)
    return false
  }
}

function clampInt(value, min, max, fallback) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.floor(parsed)))
}

function cwdOf(agent) {
  try {
    const cwd = agent?.session?.header?.cwd
    return typeof cwd === 'string' ? cwd : undefined
  } catch {
    return undefined
  }
}
