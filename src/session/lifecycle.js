/**
 * Session lifecycle: read memory in at `agent/created`, write memory out at
 * `agent/disposed`.
 *
 * Injection shape and why:
 * the model must see memory in the system prompt of its **first** request, and
 * a prompt section's text provider is synchronous while a store read is not.
 * So the section reads a warm per-agent cache, and the cache is filled by a
 * prefetch started at creation (long before the user's first message). Nothing
 * on the first request waits for disk or network, which is what keeps memory
 * from becoming a latency tax on every session.
 *
 * @module dsh-scribe/session/lifecycle
 */

import { projectName, sessionTags, summarizeSession } from './summarize.js'
import { oneLine } from '../util.js'

/** Order of the memory section: after the persona prefix (−1000…0), before policy (500). */
const MEMORY_SECTION_ORDER = 150

/** Section name; scoped per agent, so one name serves every agent. */
const MEMORY_SECTION_NAME = 'memory:context'

/** The knowledge-base digest sits right after memory: reference material, then recall. */
const KB_SECTION_ORDER = 160
const KB_SECTION_NAME = 'kb:context'

/**
 * Install the lifecycle listeners.
 * @param options - `{ ctx, service, config, logger }`.
 */
export function installSessionLifecycle({ ctx, service, kb, config, logger }) {
  /** @type {Map<string, { agent: object, text: string, kbText: string, disposers: Array<() => void> }>} */
  const entries = new Map()

  ctx.on('agent/created', (payload) => {
    try {
      onCreated(payload?.agent)
    } catch (error) {
      logger.warn('memory injection setup failed: %s', error?.message ?? error)
    }
  })

  ctx.on('agent/disposed', (payload) => {
    const agent = payload?.agent
    if (agent === undefined) return
    // Snapshot the transcript while the session is still attached, then finish
    // the write-back asynchronously: disposal must never wait on I/O.
    const snapshot = safeTranscript(agent)
    release(agent.id)
    if (!config.autoSave) return
    void writeBack(agent, snapshot).catch((error) => {
      logger.warn('session write-back failed: %s', error?.message ?? error)
    })
  })

  // Plugin unload must not leave per-agent sections behind in other agents' scopes.
  ctx.effect(() => () => {
    for (const id of [...entries.keys()]) release(id)
  })

  function onCreated(agent) {
    if (agent === undefined || agent.id === undefined) return
    if (!config.autoInject) return
    if (isSubagent(agent) && !config.includeSubagents) return
    if (entries.has(agent.id)) return

    const entry = { agent, text: '', kbText: '', disposers: [] }
    entries.set(agent.id, entry)

    const systemPrompt = agent.ctx?.systemPrompt ?? ctx.systemPrompt
    if (systemPrompt === undefined || typeof systemPrompt.section !== 'function') {
      logger.debug('systemPrompt service unavailable; memory section not registered')
      entries.delete(agent.id)
      return
    }

    entry.disposers.push(
      systemPrompt.section({
        name: MEMORY_SECTION_NAME,
        order: MEMORY_SECTION_ORDER,
        text: () => entry.text,
      }),
    )

    if (kb?.enabled) {
      // Reference material and recall are separate sections on purpose: a
      // document catalogue reads differently from "what we decided before".
      entry.disposers.push(
        systemPrompt.section({
          name: KB_SECTION_NAME,
          order: KB_SECTION_ORDER,
          text: () => entry.kbText,
        }),
      )
    }

    void prefetch(entry).catch((error) => {
      logger.debug('memory prefetch failed: %s', error?.message ?? error)
    })
  }

  async function prefetch(entry) {
    const project = projectName(cwdOf(entry.agent))
    const limit = config.injectLimit
    // Project-scoped memories first, then the most recent ones: a session
    // starting in a known project inherits that project's decisions before
    // unrelated recent work.
    const scoped = project === undefined ? [] : await service.list({ tags: [`project:${project}`], limit })
    const fill = scoped.length < limit ? await service.recent({ limit: limit * 3 }) : []
    const chosen = [...scoped]
    for (const memory of fill) {
      if (chosen.length >= limit) break
      if (!chosen.some((existing) => existing.id === memory.id)) chosen.push(memory)
    }
    if (chosen.length === 0) return
    const total = await service.count().catch(() => chosen.length)
    const text = service.formatForPrompt(chosen.slice(0, limit), { maxChars: config.injectMaxChars, total })
    if (entries.get(entry.agent.id) === entry) entry.text = text
    logger.debug('injected %d memories for %s', chosen.length, entry.agent.id)

    if (kb?.enabled) {
      // Indexing is lazy and bounded by its own TTL; a failure here must never
      // cost the session its memory block.
      const digest = await kb.digest({ cwd: cwdOf(entry.agent) }).catch((error) => {
        logger.debug('knowledge digest failed: %s', error?.message ?? error)
        return ''
      })
      if (entries.get(entry.agent.id) === entry) entry.kbText = digest
    }
  }

  async function writeBack(agent, snapshot) {
    if (snapshot === undefined || snapshot.userTurns === 0) return
    if (isSubagent(agent) && !config.includeSubagents) return
    const cwd = cwdOf(agent)
    const summary = await summarizeSession({ ctx, agent, config, logger })
    if (summary === undefined) return
    if (oneLine(summary.content, 40).length < 8) return
    const { duplicate } = await service.add({
      content: summary.content,
      source: 'session-summary',
      tags: sessionTags(agent, cwd),
      sessionId: agent.session?.id,
      metadata: {
        project: projectName(cwd),
        cwd,
        turns: summary.turns,
        kind: summary.kind,
      },
    })
    logger.debug(
      'session %s %s (%s, %d user turns)',
      agent.session?.id ?? agent.id,
      duplicate ? 'already stored' : 'stored',
      summary.kind,
      summary.turns,
    )
  }

  function release(agentId) {
    const entry = entries.get(agentId)
    if (entry === undefined) return
    entries.delete(agentId)
    for (const dispose of entry.disposers.splice(0)) {
      try {
        dispose()
      } catch (error) {
        logger.debug('memory section disposal failed: %s', error?.message ?? error)
      }
    }
  }
}

/**
 * Whether this agent belongs to a delegated child session.
 * @param agent - live agent.
 * @returns true for subagent sessions.
 */
function isSubagent(agent) {
  return agent?.session?.header?.origin === 'subagent'
}

/**
 * The agent's effective working directory, from the session header.
 * @param agent - live agent.
 * @returns the directory, or undefined.
 */
function cwdOf(agent) {
  try {
    const cwd = agent?.session?.header?.cwd
    return typeof cwd === 'string' ? cwd : undefined
  } catch {
    return undefined
  }
}

/**
 * Read the transcript synchronously so disposal does not race session detach.
 * @param agent - live agent.
 * @returns `{ userTurns }` or undefined.
 */
function safeTranscript(agent) {
  try {
    const messages = agent?.session?.deriveMessages?.() ?? []
    let userTurns = 0
    for (const message of messages) {
      if (message?.role === 'user') userTurns += 1
    }
    return { userTurns, messages }
  } catch {
    return undefined
  }
}
