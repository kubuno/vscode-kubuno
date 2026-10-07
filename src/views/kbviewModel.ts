/**
 * A small, error-tolerant reader of `.kbview` / `.kbcontrol` markup, and the surgical edits the designer needs.
 *
 * It is the fallback used when `kubuno-views-ls` is not available on this OS (the language server's
 * `kubuno/applyEdit`, `kubuno/elementAtOffset` and `kubuno/rangeOfElement` are preferred whenever it runs). It
 * follows the same contract (vskubuno docs/DESIGNER.md §8):
 *
 * - an element's id is the dot path of element-child ordinals from the root (`""` = root, `"0"` its first child,
 *   `"0.1"` that child's second child); text and comments never take an index;
 * - every edit is a list of `{start, end, newText}` splices in the original text's coordinates, empty when the id
 *   does not resolve (never an exception).
 *
 * Offsets are UTF-16 code unit offsets into the JavaScript string (what `TextDocument.positionAt` takes).
 */

export interface AttributeNode {
  name: string
  value: string
  /** Offset of the attribute's first character (its name). */
  start: number
  /** Offset just after the closing quote. */
  end: number
  /** Range of the value, inside the quotes. */
  valueStart: number
  valueEnd: number
}

export interface ElementNode {
  id: string
  name: string
  attributes: AttributeNode[]
  children: ElementNode[]
  parent: ElementNode | null
  /** Offset of `<`. */
  start: number
  /** Offset just after the start tag's `>` (or `/>`). */
  startTagEnd: number
  /** Offset of the end tag's `<` (`startTagEnd` for a self-closing element). */
  endTagStart: number
  /** Offset just after the element (after `/>` or `</Name>`). */
  end: number
  selfClosing: boolean
}

export interface Splice {
  start: number
  end: number
  newText: string
}

export type EditOp =
  | { kind: 'setAttribute'; elementId: string; name: string; value: string }
  | { kind: 'removeAttribute'; elementId: string; name: string }
  | { kind: 'insertChild'; elementId?: string; parentId: string; index: number; xml: string }
  | { kind: 'removeElement'; elementId: string }
  | { kind: 'moveElement'; elementId: string; newParentId: string; index: number }

const NAME_START = /[A-Za-z_:]/
const NAME_CHAR = /[A-Za-z0-9_:.\-]/

export class KbviewDocument {
  readonly root: ElementNode | null
  private readonly byId = new Map<string, ElementNode>()

  constructor(readonly text: string) {
    this.root = parse(text)
    if (this.root) this.index(this.root)
  }

  private index(e: ElementNode): void {
    this.byId.set(e.id, e)
    for (const c of e.children) this.index(c)
  }

  resolve(id: string): ElementNode | undefined {
    return this.byId.get(id)
  }

  /** The innermost element whose range contains `offset`. */
  elementAt(offset: number): ElementNode | null {
    let found: ElementNode | null = null
    const walk = (e: ElementNode): void => {
      if (offset < e.start || offset > e.end) return
      found = e
      for (const c of e.children) walk(c)
    }
    if (this.root) walk(this.root)
    return found
  }

  attribute(id: string, name: string): string | undefined {
    return this.resolve(id)?.attributes.find((a) => a.name === name)?.value
  }

  // ── Edits ──

  apply(op: EditOp): Splice[] {
    switch (op.kind) {
      case 'setAttribute':
        return this.setAttribute(op.elementId, op.name, op.value)
      case 'removeAttribute':
        return this.removeAttribute(op.elementId, op.name)
      case 'insertChild':
        return this.insertChild(op.parentId, op.index, op.xml)
      case 'removeElement':
        return this.removeElement(op.elementId)
      case 'moveElement':
        return this.moveElement(op.elementId, op.newParentId, op.index)
    }
  }

  setAttribute(id: string, name: string, value: string): Splice[] {
    const e = this.resolve(id)
    if (!e) return []
    const escaped = escapeAttr(value)
    const a = e.attributes.find((x) => x.name === name)
    if (a) return a.value === value ? [] : [{ start: a.valueStart, end: a.valueEnd, newText: escaped }]
    // A new attribute goes after the last one (or the name), before `/>` or `>`.
    const after = e.attributes.length ? e.attributes[e.attributes.length - 1].end : e.start + 1 + e.name.length
    return [{ start: after, end: after, newText: ` ${name}="${escaped}"` }]
  }

  removeAttribute(id: string, name: string): Splice[] {
    const e = this.resolve(id)
    const a = e?.attributes.find((x) => x.name === name)
    if (!e || !a) return []
    let start = a.start
    while (start > 0 && /[ \t]/.test(this.text[start - 1])) start--
    if (start > 0 && /[\r\n]/.test(this.text[start - 1])) {
      // The attribute was on a line of its own: remove the whole line.
      start--
      if (this.text[start] === '\n' && this.text[start - 1] === '\r') start--
    }
    return [{ start, end: a.end, newText: '' }]
  }

  removeElement(id: string): Splice[] {
    const e = this.resolve(id)
    if (!e || !e.parent) return []
    const [start, end] = this.lineAwareRange(e)
    return [{ start, end, newText: '' }]
  }

  insertChild(parentId: string, index: number, xml: string): Splice[] {
    const p = this.resolve(parentId)
    if (!p) return []
    const eol = this.text.includes('\r\n') ? '\r\n' : '\n'
    const parentIndent = this.indentOf(p.start)
    const unit = this.indentUnit()
    const childIndent = parentIndent + unit
    const body = xml.trim().split(/\r?\n/).map((l, k) => (k === 0 ? l : childIndent + l)).join(eol)
    if (p.selfClosing) {
      // `<Stack/>` → `<Stack>…</Stack>`: replace `/>` (and the blanks before it) with the content and the end tag.
      let slash = p.startTagEnd - 2
      while (slash > p.start && /\s/.test(this.text[slash - 1])) slash--
      return [{ start: slash, end: p.startTagEnd, newText: `>${eol}${childIndent}${body}${eol}${parentIndent}</${p.name}>` }]
    }
    const i = Math.max(0, Math.min(index, p.children.length))
    if (i < p.children.length) {
      const next = p.children[i]
      const lineStart = this.lineStart(next.start)
      if (this.text.slice(lineStart, next.start).trim() === '') {
        return [{ start: lineStart, end: lineStart, newText: `${childIndent}${body}${eol}` }]
      }
      return [{ start: next.start, end: next.start, newText: `${body} ` }]
    }
    // Append before the end tag.
    const lineStart = this.lineStart(p.endTagStart)
    if (lineStart > p.startTagEnd && this.text.slice(lineStart, p.endTagStart).trim() === '') {
      return [{ start: lineStart, end: lineStart, newText: `${childIndent}${body}${eol}` }]
    }
    return [{ start: p.endTagStart, end: p.endTagStart, newText: `${eol}${childIndent}${body}${eol}${parentIndent}` }]
  }

  moveElement(id: string, newParentId: string, index: number): Splice[] {
    const e = this.resolve(id)
    const p = this.resolve(newParentId)
    if (!e || !p || !e.parent) return []
    // Moving a container into itself or one of its descendants has no sane result.
    if (newParentId === id || newParentId.startsWith(`${id}.`)) return []
    const own = this.text.slice(e.start, e.end)
    const ownIndent = this.indentOf(e.start)
    // Re-indent the moved markup relative to its first line.
    const lines = own.split(/\r?\n/).map((l, k) => (k === 0 ? l : l.startsWith(ownIndent) ? l.slice(ownIndent.length) : l.trimStart()))
    // `index` has Vec semantics (the moved element's index once it has been removed, as `move_element`): in the
    // original child list, that is the slot before child `index`, or `index + 1` past the element's own slot.
    let target = index
    if (e.parent === p) {
      const from = p.children.indexOf(e)
      if (index === from) return []
      target = index > from ? index + 1 : index
    }
    const remove = this.removeElement(id)
    const insert = this.insertChild(newParentId, target, lines.join('\n'))
    if (!remove.length || !insert.length) return []
    // Disjoint by construction unless the insertion point falls inside the removed range (adjacent: fine).
    const r = remove[0]
    const ins = insert[0]
    if (ins.start > r.start && ins.start < r.end) return []
    return [r, ins]
  }

  // ── Text helpers ──

  private lineStart(offset: number): number {
    let i = offset
    while (i > 0 && this.text[i - 1] !== '\n') i--
    return i
  }

  private indentOf(offset: number): string {
    const ls = this.lineStart(offset)
    const m = /^[ \t]*/.exec(this.text.slice(ls, offset))
    return m ? m[0] : ''
  }

  private indentUnit(): string {
    if (this.root?.children.length) {
      const d = this.indentOf(this.root.children[0].start).slice(this.indentOf(this.root.start).length)
      if (d) return d
    }
    return '  '
  }

  /** The element's range widened to whole lines when it stands alone on its lines. */
  private lineAwareRange(e: ElementNode): [number, number] {
    const ls = this.lineStart(e.start)
    let end = e.end
    while (end < this.text.length && /[ \t]/.test(this.text[end])) end++
    const aloneBefore = this.text.slice(ls, e.start).trim() === ''
    const atEol = end >= this.text.length || this.text[end] === '\n' || this.text[end] === '\r'
    if (aloneBefore && atEol) {
      if (this.text[end] === '\r') end++
      if (this.text[end] === '\n') end++
      return [ls, end]
    }
    return [e.start, e.end]
  }
}

export function escapeAttr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

function unescapeAttr(v: string): string {
  return v
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
}

/** Parses the markup; tolerant: an unclosed element ends at the end of the text. */
function parse(text: string): ElementNode | null {
  const stack: ElementNode[] = []
  let root: ElementNode | null = null
  let i = 0
  const n = text.length
  while (i < n) {
    const lt = text.indexOf('<', i)
    if (lt < 0) break
    if (text.startsWith('<!--', lt)) {
      const e = text.indexOf('-->', lt + 4)
      i = e < 0 ? n : e + 3
      continue
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const e = text.indexOf(']]>', lt + 9)
      i = e < 0 ? n : e + 3
      continue
    }
    if (text.startsWith('<?', lt) || text.startsWith('<!', lt)) {
      const e = text.indexOf('>', lt + 2)
      i = e < 0 ? n : e + 1
      continue
    }
    if (text[lt + 1] === '/') {
      // End tag: close up to the matching open element.
      let j = lt + 2
      while (j < n && NAME_CHAR.test(text[j])) j++
      const name = text.slice(lt + 2, j)
      const gt = text.indexOf('>', j)
      const end = gt < 0 ? n : gt + 1
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].name === name) {
          while (stack.length > k + 1) closeAt(stack.pop()!, lt, lt)
          const el = stack.pop()!
          el.endTagStart = lt
          el.end = end
          break
        }
      }
      i = end
      continue
    }
    if (!NAME_START.test(text[lt + 1] ?? '')) {
      i = lt + 1
      continue
    }
    // Start tag.
    let j = lt + 1
    while (j < n && NAME_CHAR.test(text[j])) j++
    const name = text.slice(lt + 1, j)
    const attributes: AttributeNode[] = []
    let selfClosing = false
    let tagEnd = n
    while (j < n) {
      while (j < n && /\s/.test(text[j])) j++
      if (text[j] === '>') {
        tagEnd = j + 1
        break
      }
      if (text[j] === '/' && text[j + 1] === '>') {
        selfClosing = true
        tagEnd = j + 2
        break
      }
      if (text[j] === '<') {
        tagEnd = j
        break
      }
      const aStart = j
      while (j < n && !/[\s=>/<]/.test(text[j])) j++
      const aName = text.slice(aStart, j)
      while (j < n && /\s/.test(text[j])) j++
      if (text[j] !== '=') {
        if (!aName) j++
        continue
      }
      j++
      while (j < n && /\s/.test(text[j])) j++
      const q = text[j]
      if (q !== '"' && q !== "'") continue
      const vStart = j + 1
      const vEnd = text.indexOf(q, vStart)
      const ve = vEnd < 0 ? n : vEnd
      attributes.push({ name: aName, value: unescapeAttr(text.slice(vStart, ve)), start: aStart, end: Math.min(n, ve + 1), valueStart: vStart, valueEnd: ve })
      j = ve + 1
    }
    const parent = stack.length ? stack[stack.length - 1] : null
    if (!parent && root) {
      // A second top-level element: ignored (a view has exactly one root).
      i = tagEnd
      continue
    }
    const index = parent ? parent.children.length : 0
    const id = parent ? (parent.id === '' ? String(index) : `${parent.id}.${index}`) : ''
    const el: ElementNode = { id, name, attributes, children: [], parent, start: lt, startTagEnd: tagEnd, endTagStart: tagEnd, end: tagEnd, selfClosing }
    if (parent) parent.children.push(el)
    else root = el
    if (!selfClosing) stack.push(el)
    i = tagEnd
  }
  while (stack.length) closeAt(stack.pop()!, n, n)
  return root
}

function closeAt(e: ElementNode, endTagStart: number, end: number): void {
  e.endTagStart = endTagStart
  e.end = end
}

/** Applies splices (from one `apply` call, or several disjoint ones) to a text. */
export function applySplices(text: string, splices: readonly Splice[]): string {
  const sorted = [...splices].sort((a, b) => b.start - a.start)
  let out = text
  for (const s of sorted) out = out.slice(0, s.start) + s.newText + out.slice(s.end)
  return out
}
