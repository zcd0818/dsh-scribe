/**
 * Provider construction from configuration.
 *
 * Providers are built lazily and cached per id, so a provider that needs a
 * network key (Bailian) never blocks a user who only configured local memory.
 *
 * @module dsh-scribe/providers/factory
 */

import { BailianProvider } from './bailian.js'
import { HybridProvider } from './hybrid.js'
import { LocalProvider } from './local.js'

/**
 * Create one provider instance by id.
 *
 * A `hybrid` entry names two other configured providers: `primary` (the cloud
 * side, defaulting to the entry's own `type`-less sibling `bailian` when present)
 * and `mirror` (a local provider, default `local`).
 *
 * @param id - configured provider name.
 * @param config - resolved plugin configuration.
 * @param logger - plugin logger.
 * @returns the provider.
 */
export function createProvider(id, config, logger) {
  const entry = config.providers[id]
  if (!entry) throw new Error(`unknown provider "${id}"`)

  switch (entry.type) {
    case 'local':
      return new LocalProvider(id, { config: entry, logger })
    case 'bailian':
      return new BailianProvider(id, { config: entry, logger })
    case 'hybrid': {
      const mirrorId = entry.mirror ?? 'local'
      const primaryId = entry.primary ?? (config.providers.bailian ? 'bailian' : undefined)
      if (primaryId === undefined) {
        throw new Error(`provider "${id}" is hybrid but names no primary provider (set providers.${id}.primary)`)
      }
      if (primaryId === id || mirrorId === id) {
        throw new Error(`provider "${id}" cannot use itself as its primary or mirror`)
      }
      for (const dependency of [primaryId, mirrorId]) {
        if (!config.providers[dependency]) {
          throw new Error(`provider "${id}" depends on "${dependency}", which is not configured`)
        }
        if (config.providers[dependency].type === 'hybrid') {
          throw new Error(`provider "${id}" cannot nest another hybrid provider ("${dependency}")`)
        }
      }
      return new HybridProvider(id, {
        config: entry,
        logger,
        primary: createProvider(primaryId, config, logger),
        mirror: createProvider(mirrorId, config, logger),
      })
    }
    default:
      throw new Error(`provider "${id}" has unsupported type "${entry.type}"`)
  }
}
