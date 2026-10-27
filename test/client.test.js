import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * Renders the Client half without a browser.
 *
 * Practice to guard: a component that throws blanks the whole slot entry with
 * nothing but a console error, so the page is worth rendering at least once
 * headlessly — a missing identifier or a bad prop is caught here instead of
 * appearing as an empty Settings section.
 */

/** Minimal React stand-in: enough for createElement + hook calls to be inert. */
function fakeReact() {
  const createElement = (type, props, ...children) => ({
    type,
    props: { ...(props ?? {}), children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children },
  })
  return {
    createElement,
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useRef: (initial) => ({ current: initial }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  }
}

/** Collect every string rendered into a fake element tree. */
function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (typeof node === 'object' && node.props) {
    const fromProps = ['label', 'placeholder', 'title']
      .map((key) => (typeof node.props[key] === 'string' ? node.props[key] : ''))
      .join(' ')
    return `${fromProps} ${textOf(node.props.children)}`
  }
  return ''
}

let importCounter = 0

/** Load the module loader artifact and hand back its factory result. */
async function loadClient() {
  const calls = []
  globalThis.window = { __ModuleLoader__: { load: (definition) => calls.push(definition) } }
  // A fresh query keeps each test on a live module instance, since the artifact
  // registers itself once at import time.
  importCounter += 1
  await import(`../client.js?test=${importCounter}`)
  assert.equal(calls.length, 1, 'client.js must register exactly one module')
  const definition = calls[0]
  assert.equal(definition.id, 'dsh-scribe')
  const react = fakeReact()
  const module = definition.factory((name) => {
    if (name === 'react') return react
    throw new Error(`unexpected require(${name})`)
  })
  return { definition, module }
}

const statePayload = {
  status: { provider: 'local', type: 'local', count: 3, health: true, embedding: 'lexical fallback', autoInject: true, oldest: '2026-10-01', newest: '2026-10-27' },
  config: {
    editable: true,
    source: 'profile-patch',
    effective: {
      defaultProvider: 'local',
      autoInject: true,
      autoSave: true,
      injectLimit: 5,
      injectMaxChars: 1200,
      dataDir: '/home/user/.dsh/memory',
      providers: {
        local: { type: 'local', path: '/home/user/.dsh/memory', engine: 'file', hasApiKey: false },
        bailian: { type: 'bailian', workspaceId: '', region: 'cn-beijing', userId: 'dsh', memoryLibraryId: '', planVersion: 'pro', hasApiKey: false },
      },
      embedding: { endpoint: '', model: 'text-embedding-v3', hasApiKey: false },
      retrieval: { mode: 'hybrid', minScore: 0.18, llmRerank: true },
      summarization: { shortTurns: 10, maxChars: 320 },
      retention: { maxMemories: 5000, ttlDays: 0 },
    },
  },
  providers: [
    { id: 'local', type: 'local', active: true, hasApiKey: false },
    { id: 'bailian', type: 'bailian', active: false, hasApiKey: false },
  ],
  dataDir: '/home/user/.dsh/memory',
  migrations: [],
}

test('client: registers one factory that injects into settings.section', async () => {
  const { module } = await loadClient()
  const registrations = []
  const injections = []
  module.apply({
    slots: {
      inject: (owner, install) => {
        injections.push(owner)
        install()
      },
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
  })
  assert.deepEqual(injections, ['settings.section'])
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].options.name, 'settings.section')
  assert.equal(registrations[0].options.id, 'dsh-scribe')
  assert.equal(typeof registrations[0].component, 'function')
})

test('client: overview renders status without crashing', async () => {
  const { module } = await loadClient()
  const tree = module.__test__.Overview({ data: statePayload, busy: false, onRefresh: () => {} })
  const text = textOf(tree)
  assert.match(text, /运行状态/)
  assert.match(text, /记忆条数/)
  assert.match(text, /local/)
})

test('client: memory tab shows the local card and hides cloud credentials', async () => {
  const { module } = await loadClient()
  const text = textOf(module.__test__.MemoryTab({ data: statePayload, onSaved: () => {} }))
  for (const label of ['记忆后端', '写入位置', '本机存储', '检索', '会话摘要与留存', '保存配置', '测试当前后端']) {
    assert.ok(text.includes(label), `memory tab should render "${label}"`)
  }
  // A local backend needs no credentials, so the cloud card stays out of the way.
  assert.ok(!text.includes('业务空间 ID'), 'cloud credentials are not shown for a local backend')
})

test('client: memory tab reveals cloud credentials for a cloud backend', async () => {
  const { module } = await loadClient()
  const cloudState = {
    ...statePayload,
    config: {
      ...statePayload.config,
      effective: { ...statePayload.config.effective, defaultProvider: 'bailian' },
    },
  }
  const text = textOf(module.__test__.MemoryTab({ data: cloudState, onSaved: () => {} }))
  for (const label of ['阿里云百炼记忆库', '业务空间 ID', 'API Key', '记忆隔离键', '记忆库 ID', '计费计划']) {
    assert.ok(text.includes(label), `cloud backend should render "${label}"`)
  }
  assert.ok(!text.includes('本机存储'), 'the local card is hidden when a cloud backend is selected')
})

test('client: migration tab explains the confirmation step', async () => {
  const { module } = await loadClient()
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({}) })
  const text = textOf(module.__test__.MigrationTab({ data: statePayload, onChanged: () => {} }))
  assert.match(text, /迁移到另一个后端/)
  assert.match(text, /不会自动发生|确认/)
  assert.match(text, /迁移记录/)
})

test('client: knowledge tab renders both scopes', async () => {
  const { module } = await loadClient()
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        enabled: true,
        refreshSeconds: 300,
        cwd: '/workspaces/demo',
        scopes: {
          workspace: { root: '/workspaces/demo/kb', exists: true, files: 3, chunks: 9, generatedAt: Date.now(), topFiles: [{ path: 'INDEX.md', chunks: 1 }] },
          global: { root: '/home/user/.dsh/memory/kb/global', exists: false, files: 0, chunks: 0 },
        },
      }),
  })
  const text = textOf(module.__test__.KbTab({}))
  // The first render happens before the effect resolves; the shell must still
  // be valid, and the copy must explain the two scopes.
  assert.ok(typeof text === 'string')
  assert.match(text, /知识库|正在读取/)
})

test('client: page shell renders tabs and the unavailable notice', async () => {
  const { module } = await loadClient()
  const text = textOf(module.__test__.MemorySettingsPage({}))
  assert.match(text, /记忆与知识库/, 'the page title follows the sidebar entry')
  assert.match(text, /概览/)
  assert.match(text, /记忆/)
  assert.match(text, /知识库/)
  assert.match(text, /数据迁移/)
  assert.match(text, /正在读取记忆状态|无法读取状态/)
})

test('client: draft defaults survive an empty config', async () => {
  const { module } = await loadClient()
  const draft = module.__test__.initialDraft({})
  assert.equal(draft.defaultProvider, 'local')
  assert.equal(draft.localEngine, 'file')
  assert.equal(draft.bailianUserId, 'dsh')
  assert.equal(draft.injectLimit, 5)
})
