import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'
import { resolveConfig } from '../src/config.js'
import { JsonlStore } from '../src/store.js'
import { createKbService } from '../src/kb/service.js'

/**
 * Degradation and edge-case behaviour.
 *
 * A published plugin meets compositions it did not design for: missing optional
 * services, half-written state files, unreadable documents, huge files, and
 * several sessions at once. None of those may take a session down.
 */

const logger = { debug() {}, info() {}, warn() {}, error() {} }

/** A context with only what the plugin hard-depends on. */
function bareContext(overrides = {}) {
  const tools = new Map()
  const sections = []
  const listeners = new Map()
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
    inject: () => () => {},
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {}
      },
    },
    logger: () => logger,
    __tools: tools,
    __sections: sections,
    __listeners: listeners,
    ...overrides,
  }
}

test('robustness: mounts with only the hard-dependency services present', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mem-bare-'))
  try {
    const ctx = bareContext()
    apply(ctx, { dataDir: dir, providers: { local: { type: 'local', path: join(dir, 'data') } } })
    for (const name of ['scribe_memory_save', 'scribe_memory_search', 'scribe_kb_search', 'scribe_kb_read', 'scribe_kb_reindex', 'scribe_kb_status']) {
      assert.ok(ctx.__tools.has(name), `${name} should be registered without optional services`)
    }
    assert.ok(ctx.__listeners.has('agent/created'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('robustness: an invalid config disables the plugin instead of throwing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mem-badcfg-'))
  try {
    const ctx = bareContext()
    assert.doesNotThrow(() => apply(ctx, { dataDir: dir, defaultProvider: 'does-not-exist' }))
    assert.equal(ctx.__tools.size, 0, 'nothing registers from an unusable config')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('robustness: disabling the knowledge base removes its tools but keeps memory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mem-nokb-'))
  try {
    const ctx = bareContext()
    apply(ctx, {
      dataDir: dir,
      knowledgeBase: { enabled: false },
      providers: { local: { type: 'local', path: join(dir, 'data') } },
    })
    assert.ok(ctx.__tools.has('scribe_memory_save'))
    assert.equal(ctx.__tools.has('scribe_kb_search'), false)
    assert.equal(ctx.__tools.has('scribe_kb_reindex'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('robustness: a corrupted index file is rebuilt, not fatal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mem-corrupt-'))
  try {
    await mkdir(join(dir, 'kb'), { recursive: true })
    await writeFile(join(dir, 'kb', 'a.md'), '# A\n\n正文。\n', 'utf8')
    const config = resolveConfig({ dataDir: join(dir, 'data'), knowledgeBase: { refreshSeconds: 0 } })
    const service = createKbService({ config, logger })
    await service.reindex({ scope: 'workspace', cwd: dir })

    // Corrupt every stored index by hand.
    const indexDir = join(dir, 'data', 'kb', 'indexes')
    for (const name of await (await import('node:fs/promises')).readdir(indexDir)) {
      if (name.endsWith('.json')) await writeFile(join(indexDir, name), '{ this is not json', 'utf8')
    }

    const state = await service.state({ cwd: dir })
    assert.equal(state.scopes.workspace.files, 1, 'a torn index must be rebuilt')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('robustness: a kb path that is a file is treated as missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mem-filekb-'))
  try {
    await writeFile(join(dir, 'kb'), 'not a directory', 'utf8')
    const config = resolveConfig({ dataDir: join(dir, 'data'), knowledgeBase: { refreshSeconds: 0 } })
    const service = createKbService({ config, logger })
    const state = await service.state({ cwd: dir })
    assert.equal(state.scopes.workspace.exists, false)
    assert.equal(state.scopes.workspace.files, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('robustness: an unreadable document is skipped and the rest still index', async (t) => {
  // Permission bits are only enforced on POSIX, and root bypasses them entirely.
  if (process.platform === 'win32') return t.skip('chmod does not gate reads on Windows')
  if (typeof process.getuid === 'function' && process.getuid() === 0) return t.skip('root ignores permissions')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mem-unreadable-'))
  try {
    await mkdir(join(dir, 'kb'), { recursive: true })
    await writeFile(join(dir, 'kb', 'ok.md'), '# OK\n\n可读。\n', 'utf8')
    const secret = join(dir, 'kb', 'locked.md')
    await writeFile(secret, '# Locked\n\n不可读。\n', 'utf8')
    await chmod(secret, 0o000)
    const config = resolveConfig({ dataDir: join(dir, 'data'), knowledgeBase: { refreshSeconds: 0 } })
    const service = createKbService({ config, logger })
    const index = await service.reindex({ scope: 'workspace', cwd: dir })
    assert.deepEqual(Object.keys(index.workspace.files), ['ok.md'])
    assert.ok(index.workspace.stats.skipped >= 1)
  } finally {
    await chmod(join(dir, 'kb', 'locked.md'), 0o644).catch(() => {})
    await rm(dir, { recursive: true, force: true })
  }
})

test('robustness: an oversized document is skipped rather than read into memory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mem-big-'))
  try {
    await mkdir(join(dir, 'kb'), { recursive: true })
    await writeFile(join(dir, 'kb', 'huge.md'), `# Huge\n\n${'x'.repeat(600 * 1024)}\n`, 'utf8')
    await writeFile(join(dir, 'kb', 'small.md'), '# Small\n\n小文件。\n', 'utf8')
    const config = resolveConfig({ dataDir: join(dir, 'data'), knowledgeBase: { refreshSeconds: 0 } })
    const service = createKbService({ config, logger })
    const index = await service.reindex({ scope: 'workspace', cwd: dir })
    assert.deepEqual(Object.keys(index.workspace.files), ['small.md'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('robustness: concurrent indexing shares one build', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mem-concurrent-'))
  try {
    await mkdir(join(dir, 'kb'), { recursive: true })
    await writeFile(join(dir, 'kb', 'a.md'), '# A\n\n正文。\n', 'utf8')
    const config = resolveConfig({ dataDir: join(dir, 'data'), knowledgeBase: { refreshSeconds: 0 } })
    const service = createKbService({ config, logger })
    const [first, second, third] = await Promise.all([
      service.ensure('workspace', { cwd: dir }),
      service.ensure('workspace', { cwd: dir }),
      service.ensure('workspace', { cwd: dir }),
    ])
    assert.equal(first, second, 'concurrent callers share the same index object')
    assert.equal(second, third)
    assert.equal(Object.keys(first.files).length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('robustness: memory writes clamp length and reject empty content', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mem-clamp-'))
  try {
    const config = resolveConfig({ dataDir: dir, providers: { local: { type: 'local', path: join(dir, 'data') } } })
    const { createMemoryService } = await import('../src/memory-service.js')
    const service = createMemoryService({ ctx: { get: () => undefined }, config, logger })
    const { memory } = await service.add({ content: 'x'.repeat(9000) })
    assert.equal(memory.content.length, 4000, 'content is clamped so one memory cannot flood the prompt')
    await assert.rejects(() => service.add({ content: '   \n  ' }), /empty/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('robustness: a torn final JSONL line is tolerated on reload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mem-torn-'))
  try {
    const file = join(dir, 'memories.jsonl')
    const store = new JsonlStore(file)
    await store.put({ id: 'a', content: 'one' })
    await writeFile(file, `${await readFile(file, 'utf8')}{"id":"torn","content":`, 'utf8')
    const reopened = new JsonlStore(file)
    assert.deepEqual((await reopened.all()).map((record) => record.id), ['a'])
    assert.ok((await stat(file)).size > 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('robustness: a session without a session object does not throw', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mem-noagent-'))
  try {
    const ctx = bareContext()
    apply(ctx, { dataDir: dir, providers: { local: { type: 'local', path: join(dir, 'data') } } })
    const created = ctx.__listeners.get('agent/created')
    const disposed = ctx.__listeners.get('agent/disposed')
    assert.doesNotThrow(() => created({ agent: { id: 'sess-x', ctx: { systemPrompt: { section: () => () => {} } } } }))
    assert.doesNotThrow(() => disposed({ agent: { id: 'sess-x' } }))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('robustness: a large docx is indexed even though it exceeds the text-file ceiling', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mem-bigdoc-'))
  try {
    const { makeDocx } = await import('./zip-fixture.js')
    await mkdir(join(dir, 'kb'), { recursive: true })
    // ~700 KB of body text: over the 512 KB text ceiling, under the document one.
    await writeFile(join(dir, 'kb', '长文档.docx'), makeDocx(['季度目标', '长'.repeat(700 * 1024)]))
    const config = resolveConfig({ dataDir: join(dir, 'data'), knowledgeBase: { refreshSeconds: 0, chunk: { minChars: 5 } } })
    const service = createKbService({ config, logger })
    const index = await service.reindex({ scope: 'workspace', cwd: dir })
    assert.equal(index.workspace.stats.extracted, 1, 'documents use the larger ceiling')
    assert.ok(index.workspace.chunks.length >= 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('robustness: stale extraction caches are pruned when a document changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mem-prune-'))
  try {
    const { makeDocx } = await import('./zip-fixture.js')
    const { readdir } = await import('node:fs/promises')
    await mkdir(join(dir, 'kb'), { recursive: true })
    const file = join(dir, 'kb', 'note.docx')
    await writeFile(file, makeDocx(['第一版']))
    const config = resolveConfig({ dataDir: join(dir, 'data'), knowledgeBase: { refreshSeconds: 0, chunk: { minChars: 2 } } })
    const service = createKbService({ config, logger })
    await service.reindex({ scope: 'workspace', cwd: dir })
    const cacheDir = join(dir, 'data', 'kb', 'indexes', 'extracted')
    const first = (await readdir(cacheDir)).filter((name) => name.endsWith('.txt'))
    assert.equal(first.length, 1)

    // Rewrite the document with different content: the old cache must not linger.
    await writeFile(file, makeDocx(['第二版', '内容换了']))
    await new Promise((resolve) => setTimeout(resolve, 15))
    await service.reindex({ scope: 'workspace', cwd: dir })
    const second = (await readdir(cacheDir)).filter((name) => name.endsWith('.txt'))
    assert.equal(second.length, 1, 'exactly one cache file remains')
    assert.notEqual(second[0], first[0], 'the cache was replaced, not accumulated')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
