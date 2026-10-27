/**
 * `/memory` slash command.
 *
 * Commands are the human's own control surface: the plugin can print state and
 * run a migration only after `/memory migrate <to> --yes`, which is a second,
 * explicit act on top of the tool-side approval gate.
 *
 * @module dsh-scribe/tools/commands
 */

import { formatPlan, planMigration, readMigrations, rollbackMigration, runMigration } from '../migration/migrate.js'
import { isoDate, oneLine } from '../util.js'

/**
 * Register the command when the composition provides a command registry.
 * @param options - `{ ctx, service, config, logger }`.
 */
export function installCommands({ ctx, service, config, logger }) {
  const commands = ctx.get('commands')
  if (commands === undefined || typeof commands.register !== 'function') {
    logger?.debug?.('commands service unavailable; /memory command not registered')
    return
  }

  commands.register({
    name: 'memory',
    description: '查看和管理长期记忆：status | list | search <词> | save <内容> | migrate <provider> [--yes] | rollback <id>',
    input: { hint: 'status | list | search <词> | save <内容> | migrate <to> [--yes] | rollback <migration-id>' },
    handler: async ({ agent, rawInput }) => {
      const [head, ...rest] = String(rawInput ?? '').trim().split(/\s+/)
      const sub = (head ?? 'status').toLowerCase()
      try {
        switch (sub) {
          case 'status':
            return ok(await statusText(service, config))
          case 'list': {
            const limit = clampInt(rest[0], 1, 50, 10)
            const memories = await service.list({ limit })
            if (memories.length === 0) return ok('记忆为空。')
            return ok(
              memories
                .map((memory, index) => `${index + 1}. [${isoDate(memory.createdAt)}] ${oneLine(memory.content, 140)}\n   ${memory.id}`)
                .join('\n'),
            )
          }
          case 'search': {
            const query = rest.join(' ').trim()
            if (query.length === 0) return err('用法：/memory search <关键词>')
            const memories = await service.search(query, { limit: 8, agent })
            if (memories.length === 0) return ok(`没有匹配「${query}」的记忆。`)
            return ok(
              memories
                .map((memory, index) => `${index + 1}. [${isoDate(memory.createdAt)}] ${oneLine(memory.content, 140)}\n   ${memory.id}`)
                .join('\n'),
            )
          }
          case 'save': {
            const content = rest.join(' ').trim()
            if (content.length === 0) return err('用法：/memory save <要记住的内容>')
            const { memory, duplicate } = await service.add({
              content,
              source: 'user-explicit',
              tags: ['command'],
              sessionId: agent?.session?.id,
            })
            return ok(duplicate ? `已存在相同记忆（${memory.id}）。` : `已保存记忆 ${memory.id}。`)
          }
          case 'migrate': {
            const to = rest[0]
            const confirmed = rest.includes('--yes') || rest.includes('-y')
            if (to === undefined) return err(`用法：/memory migrate <provider> [--yes]\n已配置：${Object.keys(config.providers).join(', ')}`)
            if (config.providers[to] === undefined) return err(`未知 provider「${to}」。已配置：${Object.keys(config.providers).join(', ')}`)
            const plan = await planMigration({ service, config, from: config.defaultProvider, to })
            if (!confirmed) {
              return ok(
                [
                  formatPlan(plan),
                  '',
                  '这是预览。确认无误后执行：',
                  `  /memory migrate ${to} --yes`,
                  '（agent 也可以调用 memory_migrate，那时你会收到一次审批确认。）',
                ].join('\n'),
              )
            }
            const record = await runMigration({ service, config, logger, from: plan.from, to: plan.to })
            return ok(
              [
                `迁移${record.status === 'complete' ? '完成' : record.status === 'partial' ? '部分完成' : '失败'}：${record.from} → ${record.to}`,
                `  成功 ${record.successCount} 条，失败 ${record.failedCount} 条，耗时 ${(record.durationMs / 1000).toFixed(1)} 秒`,
                `  迁移 id: ${record.id}`,
                `  撤销：/memory rollback ${record.id}`,
              ].join('\n'),
            )
          }
          case 'rollback': {
            const id = rest[0]
            if (id === undefined) {
              const journal = await readMigrations(config)
              if (journal.length === 0) return ok('没有迁移记录。')
              return ok(['最近的迁移：', ...journal.slice(0, 5).map((entry) => `  ${entry.id}  ${entry.from} → ${entry.to}  ${entry.status}`)].join('\n'))
            }
            const result = await rollbackMigration({ service, config, logger, migrationId: id })
            return ok(`已回滚 ${id}：删除 ${result.removed} 条，跳过 ${result.declined} 条。`)
          }
          case 'providers': {
            const lines = Object.entries(config.providers).map(
              ([id, entry]) => `${id === config.defaultProvider ? '*' : ' '} ${id} (${entry.type})${entry.type === 'local' ? `  ${entry.path}` : ''}`,
            )
            return ok(lines.join('\n'))
          }
          default:
            return err(`未知子命令「${sub}」。可用：status | list | search | save | migrate | rollback | providers`)
        }
      } catch (error) {
        logger?.warn?.('/memory %s failed: %s', sub, error?.message ?? error)
        return err(`执行失败：${error?.message ?? error}`)
      }
    },
  })
}

async function statusText(service, config) {
  const status = await service.status()
  const lines = [
    `后端: ${status.provider} (${status.type})${status.health ? '' : '  ⚠ 不可达'}`,
    `记忆条数: ${status.count}`,
    `嵌入: ${status.embedding}`,
    `自动注入: ${status.autoInject ? '开启' : '关闭'}`,
  ]
  if (status.oldest) lines.push(`时间范围: ${status.oldest} 至 ${status.newest}`)
  lines.push(`数据目录: ${config.dataDir}`)
  return lines.join('\n')
}

function ok(text) {
  return { kind: 'success', text }
}

function err(text) {
  return { kind: 'error', text }
}

function clampInt(value, min, max, fallback) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.floor(parsed)))
}
