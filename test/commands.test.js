import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { resolveConfig } from '../src/config.js'
import { createMemoryService } from '../src/memory-service.js'
import { installCommands } from '../src/tools/commands.js'

const logger = { debug() {}, info() {}, warn() {}, error() {} }

/** Capture the one registered command and expose a runner. */
async function mount() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-scribe-cmd-'))
  const config = resolveConfig({
    dataDir: dir,
    defaultProvider: 'local',
    providers: {
      local: { type: 'local', path: join(dir, 'data') },
      other: { type: 'local', path: join(dir, 'other') },
    },
  })
  const service = createMemoryService({ ctx: { get: () => undefined }, config, logger })
  let registered
  const ctx = {
    get: (name) => (name === 'commands' ? { register: (definition) => { registered = definition } } : undefined),
  }
  installCommands({ ctx, service, config, logger })
  const run = (rawInput) => registered.handler({ agent: undefined, rawInput, attachments: [], signal: new AbortController().signal })
  return { dir, config, service, definition: registered, run }
}

test('command: registers under the name memory', async () => {
  const { dir, definition } = await mount()
  try {
    assert.equal(definition.name, 'memory')
    assert.match(definition.description, /status/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('command: status and save round-trip', async () => {
  const { dir, run } = await mount()
  try {
    const status = await run('status')
    assert.equal(status.kind, 'success')
    assert.match(status.text, /后端: local/)

    const saved = await run('save 约定：提交前必须跑 node --test')
    assert.equal(saved.kind, 'success')
    assert.match(saved.text, /已保存记忆/)

    const list = await run('list')
    assert.match(list.text, /提交前必须跑/)

    const search = await run('search 提交前')
    assert.match(search.text, /node --test/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('command: migrate prints a plan and writes nothing without --yes', async () => {
  const { dir, run, service } = await mount()
  try {
    await run('save 需要迁移的记忆')
    const preview = await run('migrate other')
    assert.equal(preview.kind, 'success')
    assert.match(preview.text, /检测到现有记忆数据/)
    assert.match(preview.text, /--yes/)
    assert.equal(await service.providerFor('other').count(), 0)

    const applied = await run('migrate other --yes')
    assert.match(applied.text, /迁移完成/)
    const migrationId = /迁移 id: (\S+)/.exec(applied.text)?.[1]
    assert.ok(migrationId)
    assert.equal(await service.providerFor('other').count(), 1)

    const rolled = await run(`rollback ${migrationId}`)
    assert.match(rolled.text, /删除 1 条/)
    assert.equal(await service.providerFor('other').count(), 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('command: unknown subcommand is an error, not a crash', async () => {
  const { dir, run } = await mount()
  try {
    const result = await run('nonsense')
    assert.equal(result.kind, 'error')
    assert.match(result.text, /未知子命令/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('command: providers marks the active backend', async () => {
  const { dir, run } = await mount()
  try {
    const result = await run('providers')
    assert.match(result.text, /\*\s*local/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
