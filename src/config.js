/**
 * Configuration resolution: defaults, `~` and environment expansion, and
 * validation that fails loud on a value the plugin cannot honor.
 *
 * The row's `config` in `cordis.patch.yml` is user-owned state and survives
 * upgrades, so every tunable lives here rather than in module constants.
 *
 * @module dsh-scribe/config
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** Provider types this build can construct. */
export const PROVIDER_TYPES = ['local', 'bailian', 'hybrid']

/** Retrieval modes, from cheapest to most expensive. */
export const RETRIEVAL_MODES = ['recent', 'lexical', 'vector', 'hybrid']

const DEFAULTS = {
  enabled: true,
  defaultProvider: 'local',
  autoInject: true,
  autoSave: true,
  injectLimit: 5,
  injectMaxChars: 1200,
  includeSubagents: false,
  logLevel: 'info',
  dataDir: '~/.dsh/memory',
  ui: {
    // Contribute a row to the shell's own left menu (sidebar.panellist) plus its
    // page in the keyed `main` slot. Off means the feature stays reachable only
    // from Settings.
    sidebar: true,
  },
  providers: {
    local: {
      type: 'local',
      path: '~/.dsh/memory',
      engine: 'file',
    },
    bailian: {
      type: 'bailian',
      apiKey: '',
      // Either a business-space id (builds the documented host) or a full endpoint.
      workspaceId: '',
      region: 'cn-beijing',
      endpoint: '',
      // The API isolates memory per `user_id`; this is that key, not an account id.
      userId: 'dsh',
      memoryLibraryId: '',
      projectId: '',
      planVersion: 'pro',
      pageSize: 50,
      maxPages: 20,
      timeoutMs: 15000,
    },
  },
  embedding: {
    // Reuse the conversation model when its route exposes an embeddings
    // endpoint; otherwise retrieval degrades to lexical scoring.
    mode: 'auto',
    endpoint: '',
    apiKey: '',
    model: 'text-embedding-v3',
    timeoutMs: 15000,
  },
  retrieval: {
    mode: 'hybrid',
    minScore: 0.18,
    candidateLimit: 20,
    llmRerank: true,
    llmTimeoutMs: 8000,
  },
  summarization: {
    shortTurns: 10,
    maxChars: 320,
    llmTimeoutMs: 20000,
    fallbackMessages: 5,
  },
  retention: {
    maxMemories: 5000,
    ttlDays: 0,
  },
  knowledgeBase: {
    enabled: true,
    workspace: {
      // Relative to the session's working directory: the workspace `kb/`
      // convention documented in AGENTS.md.
      root: 'kb',
      // Text-like documents only: everything here is read as UTF-8 and chunked
      // by headings, so binaries would only add noise.
      include: [
        '**/*.md',
        '**/*.markdown',
        '**/*.mdx',
        '**/*.txt',
        '**/*.rst',
        '**/*.csv',
        '**/*.tsv',
        '**/*.json',
        '**/*.jsonl',
        '**/*.yaml',
        '**/*.yml',
        '**/*.toml',
        '**/*.ini',
        '**/*.conf',
        '**/*.sql',
        '**/*.html',
        '**/*.css',
        '**/*.js',
        '**/*.mjs',
        '**/*.ts',
        '**/*.tsx',
        '**/*.jsx',
        '**/*.vue',
        '**/*.py',
        '**/*.go',
        '**/*.rs',
        '**/*.java',
        '**/*.kt',
        '**/*.rb',
        '**/*.php',
        '**/*.sh',
      ],
      exclude: [
        '**/原始/**',
        '**/inbox/**',
        '**/node_modules/**',
        '**/.git/**',
        '**/dist/**',
        '**/build/**',
        '**/package-lock.json',
        '**/pnpm-lock.yaml',
        '**/yarn.lock',
      ],
      overrides: {},
    },
    global: {
      // Empty means `<dataDir>/kb/global`; set it to share one folder across
      // every workspace.
      root: '',
      include: [
        '**/*.md',
        '**/*.markdown',
        '**/*.txt',
        '**/*.rst',
        '**/*.csv',
        '**/*.json',
        '**/*.yaml',
        '**/*.yml',
        '**/*.toml',
        '**/*.sql',
        '**/*.html',
      ],
    },
    extract: {
      // Binary documents whose body text is pulled out before indexing.
      // Word / Excel / PowerPoint use the built-in OOXML reader; PDF needs the
      // optional pdfjs-dist dependency and is skipped with a reason without it.
      enabled: true,
      documents: ['.docx', '.xlsx', '.pptx', '.pdf'],
      maxChars: 200_000,
    },
    chunk: { maxChars: 1200, minChars: 80 },
    limits: { maxFiles: 2000, maxChunks: 20000 },
    refreshSeconds: 300,
    minScore: 0.12,
    injectIndexLines: 30,
    injectMaxChars: 1100,
  },
}

/**
 * Resolve one user config object into a complete, validated configuration.
 * @param raw - the row's `config` (may be undefined).
 * @returns the resolved configuration.
 * @throws when a required value is unusable or a provider type is unknown.
 */
export function resolveConfig(raw) {
  const input = isPlainObject(raw) ? raw : {}
  const merged = {
    ...DEFAULTS,
    ...input,
    providers: mergeProviders(input.providers),
    embedding: { ...DEFAULTS.embedding, ...(isPlainObject(input.embedding) ? input.embedding : {}) },
    retrieval: { ...DEFAULTS.retrieval, ...(isPlainObject(input.retrieval) ? input.retrieval : {}) },
    summarization: {
      ...DEFAULTS.summarization,
      ...(isPlainObject(input.summarization) ? input.summarization : {}),
    },
    retention: { ...DEFAULTS.retention, ...(isPlainObject(input.retention) ? input.retention : {}) },
    ui: { ...DEFAULTS.ui, ...(isPlainObject(input.ui) ? input.ui : {}) },
    knowledgeBase: {
      ...DEFAULTS.knowledgeBase,
      ...(isPlainObject(input.knowledgeBase) ? input.knowledgeBase : {}),
      workspace: {
        ...DEFAULTS.knowledgeBase.workspace,
        ...(isPlainObject(input.knowledgeBase?.workspace) ? input.knowledgeBase.workspace : {}),
      },
      global: {
        ...DEFAULTS.knowledgeBase.global,
        ...(isPlainObject(input.knowledgeBase?.global) ? input.knowledgeBase.global : {}),
      },
      chunk: {
        ...DEFAULTS.knowledgeBase.chunk,
        ...(isPlainObject(input.knowledgeBase?.chunk) ? input.knowledgeBase.chunk : {}),
      },
      extract: {
        ...DEFAULTS.knowledgeBase.extract,
        ...(isPlainObject(input.knowledgeBase?.extract) ? input.knowledgeBase.extract : {}),
      },
      limits: {
        ...DEFAULTS.knowledgeBase.limits,
        ...(isPlainObject(input.knowledgeBase?.limits) ? input.knowledgeBase.limits : {}),
      },
    },
  }

  const config = {
    ...merged,
    dataDir: expandPath(merged.dataDir),
    injectLimit: positiveInt(merged.injectLimit, DEFAULTS.injectLimit),
    injectMaxChars: positiveInt(merged.injectMaxChars, DEFAULTS.injectMaxChars),
    providers: Object.fromEntries(
      Object.entries(merged.providers).map(([id, provider]) => [id, resolveProvider(id, provider)]),
    ),
  }

  if (!Object.hasOwn(config.providers, config.defaultProvider)) {
    throw new Error(
      `defaultProvider "${config.defaultProvider}" is not a configured provider (configured: ${Object.keys(config.providers).join(', ')})`,
    )
  }
  if (typeof config.knowledgeBase.global.root === 'string' && config.knowledgeBase.global.root.length > 0) {
    config.knowledgeBase.global.root = expandPath(config.knowledgeBase.global.root)
  }
  if (!RETRIEVAL_MODES.includes(config.retrieval.mode)) {
    throw new Error(`retrieval.mode must be one of ${RETRIEVAL_MODES.join(' | ')}`)
  }
  return config
}

/**
 * Resolve the provider that owns new memories, plus the local mirror used by a
 * hybrid provider for read-ahead.
 * @param config - resolved configuration.
 * @returns the active provider entry.
 */
export function activeProvider(config) {
  return config.providers[config.defaultProvider]
}

function mergeProviders(raw) {
  if (!isPlainObject(raw)) return { ...DEFAULTS.providers }
  const providers = { ...DEFAULTS.providers }
  for (const [id, entry] of Object.entries(raw)) {
    if (!isPlainObject(entry)) continue
    const base = id === 'local' ? DEFAULTS.providers.local : id === 'bailian' ? DEFAULTS.providers.bailian : {}
    providers[id] = { ...base, ...entry }
  }
  return providers
}

function resolveProvider(id, provider) {
  const type = provider.type ?? id
  if (!PROVIDER_TYPES.includes(type)) {
    throw new Error(`provider "${id}" has unknown type "${type}" (known: ${PROVIDER_TYPES.join(', ')})`)
  }
  const resolved = { ...provider, type }
  if (type === 'local') {
    resolved.path = expandPath(provider.path ?? join(DEFAULTS.dataDir, 'data'))
    if (!['file', 'chromadb'].includes(resolved.engine ?? 'file')) {
      throw new Error(`provider "${id}": engine must be "file" or "chromadb"`)
    }
    resolved.engine = resolved.engine ?? 'file'
  }
  if (type === 'bailian' || type === 'hybrid') {
    resolved.apiKey = expandSecret(provider.apiKey)
  }
  if (type === 'hybrid') {
    resolved.mirror = provider.mirror ?? 'local'
    if (!Object.hasOwn(DEFAULTS.providers, resolved.mirror) && resolved.mirror !== 'local') {
      throw new Error(`provider "${id}": mirror must name a configured local provider`)
    }
  }
  return resolved
}

/**
 * Expand a leading `~` and interpolate `$VAR` / `${VAR}` segments.
 * @param value - configured path or URL.
 * @returns the expanded string.
 */
export function expandPath(value) {
  if (typeof value !== 'string' || value.length === 0) return value
  const expanded = expandSecret(value)
  if (expanded === '~') return homedir()
  if (expanded.startsWith('~/') || expanded.startsWith('~\\')) return join(homedir(), expanded.slice(2))
  return expanded
}

/**
 * Resolve a secret that may be a literal, `$ENV`, `${ENV}`, or `env:ENV`.
 * @param value - configured secret.
 * @returns the literal value, or the environment value, or the input unchanged.
 */
export function expandSecret(value) {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  const envName = /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(trimmed)
  if (envName) return process.env[envName[1]] ?? ''
  const exact = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(trimmed)
  if (exact) return process.env[exact[1]] ?? ''
  return trimmed.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) => process.env[name] ?? match)
}

function positiveInt(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
