import assert from 'node:assert/strict'
import test from 'node:test'

import { BailianProvider, fromNode, resolveEndpoint } from '../src/providers/bailian.js'

const logger = { debug() {}, info() {}, warn() {}, error() {} }

const BASE = 'https://llm-abc.cn-beijing.maas.aliyuncs.com/api/v2/apps/memory'

/** Install a fetch stub that routes by path and records every call. */
function stubFetch(routes) {
  const calls = []
  const previous = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url))
    const key = `${init?.method ?? 'GET'} ${parsed.pathname}`
    calls.push({ key, url: parsed, init, body: init?.body ? JSON.parse(init.body) : undefined })
    const route = routes[key] ?? routes[`* ${parsed.pathname}`]
    if (route === undefined) return respond(404, { code: 'NotFound', message: `no stub for ${key}` })
    const value = typeof route === 'function' ? route(parsed, init) : route
    return respond(value.status ?? 200, value.body ?? {})
  }
  return {
    calls,
    restore() {
      globalThis.fetch = previous
    },
  }
}

function respond(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  }
}

function provider(config = {}) {
  return new BailianProvider('bailian', {
    logger,
    config: { type: 'bailian', apiKey: 'sk-test', workspaceId: 'llm-abc', ...config },
  })
}

test('bailian: endpoint comes from workspace id or an explicit url', () => {
  assert.equal(resolveEndpoint({ workspaceId: 'llm-abc' }), BASE)
  assert.equal(resolveEndpoint({ workspaceId: 'llm-abc', region: 'cn-shanghai' }), BASE.replace('cn-beijing', 'cn-shanghai'))
  assert.equal(resolveEndpoint({ endpoint: 'https://proxy.test/api/v2/apps/memory/' }), 'https://proxy.test/api/v2/apps/memory')
  assert.equal(resolveEndpoint({}), undefined)
})

test('bailian: a missing api key or workspace fails at construction', () => {
  assert.throws(() => new BailianProvider('bailian', { logger, config: { type: 'bailian', workspaceId: 'llm-abc' } }), /apiKey/)
  assert.throws(() => new BailianProvider('bailian', { logger, config: { type: 'bailian', apiKey: 'k' } }), /workspaceId/)
})

test('bailian: add posts custom_content with our identity in meta_data', async () => {
  const stub = stubFetch({
    'POST /api/v2/apps/memory/add': {
      body: { request_id: 'r1', memory_nodes: [{ memory_node_id: 'node-1', content: '内容', event: 'ADD' }] },
    },
  })
  try {
    const result = await provider({ userId: 'u1', memoryLibraryId: 'lib-1' }).add({
      id: 'mem_local_1',
      content: '记住这个决定',
      createdAt: 1_700_000_000_000,
      source: 'session-summary',
      tags: ['project:demo'],
    })
    const call = stub.calls.find((entry) => entry.key === 'POST /api/v2/apps/memory/add')
    assert.equal(call.body.user_id, 'u1')
    assert.equal(call.body.custom_content, '记住这个决定')
    assert.equal(call.body.memory_library_id, 'lib-1')
    assert.equal(call.body.meta_data.dsh_id, 'mem_local_1')
    assert.deepEqual(call.body.meta_data.tags, ['project:demo'])
    assert.equal(result.remoteId, 'node-1')
    assert.equal(call.init.headers.authorization, 'Bearer sk-test')
  } finally {
    stub.restore()
  }
})

test('bailian: search maps semantic nodes and passes plan/min_score', async () => {
  const stub = stubFetch({
    'POST /api/v2/apps/memory/memory_nodes/search': {
      body: {
        request_id: 'r2',
        plan_version: 'pro',
        memory_nodes: [
          {
            memory_node_id: 'node-9',
            content: '用户偏好 pnpm',
            created_at: 1_700_000_000,
            meta_data: { source: 'user-explicit', tags: ['pref'] },
            score: 0.82,
          },
        ],
      },
    },
  })
  try {
    const hits = await provider({ minScore: 0.5 }).search('包管理器偏好', { limit: 3 })
    const call = stub.calls.find((entry) => entry.key === 'POST /api/v2/apps/memory/memory_nodes/search')
    assert.equal(call.body.top_k, 3)
    assert.equal(call.body.min_score, 0.5)
    assert.equal(call.body.plan_version, 'pro')
    assert.deepEqual(call.body.messages, [{ role: 'user', content: '包管理器偏好' }])

    assert.equal(hits.length, 1)
    assert.equal(hits[0].id, 'node-9')
    assert.equal(hits[0].createdAt, 1_700_000_000_000)
    assert.equal(hits[0].score, 0.82)
    assert.deepEqual(hits[0].tags, ['pref'])
  } finally {
    stub.restore()
  }
})

test('bailian: listing pages through memory_nodes and stops at total', async () => {
  let pageCalls = 0
  const stub = stubFetch({
    'GET /api/v2/apps/memory/memory_nodes': (url) => {
      pageCalls += 1
      const page = Number(url.searchParams.get('page_num'))
      const all = [
        { memory_node_id: 'n1', content: '一', created_at: 1_700_000_100, meta_data: {} },
        { memory_node_id: 'n2', content: '二', created_at: 1_700_000_200, meta_data: {} },
        { memory_node_id: 'n3', content: '三', created_at: 1_700_000_300, meta_data: {} },
      ]
      const size = Number(url.searchParams.get('page_size'))
      const start = (page - 1) * size
      return { body: { memory_nodes: all.slice(start, start + size), total: 3, page_num: page, page_size: size } }
    },
  })
  try {
    const p = provider({ pageSize: 2 })
    const all = await p.bulkExport()
    assert.equal(all.length, 3)
    assert.equal(pageCalls, 2)
    assert.deepEqual(all.map((memory) => memory.id), ['n1', 'n2', 'n3'])
    assert.equal(await p.count(), 3)
    assert.equal(await p.health(), true)
  } finally {
    stub.restore()
  }
})

test('bailian: delete hits the node path and health reports failure', async () => {
  const stub = stubFetch({
    'DELETE /api/v2/apps/memory/memory_nodes/node-1': { body: { request_id: 'r3' } },
  })
  try {
    assert.equal(await provider({ memoryLibraryId: 'lib-1' }).delete('node-1'), true)
    const call = stub.calls.find((entry) => entry.key.startsWith('DELETE '))
    assert.equal(call.url.searchParams.get('memory_library_id'), 'lib-1')

    const down = stubFetch({})
    try {
      assert.equal(await provider().health(), false)
    } finally {
      down.restore()
    }
  } finally {
    stub.restore()
  }
})

test('bailian: an empty query lists recent nodes instead of searching', async () => {
  const stub = stubFetch({
    'GET /api/v2/apps/memory/memory_nodes': {
      body: { memory_nodes: [{ memory_node_id: 'n1', content: '最近', created_at: 1_700_000_000, meta_data: {} }], total: 1 },
    },
  })
  try {
    const hits = await provider().search('', { limit: 5 })
    assert.equal(hits.length, 1)
    assert.ok(!stub.calls.some((entry) => entry.key.includes('/search')))
  } finally {
    stub.restore()
  }
})

test('bailian: node projection tolerates missing metadata', () => {
  const memory = fromNode({ memory_node_id: 'x', content: 'c' })
  assert.equal(memory.id, 'x')
  assert.equal(memory.content, 'c')
  assert.deepEqual(memory.tags, [])
  assert.ok(memory.createdAt > 0)
})
