import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { resolveConfig } from '../src/config.js'
import { readZipEntry, listZipEntries } from '../src/kb/zip.js'
import {
  docxXmlToText,
  extractDocument,
  extractionCapabilities,
  extractDocx,
  extractPdf,
  extractXlsx,
  sheetXmlToText,
} from '../src/kb/extract.js'
import { createKbService } from '../src/kb/service.js'
import { makeDocx, makeXlsx, makeZip } from './zip-fixture.js'

const logger = { debug() {}, info() {}, warn() {}, error() {} }

async function tempDir(prefix = 'dsh-kb-extract-') {
  return mkdtemp(join(tmpdir(), prefix))
}

test('zip: entries round-trip through the built-in reader', () => {
  const buffer = makeZip({ 'a.txt': 'hello', 'b/c.xml': '<x>1</x>' })
  assert.deepEqual(
    listZipEntries(buffer).map((entry) => entry.name).sort(),
    ['a.txt', 'b/c.xml'],
  )
  assert.equal(readZipEntry(buffer, 'a.txt').toString('utf8'), 'hello')
  assert.equal(readZipEntry(buffer, 'missing.txt'), undefined)
})

test('extract: docx paragraphs become lines', async () => {
  const dir = await tempDir()
  try {
    const file = join(dir, 'note.docx')
    await writeFile(file, makeDocx(['设计规范', '提交前必须跑 node --test。']))
    const result = await extractDocx(file)
    assert.equal(result.extractor, 'docx')
    assert.match(result.text, /设计规范/)
    assert.match(result.text, /提交前必须跑 node --test/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('extract: xlsx cells resolve through the shared string table', async () => {
  const dir = await tempDir()
  try {
    const file = join(dir, 'sheet.xlsx')
    await writeFile(file, makeXlsx([['主播', '时长'], ['A', '3.5'], ['B', '2.0']]))
    const result = await extractXlsx(file)
    assert.equal(result.extractor, 'xlsx')
    const lines = result.text.split('\n')
    assert.equal(lines[0], '主播\t时长')
    assert.equal(lines[1], 'A\t3.5')
    assert.equal(lines.length, 3)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('extract: pdf without the optional dependency is skipped with a reason', async () => {
  const dir = await tempDir()
  try {
    const file = join(dir, 'scan.pdf')
    await writeFile(file, '%PDF-1.4 not a real pdf')
    const result = await extractPdf(file)
    // pdfjs-dist is not installed in this checkout, so the honest answer is a
    // skip with an actionable message — never a silent empty index.
    assert.equal(result.skipped, true)
    assert.match(result.reason, /pdfjs-dist/)
    const capabilities = await extractionCapabilities()
    assert.equal(capabilities.docx, 'builtin')
    assert.ok(capabilities.pdf === 'optional' || capabilities.pdf === 'pdfjs-dist')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('extract: an unknown container is rejected without throwing', async () => {
  const dir = await tempDir()
  try {
    const file = join(dir, 'old.doc')
    await writeFile(file, 'legacy binary')
    const result = await extractDocument(file, { logger })
    assert.equal(result.skipped, true)
    assert.match(result.reason, /不支持的文档类型/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('extract: pure XML helpers keep text and drop tags', () => {
  assert.equal(docxXmlToText('<w:p><w:r><w:t>甲</w:t></w:r></w:p><w:p><w:t>乙</w:t></w:p>').trim(), '甲\n乙')
  assert.equal(
    sheetXmlToText('<row><c t="s"><v>0</v></c></row><row><c><v>42</v></c></row>', ['名字']),
    '名字\n42',
  )
})

test('service: a docx in kb/ is indexed from its extracted text and readable', async () => {
  const dir = await tempDir('dsh-kb-docx-')
  try {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(dir, 'kb'), { recursive: true })
    await writeFile(join(dir, 'kb', '会议纪要.docx'), makeDocx(['季度目标', '把记忆与知识库合并为一个插件。']))

    const config = resolveConfig({ dataDir: join(dir, 'data'), knowledgeBase: { refreshSeconds: 0, chunk: { minChars: 5 } } })
    const service = createKbService({ config, logger })
    const index = await service.reindex({ scope: 'workspace', cwd: dir })
    assert.equal(index.workspace.stats.extracted, 1)
    const chunk = index.workspace.chunks.find((candidate) => candidate.path === '会议纪要.docx')
    assert.ok(chunk, 'the document contributes a chunk')
    assert.equal(chunk.extracted, true)
    assert.equal(chunk.extractor, 'docx')
    assert.match(chunk.content, /把记忆与知识库合并/)

    const state = await service.state({ cwd: dir })
    assert.deepEqual(state.extract.documents.includes('.docx'), true)

    // scribe_kb_read follows the cached extraction instead of reading binary garbage.
    const read = await service.read({ scope: 'workspace', path: '会议纪要.docx', cwd: dir })
    assert.match(read.content, /季度目标/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
