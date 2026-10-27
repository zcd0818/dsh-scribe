/**
 * Config read/write for the settings page.
 *
 * The page never edits files itself: it posts a patch, this module validates it
 * through the same `resolveConfig` the runtime uses, and persists it through
 * `configEditor`, which writes the profile patch and reconciles the live
 * Loader — the documented path, so a hand-written YAML edit is never needed.
 *
 * Secrets are write-only across this boundary: a read reports `hasApiKey`, and
 * a patch that omits `apiKey` keeps the stored one.
 *
 * @module dsh-scribe/web/config-store
 */

import { isPlainObject, resolveConfig } from '../config.js'

/** The bundle row this page configures. */
export const ROW_NAME = 'dsh-scribe'
export const ROW_ID = 'dsh-scribe'

/**
 * Locate this plugin's row in the composed profile.
 * @param ctx - plugin context.
 * @returns `{ entry, inherited, override, editor }` or undefined when the row is not addressable.
 */
export function findRow(ctx) {
  const editor = ctx.get('configEditor')
  if (editor === undefined || typeof editor.configuration !== 'function') return undefined
  let rows
  try {
    rows = editor.configuration()
  } catch {
    return undefined
  }
  const row = (rows ?? []).find((candidate) => {
    const entry = candidate?.entry ?? {}
    return entry.name === ROW_NAME || entry.id === ROW_ID || String(entry.id ?? '').endsWith(`:${ROW_ID}`)
  })
  if (row === undefined) return undefined
  return {
    editor,
    entry: row.entry,
    inherited: isPlainObject(row.inherited) ? row.inherited : {},
    override: isPlainObject(row.override) ? row.override : {},
  }
}

/**
 * Read the effective config with every secret removed.
 * @param ctx - plugin context.
 * @param config - the live resolved config.
 * @returns a page-safe snapshot.
 */
export function describeConfig(ctx, config) {
  const row = findRow(ctx)
  return {
    editable: row !== undefined,
    rowId: row === undefined ? ROW_ID : String(row.entry.id ?? ROW_ID),
    effective: safeEffective(config),
    override: redact(row?.override ?? {}),
    source: row === undefined ? 'bundle-default' : Object.keys(row.override).length > 0 ? 'profile-patch' : 'bundle-default',
  }
}

/**
 * Persist a patch, preserving secrets the page did not resend.
 *
 * @param ctx - plugin context.
 * @param patch - the page's field changes.
 * @returns the merged config that was written.
 * @throws when the row is not addressable or the merged config is invalid.
 */
export async function saveConfig(ctx, patch) {
  if (!isPlainObject(patch)) throw new Error('config patch must be an object')
  const row = findRow(ctx)
  if (row === undefined) {
    throw new Error('this plugin row is not addressable by the config editor; edit it in cordis.patch.yml instead')
  }
  if (typeof row.editor.edit !== 'function') throw new Error('the config editor cannot write in this deployment')

  let written
  await row.editor.edit(row.entry, (current) => {
    const base = isPlainObject(current) ? current : {}
    written = mergeConfig(base, patch)
    // Validate before it reaches disk: a bad value must not be persisted.
    resolveConfig(written)
    return written
  })
  return redact(written ?? {})
}

/**
 * Deep-merge a page patch into a stored config.
 *
 * Merges at most two levels (the shape this plugin's config has) and treats an
 * array or scalar as a replacement, never a merge.
 *
 * @param base - stored config.
 * @param patch - fields to apply.
 * @returns a new config object.
 */
export function mergeConfig(base, patch) {
  const out = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (isPlainObject(value) && isPlainObject(out[key])) {
      const nested = { ...out[key] }
      for (const [innerKey, innerValue] of Object.entries(value)) {
        if (innerValue === undefined) continue
        if (isPlainObject(innerValue) && isPlainObject(nested[innerKey])) {
          nested[innerKey] = { ...nested[innerKey], ...innerValue }
        } else {
          nested[innerKey] = innerValue
        }
      }
      out[key] = nested
    } else {
      out[key] = value
    }
  }
  return out
}

/**
 * The subset of config the page renders, with credentials reduced to presence.
 * @param config - resolved config.
 * @returns page-safe config.
 */
export function safeEffective(config) {
  return {
    enabled: config.enabled,
    defaultProvider: config.defaultProvider,
    autoInject: config.autoInject,
    autoSave: config.autoSave,
    injectLimit: config.injectLimit,
    injectMaxChars: config.injectMaxChars,
    includeSubagents: config.includeSubagents,
    dataDir: config.dataDir,
    providers: Object.fromEntries(
      Object.entries(config.providers).map(([id, provider]) => [
        id,
        {
          type: provider.type,
          ...(provider.type === 'local'
            ? { path: provider.path, engine: provider.engine, ...(provider.url ? { url: provider.url } : {}) }
            : {}),
          ...(provider.type === 'bailian'
            ? {
                workspaceId: provider.workspaceId ?? '',
                region: provider.region ?? 'cn-beijing',
                userId: provider.userId ?? 'dsh',
                memoryLibraryId: provider.memoryLibraryId ?? '',
                projectId: provider.projectId ?? '',
                planVersion: provider.planVersion ?? 'pro',
                endpoint: provider.endpoint ?? '',
              }
            : {}),
          ...(provider.type === 'hybrid' ? { primary: provider.primary ?? '', mirror: provider.mirror ?? 'local' } : {}),
          hasApiKey: typeof provider.apiKey === 'string' && provider.apiKey.length > 0,
        },
      ]),
    ),
    embedding: {
      endpoint: config.embedding.endpoint ?? '',
      model: config.embedding.model ?? '',
      hasApiKey: typeof config.embedding.apiKey === 'string' && config.embedding.apiKey.length > 0,
    },
    retrieval: { mode: config.retrieval.mode, minScore: config.retrieval.minScore, llmRerank: config.retrieval.llmRerank },
    summarization: { shortTurns: config.summarization.shortTurns, maxChars: config.summarization.maxChars },
    retention: { maxMemories: config.retention.maxMemories, ttlDays: config.retention.ttlDays },
    ui: { sidebar: config.ui?.sidebar !== false },
    knowledgeBase: {
      enabled: config.knowledgeBase?.enabled !== false,
      folder: config.knowledgeBase?.workspace?.root ?? 'kb',
      globalRoot: config.knowledgeBase?.global?.root ?? '',
      overrides: config.knowledgeBase?.workspace?.overrides ?? {},
      refreshSeconds: config.knowledgeBase?.refreshSeconds ?? 300,
    },
  }
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact)
  if (!isPlainObject(value)) return value
  const out = {}
  for (const [key, inner] of Object.entries(value)) {
    if (/apikey|token|secret|password/i.test(key)) {
      out[key] = typeof inner === 'string' && inner.length > 0 ? '<已设置>' : ''
      continue
    }
    out[key] = redact(inner)
  }
  return out
}
