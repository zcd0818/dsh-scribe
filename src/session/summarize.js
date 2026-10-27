/**
 * Turning a finished session into one memory.
 *
 * Two policies, chosen by conversation length (the user's decision):
 * - a short conversation is stored extractively — the last few exchanges are
 *   kept verbatim, which is cheap and loses no detail;
 * - a long conversation is summarized by the same model route the session
 *   already used, so the memory keeps decisions and open work instead of a
 *   transcript nobody will read.
 *
 * Both paths are fallback-safe: a failed or timed-out model call degrades to
 * the extractive path rather than dropping the session.
 *
 * @module dsh-scribe/session/summarize
 */

import { truncate } from '../util.js'
import { resolveRoute } from '../memory-service.js'

/** Prompt used for the summarizing call; kept short so the call stays cheap. */
const SUMMARY_PROMPT = [
  '把下面这段编程协作对话压缩成一条长期记忆，供你在以后的新会话里快速恢复上下文。',
  '要求：',
  '- 只写仍然有效的事实：用户在做什么项目、做过哪些决定及原因、约定的规范、未完成的待办。',
  '- 不要写寒暄、不要复述提问、不要写“本次对话”这类元信息。',
  '- 用一条连贯的中文段落，不要列表，不要标题。',
  '- 保留确切的文件名、命令、标识符和数字。',
  '- 最多 200 字。',
  '',
  '对话：',
].join('\n')

/**
 * Read the session transcript as plain `{ role, text }` turns.
 * @param agent - the disposing agent.
 * @returns the transcript, oldest first.
 */
export function collectTranscript(agent) {
  const messages = safeMessages(agent)
  const turns = []
  for (const message of messages) {
    const role = message?.role
    if (role !== 'user' && role !== 'assistant') continue
    const text = textOf(message)
    if (text.length === 0) continue
    turns.push({ role, text })
  }
  return turns
}

/**
 * Count user-authored turns, which is the "conversation length" policy input.
 * @param turns - transcript turns.
 * @returns the number of user turns.
 */
export function countUserTurns(turns) {
  return turns.reduce((total, turn) => total + (turn.role === 'user' ? 1 : 0), 0)
}

/**
 * Extract the tail of a conversation verbatim.
 * @param turns - transcript turns.
 * @param options - `{ messages, maxChars }`.
 * @returns the extractive memory text.
 */
export function extractiveSummary(turns, options = {}) {
  const keep = Math.max(1, Number(options.messages) || 5)
  const maxChars = Number(options.maxChars) || 320
  const tail = turns.slice(-keep).map((turn) => `${turn.role === 'user' ? '用户' : '助手'}：${turn.text}`)
  return truncate(tail.join('\n'), maxChars)
}

/**
 * Summarize through the session's own model route.
 * @param options - `{ ctx, agent, turns, maxChars, timeoutMs, logger }`.
 * @returns the summary, or undefined when the model route is unusable.
 */
export async function modelSummary({ ctx, agent, turns, maxChars, timeoutMs, logger }) {
  const llm = ctx.get('llm')
  if (llm === undefined || typeof llm.stream !== 'function') return undefined
  const route = resolveRoute(agent, ctx)
  if (route === undefined) return undefined

  const transcript = truncate(
    turns.map((turn) => `${turn.role === 'user' ? '用户' : '助手'}：${turn.text}`).join('\n\n'),
    12_000,
  )
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Number(timeoutMs) || 20_000)
  try {
    let text = ''
    const options = {
      provider: route.provider,
      model: route.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: `${SUMMARY_PROMPT}\n${transcript}` }] }],
      maxTokens: 400,
      temperature: 0.2,
      signal: controller.signal,
      ...(agent?.session?.id ? { sessionId: agent.session.id } : {}),
    }
    for await (const chunk of llm.stream(options)) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      if (chunk?.type === 'finish') break
    }
    const cleaned = text.replace(/\s+/g, ' ').trim()
    return cleaned.length === 0 ? undefined : truncate(cleaned, maxChars)
  } catch (error) {
    logger?.warn('session summary call failed, falling back to extractive: %s', error?.message ?? error)
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Produce the memory text for one finished session.
 * @param options - `{ ctx, agent, config, logger }`.
 * @returns `{ content, kind, turns }` or undefined when there is nothing worth storing.
 */
export async function summarizeSession({ ctx, agent, config, logger }) {
  const turns = collectTranscript(agent)
  const userTurns = countUserTurns(turns)
  if (userTurns === 0) return undefined

  const settings = config.summarization
  if (userTurns < settings.shortTurns) {
    const content = extractiveSummary(turns, {
      messages: settings.fallbackMessages,
      maxChars: settings.maxChars,
    })
    return content.length === 0 ? undefined : { content, kind: 'extractive', turns: userTurns }
  }

  const summarized = await modelSummary({
    ctx,
    agent,
    turns,
    maxChars: settings.maxChars,
    timeoutMs: settings.llmTimeoutMs,
    logger,
  })
  if (summarized !== undefined) return { content: summarized, kind: 'model', turns: userTurns }

  const content = extractiveSummary(turns, {
    messages: Math.max(5, settings.fallbackMessages),
    maxChars: settings.maxChars,
  })
  return content.length === 0 ? undefined : { content, kind: 'extractive-fallback', turns: userTurns }
}

/**
 * Project tags for one session's memory: its working-directory project name,
 * plus the session id so a memory can be traced back to its origin.
 * @param agent - live agent.
 * @param cwd - effective working directory, when resolvable.
 * @returns tag list.
 */
export function sessionTags(agent, cwd) {
  const tags = ['session-summary']
  const project = projectName(cwd)
  if (project !== undefined) tags.push(`project:${project}`)
  if (agent?.session?.id) tags.push(`session:${agent.session.id}`)
  return tags
}

/**
 * Last path segment of a working directory.
 * @param cwd - directory path.
 * @returns the project name, or undefined.
 */
export function projectName(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return undefined
  const segments = cwd.split(/[\\/]+/).filter((segment) => segment.length > 0)
  return segments.at(-1)
}

function safeMessages(agent) {
  try {
    const derive = agent?.session?.deriveMessages
    if (typeof derive === 'function') return agent.session.deriveMessages() ?? []
  } catch {
    return []
  }
  return []
}

function textOf(message) {
  const content = message?.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}
