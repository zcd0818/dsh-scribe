/**
 * The settings page's local HTTP API.
 *
 * Why a route instead of Remote: a plain-JS bundle cannot register the typed
 * Remote gateway, and this page needs four operations the shipped RPC surface
 * does not have (plan a migration, run it, read progress, roll back). A
 * same-origin route under the plugin's own path does that with no build step.
 *
 * Two properties matter and are enforced here, not in the page:
 * - **Same-origin only.** A request carrying a foreign `Origin` or a
 *   `Sec-Fetch-Site: cross-site` marker is refused, so another site cannot POST
 *   a config change or a migration to the loopback listener.
 * - **Migration needs a plan token.** `POST /run` only accepts the single-use
 *   token minted by `POST /plan` (5 min TTL). Clicking "确认迁移" in the UI is
 *   the human consent step; the token is what makes the API require it.
 *
 * @module dsh-scribe/web/api
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'

import { formatBytes } from '../util.js'
import { resolveConfig } from '../config.js'
import { extractionCapabilities } from '../kb/extract.js'
import { describeConfig, mergeConfig, safeEffective, saveConfig } from './config-store.js'
import { readMigrations, rollbackMigration, runMigration } from '../migration/migrate.js'

/** Route prefix. Distinct from `/api`, which the shared connection handler owns. */
export const ROUTE_PREFIX = '/dsh-scribe/api'

/** Request body ceiling: the page only ever sends a small config patch. */
const MAX_BODY_BYTES = 256 * 1024

/** How long a migration plan's confirmation token stays valid. */
const PLAN_TTL_MS = 5 * 60 * 1000

/** Every route this module answers; anything else is a 404, not a 405. */
const KNOWN_ROUTES = new Set([
  '/state',
  '/progress',
  '/migrations',
  '/config',
  '/test',
  '/plan',
  '/run',
  '/rollback',
  '/kb/state',
  '/kb/reindex',
  '/kb/upload',
  '/kb/folder',
])

/** Upload ceiling: a memory-sized knowledge document, not a dataset. */
const MAX_UPLOAD_BYTES = 16 * 1024 * 1024

/**
 * Install the route on the web carrier.
 * @param options - `{ ctx, service, config, logger }`.
 */
export function installWebApi({ ctx, service, kb, config, logger }) {
  const plans = new Map()
  const progress = { active: false, done: 0, total: 0 }
  let lastError
  let registered = false

  /**
   * Register the route against whichever context owns the carrier.
   *
   * This row may activate before the Web carrier row does (that is what a
   * profile-order-dependent failure looks like: the fiber is healthy, nothing
   * throws, and requests just 404 because no route was ever added). So the
   * registration is attempted now and re-attempted through `ctx.inject` the
   * moment `webServer` exists.
   *
   * @param host - a context that can see `webServer`.
   * @returns whether the route is registered.
   */
  const attach = (host) => {
    if (registered) return true
    const server = host.get('webServer')
    if (server === undefined || typeof server.register !== 'function') return false
    registered = true
    host.effect(() =>
      server.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
          const started = Date.now()
          try {
            await handle(req, res)
          } catch (error) {
            lastError = error?.message ?? String(error)
            logger.warn('memory api %s failed: %s', req.url, lastError)
            if (!res.headersSent) sendJson(res, 500, { error: lastError })
            else res.end()
          }
          logger.debug('%s %s → %dms', req.method, String(req.url).slice(0, 64), Date.now() - started)
        },
      }),
    )
    logger.debug('memory api registered at %s', ROUTE_PREFIX)
    return true
  }

  if (!attach(ctx)) {
    logger.debug('webServer not ready; waiting for it before registering %s', ROUTE_PREFIX)
    try {
      ctx.inject(['webServer'], (host) => {
        attach(host)
      })
    } catch (error) {
      logger.warn('could not wait for webServer: %s', error?.message ?? error)
    }
  }

  async function handle(req, res) {
    if (!isSameOrigin(req, ctx.get('webServer'))) {
      sendJson(res, 403, { error: 'cross-origin request refused' })
      return
    }
    const url = new URL(String(req.url ?? '/'), 'http://localhost')
    const route = url.pathname.slice(ROUTE_PREFIX.length) || '/'
    const method = String(req.method ?? 'GET').toUpperCase()

    if (!KNOWN_ROUTES.has(route)) {
      sendJson(res, 404, { error: `unknown route ${route}` })
      return
    }

    if (route === '/state' && method === 'GET') {
      sendJson(res, 200, await buildState())
      return
    }
    if (route === '/kb/state' && method === 'GET') {
      if (kb === undefined) {
        sendJson(res, 200, { enabled: false, workspaces: [], global: null })
        return
      }
      try {
        sendJson(res, 200, await buildKbState())
      } catch (error) {
        sendJson(res, 500, { error: error?.message ?? String(error) })
      }
      return
    }
    if (route === '/progress' && method === 'GET') {
      sendJson(res, 200, { ...progress, lastError })
      return
    }
    if (route === '/migrations' && method === 'GET') {
      sendJson(res, 200, { records: await readMigrations(config) })
      return
    }
    if (method !== 'POST') {
      sendJson(res, 405, { error: `method ${method} is not supported on ${route}` })
      return
    }
    if (!String(req.headers['content-type'] ?? '').includes('application/json')) {
      sendJson(res, 415, { error: 'expected application/json' })
      return
    }
    const body = await readJson(req)

    if (route === '/config') {
      // Respond before the Loader reconciles: a successful write re-mounts this
      // plugin, and that would tear down the route mid-response.
      try {
        const preview = saveConfigPreview(body?.patch)
        sendJson(res, 200, { ok: true, effective: preview })
      } catch (error) {
        sendJson(res, 400, { error: error?.message ?? String(error) })
        return
      }
      void saveConfig(ctx, body?.patch)
        .then(() => {
          lastError = undefined
        })
        .catch((error) => {
          lastError = error?.message ?? String(error)
          logger.warn('config save failed: %s', lastError)
        })
      return
    }

    if (route === '/kb/reindex') {
      if (kb === undefined) {
        sendJson(res, 400, { error: '知识库未启用' })
        return
      }
      const scope = body?.scope === 'workspace' || body?.scope === 'global' ? body.scope : undefined
      const target = typeof body?.path === 'string' && body.path.length > 0 ? body.path : undefined
      try {
        const result = await kb.reindex({ scope, cwd: target ?? settingsCwd() })
        sendJson(res, 200, {
          ok: true,
          scopes: Object.fromEntries(
            Object.entries(result).map(([name, index]) => [
              name,
              {
                root: index.root,
                files: Object.keys(index.files ?? {}).length,
                chunks: index.chunks?.length ?? 0,
                durationMs: index.durationMs ?? 0,
                stats: index.stats ?? {},
              },
            ]),
          ),
        })
      } catch (error) {
        sendJson(res, 500, { error: error?.message ?? String(error) })
      }
      return
    }

    if (route === '/kb/upload') {
      if (kb === undefined) {
        sendJson(res, 400, { error: '知识库未启用' })
        return
      }
      const scope = body?.scope === 'global' ? 'global' : 'workspace'
      const rawName = String(body?.name ?? '').trim()
      const name = sanitizeFileName(rawName)
      if (name === undefined) {
        sendJson(res, 400, { error: `文件名不可用：${rawName || '(空)'}` })
        return
      }
      const encoded = String(body?.dataBase64 ?? '')
      let bytes
      try {
        bytes = Buffer.from(encoded, 'base64')
      } catch {
        sendJson(res, 400, { error: '文件内容不是有效的 base64' })
        return
      }
      if (bytes.length === 0) {
        sendJson(res, 400, { error: '文件是空的' })
        return
      }
      if (bytes.length > MAX_UPLOAD_BYTES) {
        sendJson(res, 413, { error: `文件超过 ${formatBytes(MAX_UPLOAD_BYTES)} 上限` })
        return
      }
      const cwd = typeof body?.cwd === 'string' && body.cwd.length > 0 ? body.cwd : settingsCwd()
      const root = kb.rootOf(scope, scope === 'workspace' ? cwd : undefined)
      const relative = typeof body?.dir === 'string' ? sanitizeDir(body.dir) : ''
      const targetDir = relative.length > 0 ? join(root, relative) : root
      try {
        await mkdir(targetDir, { recursive: true })
        await writeFile(join(targetDir, name), bytes)
        const index = await kb.ensure(scope, { cwd: scope === 'workspace' ? cwd : undefined, force: true })
        const indexed = Boolean(index.files?.[relative.length > 0 ? `${relative}/${name}` : name])
        sendJson(res, 200, {
          ok: true,
          scope,
          path: relative.length > 0 ? `${relative}/${name}` : name,
          root,
          bytes: bytes.length,
          indexed,
          files: Object.keys(index.files ?? {}).length,
          chunks: index.chunks?.length ?? 0,
        })
      } catch (error) {
        sendJson(res, 500, { error: error?.message ?? String(error) })
      }
      return
    }

    if (route === '/kb/folder') {
      if (kb === undefined) {
        sendJson(res, 400, { error: '知识库未启用' })
        return
      }
      const scope = body?.scope === 'global' ? 'global' : 'workspace'
      const folder = String(body?.folder ?? '').trim()
      if (folder.length === 0) {
        sendJson(res, 400, { error: '请选择一个文件夹' })
        return
      }
      const cwd = typeof body?.cwd === 'string' && body.cwd.length > 0 ? body.cwd : settingsCwd()
      const overrides = { ...(config?.knowledgeBase?.workspace?.overrides ?? {}) }
      if (scope === 'global') {
        // Clearing the field restores the default location.
        const patch = { knowledgeBase: { global: { root: folder === '<default>' ? '' : folder } } }
        try {
          pushConfig(patch)
          sendJson(res, 200, { ok: true, scope, folder })
        } catch (error) {
          sendJson(res, 400, { error: error?.message ?? String(error) })
        }
        return
      }
      if (folder === '<default>') delete overrides[cwd]
      else overrides[cwd] = folder
      try {
        pushConfig({ knowledgeBase: { workspace: { overrides } } })
        sendJson(res, 200, { ok: true, scope, cwd, folder })
      } catch (error) {
        sendJson(res, 400, { error: error?.message ?? String(error) })
      }
      return
    }

    if (route === '/test') {
      const providerId = String(body?.provider ?? config.defaultProvider)
      try {
        const provider = service.providerFor(providerId)
        const healthy = await provider.health()
        let count
        try {
          count = await provider.count()
        } catch {
          count = undefined
        }
        sendJson(res, 200, { ok: healthy, provider: providerId, type: provider.kind, count })
      } catch (error) {
        sendJson(res, 200, { ok: false, provider: providerId, error: error?.message ?? String(error) })
      }
      return
    }

    if (route === '/plan') {
      const to = String(body?.to ?? '').trim()
      if (to.length === 0) {
        sendJson(res, 400, { error: '缺少目标 provider' })
        return
      }
      if (config.providers[to] === undefined) {
        sendJson(res, 400, { error: `未知 provider「${to}」` })
        return
      }
      if (to === config.defaultProvider) {
        sendJson(res, 400, { error: '目标与当前 provider 相同，无需迁移' })
        return
      }
      const source = service.providerFor(config.defaultProvider)
      const target = service.providerFor(to)
      const [sourceInfo, targetInfo] = await Promise.all([inspect(source), inspect(target)])
      if (sourceInfo.count === 0) {
        sendJson(res, 200, { empty: true, from: config.defaultProvider, to, source: sourceInfo, target: targetInfo })
        return
      }
      const token = randomToken()
      plans.set(token, { from: config.defaultProvider, to, expiresAt: Date.now() + PLAN_TTL_MS })
      prunePlans(plans)
      sendJson(res, 200, {
        empty: false,
        token,
        from: config.defaultProvider,
        to,
        source: sourceInfo,
        target: targetInfo,
      })
      return
    }

    if (route === '/run') {
      const token = String(body?.token ?? '')
      const plan = plans.get(token)
      if (plan === undefined || plan.expiresAt < Date.now()) {
        plans.delete(token)
        sendJson(res, 400, { error: '确认已过期，请重新生成迁移计划' })
        return
      }
      plans.delete(token)
      progress.active = true
      progress.done = 0
      progress.total = 0
      try {
        const record = await runMigration({
          service,
          config,
          logger,
          from: plan.from,
          to: plan.to,
          onProgress: ({ done, total }) => {
            progress.done = done
            progress.total = total
          },
        })
        lastError = undefined
        sendJson(res, 200, { ok: true, record })
      } catch (error) {
        lastError = error?.message ?? String(error)
        sendJson(res, 500, { error: lastError })
      } finally {
        progress.active = false
      }
      return
    }

    if (route === '/rollback') {
      const id = String(body?.id ?? '').trim()
      if (id.length === 0) {
        sendJson(res, 400, { error: '缺少迁移 id' })
        return
      }
      try {
        const result = await rollbackMigration({ service, config, logger, migrationId: id })
        sendJson(res, 200, { ok: true, removed: result.removed, declined: result.declined })
      } catch (error) {
        sendJson(res, 200, { ok: false, error: error?.message ?? String(error) })
      }
      return
    }

    sendJson(res, 404, { error: `unknown route ${route}` })
  }

  /**
   * Registered workspaces, which are the real targets of a workspace index.
   *
   * A settings page has no Session, so there is no single "current directory":
   * the honest answer is the workspace list the user already works in. The
   * fallback chain ends at the Host process directory so the page still renders
   * something legible in a composition without a workspace registry.
   */
  function workspaceTargets() {
    const targets = []
    try {
      const registry = ctx.get('workspaceRegistry')
      for (const workspace of registry?.list?.() ?? []) {
        const path = typeof workspace?.path === 'string' ? workspace.path : undefined
        if (path === undefined || path.length === 0) continue
        targets.push({
          id: String(workspace.id ?? path),
          title: String(workspace.title ?? workspace.record?.title ?? path.split(/[\\/]/).filter(Boolean).at(-1) ?? path),
          path,
        })
      }
    } catch {
      // A registry failure must not take the whole page down.
    }
    return targets
  }

  /** The directory `reindex`/`peek` use when the page names none. */
  function settingsCwd() {
    const configured = config?.knowledgeBase?.workspace?.cwd
    if (typeof configured === 'string' && configured.length > 0) return configured
    const first = workspaceTargets()[0]
    if (first !== undefined) return first.path
    return process.cwd()
  }

  /**
   * Persist a config patch without blocking the response.
   *
   * A successful write re-mounts this plugin, which would tear down the route
   * mid-response — so the caller answers first and the write settles after.
   */
  function pushConfig(patch) {
    // Validate synchronously so a bad value is rejected before the response.
    resolveConfig(mergeConfig(config, patch))
    void saveConfig(ctx, patch)
      .then(() => {
        lastError = undefined
      })
      .catch((error) => {
        lastError = error?.message ?? String(error)
        logger.warn('config save failed: %s', lastError)
      })
  }

  /** Page state for the knowledge tab: one row per registered workspace, plus global. */
  async function buildKbState() {
    const targets = workspaceTargets()
    const overrides = config?.knowledgeBase?.workspace?.overrides ?? {}
    const workspaces = []
    for (const target of targets) {
      const peeked = await kb.peek({ cwd: target.path })
      workspaces.push({
        id: target.id,
        title: target.title,
        path: target.path,
        root: peeked.root,
        overridden: typeof overrides[target.path] === 'string',
        exists: peeked.exists,
        files: peeked.files,
        chunks: peeked.chunks,
        generatedAt: peeked.generatedAt,
      })
    }
    const global = await kb.peek({ scope: 'global' })
    return {
      enabled: kb.enabled,
      refreshSeconds: config?.knowledgeBase?.refreshSeconds ?? 300,
      cwd: settingsCwd(),
      sidebar: config?.ui?.sidebar !== false,
      defaultFolder: config?.knowledgeBase?.workspace?.root ?? 'kb',
      include: config?.knowledgeBase?.workspace?.include ?? ['**/*.md'],
      extract: {
        enabled: config?.knowledgeBase?.extract?.enabled !== false,
        documents: config?.knowledgeBase?.extract?.documents ?? ['.docx', '.xlsx', '.pptx', '.pdf'],
        capabilities: await extractionCapabilities(),
      },
      globalRootConfigured: typeof config?.knowledgeBase?.global?.root === 'string' && config.knowledgeBase.global.root.length > 0,
      overrides: config?.knowledgeBase?.workspace?.overrides ?? {},
      workspaces,
      global: {
        root: global.root,
        exists: global.exists,
        files: global.files,
        chunks: global.chunks,
        generatedAt: global.generatedAt,
      },
    }
  }

  async function buildState() {
    const status = await service.status()
    const described = describeConfig(ctx, config)
    const providers = Object.entries(config.providers).map(([id, provider]) => ({
      id,
      type: provider.type,
      active: id === config.defaultProvider,
      hasApiKey: typeof provider.apiKey === 'string' && provider.apiKey.length > 0,
    }))
    return {
      status,
      config: described,
      providers,
      dataDir: config.dataDir,
      migrations: (await readMigrations(config)).slice(0, 10),
      lastError,
    }
  }

  /** Validate a patch against the live config without writing it. */
  function saveConfigPreview(patch) {
    if (patch === undefined || patch === null || typeof patch !== 'object') throw new Error('缺少配置内容')
    // Re-resolve the merged config to surface a clear message before persisting.
    return safeEffective(resolveConfig(mergeConfig(config, patch)))
  }
}

async function inspect(provider) {
  const memories = await provider.bulkExport()
  const dates = memories.map((memory) => Number(memory.createdAt ?? 0)).filter((value) => value > 0)
  const bytes = memories.reduce((total, memory) => total + Buffer.byteLength(String(memory.content ?? ''), 'utf8'), 0)
  return {
    count: memories.length,
    bytes,
    bytesLabel: formatBytes(bytes),
    oldest: dates.length > 0 ? new Date(Math.min(...dates)).toISOString().slice(0, 10) : undefined,
    newest: dates.length > 0 ? new Date(Math.max(...dates)).toISOString().slice(0, 10) : undefined,
    sample: memories.slice(0, 3).map((memory) => String(memory.content ?? '').slice(0, 100)),
  }
}

/**
 * Same-origin check for a request to a loopback listener.
 * @param req - incoming request.
 * @param server - the web carrier (supplies the expected origin).
 * @returns whether the request may proceed.
 */
function isSameOrigin(req, server) {
  if (String(req.headers['sec-fetch-site'] ?? '') === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  let expected
  try {
    expected = server.getOrigin()
  } catch {
    return true
  }
  try {
    return new URL(String(origin)).origin === new URL(expected).origin
  } catch {
    return false
  }
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text.length === 0) return {}
  return JSON.parse(text)
}

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * Reject anything that could escape the knowledge directory.
 * @param name - the browser-supplied file name.
 * @returns a safe basename, or undefined when unusable.
 */
function sanitizeFileName(name) {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? ''
  const trimmed = base.trim().replace(/^[.]+/, '')
  if (trimmed.length === 0 || trimmed === '.' || trimmed === '..') return undefined
  if (/[\u0000-\u001f]/.test(trimmed)) return undefined
  if (trimmed.length > 120) return undefined
  if (!/\.[A-Za-z0-9]{1,8}$/.test(trimmed)) return undefined
  return trimmed
}

/** A relative sub-directory inside the knowledge folder. */
function sanitizeDir(dir) {
  const value = String(dir ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (value.length === 0) return ''
  if (value.includes('..')) throw new Error('目录不能包含 ..')
  return value
}

function randomToken() {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function prunePlans(plans) {
  const now = Date.now()
  for (const [token, plan] of plans) {
    if (plan.expiresAt < now) plans.delete(token)
  }
}
