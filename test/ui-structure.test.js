import assert from 'node:assert/strict'
import test from 'node:test'

import { readFile } from 'node:fs/promises'

import { childrenOf, loadClientComponents, textOf, walk } from './react-shim.js'

/**
 * Layout invariants for the settings page.
 *
 * The grids in this page are fixed-column (`minmax(...)` tracks), so the ONLY
 * thing keeping a row aligned with its header is that both carry the same
 * number of children. A missing or extra child shifts every following column —
 * exactly the "组件移位" symptom — and it is invisible to a text-only assertion.
 * These checks walk the rendered tree and enforce the column contract,
 * including the empty and edge-case states.
 */

let counter = 0
async function components() {
  counter += 1
  return loadClientComponents(counter)
}

const baseState = {
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
      ui: { sidebar: true },
      knowledgeBase: { enabled: true, folder: 'kb', globalRoot: '', overrides: {}, refreshSeconds: 300 },
    },
  },
  providers: [
    { id: 'local', type: 'local', active: true, hasApiKey: false },
    { id: 'bailian', type: 'bailian', active: false, hasApiKey: false },
  ],
  dataDir: '/home/user/.dsh/memory',
  migrations: [],
}

const kbState = (overrides = {}) => ({
  enabled: true,
  refreshSeconds: 300,
  cwd: '/workspaces/demo',
  sidebar: true,
  defaultFolder: 'kb',
  include: ['**/*.md', '**/*.txt', '**/*.json'],
  extract: { enabled: true, documents: ['.docx', '.xlsx', '.pptx', '.pdf'], capabilities: { docx: 'builtin', xlsx: 'builtin', pptx: 'builtin', pdf: 'optional' } },
  workspaces: [
    { id: 'w1', title: 'demo', path: '/workspaces/demo', root: '/workspaces/demo/kb', overridden: false, exists: true, files: 3, chunks: 11, generatedAt: 1_700_000_000_000 },
    { id: 'w2', title: 'other', path: '/workspaces/other', root: '/workspaces/other/kb', overridden: true, exists: false, files: 0, chunks: 0, generatedAt: undefined },
  ],
  global: { root: '/home/user/.dsh/memory/kb/global', exists: false, files: 0, chunks: 0, generatedAt: undefined },
  ...overrides,
})

const hasClass = (node, name) =>
  typeof node.props?.className === 'string' && node.props.className.split(/\s+/).includes(name)

const gridClassesOf = (node) =>
  String(node.props?.className ?? '')
    .split(/\s+/)
    .filter((name) => name.startsWith('dsh-mem-rowgrid'))

/**
 * Assert the column contract: header and rows must share the same grid class
 * (one source of truth), and every row must carry one cell per track.
 */
function assertGridContract(root, label) {
  const rows = []
  let header
  walk(root, (node) => {
    if (hasClass(node, 'dsh-mem-rowline')) rows.push(node)
    if (hasClass(node, 'dsh-mem-rowhead')) header = node
  })
  assert.ok(rows.length > 0, `${label}: expected at least one grid row`)
  assert.ok(header !== undefined, `${label}: the list has no header row`)
  const headerGrid = gridClassesOf(header)
  assert.equal(headerGrid.length, 1, `${label}: the header must name exactly one grid class`)
  for (const row of rows) {
    assert.deepEqual(gridClassesOf(row), headerGrid, `${label}: a row uses different tracks than the header`)
    const cells = childrenOf(row).filter((cell) => cell !== null && cell !== undefined)
    assert.equal(cells.length, 4, `${label}: a grid row rendered ${cells.length} columns instead of 4`)
  }
  assert.equal(childrenOf(header).length, 4, `${label}: the header must declare four columns`)
  return rows
}

/** Cards must carry a heading, or they read as unlabelled panels. */
function assertCardsHeaded(root, label) {
  const cards = []
  walk(root, (node) => {
    if (typeof node.props?.className === 'string' && node.props.className.split(' ').includes('dsh-mem-card')) cards.push(node)
  })
  assert.ok(cards.length > 0, `${label}: no cards rendered`)
  for (const card of cards) {
    const text = textOf(card)
    assert.ok(text.trim().length > 0, `${label}: an empty card rendered`)
  }
  return cards
}

function assertNoLiteralJunk(root, label) {
  const text = textOf(root)
  for (const junk of ['undefined', 'NaN', '[object Object]']) {
    assert.ok(!text.includes(junk), `${label}: rendered literal "${junk}"`)
  }
}

test('structure: the workspace list keeps its four-column contract', async () => {
  const ui = await components()
  const state = kbState()
  const tree = ui.KbScopeRows({
    state,
    busy: undefined,
    onReindex: () => {},
    onChooseFolder: () => {},
    onResetFolder: () => {},
  })
  assertNoLiteralJunk(tree, 'kb-rows')
  const rows = assertGridContract(tree, 'kb-rows')
  assert.equal(rows.length, state.workspaces.length + 1, 'one row per workspace plus the shared global scope')
  assert.match(textOf(rows[rows.length - 1]), /全局知识库/, 'the global scope is the last row')
})

test('structure: an overridden workspace keeps four columns too', async () => {
  const ui = await components()
  const tree = ui.KbScopeRows({
    state: kbState({ workspaces: [{ id: 'w2', title: 'other', path: '/workspaces/other', root: '/docs/kb', overridden: true, exists: true, files: 1, chunks: 2, generatedAt: Date.now() }] }),
    busy: undefined,
    onReindex: () => {},
    onChooseFolder: () => {},
    onResetFolder: () => {},
  })
  const rows = assertGridContract(tree, 'kb-overridden')
  const actions = childrenOf(rows[0])[3]
  assert.equal(childrenOf(actions).length, 3, 'overridden rows show 重建 / 更换目录 / 默认')
})

test('structure: an empty workspace list still renders the global scope in the same grid', async () => {
  const ui = await components()
  const tree = ui.KbScopeRows({
    state: kbState({ workspaces: [] }),
    busy: undefined,
    onReindex: () => {},
    onChooseFolder: () => {},
    onResetFolder: () => {},
  })
  assertNoLiteralJunk(tree, 'kb-empty')
  const rows = assertGridContract(tree, 'kb-empty')
  assert.equal(rows.length, 1, 'only the global scope remains')
  assert.match(textOf(rows[0]), /全局知识库/)
})

test('structure: migration records keep the same four-column contract', async () => {
  const ui = await components()
  const records = [
    { id: 'mig_1', timestamp: '2026-10-27T10:00:00Z', from: 'local', to: 'bailian', status: 'complete', successCount: 2, failedCount: 0, totalCount: 2, durationMs: 1200 },
    { id: 'mig_2', timestamp: '2026-10-27T11:00:00Z', from: 'bailian', to: 'local', status: 'rolled-back', successCount: 0, failedCount: 0, totalCount: 2, durationMs: 90 },
  ]
  const tree = ui.MigrationRecords({ records, busy: false, onRollback: () => {} })
  assertNoLiteralJunk(tree, 'migration-rows')
  const rows = assertGridContract(tree, 'migration-rows')
  assert.equal(rows.length, 2)
  // A rolled-back record shows text instead of a button, inside the same cell.
  const lastAction = childrenOf(rows[1])[3]
  assert.match(textOf(lastAction), /已回滚/)
  assert.equal(ui.MigrationRecords({ records: [], busy: false, onRollback: () => {} }).type, 'p')
})

test('structure: overview and memory tabs render without literal junk', async () => {
  const ui = await components()
  const overview = ui.Overview({ data: baseState, busy: false, onRefresh: () => {}, ui: { on: true, set: () => {} } })
  const cloud = ui.MemoryTab({ data: baseState, onSaved: () => {} })
  assertNoLiteralJunk(overview, 'overview')
  assertNoLiteralJunk(cloud, 'cloud')
  assertCardsHeaded(overview, 'overview')
  assertCardsHeaded(cloud, 'cloud')
})

test('structure: long workspace paths and titles do not break the grid', async () => {
  const ui = await components()
  const long = `/${'very-long-segment'.repeat(12)}`
  const tree = ui.KbScopeRows({
    state: kbState({ workspaces: [{ id: 'w1', title: 'x'.repeat(120), path: long, root: `${long}/kb`, overridden: true, exists: true, files: 999, chunks: 4321, generatedAt: Date.now() }] }),
    busy: undefined,
    onReindex: () => {},
    onChooseFolder: () => {},
    onResetFolder: () => {},
  })
  assertNoLiteralJunk(tree, 'kb-long')
  assertGridContract(tree, 'kb-long')
})

test('structure: every action button has a visible label', async () => {
  const ui = await components()
  const tree = ui.KbScopeRows({
    state: kbState(),
    busy: undefined,
    onReindex: () => {},
    onChooseFolder: () => {},
    onResetFolder: () => {},
  })
  walk(tree, (node) => {
    if (node.type !== 'button') return
    const label = textOf(node).trim()
    assert.ok(label.length > 0, 'a button rendered with no accessible text')
  })
})

test('structure: the page shell renders one tab strip and a titled header', async () => {
  const ui = await components()
  const tree = ui.MemorySettingsPage({})
  const tabs = []
  walk(tree, (node) => {
    if (node.props?.role === 'tab') tabs.push(node)
  })
  assert.equal(tabs.length, 4, `expected four tabs, got ${tabs.length}`)
  assert.equal(tabs.filter((tab) => tab.props['aria-selected'] === 'true').length, 1, 'exactly one tab is selected')
  assert.match(textOf(tree), /记忆与知识库/)
})

test('structure: the migration target row keeps select and button on one baseline', async () => {
  const ui = await components()
  const tree = ui.MigrationTab({ data: baseState, onChanged: () => {} })

  let fieldrow
  walk(tree, (node) => {
    if (node.props?.className === 'dsh-mem-fieldrow') fieldrow = node
  })
  assert.ok(fieldrow, 'the target-provider row must use the inline field row')
  const cells = childrenOf(fieldrow)
  assert.equal(cells.length, 2, 'label column + controls column')
  assert.equal(cells[0].props.className, 'dsh-mem-fieldrow-label')

  const controls = childrenOf(cells[1])
  assert.deepEqual(
    controls.map((control) => control.type),
    ['select', 'button'],
    'select and button are siblings so they share one vertical centre',
  )
  assert.ok(controls.every((control) => control.props.className.includes('dsh-mem-')), 'both controls carry the shared sizing classes')
})

test('structure: no stacked label block contains a sibling button', async () => {
  const ui = await components()
  const trees = [
    ui.Overview({ data: baseState, busy: false, onRefresh: () => {}, ui: { on: true, set: () => {} } }),
    ui.MemoryTab({ data: baseState, onSaved: () => {} }),
    ui.MigrationTab({ data: baseState, onChanged: () => {} }),
  ]
  for (const tree of trees) {
    walk(tree, (node) => {
      if (node.props?.className !== 'dsh-mem-field') return
      const buttons = childrenOf(node).filter((child) => child && child.type === 'button')
      assert.equal(buttons.length, 0, 'a button inside a stacked field would centre against the label, not the input')
    })
  }
})

test('structure: multi-row grids never use a content-sized track', async () => {
  const client = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const cssStart = client.indexOf('const CSS = `')
  const css = client.slice(cssStart, client.indexOf('`', cssStart + 14))

  // Every list row is an independent grid element, so an `auto`/`max-content`
  // track resolves differently in the header than in a data row and shifts the
  // columns. The last track must therefore be a fixed length.
  for (const selector of ['.dsh-mem-rowgrid', '.dsh-mem-rowgrid-mig']) {
    const rule = new RegExp(`\\${selector} \\{[^}]*grid-template-columns:([^;]*);`).exec(css)
    assert.ok(rule, `${selector} must declare its tracks`)
    const tracks = rule[1].trim()
    assert.ok(!/\bauto\b/.test(tracks), `${selector} must not size a track by content: ${tracks}`)
    assert.ok(!/max-content|min-content|fit-content/.test(tracks), `${selector} must use fixed/proportional tracks`)
    assert.match(tracks.split(/\s+(?=minmax|\d)/).at(-1), /^\d+px$/, `${selector} must end with a fixed pixel track`)
  }
})
