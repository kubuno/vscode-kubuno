/**
 * Event handler creation when `kubuno-views-ls` is not available on this OS: the same result as its
 * `kubuno/createHandler` for a web view (vskubuno docs/WEB-VIEWS.md §16), written by the extension -
 *
 * - the default name is `<x:Name>_<event>` in snake_case (the element's name without `x:Name`, the file stem for
 *   the root's own events: `account_menu_load`), made unique among the class's members;
 * - the view gets `OnX="name"`, the class extending `ViewBase` gets
 *   `name(sender: Button, e: MouseEventArgs): void { // TODO: implement name }` (`_sender` / `_e` when the
 *   project's tsconfig sets `noUnusedParameters`), and the missing types are imported from `@kubuno/views`.
 *
 * The language server remains the reference (it reads the TypeScript with oxc, checks signatures, binds
 * compatible existing methods); this fallback only covers the common case so a view can be wired on any OS.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { log } from '../log'
import type { KbviewDocument } from './kbviewModel'
import { codeBehindClass, codeBehindOf, findProject, type Registry } from '../project/webProject'

export function snakeCase(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
}

export function defaultHandlerName(elementName: string, xName: string | undefined, isRoot: boolean, fileStem: string, event: string): string {
  const base = xName ?? (isRoot ? fileStem : elementName)
  return `${snakeCase(base)}_${snakeCase(event.replace(/^On(?=[A-Z])/, ''))}`
}

/** The offset of the `}` closing the class body that starts at `open` (`{`); strings and comments skipped. */
export function matchingBrace(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (c === '/' && text[i + 1] === '/') {
      i = text.indexOf('\n', i)
      if (i < 0) return -1
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2)
      if (i < 0) return -1
      i++
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++
      continue
    }
    if (c === '{') depth++
    else if (c === '}' && --depth === 0) return i
  }
  return -1
}

/** Edits of the code-behind: the method before the class's closing brace and the missing type imports. */
export function codeBehindEdits(ts: string, name: string, sender: string, args: string, underscore: boolean): { offset: number; text: string; replaceEnd?: number }[] | null {
  const cls = /export\s+(?:default\s+)?class\s+[A-Za-z_$][\w$]*\s+extends\s+ViewBase\b[^{]*\{/.exec(ts)
  if (!cls) return null
  const open = cls.index + cls[0].length - 1
  const close = matchingBrace(ts, open)
  if (close < 0) return null
  const eol = ts.includes('\r\n') ? '\r\n' : '\n'
  const p = underscore ? '_' : ''
  const method = `${eol}  ${name}(${p}sender: ${sender}, ${p}e: ${args}): void {${eol}    // TODO: implement ${name}${eol}  }${eol}`
  // Insert after the last non-blank character of the body, so the class keeps one blank line before its brace.
  let at = close
  while (at > open + 1 && /\s/.test(ts[at - 1])) at--
  // The original blank characters before the `}` stay after the new method.
  const edits: { offset: number; text: string; replaceEnd?: number }[] = [{ offset: at, text: `${eol}${method.slice(0, -eol.length)}` }]
  const needed = [sender, args].filter((t, k, all) => all.indexOf(t) === k)
  const imp = /import\s*(type\s*)?\{([^}]*)\}\s*from\s*['"]@kubuno\/views['"]/.exec(ts)
  if (imp) {
    const typeOnly = !!imp[1]
    const inner = imp[2]
    const names = inner.split(',').map((s) => s.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]).filter(Boolean)
    const missing = needed.filter((t) => !names.includes(t))
    if (missing.length) {
      const body = inner.replace(/[\s,]+$/, '')
      const trailing = /\s*$/.exec(inner)?.[0] ?? ''
      const add = missing.map((t) => (typeOnly ? t : `type ${t}`)).join(', ')
      const start = imp.index + imp[0].indexOf('{') + 1
      edits.push({ offset: start, replaceEnd: start + inner.length, text: `${body}${body.trim() ? ', ' : ' '}${add}${trailing || ' '}` })
    }
  } else {
    const lastImport = [...ts.matchAll(/^import[^\n]*\n/gm)].pop()
    const at2 = lastImport ? lastImport.index + lastImport[0].length : 0
    edits.push({ offset: at2, text: `import type { ${needed.join(', ')} } from '@kubuno/views'${eol}` })
  }
  return edits
}

function noUnusedParameters(viewFile: string): boolean {
  const p = findProject(viewFile)
  if (!p) return false
  for (const f of ['tsconfig.app.json', 'tsconfig.json']) {
    try {
      if (/"noUnusedParameters"\s*:\s*true/.test(fs.readFileSync(path.join(p.root, f), 'utf8'))) return true
    } catch {
      /* no such file */
    }
  }
  return false
}

export async function createHandlerFallback(doc: vscode.TextDocument, model: KbviewDocument, elementId: string, event: string, registry: Registry | null): Promise<string | null> {
  const el = model.resolve(elementId)
  if (!el) return null
  const existing = el.attributes.find((a) => a.name === event)?.value
  if (existing) return existing
  const file = doc.uri.fsPath
  const tsFile = codeBehindOf(file)
  if (!tsFile) {
    void vscode.window.showWarningMessage(`Kubuno: ${path.basename(file)} has no code-behind (.ts) to put the handler in.`)
    return null
  }
  const tsDoc = await vscode.workspace.openTextDocument(tsFile)
  const ts = tsDoc.getText()
  if (!codeBehindClass(ts)) {
    void vscode.window.showWarningMessage(`Kubuno: no class extending ViewBase in ${path.basename(tsFile)}.`)
    return null
  }
  const ext = path.extname(file)
  let name = defaultHandlerName(el.name, el.attributes.find((a) => a.name === 'x:Name')?.value, elementId === '', path.basename(file, ext), event)
  const taken = (n: string): boolean => new RegExp(`^\\s*(?:async\\s+)?${n}\\s*\\(`, 'm').test(ts)
  for (let k = 2; taken(name); k++) name = `${name.replace(/_\d+$/, '')}_${k}`
  const comp = registry?.components.find((c) => c.name === el.name)
  const args = comp?.events?.find((e) => e.name === event)?.args_type ?? 'EventArgs'
  const sender = comp ? el.name : 'ElementHandle'
  const tsEdits = codeBehindEdits(ts, name, sender, args, noUnusedParameters(file))
  if (!tsEdits) return null
  const we = new vscode.WorkspaceEdit()
  for (const s of model.setAttribute(elementId, event, name)) we.replace(doc.uri, new vscode.Range(doc.positionAt(s.start), doc.positionAt(s.end)), s.newText)
  for (const e of tsEdits) {
    const end = e.replaceEnd ?? e.offset
    we.replace(tsDoc.uri, new vscode.Range(tsDoc.positionAt(e.offset), tsDoc.positionAt(end)), e.text)
  }
  const ok = await vscode.workspace.applyEdit(we)
  log(`handler ${name} (${event} of ${el.name} "${elementId}") written by the extension (no language server): ${ok}`)
  return ok ? name : null
}
