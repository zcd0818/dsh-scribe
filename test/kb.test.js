import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { resolveConfig } from '../src/config.js'
import { chunkMarkdown, citationOf, globToRegExp, matchesAny, splitLongBody } from '../src/kb/chunk.js'
import { buildIndex, listDocuments } from '../src/kb/indexer.js'
import { KbService, createKbService, formatHit } from '../src/kb/service.js'

const logger = { debug() {}, info() {}, warn() {}, error() {} }

test('chunk: headings become sections with line ranges', () => {
  const text = [
    '# 标题',
    '',
    '开头一段，说明这个文档是干什么的。',
    '',
    '## 第一节',
    '',
    '第一节的内容，比较长一点，方便断言。',
    '',
    '### 子节',
    '',
    '子节的内容。',
    '',
    '## 第二节',
    '',
    '第二节内容。',
  ].join('\n')
  const chunks = chunkMarkdown(text, { minChars: 1 })
  assert.ok(chunks.length >= 3, `expected several chunks, got ${chunks.length}`)
  const first = chunks.find((chunk) => chunk.heading === '标题')
  assert.ok(first, 'a chunk should carry the h1 heading')
  assert.equal(first.startLine, 3)
  const nested = chunks.find((chunk) => chunk.heading === '标题 > 第一节 > 子节')
  assert.ok(nested, 'heading path should nest')
  assert.match(nested.content, /子节的内容/)
})

test('chunk: an oversized section splits at paragraph boundaries', () => {
  const paragraph = '甲'.repeat(300)
  const body = [paragraph, paragraph, paragraph].join('\n\n')
  const pieces = splitLongBody(body, 400)
  assert.ok(pieces.length >= 2)
  for (const piece of pieces) assert.ok(piece.length <= 420, `piece too long: ${piece.length}`)
})

test('chunk: citations carry scope, path and line range', () => {
  assert.equal(
    citationOf({ scope: 'workspace', path: '设计规范.md', startLine: 12, endLine: 40 }),
    'kb/设计规范.md#L12-L40',
  )
  assert.equal(citationOf({ scope: 'global', path: '术语.md', startLine: 5, endLine: 5 }), 'kb-global/术语.md#L5')
})

test('chunk: globs match nested paths and excludes', () => {
  assert.equal(globToRegExp('**/*.md').test('a/b/c.md'), true)
  assert.equal(globToRegExp('**/*.md').test('c.txt'), false)
  assert.equal(matchesAny('inbox/raw.md', ['**/inbox/**']), true)
  assert.equal(matchesAny('原始/截图.md', ['**/原始/**']), true)
  assert.equal(matchesAny('设计规范.md', ['**/inbox/**']), false)
})

test('indexer: builds, reuses unchanged files, and drops removed ones', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-kb-index-'))
  try {
    const kb = join(dir, 'kb')
    await mkdir(join(kb, 'inbox'), { recursive: true })
    await writeFile(join(kb, 'a.md'), '# A\n\n## 一\n\n甲内容，足够长以便成为一块。\n', 'utf8')
    await writeFile(join(kb, 'sub.md'), '# B\n\n乙内容，也足够长以便成为一块。\n', 'utf8')
    await writeFile(join(kb, 'inbox', 'raw.md'), '# RAW\n\n不该被索引。\n', 'utf8')

    const first = await buildIndex({ scope: 'workspace', root: kb, chunkOptions: { minChars: 1 }, logger })
    assert.equal(Object.keys(first.files).length, 2, 'inbox must be excluded')
    assert.ok(first.chunks.length >= 2)

    const second = await buildIndex({ scope: 'workspace', root: kb, previous: first, chunkOptions: { minChars: 1 }, logger })
    assert.equal(second.stats.reused, 2)
    assert.equal(second.stats.indexed, 0)
    assert.equal(second.chunks.length, first.chunks.length)

    await rm(join(kb, 'sub.md'))
    const third = await buildIndex({ scope: 'workspace', root: kb, previous: second, chunkOptions: { minChars: 1 }, logger })
    assert.equal(third.stats.removed, 1)
    assert.deepEqual(Object.keys(third.files), ['a.md'])
    assert.ok(third.chunks.every((chunk) => chunk.path === 'a.md'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('indexer: nested directories are walked and sorted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-kb-walk-'))
  try {
    await mkdir(join(dir, 'a', 'b'), { recursive: true })
    await writeFile(join(dir, 'a', 'b', 'deep.md'), '# D\n', 'utf8')
    await writeFile(join(dir, 'top.md'), '# T\n', 'utf8')
    const listed = await listDocuments(dir)
    assert.deepEqual(listed.map((entry) => entry.rel), ['a/b/deep.md', 'top.md'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

async function workspaceFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-kb-svc-'))
  const kb = join(dir, 'kb')
  await mkdir(kb, { recursive: true })
  await writeFile(
    join(kb, 'INDEX.md'),
    ['# 知识库索引', '- 设计规范.md —— 命名与错误处理约定', '- 部署.md —— 发布流程'].join('\n'),
    'utf8',
  )
  await writeFile(
    join(kb, '设计规范.md'),
    ['# 设计规范', '', '## 错误处理', '', '所有对外函数必须返回结构化错误，禁止抛裸字符串。', '', '## 命名', '', '文件名用小写短横线。'].join('\n'),
    'utf8',
  )
  await writeFile(join(kb, '部署.md'), ['# 部署', '', '发布走 deploy.sh，先 staging 再 promote。'].join('\n'), 'utf8')
  const config = resolveConfig({
    dataDir: join(dir, 'data'),
    knowledgeBase: { refreshSeconds: 0, minScore: 0.05, chunk: { minChars: 5 } },
  })
  return { dir, kb, config, service: createKbService({ config, logger }), cleanup: () => rm(dir, { recursive: true, force: true }) }
}

test('service: workspace search returns citations and prefers workspace scope', async () => {
  const fixture = await workspaceFixture()
  try {
    const globalRoot = join(fixture.dir, 'data', 'kb', 'global')
    await mkdir(globalRoot, { recursive: true })
    await writeFile(join(globalRoot, '通用.md'), '# 通用\n\n错误处理要统一。\n', 'utf8')

    const { hits } = await fixture.service.search('错误处理', { cwd: fixture.dir, limit: 5 })
    assert.ok(hits.length >= 1)
    assert.equal(hits[0].scope, 'workspace', 'a workspace hit should outrank the global one')
    assert.match(citationOf(hits[0]), /^kb\//)
    assert.match(formatHit(hits[0], 1), /^1\. kb\//)
  } finally {
    await fixture.cleanup()
  }
})

test('service: digest uses INDEX.md and stays bounded', async () => {
  const fixture = await workspaceFixture()
  try {
    const digest = await fixture.service.digest({ cwd: fixture.dir })
    assert.match(digest, /知识库目录/)
    assert.match(digest, /设计规范\.md/)
    assert.match(digest, /scribe_kb_search/)
    assert.ok(digest.length <= 1300)
  } finally {
    await fixture.cleanup()
  }
})

test('service: reading a range returns numbered lines', async () => {
  const fixture = await workspaceFixture()
  try {
    const result = await fixture.service.read({ scope: 'workspace', path: '设计规范.md', start: 3, end: 5, cwd: fixture.dir })
    assert.equal(result.total, 9)
    assert.equal(result.lines.length, 3)
    assert.equal(result.lines[0].n, 3)
    assert.match(result.content, /│/)
    await assert.rejects(() => fixture.service.read({ scope: 'workspace', path: '../escape.md', cwd: fixture.dir }), /\.\./)
  } finally {
    await fixture.cleanup()
  }
})

test('service: state reports both scopes and a missing workspace dir is not an error', async () => {
  const fixture = await workspaceFixture()
  try {
    const state = await fixture.service.state({ cwd: fixture.dir })
    assert.equal(state.enabled, true)
    // INDEX.md is a document too: the digest reads it, and it is indexed.
    assert.equal(state.scopes.workspace.files, 3)
    assert.ok(state.scopes.workspace.chunks >= 2)
    assert.equal(state.scopes.global.exists, false)
    assert.equal(state.scopes.global.files, 0)

    const elsewhere = await fixture.service.state({ cwd: join(fixture.dir, 'nope') })
    assert.equal(elsewhere.scopes.workspace.files, 0)
    assert.equal(elsewhere.scopes.workspace.exists, false)
  } finally {
    await fixture.cleanup()
  }
})

test('service: disabled knowledge base answers empty instead of throwing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-kb-off-'))
  try {
    const config = resolveConfig({ dataDir: dir, knowledgeBase: { enabled: false } })
    const service = new KbService({ config, logger })
    const { hits } = await service.search('任何东西', { cwd: dir })
    assert.deepEqual(hits, [])
    assert.equal(await service.digest({ cwd: dir }), '')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('service: peek reports a stored index without building one', async () => {
  const fixture = await workspaceFixture()
  try {
    const before = await fixture.service.peek({ cwd: fixture.dir })
    assert.equal(before.files, 0, 'peek must not build an index')
    assert.equal(before.exists, true)

    await fixture.service.reindex({ scope: 'workspace', cwd: fixture.dir })
    const after = await fixture.service.peek({ cwd: fixture.dir })
    assert.equal(after.files, 3)
    assert.ok(after.chunks >= 2)
    assert.ok(after.generatedAt > 0)
  } finally {
    await fixture.cleanup()
  }
})

test('service: rebuilding the global scope creates its directory', async () => {
  const fixture = await workspaceFixture()
  try {
    const before = await fixture.service.peek({ scope: 'global' })
    assert.equal(before.exists, false, 'the global directory starts absent')

    await fixture.service.reindex({ scope: 'global' })
    const after = await fixture.service.peek({ scope: 'global' })
    assert.equal(after.exists, true, 'rebuild must leave a usable directory behind')
    assert.equal(after.files, 0)

    // A document dropped in afterwards is picked up by the next build.
    await writeFile(join(after.root, '术语.md'), '# 术语\n\nDSH = DeepSeek Harness。\n', 'utf8')
    const built = await fixture.service.reindex({ scope: 'global' })
    assert.equal(Object.keys(built.global.files).length, 1)
  } finally {
    await fixture.cleanup()
  }
})

test('indexer: the default include list covers text and code, not binaries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-kb-types-'))
  try {
    const kb = join(dir, 'kb')
    await mkdir(kb, { recursive: true })
    await writeFile(join(kb, 'a.md'), '# A\n\nMarkdown 内容。\n', 'utf8')
    await writeFile(join(kb, 'b.txt'), '纯文本内容，没有标题。\n', 'utf8')
    await writeFile(join(kb, 'c.json'), '{"note":"结构化说明"}\n', 'utf8')
    await writeFile(join(kb, 'd.ts'), 'export const value = 1\n', 'utf8')
    await writeFile(join(kb, 'e.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    await writeFile(join(kb, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8')

    const config = resolveConfig({ dataDir: join(dir, 'data'), knowledgeBase: { chunk: { minChars: 5 } } })
    const service = createKbService({ config, logger })
    const index = await service.reindex({ scope: 'workspace', cwd: dir })
    const files = Object.keys(index.workspace.files).sort()
    assert.deepEqual(files, ['a.md', 'b.txt', 'c.json', 'd.ts'], 'text and code are indexed; png and lockfiles are not')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
