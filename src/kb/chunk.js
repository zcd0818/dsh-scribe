/**
 * Markdown chunking for the knowledge base.
 *
 * The unit is a *section*, not a fixed window: a hit must be quotable back to
 * `path#L12-L40`, and a section that keeps its heading path in the text is what
 * makes a retrieved chunk meaningful on its own.
 *
 * Pure and synchronous so the folding rules are unit-testable without a
 * filesystem.
 *
 * @module dsh-scribe/kb/chunk
 */

/**
 * Split one markdown document into citation-ready chunks.
 *
 * @param text - the document text.
 * @param options - `{ maxChars, minChars }`.
 * @returns chunks, each `{ heading, content, startLine, endLine }`, 1-based lines.
 */
export function chunkMarkdown(text, options = {}) {
  const maxChars = Math.max(200, Number(options.maxChars) || 1200)
  const minChars = Math.max(0, Number(options.minChars) || 80)
  const lines = String(text ?? '').split('\n')

  const chunks = []
  const headingStack = []
  /** @type {{ headingPath: string[], firstLine: number, lines: string[] } | null} */
  let block = null

  const flush = () => {
    if (block === null) return
    let start = 0
    let end = block.lines.length
    while (start < end && block.lines[start].trim().length === 0) start += 1
    while (end > start && block.lines[end - 1].trim().length === 0) end -= 1
    if (end > start) {
      const body = block.lines.slice(start, end).join('\n')
      const heading = block.headingPath.join(' > ')
      const content = heading.length > 0 ? `${heading}\n\n${body}` : body
      if (content.length >= minChars || chunks.length === 0) {
        chunks.push({
          heading,
          content,
          // +1 because the block's own first line is right after the heading.
          startLine: block.firstLine + start,
          endLine: block.firstLine + end - 1,
        })
      }
    }
    block = null
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (match !== null) {
      flush()
      const level = match[1].length
      headingStack.length = Math.max(0, level - 1)
      headingStack[level - 1] = match[2]
      continue
    }
    if (block === null) block = { headingPath: headingStack.filter((entry) => typeof entry === 'string'), firstLine: index + 1, lines: [] }
    const size = block.lines.reduce((total, entry) => total + entry.length + 1, 0)
    // Break only at a blank line: cutting mid-paragraph would make the citation
    // range point at a sentence fragment.
    if (size > 0 && size + line.length > maxChars && line.trim().length === 0) {
      flush()
      block = { headingPath: headingStack.filter((entry) => typeof entry === 'string'), firstLine: index + 2, lines: [] }
      continue
    }
    block.lines.push(line)
  }
  flush()
  return chunks
}

export function splitLongBody(body, maxChars) {
  if (body.length <= maxChars) return [body]
  const paragraphs = body.split(/\n\s*\n/)
  const pieces = []
  let buffer = ''
  for (const paragraph of paragraphs) {
    if (buffer.length === 0) {
      buffer = paragraph
      continue
    }
    if (buffer.length + 2 + paragraph.length <= maxChars) {
      buffer += `\n\n${paragraph}`
      continue
    }
    pieces.push(buffer)
    buffer = paragraph
  }
  if (buffer.length > 0) pieces.push(buffer)
  // A single paragraph longer than the ceiling still has to be cut somewhere;
  // prefer a line boundary so the citation stays readable.
  return pieces.flatMap((piece) => hardSplit(piece, maxChars))
}

function hardSplit(piece, maxChars) {
  if (piece.length <= maxChars) return [piece]
  const out = []
  let rest = piece
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf('\n', maxChars)
    if (cut < maxChars * 0.5) cut = maxChars
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n/, '')
  }
  if (rest.length > 0) out.push(rest)
  return out
}

/**
 * Render a citation for one chunk.
 * @param chunk - `{ scope, path, startLine, endLine }`.
 * @returns a `kb/...md#L12-L40` style citation.
 */
export function citationOf(chunk) {
  const prefix = chunk.scope === 'global' ? 'kb-global' : 'kb'
  const range = chunk.endLine > chunk.startLine ? `#L${chunk.startLine}-L${chunk.endLine}` : `#L${chunk.startLine}`
  return `${prefix}/${chunk.path}${range}`
}

/**
 * Match a relative path against simple include/exclude globs (`**`, `*`).
 * @param relPath - POSIX-style relative path.
 * @param globs - patterns to test.
 * @returns whether any pattern matches.
 */
export function matchesAny(relPath, globs) {
  return (globs ?? []).some((glob) => globToRegExp(glob).test(relPath))
}

/**
 * Translate one glob into an anchored regular expression.
 * @param glob - pattern using `**`, `*`, `?`.
 * @returns the matcher.
 */
export function globToRegExp(glob) {
  let out = '^'
  const source = String(glob).replace(/^\.\//, '')
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (char === '*') {
      if (source[index + 1] === '*') {
        out += '.*'
        index += 1
        if (source[index + 1] === '/') index += 1
      } else {
        out += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      out += '[^/]'
      continue
    }
    out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  out += '$'
  return new RegExp(out)
}
