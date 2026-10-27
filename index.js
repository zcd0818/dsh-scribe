/**
 * `dsh-scribe` — cross-session memory and a local knowledge base for
 * DeepSeek Harness.
 *
 * Design contract (see README.md):
 * - Every memory lives in a `StorageProvider`; the default provider is a local,
 *   file-backed vector/lexical store under `~/.dsh/memory`.
 * - The knowledge base is read-only over the user's own documents: `kb/` per
 *   workspace plus one global folder, with citations back to file lines.
 * - A session sees memory through one per-agent, scoped `systemPrompt` section,
 *   filled at `agent/created` from an already-warm cache so the first model
 *   request carries it without blocking on I/O.
 * - A session writes back one memory at `agent/disposed` (short transcripts are
 *   stored extractively, long ones are summarized by the session's own model).
 * - Migrating data between providers is never automatic: it requires an
 *   explicit approval decision from the user and is logged so it can be rolled
 *   back.
 *
 * @module dsh-scribe
 */

import { resolveConfig } from './src/config.js'
import { createLogger } from './src/log.js'
import { createMemoryService } from './src/memory-service.js'
import { installSessionLifecycle } from './src/session/lifecycle.js'
import { installMemoryTools } from './src/tools/memory-tools.js'
import { installCommands } from './src/tools/commands.js'
import { createKbService } from './src/kb/service.js'
import { installKbTools } from './src/kb/tools.js'
import { installWebApi } from './src/web/api.js'

/** Cordis plugin name. */
export const name = 'dsh-scribe'

/**
 * The services this plugin cannot do without. Both are core rows in every
 * composition, so a hard injection keeps the plugin inactive (instead of
 * throwing) only in a composition that removed the prompt or tool registry.
 */
export const inject = ['systemPrompt', 'tools']

/**
 * Mount the memory plugin.
 * @param ctx - the plugin's Cordis context.
 * @param config - the row's `config` object (see README for every field).
 */
export function apply(ctx, config) {
  let resolved
  try {
    resolved = resolveConfig(config)
  } catch (error) {
    ctx.logger?.('dsh-scribe')?.error?.('invalid config: %s', error?.message ?? error)
    return
  }
  if (!resolved.enabled) return

  const logger = createLogger(ctx, resolved.logLevel)
  const service = createMemoryService({ ctx, config: resolved, logger })
  const kb = createKbService({ config: resolved, logger })

  installSessionLifecycle({ ctx, service, kb, config: resolved, logger })
  installMemoryTools({ ctx, service, config: resolved, logger })
  installKbTools({ ctx, kb, config: resolved, logger })
  installCommands({ ctx, service, config: resolved, logger })
  // The settings page's local API. Optional: a composition without a web
  // carrier simply has no page data.
  installWebApi({ ctx, service, kb, config: resolved, logger })

  // Warm the store once so the first session of a process is not the one that
  // pays for parsing the whole memory file.
  void service.ready().catch((error) => {
    logger.warn('memory store failed to load: %s', error?.message ?? error)
  })

  logger.debug('mounted (provider=%s, autoInject=%s)', resolved.defaultProvider, resolved.autoInject)
}
