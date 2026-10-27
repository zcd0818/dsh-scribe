import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { resolveConfig } from '../src/config.js'
import { createMemoryService } from '../src/memory-service.js'
import { describeConfig, mergeConfig, saveConfig } from '../src/web/config-store.js'
import { ROUTE_PREFIX, installWebApi } from '../src/web/api.js'

const logger = { debug() {}, info() {}, warn() {}, error() {} }

/** Build a request-like async iterable. */
function request(method, path, { body, headers = {} } = {}) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url: `${ROUTE_PREFIX}${path}`,
    headers: { host: '127.0.0.1:43120', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    async *[Symbol.asyncIterator]() {
      for (const chunk of payload) yield chunk
    },
  }
}

/** Build a response-like capture. */
function response() {
  const state = { status: 0, headers: {}, body: '' }
  return {
    headersSent: false,
    writeHead(status, headers) {
      state.status = status
      state.headers = headers ?? {}
      this.headersSent = true
    },
    end(value) {
      state.body = value === undefined ? '' : String(value)
    },
    get json() {
      try {
        return JSON.parse(state.body)
      } catch {
        return undefined
      }
    },
    get result() {
      return state
    },
  }
}

async function harness(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-scribe-web-'))
  const config = resolveConfig({
    dataDir: dir,
    defaultProvider: 'local',
    providers: {
      local: { type: 'local', path: join(dir, 'data') },
      mirror: { type: 'local', path: join(dir, 'mirror') },
    },
  })
  const store = { current: { defaultProvider: 'local' } }
  const registered = []
  const injected = []
  const ctx = {
    inject(deps, callback) {
      injected.push({ deps, callback })
      return () => {}
    },
    get(name) {
      if (name === 'webServer') {
        return {
          getOrigin: () => 'http://127.0.0.1:43120',
          register(route) {
            registered.push(route)
            return () => {}
          },
        }
      }
      if (name === 'workspaceRegistry') {
        return { list: () => options.workspaces ?? [] }
      }
      if (name === 'configEditor') {
        return {
          configuration: () => [{ entry: { id: 'dsh-scribe', name: 'dsh-scribe' }, inherited: {}, override: store.current }],
          async edit(_entry, change) {
            store.current = change(store.current, {})
          },
        }
      }
      return undefined
    },
    effect(callback) {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
  }
  const service = createMemoryService({ ctx, config, logger })
  const kb = options.makeKb === undefined ? options.kb : options.makeKb(config, ctx)
  installWebApi({ ctx, service, kb, config, logger })
  const route = registered[0]
  const call = async (method, path, options) => {
    const res = response()
    await route.handler(request(method, path, options), res)
    return res
  }
  return { dir, ctx, config, service, call, store, injected, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

test('config-store: merge is deep at two levels and replaces arrays', () => {
  const merged = mergeConfig(
    { providers: { local: { type: 'local', path: '/a', engine: 'file' } }, injectLimit: 5 },
    { providers: { local: { path: '/b' } }, injectLimit: 9 },
  )
  assert.equal(merged.providers.local.path, '/b')
  assert.equal(merged.providers.local.engine, 'file')
  assert.equal(merged.injectLimit, 9)
})

test('config-store: describe redacts secrets and reports presence', () => {
  const config = resolveConfig({
    providers: { bailian: { type: 'bailian', apiKey: 'sk-secret', workspaceId: 'llm-abc' } },
  })
  const ctx = {
    get: () => ({
      configuration: () => [
        { entry: { id: 'dsh-scribe' }, inherited: {}, override: { providers: { bailian: { apiKey: 'sk-secret' } } } },
      ],
    }),
  }
  const described = describeConfig(ctx, config)
  assert.equal(described.override.providers.bailian.apiKey, '<已设置>')
  assert.equal(described.effective.providers.bailian.hasApiKey, true)
  assert.equal(described.effective.providers.bailian.apiKey, undefined)
})

test('config-store: saving validates before write', async () => {
  const config = resolveConfig({})
  let written
  const ctx = {
    get: () => ({
      configuration: () => [{ entry: { id: 'dsh-scribe' }, inherited: {}, override: {} }],
      async edit(_entry, change) {
        written = change({}, {})
      },
    }),
  }
  await saveConfig(ctx, { injectLimit: 7 })
  assert.equal(written.injectLimit, 7)
  await assert.rejects(() => saveConfig(ctx, { defaultProvider: 'nope' }), /defaultProvider/)
})

test('web api: cross-site and foreign-origin requests are refused', async () => {
  const local = await harness()
  try {
    const crossSite = await local.call('GET', '/state', { headers: { 'sec-fetch-site': 'cross-site' } })
    assert.equal(crossSite.result.status, 403)

    const foreign = await local.call('GET', '/state', { headers: { origin: 'https://evil.example' } })
    assert.equal(foreign.result.status, 403)

    const same = await local.call('GET', '/state', { headers: { origin: 'http://127.0.0.1:43120' } })
    assert.equal(same.result.status, 200)
  } finally {
    await local.cleanup()
  }
})

test('web api: state reports status, providers, and config', async () => {
  const local = await harness()
  try {
    const res = await local.call('GET', '/state')
    assert.equal(res.result.status, 200)
    const body = res.json
    assert.equal(body.status.provider, 'local')
    assert.equal(body.config.editable, true)
    assert.deepEqual(body.providers.map((entry) => entry.id).sort(), ['bailian', 'local', 'mirror'])
    assert.ok(body.dataDir.length > 0)
  } finally {
    await local.cleanup()
  }
})

test('web api: config rejects an invalid patch and does not write', async () => {
  const local = await harness()
  try {
    const res = await local.call('POST', '/config', { body: { patch: { defaultProvider: 'ghost' } } })
    assert.equal(res.result.status, 400)
    assert.match(res.json.error, /defaultProvider/)
    assert.equal(local.store.current.injectLimit, undefined)
  } finally {
    await local.cleanup()
  }
})

test('web api: config save accepts a valid patch', async () => {
  const local = await harness()
  try {
    const res = await local.call('POST', '/config', { body: { patch: { injectLimit: 8 } } })
    assert.equal(res.result.status, 200)
    assert.equal(res.json.ok, true)
    // The write is queued after the response (the Loader re-mounts the plugin).
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(local.store.current.injectLimit, 8)
  } finally {
    await local.cleanup()
  }
})

test('web api: migration requires a plan token and then journals a run', async () => {
  const local = await harness()
  try {
    await local.service.add({ content: '迁移计划测试记忆' })

    const noToken = await local.call('POST', '/run', { body: { token: 'forged' } })
    assert.equal(noToken.result.status, 400)

    const plan = await local.call('POST', '/plan', { body: { to: 'mirror' } })
    assert.equal(plan.result.status, 200)
    assert.equal(plan.json.source.count, 1)
    assert.ok(plan.json.token.length >= 16)

    const run = await local.call('POST', '/run', { body: { token: plan.json.token } })
    assert.equal(run.result.status, 200)
    assert.equal(run.json.record.status, 'complete')
    assert.equal(run.json.record.successCount, 1)

    // A token is single use.
    const replay = await local.call('POST', '/run', { body: { token: plan.json.token } })
    assert.equal(replay.result.status, 400)

    const journal = await local.call('GET', '/migrations')
    assert.equal(journal.json.records.length, 1)

    const rollback = await local.call('POST', '/rollback', { body: { id: run.json.record.id } })
    assert.equal(rollback.json.removed, 1)
    assert.equal(await local.service.providerFor('mirror').count(), 0)
  } finally {
    await local.cleanup()
  }
})

test('web api: testing a provider reports reachability', async () => {
  const local = await harness()
  try {
    const res = await local.call('POST', '/test', { body: { provider: 'local' } })
    assert.equal(res.json.ok, true)
    assert.equal(res.json.provider, 'local')

    const missing = await local.call('POST', '/test', { body: { provider: 'ghost' } })
    assert.equal(missing.json.ok, false)
  } finally {
    await local.cleanup()
  }
})

test('web api: refuses a non-json POST and unknown routes', async () => {
  const local = await harness()
  try {
    const unknown = await local.call('GET', '/nope')
    assert.equal(unknown.result.status, 404)

    const notJson = await local.call('POST', '/config', {
      body: { patch: { injectLimit: 8 } },
      headers: { 'content-type': 'text/plain' },
    })
    assert.equal(notJson.result.status, 415)

    const wrongMethod = await local.call('DELETE', '/state')
    assert.equal(wrongMethod.result.status, 405)
  } finally {
    await local.cleanup()
  }
})

test('web api: registers immediately when the carrier is already present', async () => {
  const local = await harness()
  try {
    assert.equal(local.injected.length, 0, 'no waiting needed when webServer exists')
    const res = await local.call('GET', '/state')
    assert.equal(res.result.status, 200)
  } finally {
    await local.cleanup()
  }
})

test('web api: waits for the web carrier when the row activates first', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-scribe-web-late-'))
  try {
    const config = resolveConfig({
      dataDir: dir,
      providers: { local: { type: 'local', path: join(dir, 'data') } },
    })
    const service = createMemoryService({ ctx: { get: () => undefined }, config, logger })
    const registered = []
    const pending = []
    // The row activates before the Web carrier row: `webServer` is absent now.
    const ctx = {
      get: () => undefined,
      inject(deps, callback) {
        pending.push({ deps, callback })
        return () => {}
      },
      effect(callback) {
        const disposer = callback()
        return typeof disposer === 'function' ? disposer : () => {}
      },
    }
    installWebApi({ ctx, service, config, logger })
    assert.equal(registered.length, 0)
    assert.equal(pending.length, 1)
    assert.deepEqual(pending[0].deps, ['webServer'])

    // The carrier arrives; the deferred registration must add the route once.
    const host = {
      get: (name) =>
        name === 'webServer'
          ? {
              getOrigin: () => 'http://127.0.0.1:43120',
              register: (route) => {
                registered.push(route)
                return () => {}
              },
            }
          : undefined,
      effect(callback) {
        const disposer = callback()
        return typeof disposer === 'function' ? disposer : () => {}
      },
    }
    pending[0].callback(host)
    assert.equal(registered.length, 1)
    assert.equal(registered[0].path, '/dsh-scribe/api')

    // A second injection callback must not double-register.
    pending[0].callback(host)
    assert.equal(registered.length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/** A knowledge service stub: the routes only need state() and reindex(). */
function kbStub() {
  return {
    enabled: true,
    async peek({ scope = 'workspace', cwd } = {}) {
      if (scope === 'global') {
        return { root: '/home/user/.dsh/memory/kb/global', exists: false, files: 0, chunks: 0, generatedAt: undefined }
      }
      return { root: `${cwd}/kb`, exists: true, files: 3, chunks: 11, generatedAt: 1_700_000_000_000 }
    },
    async state({ cwd } = {}) {
      return {
        enabled: true,
        refreshSeconds: 300,
        cwd,
        scopes: {
          workspace: { root: '/workspaces/demo/kb', exists: true, files: 3, chunks: 11, generatedAt: 1_700_000_000_000, topFiles: [] },
          global: { root: '/home/user/.dsh/memory/kb/global', exists: false, files: 0, chunks: 0, topFiles: [] },
        },
      }
    },
    async reindex({ scope } = {}) {
      const base = { files: {}, chunks: [], durationMs: 5, stats: { indexed: 3, reused: 0, removed: 0 } }
      return scope === 'workspace' ? { workspace: base } : { workspace: base, global: { ...base, stats: { indexed: 0, reused: 0, removed: 0 } } }
    },
  }
}

test('web api: GET /kb/state lists every registered workspace plus global', async () => {
  const local = await harness({
    kb: kbStub(),
    workspaces: [
      { id: 'w1', title: 'demo', path: '/workspaces/demo' },
      { id: 'w2', title: 'other', path: '/work/other' },
    ],
  })
  try {
    const res = await local.call('GET', '/kb/state')
    assert.equal(res.result.status, 200, 'a GET must not be rejected as an unsupported method')
    assert.equal(res.json.enabled, true)
    assert.equal(res.json.workspaces.length, 2, 'each registered workspace is its own index target')
    assert.equal(res.json.workspaces[0].path, '/workspaces/demo')
    assert.equal(res.json.workspaces[0].files, 3)
    assert.equal(res.json.global.chunks, 0)
    assert.ok(Array.isArray(res.json.include) && res.json.include.includes('**/*.md'), 'the page needs the accepted file types')
  } finally {
    await local.cleanup()
  }
})

test('web api: POST /kb/reindex rebuilds the requested target', async () => {
  const local = await harness({ kb: kbStub() })
  try {
    const res = await local.call('POST', '/kb/reindex', { body: { scope: 'workspace', path: '/workspaces/demo' } })
    assert.equal(res.result.status, 200)
    assert.equal(res.json.ok, true)
    assert.equal(res.json.scopes.workspace.stats.indexed, 3)
    assert.equal(res.json.scopes.global, undefined, 'a single-scope rebuild must not touch the other scope')
  } finally {
    await local.cleanup()
  }
})

test('web api: knowledge routes answer disabled instead of 404 without a service', async () => {
  const local = await harness()
  try {
    const state = await local.call('GET', '/kb/state')
    assert.equal(state.result.status, 200)
    assert.equal(state.json.enabled, false)
    assert.deepEqual(state.json.workspaces, [])

    const reindex = await local.call('POST', '/kb/reindex', { body: {} })
    assert.equal(reindex.result.status, 400)
  } finally {
    await local.cleanup()
  }
})

test('web api: upload stores the file and reindexes immediately', async () => {
  const { mkdtemp, mkdir, readFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createKbService } = await import('../src/kb/service.js')
  const { existsSync } = await import('node:fs')

  const root = await mkdtemp(join(tmpdir(), 'dsh-kb-upload-'))
  const workspace = join(root, 'ws')
  try {
    await mkdir(join(workspace, 'kb'), { recursive: true })
    const local = await harness({
      makeKb: (config) => createKbService({ config, logger }),
    })
    try {
      const content = '# 上传的资料\n\n## 约定\n\n提交前必须跑 node --test。\n'
      const res = await local.call('POST', '/kb/upload', {
        body: {
          scope: 'workspace',
          cwd: workspace,
          name: '上传规范.md',
          dataBase64: Buffer.from(content, 'utf8').toString('base64'),
        },
      })
      assert.equal(res.result.status, 200, JSON.stringify(res.json))
      assert.equal(res.json.ok, true)
      assert.equal(res.json.indexed, true)
      const written = join(workspace, 'kb', '上传规范.md')
      assert.ok(existsSync(written), 'the upload must land inside the knowledge folder')
      assert.equal(await readFile(written, 'utf8'), content)

      // A traversal attempt is refused before anything is written.
      const evil = await local.call('POST', '/kb/upload', {
        body: { scope: 'workspace', cwd: workspace, name: '../../escape.md', dataBase64: 'aGk=' },
      })
      assert.equal(evil.result.status, 200, 'a traversing name is reduced to its basename rather than escaping')
      assert.ok(existsSync(join(workspace, 'kb', 'escape.md')))
      assert.ok(!existsSync(join(workspace, 'escape.md')))

      const nameless = await local.call('POST', '/kb/upload', {
        body: { scope: 'workspace', cwd: workspace, name: 'no-extension', dataBase64: 'aGk=' },
      })
      assert.equal(nameless.result.status, 400)
    } finally {
      await local.cleanup()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('web api: folder switch persists global root and workspace override', async () => {
  const local = await harness({ kb: kbStub() })
  try {
    const global = await local.call('POST', '/kb/folder', { body: { scope: 'global', folder: '/tmp/kb-shared' } })
    assert.equal(global.result.status, 200, JSON.stringify(global.json))
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.equal(local.store.current.knowledgeBase.global.root, '/tmp/kb-shared')

    const workspace = await local.call('POST', '/kb/folder', {
      body: { scope: 'workspace', cwd: '/workspaces/demo', folder: 'docs' },
    })
    assert.equal(workspace.result.status, 200)
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.equal(local.store.current.knowledgeBase.workspace.overrides['/workspaces/demo'], 'docs')

    // '<default>' clears the override again.
    const reset = await local.call('POST', '/kb/folder', {
      body: { scope: 'workspace', cwd: '/workspaces/demo', folder: '<default>' },
    })
    assert.equal(reset.result.status, 200)
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.equal(local.store.current.knowledgeBase.workspace.overrides['/workspaces/demo'], undefined)

    const empty = await local.call('POST', '/kb/folder', { body: { scope: 'global', folder: '  ' } })
    assert.equal(empty.result.status, 400)
  } finally {
    await local.cleanup()
  }
})
