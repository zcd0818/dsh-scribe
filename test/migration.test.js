import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { resolveConfig } from '../src/config.js'
import { createMemoryService } from '../src/memory-service.js'
import { formatPlan, planMigration, readMigrations, rollbackMigration, runMigration } from '../src/migration/migrate.js'
import { countUserTurns, extractiveSummary, summarizeSession } from '../src/session/summarize.js'

const logger = { debug() {}, info() {}, warn() {}, error() {} }

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-scribe-migrate-'))
  const config = resolveConfig({
    dataDir: dir,
    defaultProvider: 'a',
    providers: {
      a: { type: 'local', path: join(dir, 'a') },
      b: { type: 'local', path: join(dir, 'b') },
    },
    logLevel: 'error',
  })
  const service = createMemoryService({ ctx: { get: () => undefined }, config, logger })
  return { dir, config, service }
}

test('migration: plan is read-only and reports both sides', async () => {
  const { dir, config, service } = await setup()
  try {
    await service.add({ content: '迁移测试记忆一' })
    await service.add({ content: '迁移测试记忆二' })
    const plan = await planMigration({ service, config, from: 'a', to: 'b' })
    assert.equal(plan.source.count, 2)
    assert.equal(plan.target.count, 0)
    // Nothing was written to the target by planning.
    assert.equal(await service.providerFor('b').count(), 0)
    assert.match(formatPlan(plan), /检测到现有记忆数据/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('migration: run copies records and journals the written ids', async () => {
  const { dir, config, service } = await setup()
  try {
    await service.add({ content: '迁移测试记忆一' })
    await service.add({ content: '迁移测试记忆二' })
    const record = await runMigration({ service, config, logger, from: 'a', to: 'b' })
    assert.equal(record.status, 'complete')
    assert.equal(record.successCount, 2)
    assert.equal(record.failedCount, 0)
    assert.equal(await service.providerFor('b').count(), 2)

    const journal = await readMigrations(config)
    assert.equal(journal[0].id, record.id)
    assert.equal(journal[0].writtenIds.length, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('migration: rollback removes exactly what the run added', async () => {
  const { dir, config, service } = await setup()
  try {
    const target = service.providerFor('b')
    await target.add({ id: 'pre-existing', content: '目标端原有记忆', createdAt: 1 })

    await service.add({ content: '迁移测试记忆一' })
    await service.add({ content: '迁移测试记忆二' })
    const record = await runMigration({ service, config, logger, from: 'a', to: 'b' })
    assert.equal(await target.count(), 3)

    const result = await rollbackMigration({ service, config, logger, migrationId: record.id })
    assert.equal(result.removed, 2)
    const remaining = await target.bulkExport()
    assert.deepEqual(remaining.map((memory) => memory.id), ['pre-existing'])

    // The source is untouched by either direction.
    assert.equal(await service.providerFor('a').count(), 2)
    // A second rollback of the same id is refused.
    await assert.rejects(
      () => rollbackMigration({ service, config, logger, migrationId: record.id }),
      /already rolled back/,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('summarize: short conversations stay extractive, long ones need a model', async () => {
  const turns = [
    { role: 'user', text: '帮我看看本地存储怎么选' },
    { role: 'assistant', text: '建议用文件 + 向量索引' },
  ]
  assert.equal(countUserTurns(turns), 1)
  assert.match(extractiveSummary(turns), /用户：/)

  const config = resolveConfig({})
  // No llm service in the stub context: a long conversation must fall back to
  // the extractive path instead of throwing.
  const agent = {
    session: {
      id: 'sess-1',
      deriveMessages: () => {
        const messages = []
        for (let index = 0; index < 24; index += 1) {
          messages.push({ role: index % 2 === 0 ? 'user' : 'assistant', content: [{ type: 'text', text: `第 ${index} 轮内容` }] })
        }
        return messages
      },
      requestHeader: () => undefined,
    },
    options: {},
  }
  const summary = await summarizeSession({ ctx: { get: () => undefined }, agent, config, logger })
  assert.ok(summary !== undefined)
  assert.equal(summary.kind, 'extractive-fallback')
  assert.equal(summary.turns, 12)
})

test('summarize: an empty transcript produces no memory', async () => {
  const agent = { session: { id: 'sess-2', deriveMessages: () => [], requestHeader: () => undefined }, options: {} }
  const summary = await summarizeSession({ ctx: { get: () => undefined }, agent, config: resolveConfig({}), logger })
  assert.equal(summary, undefined)
})
