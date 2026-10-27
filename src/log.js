/**
 * Minimal leveled logger over the Cordis context logger, with a console
 * fallback so the plugin also reports outside the Harness boot path.
 *
 * @module dsh-scribe/log
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }

/**
 * Create one scoped logger.
 * @param ctx - Cordis context (`ctx.logger(name)` returns the host logger).
 * @param level - minimum level to emit; defaults to `info`.
 * @returns a logger with `debug/info/warn/error`.
 */
export function createLogger(ctx, level = 'info') {
  const threshold = LEVELS[level] ?? LEVELS.info
  const host = typeof ctx?.logger === 'function' ? safeHostLogger(ctx) : undefined
  const emit = (name) => (message, ...args) => {
    if ((LEVELS[name] ?? LEVELS.info) < threshold) return
    if (host !== undefined) {
      const fn = host[name] ?? host.info
      if (typeof fn === 'function') {
        fn.call(host, message, ...args)
        return
      }
    }
    // Console fallback keeps development output visible; the prefix makes the
    // plugin's lines recognizable in a shared terminal.
    const text = formatArgs(message, args)
    if (name === 'error') console.error(`[dsh-scribe] ${text}`)
    else if (name === 'warn') console.warn(`[dsh-scribe] ${text}`)
    else console.log(`[dsh-scribe] ${text}`)
  }
  return {
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
  }
}

function safeHostLogger(ctx) {
  try {
    const logger = ctx.logger('dsh-scribe')
    return logger && typeof logger === 'object' ? logger : undefined
  } catch {
    return undefined
  }
}

function formatArgs(message, args) {
  let index = 0
  const text = String(message).replace(/%[sdifjo]/g, (match) => {
    if (index >= args.length) return match
    const value = args[index++]
    if (match === '%j') {
      try {
        return JSON.stringify(value)
      } catch {
        return String(value)
      }
    }
    if (match === '%d' || match === '%i') return String(Number(value))
    if (match === '%f') return String(Number(value))
    return String(value)
  })
  return index < args.length ? `${text} ${args.slice(index).map((v) => String(v)).join(' ')}` : text
}
