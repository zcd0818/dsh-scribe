import assert from 'node:assert/strict'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * Pre-publication invariants.
 *
 * These are the checks a reviewer would otherwise have to do by hand: no
 * machine-specific paths, no debugging leftovers, every used style class
 * defined, the published file list complete, and no import that would only
 * resolve on this checkout.
 *
 * Paths go through `fileURLToPath` rather than `URL#pathname`: on Windows the
 * latter yields `/D:/a/...`, and joining it produces `D:\D:\a\...`.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) await walk(abs, out)
    else out.push(abs)
  }
  return out
}

/** Files the package actually publishes (test/ is not shipped). */
const shippedFiles = async () =>
  (await walk(ROOT)).filter(
    (file) => file.endsWith('.js') && !file.includes('/test/') && !file.includes('/node_modules/'),
  )

const sourceFiles = async () => (await walk(ROOT)).filter((file) => file.endsWith('.js'))

test('publish: no machine-specific absolute paths in shipped sources', async () => {
  const offenders = []
  for (const file of await shippedFiles()) {
    const text = await readFile(file, 'utf8')
    for (const pattern of [/\/Users\/[a-z]/i, /\/Applications\/[A-Z]/, /[A-Z]:\\\\Users\\\\/i, /localhost:\\d{4,5}/]) {
      if (pattern.test(text)) offenders.push(`${file.replace(ROOT, '')}: ${pattern}`)
    }
  }
  assert.deepEqual(offenders, [], 'shipped code must not bake in one machine’s layout')
})

test('publish: no debugging leftovers in shipped sources', async () => {
  const offenders = []
  for (const file of await shippedFiles()) {
    if (file.includes('/test/')) continue
    const text = await readFile(file, 'utf8')
    for (const marker of ['TEMP DIAGNOSTIC', '[probe]', 'diagnose.log', 'FIXME']) {
      if (text.includes(marker)) offenders.push(`${file.replace(ROOT, '')}: ${marker}`)
    }
    // console.log is allowed only in the logger's documented fallback.
    if (file.endsWith('/src/log.js')) continue
    if (/console\.log\(/.test(text)) offenders.push(`${file.replace(ROOT, '')}: console.log`)
    if (/console\.info\(/.test(text)) offenders.push(`${file.replace(ROOT, '')}: console.info`)
  }
  assert.deepEqual(offenders, [])
})

test('publish: every imported module resolves', async () => {
  const files = await sourceFiles()
  const missing = []
  for (const file of files) {
    const text = await readFile(file, 'utf8')
    for (const match of text.matchAll(/from\s+'(\.[^']+)'/g)) {
      const target = fileURLToPath(new URL(match[1], pathToFileURL(file)))
      try {
        await stat(target)
      } catch {
        missing.push(`${file.replace(ROOT, '')} -> ${match[1]}`)
      }
    }
  }
  assert.deepEqual(missing, [])
})

test('publish: runtime imports are node builtins only (pdfjs-dist stays optional)', async () => {
  const offenders = []
  for (const file of await sourceFiles()) {
    if (file.includes('/test/')) continue
    const text = await readFile(file, 'utf8')
    for (const match of text.matchAll(/^\s*import\s+[^'"]*'([^']+)'/gm)) {
      const specifier = match[1]
      const isRelative = specifier.startsWith('.')
      const isBuiltin = specifier.startsWith('node:')
      if (!isRelative && !isBuiltin) offenders.push(`${file.replace(ROOT, '')}: ${specifier}`)
    }
  }
  assert.deepEqual(offenders, [], 'a published bundle must not require an uninstalled package')
})

test('publish: manifest exports every shipped artifact and declares the client half', async () => {
  const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(manifest.name, 'dsh-scribe')
  assert.ok(manifest.license, 'a published package needs a license field')
  assert.equal(manifest.exports['.'], './index.js')
  assert.equal(manifest.exports['./client'], './client.js')
  assert.equal(manifest.exports['./package.json'], './package.json', 'the client scanner resolves the manifest through this export')
  assert.equal(manifest.dsh.client.platform, 'web')
  for (const file of ['index.js', 'client.js', 'cordis.patch.yml', 'README.md', 'LICENSE', 'icon.svg']) {
    await stat(join(ROOT, file))
  }
  for (const pattern of ['src/**/*.js', 'locale/*.json']) {
    assert.ok(manifest.files.includes(pattern), `files must ship ${pattern}`)
  }
})

test('publish: every style class used by the page is defined', async () => {
  const client = await readFile(join(ROOT, 'client.js'), 'utf8')
  const cssStart = client.indexOf('const CSS = `')
  const cssEnd = client.indexOf('`', cssStart + 14)
  const css = client.slice(cssStart, cssEnd)
  const defined = new Set([...css.matchAll(/\.([a-z][a-z0-9-]+)/g)].map((match) => match[1]))
  const used = new Set()
  for (const match of client.matchAll(/className: '([^']+)'/g)) {
    for (const name of match[1].split(/\s+/)) if (name) used.add(name)
  }
  const missing = [...used].filter((name) => name.startsWith('dsh-mem') && !defined.has(name))
  assert.deepEqual(missing, [], 'an undefined class means silently unaligned layout')
})

test('publish: the patch inserts exactly one row and keeps secrets out of the repo', async () => {
  const patch = await readFile(join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.equal((patch.match(/- id: dsh-scribe$/gm) ?? []).length, 1)
  assert.ok(!/sk-[A-Za-z0-9]{8,}/.test(patch), 'no literal API key in the shipped patch')
  assert.match(patch, /apiKey: 'env:BAILIAN_API_KEY'/, 'secrets come from the environment')
})

test('publish: README states the real version and test count', async () => {
  const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
  const readme = await readFile(join(ROOT, 'README.md'), 'utf8')
  assert.match(readme, /## 已知限制/, 'a published plugin documents its limits')
  assert.ok(!/[\u0000-\u0008]/.test(readme))
  const countMatch = /(\d+) 个测试覆盖/.exec(readme)
  assert.ok(countMatch, 'README should state the test count')
  assert.ok(Number(countMatch[1]) > 60, `test count looks stale: ${countMatch[1]}`)
  assert.match(readme, new RegExp(`\\b${manifest.version.replace(/\./g, '\\.')}\\b`), 'README mentions the current version')
})
