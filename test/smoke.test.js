import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'

/**
 * Minimal Cordis-context stand-in: enough surface for `apply()` and the two
 * lifecycle events, so the mount path is exercised without a Host process.
 */
function fakeCtx() {
  const listeners = new Map()
  const tools = new Map()
  const sections = []
  return {
    get: () => undefined,
    on(event, handler) {
      listeners.set(event, handler)
      return () => listeners.delete(event)
    },
    effect(callback) {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {
          const index = sections.indexOf(section)
          if (index >= 0) sections.splice(index, 1)
        }
      },
    },
    logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
    __listeners: listeners,
    __tools: tools,
    __sections: sections,
  }
}

function fakeAgent({ id, cwd, origin, messages = [] }) {
  const agentSections = []
  return {
    id,
    ctx: {
      systemPrompt: {
        section(section) {
          agentSections.push(section)
          return () => {
            const index = agentSections.indexOf(section)
            if (index >= 0) agentSections.splice(index, 1)
          }
        },
      },
    },
    session: {
      id,
      header: { cwd, ...(origin ? { origin } : {}) },
      deriveMessages: () => messages,
      requestHeader: () => undefined,
    },
    __sections: agentSections,
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 25))

test('apply: mounts tools and lifecycle listeners without a full Host', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-scribe-smoke-'))
  try {
    const ctx = fakeCtx()
    apply(ctx, {
      dataDir: dir,
      providers: { local: { type: 'local', path: join(dir, 'data') } },
    })

    for (const name of [
      'memory_save',
      'memory_search',
      'memory_list',
      'memory_forget',
      'memory_status',
      'memory_migrate',
      'memory_migrate_rollback',
    ]) {
      assert.ok(ctx.__tools.has(name), `tool ${name} should be registered`)
    }
    assert.ok(ctx.__listeners.has('agent/created'))
    assert.ok(ctx.__listeners.has('agent/disposed'))

    // Save one memory through the tool, exactly as the model would.
    const save = ctx.__tools.get('memory_save')
    const saved = await save.execute({ content: '项目约定：pnpm + node 20', tags: ['project:demo'] }, { agent: undefined })
    assert.match(saved, /已保存记忆/)

    // A session in that project sees it in the injected section text.
    const agent = fakeAgent({ id: 'sess-a', cwd: '/work/demo' })
    ctx.__listeners.get('agent/created')({ agent, source: 'start' })
    assert.deepEqual(
      agent.__sections.map((section) => section.name),
      ['memory:context', 'kb:context'],
      'memory and the knowledge digest are independent sections',
    )
    await tick()
    const text = agent.__sections[0].text()
    assert.match(text, /pnpm \+ node 20/)
    // No kb/ in that (nonexistent) working directory: the section stays empty.
    assert.equal(agent.__sections[1].text(), '')

    // Disposal removes the per-agent section.
    ctx.__listeners.get('agent/disposed')({ agent })
    assert.equal(agent.__sections.length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('apply: a short session is written back as one memory on dispose', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-scribe-smoke-'))
  try {
    const ctx = fakeCtx()
    apply(ctx, {
      dataDir: dir,
      providers: { local: { type: 'local', path: join(dir, 'data') } },
    })

    const messages = [
      { role: 'user', content: [{ type: 'text', text: '把记忆插件的数据目录改成 ~/.dsh/memory' }] },
      { role: 'assistant', content: [{ type: 'text', text: '已改，默认写在 dataDir 下' }] },
    ]
    const agent = fakeAgent({ id: 'sess-b', cwd: '/work/demo', messages })
    ctx.__listeners.get('agent/created')({ agent, source: 'start' })
    ctx.__listeners.get('agent/disposed')({ agent })
    await tick()
    await tick()

    const list = ctx.__tools.get('memory_list')
    const listed = await list.execute({ limit: 10 }, {})
    assert.match(listed, /~\/.dsh\/memory/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('apply: subagent sessions are skipped by default', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-scribe-smoke-'))
  try {
    const ctx = fakeCtx()
    apply(ctx, {
      dataDir: dir,
      providers: { local: { type: 'local', path: join(dir, 'data') } },
    })
    const agent = fakeAgent({ id: 'sess-child', cwd: '/work/demo', origin: 'subagent' })
    ctx.__listeners.get('agent/created')({ agent, source: 'start' })
    assert.equal(agent.__sections.length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('apply: migration refuses without an approval service', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-scribe-smoke-'))
  try {
    const ctx = fakeCtx()
    apply(ctx, {
      dataDir: dir,
      providers: {
        local: { type: 'local', path: join(dir, 'data') },
        other: { type: 'local', path: join(dir, 'other') },
      },
    })
    await ctx.__tools.get('memory_save').execute({ content: '待迁移的记忆' }, {})
    const text = await ctx.__tools.get('memory_migrate').execute({ to: 'other' }, { agent: undefined })
    assert.match(text, /未批准迁移/)
    assert.equal(await ctx.__tools.get('memory_status').execute({}, {}).then(() => 0), 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
