/**
 * Minimal React stand-in for headless render checks.
 *
 * A component that throws blanks its whole slot entry in the browser, and a
 * grid row with the wrong number of children silently shifts every column. Both
 * are cheap to catch here and expensive to catch in a screenshot.
 */

export function fakeReact() {
  const createElement = (type, props, ...children) => ({
    type,
    props: { ...(props ?? {}), children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children },
  })
  return {
    createElement,
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useRef: (initial) => ({ current: initial }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  }
}

/** Every string rendered in a fake element tree. */
export function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (typeof node === 'object' && node.props) {
    const fromProps = ['label', 'placeholder', 'title', 'aria-label']
      .map((key) => (typeof node.props[key] === 'string' ? node.props[key] : ''))
      .join(' ')
    return `${fromProps} ${textOf(node.props.children)}`
  }
  return ''
}

/** Depth-first walk over a fake element tree. */
export function walk(node, visit) {
  if (node === null || node === undefined || node === false) return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (typeof node !== 'object' || !node.props) return
  visit(node)
  walk(node.props.children, visit)
}

/** Children of one element as an array. */
export function childrenOf(node) {
  const children = node?.props?.children
  if (children === undefined || children === null || children === false) return []
  return Array.isArray(children) ? children : [children]
}

/** Load a client component map from the module-loader artifact. */
export async function loadClientComponents(counter) {
  const calls = []
  globalThis.window = { __ModuleLoader__: { load: (definition) => calls.push(definition) } }
  await import(`../client.js?structure=${counter}`)
  if (calls.length !== 1) throw new Error(`client.js registered ${calls.length} modules`)
  const react = fakeReact()
  const module = calls[0].factory((name) => {
    if (name === 'react') return react
    throw new Error(`unexpected require(${name})`)
  })
  return module.__test__
}
