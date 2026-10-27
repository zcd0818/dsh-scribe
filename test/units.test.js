import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import test from 'node:test'

import { resolveConfig } from '../src/config.js'
import { JsonlStore } from '../src/store.js'
import { LocalProvider } from '../src/providers/local.js'
import { createMemoryService } from '../src/memory-service.js'
import { cosineSimilarity, lexicalScore, normalizeContent, tokenize, truncate } from '../src/util.js'

const logger = { debug() {}, info() {}, warn() {}, error() {} }

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'dsh-scribe-test-'))
}

function stubCtx() {
  return { get: () => undefined }
}

test('config: defaults resolve into a usable local provider', () => {
  const config = resolveConfig({})
  assert.equal(config.defaultProvider, 'local')
  assert.equal(config.providers.local.type, 'local')
  assert.ok(isAbsolute(config.providers.local.path), 'default data dir must be absolute')
  assert.equal(config.autoInject, true)
})

test('config: unknown default provider fails loud', () => {
  assert.throws(() => resolveConfig({ defaultProvider: 'nope' }), /defaultProvider/)
})

test('config: unknown provider type fails loud', () => {
  assert.throws(() => resolveConfig({ providers: { remote: { type: 'ftp' } } }), /unknown type/)
})

test('config: env secret expansion', () => {
  process.env.DSH_MEMORY_TEST_KEY = 'sk-test-123'
  const config = resolveConfig({ providers: { bailian: { type: 'bailian', apiKey: 'env:DSH_MEMORY_TEST_KEY' } } })
  assert.equal(config.providers.bailian.apiKey, 'sk-test-123')
  delete process.env.DSH_MEMORY_TEST_KEY
})

test('util: CJK bigrams and latin tokens', () => {
  const tokens = tokenize('使用 chromadb 做向量检索')
  assert.ok(tokens.includes('chromadb'))
  assert.ok(tokens.includes('向量'))
  assert.ok(tokens.includes('检索'))
})

test('util: lexical score prefers the memory that shares the query', () => {
  const query = '数据迁移必须经过用户确认'
  const relevant = { content: '决定：数据迁移必须经过用户明确同意，绝不自动执行', tags: [] }
  const unrelated = { content: '今天测试了 ChromaDB 的写入性能', tags: [] }
  assert.ok(lexicalScore(query, relevant) > lexicalScore(query, unrelated))
})

test('util: cosine similarity handles unusable input', () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1)
  assert.equal(cosineSimilarity([], [1]), 0)
  assert.equal(cosineSimilarity([1, 2], [1, 2, 3]), 0)
})

test('util: truncate and normalize', () => {
  assert.equal(truncate('abcdef', 4), 'abc…')
  assert.equal(normalizeContent('  a\n\n\n\nb  '), 'a\n\nb')
})

test('store: records survive a reopen and deletes are durable', async () => {
  const dir = await tempDir()
  try {
    const file = join(dir, 'm.jsonl')
    const store = new JsonlStore(file)
    await store.put({ id: 'a', content: 'one' })
    await store.put({ id: 'b', content: 'two' })
    await store.delete('a')

    const reopened = new JsonlStore(file)
    const all = await reopened.all()
    assert.deepEqual(all.map((record) => record.id), ['b'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('store: replaceAll rewrites the file atomically', async () => {
  const dir = await tempDir()
  try {
    const file = join(dir, 'm.jsonl')
    const store = new JsonlStore(file)
    await store.put({ id: 'a', content: 'one' })
    await store.replaceAll([{ id: 'c', content: 'three' }])
    const reopened = new JsonlStore(file)
    assert.deepEqual((await reopened.all()).map((record) => record.id), ['c'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('local provider: list filters by tag and pages newest first', async () => {
  const dir = await tempDir()
  try {
    const provider = new LocalProvider('local', { config: { type: 'local', path: dir, engine: 'file' }, logger })
    await provider.bulkAdd([
      { id: '1', content: 'a', createdAt: 3, tags: ['project:x'] },
      { id: '2', content: 'b', createdAt: 1, tags: [] },
      { id: '3', content: 'c', createdAt: 2, tags: ['project:x', 'decision'] },
    ])
    assert.deepEqual((await provider.list({})).map((m) => m.id), ['1', '3', '2'])
    assert.deepEqual((await provider.list({ tags: ['project:x'] })).map((m) => m.id), ['1', '3'])
    assert.deepEqual((await provider.list({ limit: 1, offset: 1 })).map((m) => m.id), ['3'])
    assert.equal(await provider.count(), 3)
    assert.equal(await provider.health(), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('service: deduplicates identical content and searches by relevance', async () => {
  const dir = await tempDir()
  try {
    const config = resolveConfig({ dataDir: dir, providers: { local: { type: 'local', path: join(dir, 'data') } } })
    const service = createMemoryService({ ctx: stubCtx(), config, logger })

    const first = await service.add({ content: '决定：本地默认存储，云端可选同步', tags: ['decision'] })
    const second = await service.add({ content: '决定：本地默认存储，云端可选同步', tags: ['decision'] })
    assert.equal(first.duplicate, false)
    assert.equal(second.duplicate, true)

    await service.add({ content: '测试 ChromaDB 写入性能', tags: ['test'] })
    const hits = await service.search('云端同步', { limit: 1, rerank: false })
    assert.equal(hits.length, 1)
    assert.match(hits[0].content, /本地默认存储/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('service: recent returns newest first and prompt text stays bounded', async () => {
  const dir = await tempDir()
  try {
    const config = resolveConfig({ dataDir: dir, injectMaxChars: 120, providers: { local: { type: 'local', path: join(dir, 'data') } } })
    const service = createMemoryService({ ctx: stubCtx(), config, logger })
    for (let index = 0; index < 4; index += 1) {
      await service.add({ content: `记忆编号 ${index} 内容` })
    }
    const recent = await service.recent({ limit: 2 })
    assert.equal(recent.length, 2)
    assert.equal(recent[0].content, '记忆编号 3 内容')

    const text = service.formatForPrompt(recent, { maxChars: 120 })
    assert.match(text, /长期记忆/)
    assert.ok(text.length <= 200)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('service: status reports provider and health', async () => {
  const dir = await tempDir()
  try {
    const config = resolveConfig({ dataDir: dir, providers: { local: { type: 'local', path: join(dir, 'data') } } })
    const service = createMemoryService({ ctx: stubCtx(), config, logger })
    await service.add({ content: '一条记忆' })
    const status = await service.status()
    assert.equal(status.provider, 'local')
    assert.equal(status.count, 1)
    assert.equal(status.health, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
