/**
 * Text extraction for binary documents.
 *
 * Two rules shape this module, because the plugin ships to machines that look
 * nothing like the one it was written on:
 *
 * 1. **No machine-specific probing.** Nothing here looks for a CLI on `PATH`,
 *    an OS-provided converter, or a bundled office suite. A published plugin
 *    cannot assume what a user's machine has installed.
 * 2. **Built-in first, optional dependency second.** Word / Excel / PowerPoint
 *    are Office Open XML — a ZIP of XML parts — so their text is read with the
 *    built-in ZIP reader: no dependency, nothing to install, identical on
 *    macOS, Linux and Windows.
 *
 * PDF is the one format that genuinely needs a parser (compressed content
 * streams, font maps, encryption). It is handled through an **optional**
 * dependency: if `pdfjs-dist` is installed the plugin uses it; otherwise the
 * file is skipped with an explicit reason the UI can show. Either way the
 * behaviour is the same on every machine, and decided by what the user
 * installed, not by what happens to be on `PATH`.
 *
 * @module dsh-scribe/kb/extract
 */

import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'

import { readZipEntry } from './zip.js'

/** Containers whose text this module reads by itself. */
export const OOXML_EXTENSIONS = ['.docx', '.xlsx', '.pptx']

/** Formats that need the optional PDF parser. */
export const PARSER_EXTENSIONS = ['.pdf']

/**
 * Extract the body text of one document.
 *
 * @param absPath - absolute path.
 * @param options - `{ logger }`.
 * @returns `{ text, extractor }` or `{ skipped, reason }` — never throws.
 */
export async function extractDocument(absPath, options = {}) {
  const extension = extname(absPath).toLowerCase()
  try {
    if (extension === '.docx') return await extractDocx(absPath)
    if (extension === '.xlsx') return await extractXlsx(absPath)
    if (extension === '.pptx') return await extractPptx(absPath)
    if (extension === '.pdf') return await extractPdf(absPath, options)
    return { skipped: true, reason: `不支持的文档类型 ${extension || '(无扩展名)'}` }
  } catch (error) {
    options.logger?.warn?.('document extraction failed for %s: %s', basename(absPath), error?.message ?? error)
    return { skipped: true, reason: `抽取失败：${error?.message ?? error}` }
  }
}

/**
 * Report which extractors are available, decided by what is installed — not by
 * what the host happens to have on `PATH`.
 * @returns `{ docx, xlsx, pptx, pdf }`.
 */
export async function extractionCapabilities() {
  const pdf = await loadPdfModule()
  return {
    docx: 'builtin',
    xlsx: 'builtin',
    pptx: 'builtin',
    pdf: pdf === undefined ? 'optional' : 'pdfjs-dist',
  }
}

/** Word: the body is `word/document.xml`; paragraphs become lines. */
export async function extractDocx(absPath) {
  const buffer = await readFile(absPath)
  const xml = readZipEntry(buffer, 'word/document.xml')
  if (xml === undefined) throw new Error('缺少 word/document.xml')
  const text = docxXmlToText(xml.toString('utf8'))
  return text.trim().length === 0 ? { skipped: true, reason: '文档没有正文' } : { text, extractor: 'docx' }
}

/** Excel: shared strings plus each sheet's cells, one line per row. */
export async function extractXlsx(absPath) {
  const buffer = await readFile(absPath)
  const sharedXml = readZipEntry(buffer, 'xl/sharedStrings.xml')
  const shared = sharedXml === undefined ? [] : sharedStrings(sharedXml.toString('utf8'))
  const sheets = []
  for (let index = 1; index <= 50; index += 1) {
    const entry = readZipEntry(buffer, `xl/worksheets/sheet${index}.xml`)
    if (entry === undefined) break
    sheets.push(sheetXmlToText(entry.toString('utf8'), shared))
  }
  const text = sheets.filter((sheet) => sheet.length > 0).join('\n\n')
  return text.trim().length === 0 ? { skipped: true, reason: '工作簿没有文本内容' } : { text, extractor: 'xlsx' }
}

/** PowerPoint: each slide contributes its text runs, one paragraph per line. */
export async function extractPptx(absPath) {
  const buffer = await readFile(absPath)
  const slides = []
  for (let index = 1; index <= 300; index += 1) {
    const entry = readZipEntry(buffer, `ppt/slides/slide${index}.xml`)
    if (entry === undefined) break
    const text = pptxXmlToText(entry.toString('utf8'))
    if (text.length > 0) slides.push(text)
  }
  const text = slides.join('\n\n')
  return text.trim().length === 0 ? { skipped: true, reason: '演示文稿没有文本内容' } : { text, extractor: 'pptx' }
}

/**
 * PDF through the optional `pdfjs-dist` dependency.
 * @param absPath - absolute path.
 * @param options - `{ logger }`.
 * @returns `{ text, extractor }` or `{ skipped, reason }`.
 */
export async function extractPdf(absPath, options = {}) {
  const pdfjs = await loadPdfModule()
  if (pdfjs === undefined) {
    return {
      skipped: true,
      reason: 'PDF 需要可选依赖 pdfjs-dist（在插件目录执行 npm i pdfjs-dist 后重启）',
    }
  }
  const data = new Uint8Array(await readFile(absPath))
  const document = await pdfjs.getDocument({ data, useSystemFonts: false, isEvalSupported: false }).promise
  try {
    const pages = []
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      const content = await page.getTextContent()
      const text = content.items
        .map((item) => (typeof item.str === 'string' ? item.str : ''))
        .join(' ')
        .replace(/[ \t]+/g, ' ')
        .trim()
      if (text.length > 0) pages.push(`第 ${pageNumber} 页\n${text}`)
    }
    const text = pages.join('\n\n')
    return text.trim().length === 0
      ? { skipped: true, reason: 'PDF 没有可抽取的文本（可能是扫描件）' }
      : { text, extractor: 'pdfjs-dist' }
  } finally {
    await document.destroy?.()
  }
}

let pdfModulePromise

/**
 * Load `pdfjs-dist` when the user installed it.
 *
 * The specifier is built at runtime so a missing package is a normal "not
 * installed" answer rather than a build-time resolution error — and bundlers do
 * not try to inline it.
 * @returns the module namespace, or undefined.
 */
function loadPdfModule() {
  pdfModulePromise ??= (async () => {
    for (const specifier of ['pdfjs-dist/legacy/build/pdf.mjs', 'pdfjs-dist']) {
      try {
        return await import(specifier)
      } catch {
        // try the next entry point
      }
    }
    return undefined
  })()
  return pdfModulePromise
}

/** Flatten `<w:p>` into lines and strip every tag. */
export function docxXmlToText(xml) {
  return xml
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:br\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
}

/** Collect `<si>` shared strings in index order. */
export function sharedStrings(xml) {
  const out = []
  const items = xml.match(/<si>[\s\S]*?<\/si>/g) ?? []
  for (const item of items) {
    const runs = item.match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? []
    out.push(
      runs
        .map((entry) => entry.replace(/<[^>]+>/g, ''))
        .join('')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&'),
    )
  }
  return out
}

/** Render one worksheet as tab-separated rows. */
export function sheetXmlToText(xml, shared = []) {
  const rows = xml.match(/<row[^>]*>[\s\S]*?<\/row>/g) ?? []
  const lines = []
  for (const row of rows) {
    const cells = row.match(/<c[^>]*>[\s\S]*?<\/c>/g) ?? []
    const values = []
    for (const cell of cells) {
      const isShared = /t="s"/.test(cell)
      const raw = /<v>([\s\S]*?)<\/v>/.exec(cell)?.[1]
      if (raw === undefined) {
        const inline = /<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/.exec(cell)?.[1]
        if (inline !== undefined) values.push(inline)
        continue
      }
      values.push(isShared ? (shared[Number(raw)] ?? '') : raw)
    }
    const line = values.join('\t').trim()
    if (line.length > 0) lines.push(line)
  }
  return lines.join('\n')
}

/** Presentation text runs, one line per paragraph. */
export function pptxXmlToText(xml) {
  return xml
    .replace(/<\/a:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
}
