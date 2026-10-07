/**
 * What the designer, the Toolbox and the Properties view ask about a view document, answered by
 * `kubuno-views-ls` when it runs and by the extension's own XML model otherwise. Every text change goes through
 * a `WorkspaceEdit` on the document, so undo/redo, dirty state and saving are VS Code's own.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import type { ViewsLanguageServer } from '../lsp/client'
import { log } from '../log'
import { createHandlerFallback } from './handlerFallback'
import { type EditOp, KbviewDocument } from './kbviewModel'
import { findProject, loadRegistryFromDisk, type Registry, type RegistryComponent, type WebProject } from '../project/webProject'

interface LspRange {
  start: { line: number; character: number }
  end: { line: number; character: number }
}

const toRange = (r: LspRange): vscode.Range => new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character)

export class ViewService {
  private registries = new Map<string, { registry: Registry; stamp: number }>()

  constructor(readonly ls: ViewsLanguageServer) {}

  model(doc: vscode.TextDocument): KbviewDocument {
    return new KbviewDocument(doc.getText())
  }

  project(doc: vscode.TextDocument): WebProject | null {
    return doc.uri.scheme === 'file' ? findProject(doc.uri.fsPath) : null
  }

  // ── Registry ──

  /** The registry of the document's project (host + project components); cached for 2 s. */
  async registry(doc: vscode.TextDocument): Promise<Registry | null> {
    const p = this.project(doc)
    if (!p || p.target !== 'web') return null
    const cached = this.registries.get(p.root)
    if (cached && Date.now() - cached.stamp < 2000) return cached.registry
    const disk = loadRegistryFromDisk(p)
    let registry = disk
    const fromLs = await this.ls.request<{ target?: string; components?: RegistryComponent[] }>('kubuno/registry', { uri: doc.uri.toString() })
    if (fromLs?.target === 'web' && Array.isArray(fromLs.components) && fromLs.components.length) {
      // The server's registry is the truth for names and properties (it also scans the project's user controls).
      registry = { ...disk, components: fromLs.components, projectComponents: fromLs.components.filter((c) => c.origin === 'project') }
    }
    this.registries.set(p.root, { registry, stamp: Date.now() })
    return registry
  }

  invalidateRegistries(): void {
    this.registries.clear()
  }

  // ── Edits ──

  /** Applies designer edit operations as one `WorkspaceEdit` (one undo step). Returns false when nothing changed. */
  async applyOps(doc: vscode.TextDocument, ops: readonly EditOp[]): Promise<boolean> {
    const edit = new vscode.WorkspaceEdit()
    let count = 0
    if (this.ls.running) {
      for (const op of ops) {
        type Result = { edits: { range: LspRange; newText: string }[] }
        const send = (wire: Record<string, unknown>): Promise<Result | undefined> => this.ls.request<Result>('kubuno/applyEdit', { uri: doc.uri.toString(), op: wire })
        // The server's `insertChild` is a verbatim splice (`<Label />` glued before `</Panel>`); its
        // `insertFragment` lays the element out on its own indented line, as the built-in model does. Older
        // servers without it answer no edit, and the verbatim splice is used.
        let r = op.kind === 'insertChild' ? await send({ ...wireOp(op), kind: 'insertFragment' }) : undefined
        if (!r?.edits?.length) r = await send(wireOp(op))
        for (const e of r?.edits ?? []) {
          edit.replace(doc.uri, toRange(e.range), e.newText)
          count++
        }
      }
    } else {
      const model = this.model(doc)
      for (const op of ops) {
        for (const s of model.apply(op)) {
          edit.replace(doc.uri, new vscode.Range(doc.positionAt(s.start), doc.positionAt(s.end)), s.newText)
          count++
        }
      }
    }
    if (!count) {
      log(`edit produced no change: ${JSON.stringify(ops)}`)
      return false
    }
    return vscode.workspace.applyEdit(edit)
  }

  // ── Selection ──

  async elementAt(doc: vscode.TextDocument, pos: vscode.Position): Promise<string | null> {
    if (this.ls.running) {
      const r = await this.ls.request<{ elementId: string } | null>('kubuno/elementAtOffset', { uri: doc.uri.toString(), position: { line: pos.line, character: pos.character } })
      if (r !== undefined) return r?.elementId ?? null
    }
    return this.model(doc).elementAt(doc.offsetAt(pos))?.id ?? null
  }

  /** The range of the element's start tag (where the caret goes when the designer selects it). */
  startTagRange(doc: vscode.TextDocument, id: string): vscode.Range | null {
    const e = this.model(doc).resolve(id)
    return e ? new vscode.Range(doc.positionAt(e.start), doc.positionAt(e.startTagEnd)) : null
  }

  // ── Handlers ──

  /** Creates (or finds) the handler of `event` on the element and opens the code-behind at it. */
  async createHandler(doc: vscode.TextDocument, elementId: string, event: string): Promise<void> {
    if (this.ls.running) {
      const openFiles: Record<string, string> = {}
      for (const d of vscode.workspace.textDocuments) if (/\.(ts|tsx)$/.test(d.uri.fsPath)) openFiles[d.uri.toString()] = d.getText()
      const r = await this.ls.request<{ handlerName: string; location?: { uri: string; range: LspRange }; edit?: unknown }>('kubuno/createHandler', {
        uri: doc.uri.toString(),
        elementId,
        event,
        openFiles,
      })
      // An empty answer is the server's "degrade to no-op" (an element or event it cannot resolve, a code-behind
      // it cannot write): the built-in writer still creates the handler instead of doing nothing.
      if (r?.handlerName) {
        if (r.edit) {
          const we = await this.ls.toWorkspaceEdit(r.edit)
          if (we) await vscode.workspace.applyEdit(we)
        }
        if (r.location) {
          await vscode.window.showTextDocument(vscode.Uri.parse(r.location.uri), { selection: toRange(r.location.range), viewColumn: vscode.ViewColumn.Beside })
        } else {
          await revealMethod(doc, r.handlerName)
        }
        log(`handler ${r.handlerName} (${event} of element "${elementId}") by kubuno-views-ls`)
        return
      }
      log(`kubuno/createHandler gave no handler (${JSON.stringify(r ?? null)}): the built-in writer creates it`)
    }
    const name = await createHandlerFallback(doc, this.model(doc), elementId, event, await this.registry(doc))
    if (name) await revealMethod(doc, name)
  }
}

/** The wire shape of `kubuno/applyEdit` (`elementId` is the parent's for `insertChild`). */
function wireOp(op: EditOp): Record<string, unknown> {
  return op.kind === 'insertChild' ? { kind: op.kind, parentId: op.parentId, index: op.index, xml: op.xml } : { ...op }
}

/** Opens the view's code-behind beside the designer with the caret on `name(`. */
export async function revealMethod(viewDoc: vscode.TextDocument, name: string): Promise<void> {
  const dir = path.dirname(viewDoc.uri.fsPath)
  const ext = path.extname(viewDoc.uri.fsPath)
  const stem = path.basename(viewDoc.uri.fsPath, ext)
  const file = [`${stem}.ts`, `${stem}.tsx`, `${stem}${ext}.ts`].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f))
  if (!file) return
  const ts = await vscode.workspace.openTextDocument(file)
  const text = ts.getText()
  const at = new RegExp(`^\\s*(?:async\\s+)?${name}\\s*\\(`, 'm').exec(text)
  const pos = at ? ts.positionAt(at.index + at[0].indexOf(name)) : new vscode.Position(0, 0)
  await vscode.window.showTextDocument(ts, { selection: new vscode.Range(pos, pos.translate(0, at ? name.length : 0)), viewColumn: vscode.ViewColumn.Beside })
}
