/**
 * The Kubuno View Designer: a custom text editor for web `.kbview` / `.kbcontrol` files.
 *
 * The document is VS Code's own `TextDocument` (undo/redo, dirty state, save, hot exit are VS Code's); the Design
 * pane is the design page in a webview; the XML pane is an ordinary text editor opened beside it (the Design | XML
 * split), where `kubuno-views-ls` provides completion and diagnostics. The flow is vskubuno's
 * (docs/DESIGNER.md §3): the page turns a gesture into an intent (`EditOp`), the extension turns the intent into
 * text (the language server's `kubuno/applyEdit`, or the built-in model), the page re-renders from the new text.
 */
import * as path from 'node:path'
import * as vscode from 'vscode'
import { log } from '../log'
import type { EditOp } from '../views/kbviewModel'
import type { ViewService } from '../views/viewService'
import { codeBehindClass, codeBehindOf, designDataOf, relativeToRoot, type RegistryComponent } from '../project/webProject'
import { designHostDir, designPageHtml, hostRuntimeVersion } from './designHost'
import { toolboxGroups } from '../views/toolboxModel'

export const VIEW_TYPE = 'kubuno.viewDesigner'

interface PageMessage {
  type: string
  [k: string]: unknown
}

/** One open designer (a webview panel over one document). */
export class DesignerSession implements vscode.Disposable {
  selection: string | null = null
  selectionIds: string[] = []
  surfaceInfo: Record<string, unknown> | null = null
  ready = false
  lastStatus: { state: string; diagnostics: unknown[] } | null = null
  private readonly disposables: vscode.Disposable[] = []
  private textTimer: ReturnType<typeof setTimeout> | null = null
  private readonly received: PageMessage[] = []

  constructor(
    readonly document: vscode.TextDocument,
    readonly panel: vscode.WebviewPanel,
    private readonly owner: DesignerProvider,
  ) {}

  get service(): ViewService {
    return this.owner.service
  }

  /** Messages received from the page (tests read them). */
  get messages(): readonly PageMessage[] {
    return this.received
  }

  post(message: Record<string, unknown>): void {
    void this.panel.webview.postMessage(message)
  }

  track(d: vscode.Disposable): void {
    this.disposables.push(d)
  }

  // ── Host → page ──

  async sendAll(): Promise<void> {
    const doc = this.document
    this.post(themeMessage())
    const registry = await this.service.registry(doc)
    const project = this.service.project(doc)
    if (registry?.hostText) this.post({ type: 'setHostRegistry', text: registry.hostText })
    if (registry) this.post({ type: 'projectComponents', components: registry.projectComponents })
    const file = doc.uri.fsPath
    const cb = codeBehindOf(file)
    let className: string | null = null
    if (cb) {
      try {
        className = codeBehindClass((await vscode.workspace.openTextDocument(cb)).getText())
      } catch {
        className = null
      }
    }
    this.post({
      type: 'setDocumentInfo',
      file: project ? relativeToRoot(project, file) : path.basename(file),
      codeBehind: cb ? `./${path.basename(cb).replace(/\.tsx?$/, '')}` : null,
      className,
      userControls: (registry?.userControls ?? []).map((u) => ({ name: u.name, module: u.module })),
      designData: designDataOf(file) ?? null,
    })
    this.post({ type: 'setText', text: doc.getText(), baseDir: path.dirname(file) })
    this.post({ type: 'setDesignMode', on: true })
    this.post({ type: 'kbPalette', groups: toolboxGroups(registry), enabled: vscode.workspace.getConfiguration('kubuno').get<boolean>('designer.palette', true) })
    this.post({ type: 'setDesignOptions', containerOutlines: true })
    if (this.selection !== null) this.post({ type: 'select', id: this.selection })
  }

  scheduleText(): void {
    if (this.textTimer) clearTimeout(this.textTimer)
    this.textTimer = setTimeout(() => {
      this.textTimer = null
      this.post({ type: 'setText', text: this.document.getText(), baseDir: path.dirname(this.document.uri.fsPath) })
      this.owner.fireSelection(this)
    }, 40)
  }

  select(id: string | null): void {
    this.selection = id
    this.selectionIds = id === null ? [] : [id]
    this.post({ type: 'select', id })
    this.owner.fireSelection(this)
  }

  // ── Page → host ──

  async onMessage(m: PageMessage): Promise<void> {
    this.received.push(m)
    if (this.received.length > 500) this.received.splice(0, 100)
    switch (m.type) {
      case 'surfaceInfo':
        this.surfaceInfo = m
        log(`design page: ${JSON.stringify(m)}`)
        if (m.version !== 1 || m.target !== 'web') log('design page: unexpected surface version or target')
        break
      case 'ready':
        this.ready = true
        await this.sendAll()
        break
      case 'selectionChanged': {
        this.selection = typeof m.id === 'string' ? m.id : null
        this.selectionIds = Array.isArray(m.ids) ? (m.ids as string[]) : []
        this.owner.fireSelection(this)
        this.revealInXml()
        break
      }
      case 'editRequest':
        await this.service.applyOps(this.document, [m.op as EditOp])
        break
      case 'editRequests':
        await this.service.applyOps(this.document, (m.ops as EditOp[]) ?? [])
        break
      case 'doubleClick':
        await this.createDefaultHandler(String(m.elementId ?? ''))
        break
      case 'contextMenu':
        await this.contextMenu(typeof m.elementId === 'string' ? m.elementId : this.selection)
        break
      case 'command':
        await this.command(String(m.name), typeof m.elementId === 'string' ? m.elementId : this.selection)
        break
      case 'renderStatus':
        this.lastStatus = { state: String(m.state), diagnostics: (m.diagnostics as unknown[]) ?? [] }
        this.owner.publishPageDiagnostics(this, (m.diagnostics as WireDiagnostic[]) ?? [])
        break
      case 'unhandledKey':
        await this.unhandledKey(m)
        break
      case 'kbInsert':
        await this.insertComponent(String(m.name))
        break
      case 'kbToolDropped':
        log(`toolbox drop: ${String(m.name)}`)
        this.owner.setCurrent(this)
        break
      case 'kbToolDisarmed':
        this.owner.fireToolDisarmed(m.used === true)
        break
      case 'log':
        log(`design page: ${String(m.message)}`)
        break
      case 'surfaceError':
        log(`design page error: ${String(m.message)} (${String(m.line)}:${String(m.column)})`)
        break
      default:
        break
    }
  }

  /** Puts the XML editor's caret on the selected element's start tag (when the XML is visible). */
  private revealInXml(): void {
    if (this.selection === null) return
    const range = this.service.startTagRange(this.document, this.selection)
    if (!range) return
    for (const ed of vscode.window.visibleTextEditors) {
      if (ed.document.uri.toString() !== this.document.uri.toString()) continue
      ed.selection = new vscode.Selection(range.start, range.start)
      ed.revealRange(new vscode.Range(range.start, range.start), vscode.TextEditorRevealType.InCenterIfOutsideViewport)
    }
  }

  async component(id: string | null): Promise<RegistryComponent | undefined> {
    if (id === null) return undefined
    const el = this.service.model(this.document).resolve(id)
    if (!el) return undefined
    return (await this.service.registry(this.document))?.components.find((c) => c.name === el.name)
  }

  async createDefaultHandler(id: string | null): Promise<void> {
    if (id === null) return
    const comp = await this.component(id)
    const event = comp?.default_event ?? comp?.events?.[0]?.name
    if (!event) {
      void vscode.window.showInformationMessage(`Kubuno: ${comp?.name ?? 'this element'} has no default event.`)
      return
    }
    await this.service.createHandler(this.document, id, event)
  }

  async insertComponent(name: string): Promise<void> {
    const model = this.service.model(this.document)
    const registry = await this.service.registry(this.document)
    const sel = this.selection !== null ? model.resolve(this.selection) : model.root
    if (!sel || !model.root) return
    const isContainer = (n: string): boolean => {
      const c = registry?.components.find((x) => x.name === n)
      return !!c && c.children !== undefined && c.children !== 'None'
    }
    let parent = sel
    let index = sel.children.length
    if (!isContainer(sel.name) && sel.parent) {
      parent = sel.parent
      index = parent.children.indexOf(sel) + 1
    }
    await this.service.applyOps(this.document, [{ kind: 'insertChild', parentId: parent.id, index, xml: `<${name} />` }])
  }

  private async contextMenu(id: string | null): Promise<void> {
    const items: (vscode.QuickPickItem & { run: () => Promise<void> | void })[] = [
      { label: '$(zap) Create default event handler', run: () => this.createDefaultHandler(id) },
      { label: '$(go-to-file) View code', run: () => vscode.commands.executeCommand('kubuno.toggleCodeBehind') },
      { label: '$(arrow-up) Select parent', run: () => this.selectParent() },
      { label: '$(copy) Copy', run: () => this.command('copy', id) },
      { label: '$(files) Duplicate', run: () => this.command('duplicate', id) },
      { label: '$(trash) Delete', run: () => this.command('delete', id) },
      { label: '$(list-unordered) Properties', run: () => vscode.commands.executeCommand('kubuno.properties.focus') },
    ]
    const pick = await vscode.window.showQuickPick(items, { placeHolder: id === null ? 'Kubuno designer' : `Element ${id === '' ? '(root)' : id}` })
    if (pick) await pick.run()
  }

  selectParent(): void {
    if (this.selection === null || this.selection === '') return
    const k = this.selection.lastIndexOf('.')
    this.select(k < 0 ? '' : this.selection.slice(0, k))
  }

  async command(name: string, id: string | null): Promise<void> {
    if (id === null) return
    const model = this.service.model(this.document)
    const el = model.resolve(id)
    if (!el) return
    const text = this.document.getText().slice(el.start, el.end)
    switch (name) {
      case 'copy':
        await vscode.env.clipboard.writeText(text)
        break
      case 'cut':
        await vscode.env.clipboard.writeText(text)
        if (el.parent) await this.service.applyOps(this.document, [{ kind: 'removeElement', elementId: id }])
        break
      case 'delete':
        if (el.parent) await this.service.applyOps(this.document, [{ kind: 'removeElement', elementId: id }])
        break
      case 'duplicate':
        if (el.parent) {
          await this.service.applyOps(this.document, [{ kind: 'insertChild', parentId: el.parent.id, index: el.parent.children.indexOf(el) + 1, xml: stripName(text) }])
        }
        break
      case 'paste': {
        const xml = (await vscode.env.clipboard.readText()).trim()
        if (!xml.startsWith('<')) return
        await this.service.applyOps(this.document, [{ kind: 'insertChild', parentId: el.id, index: el.children.length, xml: stripName(xml) }])
        break
      }
    }
  }

  private async unhandledKey(m: PageMessage): Promise<void> {
    const key = String(m.key)
    const ctrl = m.ctrl === true
    const shift = m.shift === true
    const k = key.toLowerCase()
    if (ctrl && k === 'z' && !shift) await vscode.commands.executeCommand('undo')
    else if (ctrl && (k === 'y' || (k === 'z' && shift))) await vscode.commands.executeCommand('redo')
    else if (ctrl && k === 's') await this.document.save()
    else if (key === 'F7') await vscode.commands.executeCommand('kubuno.toggleCodeBehind')
    else if (key === 'F4') await vscode.commands.executeCommand('kubuno.properties.focus')
  }

  dispose(): void {
    if (this.textTimer) clearTimeout(this.textTimer)
    for (const d of this.disposables.splice(0)) d.dispose()
  }
}

/** Copies drop their `x:Name` (names are unique in a view). */
function stripName(xml: string): string {
  return xml.replace(/\s+x:Name="[^"]*"/g, '')
}

interface WireDiagnostic {
  line: number
  column: number
  endLine: number
  endColumn: number
  message: string
  code: string
}

/** The design page's chrome in VS Code's colours (`--vs-*` of the page ← `--vscode-*` of the webview). */
function themeMessage(): Record<string, unknown> {
  const kind = vscode.window.activeColorTheme.kind
  const dark = kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast
  return {
    type: 'setVsTheme',
    mode: dark ? 'dark' : 'light',
    colors: {
      canvas: 'var(--vscode-editor-background)',
      panel: 'var(--vscode-editorWidget-background, var(--vscode-sideBar-background))',
      text: 'var(--vscode-foreground)',
      'text-dim': 'var(--vscode-descriptionForeground)',
      border: 'var(--vscode-panel-border, var(--vscode-widget-border))',
      accent: 'var(--vscode-focusBorder)',
      hover: 'var(--vscode-toolbar-hoverBackground)',
    },
  }
}

export class DesignerProvider implements vscode.CustomTextEditorProvider {
  private readonly sessions = new Set<DesignerSession>()
  private current: DesignerSession | null = null
  private readonly currentChanged = new vscode.EventEmitter<DesignerSession | null>()
  private readonly selectionChanged = new vscode.EventEmitter<DesignerSession>()
  readonly onDidChangeCurrent = this.currentChanged.event
  readonly onDidChangeSelection = this.selectionChanged.event
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('kubuno-designer')

  constructor(
    private readonly context: vscode.ExtensionContext,
    readonly service: ViewService,
  ) {}

  get active(): DesignerSession | null {
    return this.current
  }

  get all(): readonly DesignerSession[] {
    return [...this.sessions]
  }

  sessionFor(uri: vscode.Uri): DesignerSession | undefined {
    return [...this.sessions].find((s) => s.document.uri.toString() === uri.toString())
  }

  private readonly toolDisarmed = new vscode.EventEmitter<boolean>()
  /** The armed Toolbox item was placed (true) or dropped with Esc (false). */
  readonly onDidDisarmTool = this.toolDisarmed.event

  fireToolDisarmed(used: boolean): void {
    this.toolDisarmed.fire(used)
  }

  /** Tells every open design page which Toolbox item is being dragged (null: the drag ended). */
  broadcastToolDrag(name: string | null): void {
    for (const s of this.sessions) s.post({ type: 'kbToolDrag', name })
  }

  /** Arms a Toolbox item on the current designer: the next click on the surface places it (null disarms). */
  armTool(name: string | null): boolean {
    const s = this.current
    if (!s) return false
    s.post({ type: 'kbArmTool', name })
    if (name) s.panel.reveal(undefined, false)
    return true
  }

  fireSelection(s: DesignerSession): void {
    this.selectionChanged.fire(s)
  }

  setCurrent(s: DesignerSession | null): void {
    if (this.current === s) return
    this.current = s
    this.currentChanged.fire(s)
  }

  /** The page's own compiler diagnostics, shown only when the language server does not publish its own. */
  publishPageDiagnostics(s: DesignerSession, diags: WireDiagnostic[]): void {
    if (this.service.ls.running) {
      this.diagnostics.delete(s.document.uri)
      return
    }
    const doc = s.document
    const line = (n: number): number => Math.max(0, Math.min(doc.lineCount - 1, n - 1))
    this.diagnostics.set(
      doc.uri,
      diags.map((d) => {
        const r = new vscode.Range(line(d.line), Math.max(0, d.column - 1), line(d.endLine || d.line), Math.max(0, (d.endColumn || d.column + 1) - 1))
        const diag = new vscode.Diagnostic(r, d.message, vscode.DiagnosticSeverity.Error)
        diag.source = 'kubuno designer'
        diag.code = d.code
        return diag
      }),
    )
  }

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    const dir = designHostDir(this.context)
    const roots = [vscode.Uri.file(dir), vscode.Uri.joinPath(this.context.extensionUri, 'media'), ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri)]
    panel.webview.options = { enableScripts: true, localResourceRoots: roots }
    const session = new DesignerSession(document, panel, this)
    this.sessions.add(session)
    log(`designer: ${document.uri.fsPath} (design host ${hostRuntimeVersion(dir) ?? '?'} from ${dir}, language server ${this.service.ls.state})`)

    session.track(panel.webview.onDidReceiveMessage((m: PageMessage) => void session.onMessage(m)))
    session.track(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() === document.uri.toString() && e.contentChanges.length) session.scheduleText()
      }),
    )
    session.track(
      vscode.window.onDidChangeTextEditorSelection(async (e) => {
        if (e.textEditor.document.uri.toString() !== document.uri.toString()) return
        if (e.kind !== vscode.TextEditorSelectionChangeKind.Keyboard && e.kind !== vscode.TextEditorSelectionChangeKind.Mouse) return
        const id = await this.service.elementAt(document, e.selections[0].active)
        if (id !== null && id !== session.selection) session.select(id)
        this.setCurrent(session)
      }),
    )
    session.track(vscode.window.onDidChangeActiveColorTheme(() => session.post(themeMessage())))
    session.track(
      panel.onDidChangeViewState((e) => {
        if (e.webviewPanel.active) this.setCurrent(session)
      }),
    )
    panel.onDidDispose(() => {
      this.sessions.delete(session)
      session.dispose()
      this.diagnostics.delete(document.uri)
      if (this.current === session) this.setCurrent([...this.sessions].pop() ?? null)
    })

    panel.webview.html = designPageHtml(panel.webview, dir, this.context.extensionUri)
    this.setCurrent(session)

    if (vscode.workspace.getConfiguration('kubuno').get<boolean>('designer.openXmlBeside', true)) {
      const alreadyVisible = vscode.window.visibleTextEditors.some((e) => e.document.uri.toString() === document.uri.toString())
      if (!alreadyVisible) {
        await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true, preview: false })
      }
    }
  }

  dispose(): void {
    this.diagnostics.dispose()
    this.currentChanged.dispose()
    this.selectionChanged.dispose()
  }
}
