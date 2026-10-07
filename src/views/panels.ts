/**
 * The Toolbox and Properties views (webview views in the Kubuno side bar), both following the active designer.
 *
 * - **Toolbox**: the elements of the active view's registry (the language server's `kubuno/registry`, else the
 *   project's registry files), grouped like Visual Studio's Toolbox tabs, filterable. An item is dragged onto the
 *   design surface (HTML5 drag with the private type `application/vnd.kubuno.toolbox-item`, insertion markers
 *   while hovering, dropped at the pointer), armed by a click then placed by a click on the surface, or inserted
 *   into the selection with a double-click / Enter.
 * - **Properties**: the selected element's properties by category (enum lists, booleans, text), its events
 *   (⚡ creates or opens the handler), and `x:Name`. A change applies a `WorkspaceEdit` to the XML.
 */
import * as crypto from 'node:crypto'
import * as vscode from 'vscode'
import type { DesignerProvider, DesignerSession } from '../designer/designerProvider'
import type { RegistryComponent, RegistryProperty } from '../project/webProject'
import { log } from '../log'
import { toolboxGroups } from './toolboxModel'

function pageHtml(webview: vscode.Webview, extensionUri: vscode.Uri, script: string, title: string): string {
  const nonce = crypto.randomBytes(16).toString('base64')
  const css = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'panels.css'))
  const js = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', script))
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}"><title>${title}</title></head>
<body><div id="app"></div><script nonce="${nonce}" src="${js}"></script></body></html>`
}

export class ToolboxView implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly designers: DesignerProvider,
  ) {
    designers.onDidChangeCurrent(() => void this.refresh())
    designers.onDidDisarmTool(() => void this.view?.webview.postMessage({ type: 'disarmed' }))
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')] }
    view.webview.html = pageHtml(view.webview, this.extensionUri, 'toolbox.js', 'Toolbox')
    view.webview.onDidReceiveMessage(async (m: { type: string; name?: string }) => {
      if (m.type === 'ready') await this.refresh()
      else if (m.type === 'insert' && m.name) {
        this.designers.armTool(null)
        await this.designers.active?.insertComponent(m.name)
      } else if (m.type === 'dragStart' || m.type === 'dragEnd') {
        // The item's name goes ahead to every designer: during an HTML5 drag the page can read only the types.
        this.designers.broadcastToolDrag(m.type === 'dragStart' ? (m.name ?? null) : null)
        log(`toolbox ${m.type} ${m.name ?? ''}`)
      } else if (m.type === 'arm') {
        if (!this.designers.armTool(m.name ?? null)) void this.view?.webview.postMessage({ type: 'disarmed' })
      }
    })
    view.onDidChangeVisibility(() => view.visible && void this.refresh())
  }

  async refresh(): Promise<void> {
    if (!this.view) return
    const s = this.designers.active
    const registry = s ? await s.service.registry(s.document) : null
    void this.view.webview.postMessage({
      type: 'toolbox',
      file: s ? vscode.workspace.asRelativePath(s.document.uri) : null,
      groups: toolboxGroups(registry),
    })
  }
}

interface PropRow {
  name: string
  category: string
  kind: 'text' | 'enum' | 'bool' | 'number'
  values?: string[]
  value: string | null
  defaultValue: string
  doc: string
  bindable: boolean
}

export class PropertiesView implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly designers: DesignerProvider,
  ) {
    designers.onDidChangeCurrent(() => void this.refresh())
    designers.onDidChangeSelection(() => void this.refresh())
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')] }
    view.webview.html = pageHtml(view.webview, this.extensionUri, 'properties.js', 'Properties')
    view.webview.onDidReceiveMessage(async (m: { type: string; id?: string; name?: string; value?: string }) => {
      const s = this.designers.active
      if (m.type === 'ready') return this.refresh()
      if (!s || m.id === undefined || !m.name) return
      if (m.type === 'set') {
        const op =
          m.value === undefined || m.value === ''
            ? ({ kind: 'removeAttribute', elementId: m.id, name: m.name } as const)
            : ({ kind: 'setAttribute', elementId: m.id, name: m.name, value: m.value } as const)
        await s.service.applyOps(s.document, [op])
      } else if (m.type === 'handler') {
        await s.service.createHandler(s.document, m.id, m.name)
      } else if (m.type === 'select') {
        s.select(m.id)
      }
    })
    view.onDidChangeVisibility(() => view.visible && void this.refresh())
  }

  async refresh(): Promise<void> {
    if (!this.view) return
    const s = this.designers.active
    void this.view.webview.postMessage(await describeSelection(s))
  }
}

/** The Properties view's model of the selection (also used by the tests). */
export async function describeSelection(s: DesignerSession | null): Promise<Record<string, unknown>> {
  if (!s || s.selection === null) return { type: 'empty' }
  const model = s.service.model(s.document)
  const el = model.resolve(s.selection)
  if (!el) return { type: 'empty' }
  const comp: RegistryComponent | undefined = await s.component(s.selection)
  const attrs = new Map(el.attributes.map((a) => [a.name, a.value]))
  const isRoot = el.id === ''
  const rows: PropRow[] = []
  rows.push({ name: 'x:Name', category: 'Design', kind: 'text', value: attrs.get('x:Name') ?? null, defaultValue: '', doc: 'The element\'s name in the code-behind.', bindable: false })
  for (const p of comp?.properties ?? []) {
    if (p.browsable === false || (p.root_only && !isRoot)) continue
    rows.push(propRow(p, attrs.get(p.name) ?? null))
  }
  // Attributes the registry does not describe (attached properties, `d:` design data…) stay visible and editable.
  for (const [name, value] of attrs) {
    if (name === 'x:Name' || rows.some((r) => r.name === name) || /^On[A-Z]/.test(name)) continue
    rows.push({ name, category: 'Other', kind: 'text', value, defaultValue: '', doc: '', bindable: false })
  }
  const events = (comp?.events ?? [])
    .filter((e) => e.browsable !== false && (!e.root_only || isRoot))
    .map((e) => ({ name: e.name, display: e.display_name ?? e.name, category: e.category ?? 'Misc', handler: attrs.get(e.name) ?? null, doc: e.doc ?? '', args: e.args_type ?? '' }))
  const path: { id: string; name: string }[] = []
  for (let p = el.parent; p; p = p.parent) path.unshift({ id: p.id, name: p.name })
  return {
    type: 'element',
    id: el.id,
    element: el.name,
    xName: attrs.get('x:Name') ?? null,
    known: !!comp,
    doc: comp?.doc ?? '',
    defaultEvent: comp?.default_event ?? null,
    path,
    properties: rows,
    events,
    file: vscode.workspace.asRelativePath(s.document.uri),
  }
}

function propRow(p: RegistryProperty, value: string | null): PropRow {
  let kind: PropRow['kind'] = 'text'
  let values: string[] | undefined
  if (typeof p.kind === 'object' && p.kind && Array.isArray((p.kind as { Enum?: string[] }).Enum)) {
    kind = 'enum'
    values = (p.kind as { Enum: string[] }).Enum
  } else if (p.kind === 'Bool') kind = 'bool'
  else if (typeof p.kind === 'string' && /^(I|U|F)\d+$/.test(p.kind)) kind = 'number'
  return { name: p.name, category: p.category || 'Misc', kind, values, value, defaultValue: p.default ?? '', doc: p.doc ?? '', bindable: !!p.bindable }
}
