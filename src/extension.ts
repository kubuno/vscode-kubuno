/**
 * Kubuno for Visual Studio Code: the web view designer (custom editor + design page), the Toolbox and Properties
 * views, the `kubuno-views-ls` client and the « Projects » view. The counterpart of vskubuno (Visual Studio 2026)
 * for every OS VS Code runs on; see docs/VSCODE.md.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { DesignerProvider, VIEW_TYPE } from './designer/designerProvider'
import { initLog, log } from './log'
import { ViewsLanguageServer } from './lsp/client'
import { KubunoExplorer } from './project/explorer'
import { codeBehindOf, findProject } from './project/webProject'
import { describeSelection, PropertiesView, ToolboxView } from './views/panels'
import { ViewService } from './views/viewService'
import { DEBUG_TYPE, KubunoDebugProvider, KubunoDynamicConfigurations, watchDevCoreSessions } from './dev/debug'
import { initDevCore } from './dev/devCore'
import { KubunoTaskProvider, TASK_TYPE } from './dev/tasks'

export interface KubunoApi {
  designers: DesignerProvider
  service: ViewService
  ls: ViewsLanguageServer
  describeSelection: typeof describeSelection
  explorer: KubunoExplorer
  explorerView: vscode.TreeView<unknown>
}

const VIEW_EXTS = ['.kbview', '.kbcontrol']

/** The view a code-behind belongs to (`X.ts` → `X.kbview` / `X.kbcontrol`; `X.kbcontrol.ts` → `X.kbcontrol`). */
function viewOfCodeBehind(file: string): string | null {
  const m = /^(.*?)(\.kbview|\.kbcontrol)?\.tsx?$/.exec(file)
  if (!m) return null
  if (m[2]) return fs.existsSync(m[1] + m[2]) ? m[1] + m[2] : null
  for (const ext of VIEW_EXTS) if (fs.existsSync(m[1] + ext)) return m[1] + ext
  return null
}

function activeUri(designers: DesignerProvider, arg?: unknown): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) return arg
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input
  if (tab instanceof vscode.TabInputCustom || tab instanceof vscode.TabInputText) return tab.uri
  return vscode.window.activeTextEditor?.document.uri ?? designers.active?.document.uri
}

export async function activate(context: vscode.ExtensionContext): Promise<KubunoApi> {
  context.subscriptions.push(initLog())
  const ls = new ViewsLanguageServer(context)
  context.subscriptions.push(ls)
  const service = new ViewService(ls)
  const designers = new DesignerProvider(context, service)
  context.subscriptions.push(designers)

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, designers, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
  )

  const toolbox = new ToolboxView(context.extensionUri, designers)
  const properties = new PropertiesView(context.extensionUri, designers)
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('kubuno.toolbox', toolbox, { webviewOptions: { retainContextWhenHidden: true } }))
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('kubuno.properties', properties))

  const explorer = new KubunoExplorer()
  const explorerView = vscode.window.createTreeView('kubuno.explorer', { treeDataProvider: explorer, showCollapseAll: true })
  context.subscriptions.push(explorerView)

  // The XML editor of a designed view makes that designer the current one (Toolbox, Properties follow it).
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((e) => {
      const s = e && designers.sessionFor(e.document.uri)
      if (s) designers.setCurrent(s)
    }),
  )
  // Registry files and user controls change: the Toolbox and the design pages pick them up.
  const watcher = vscode.workspace.createFileSystemWatcher('**/{kbview-registry*.json,kbview-controls.json,kubuno.views.json,*.kbcontrol}')
  const registryChanged = (): void => {
    service.invalidateRegistries()
    void toolbox.refresh()
    for (const s of designers.all) if (s.ready) void s.sendAll()
  }
  watcher.onDidChange(registryChanged)
  watcher.onDidCreate(() => {
    registryChanged()
    explorer.refresh()
  })
  watcher.onDidDelete(() => {
    registryChanged()
    explorer.refresh()
  })
  context.subscriptions.push(watcher)

  const cmd = (id: string, f: (...args: unknown[]) => unknown): void => void context.subscriptions.push(vscode.commands.registerCommand(id, f))

  cmd('kubuno.openDesigner', async (arg) => {
    let uri = activeUri(designers, arg)
    if (!uri) return
    if (/\.tsx?$/.test(uri.fsPath)) {
      const v = viewOfCodeBehind(uri.fsPath)
      if (!v) return void vscode.window.showInformationMessage('Kubuno: no view beside this file.')
      uri = vscode.Uri.file(v)
    }
    await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE)
  })
  cmd('kubuno.openXml', async () => {
    const s = designers.active
    if (s) await vscode.window.showTextDocument(s.document, { viewColumn: vscode.ViewColumn.Beside, preview: false })
  })
  cmd('kubuno.toggleCodeBehind', async (arg) => {
    const uri = activeUri(designers, arg)
    if (!uri) return
    if (VIEW_EXTS.includes(path.extname(uri.fsPath))) {
      const cb = codeBehindOf(uri.fsPath)
      if (!cb) return void vscode.window.showInformationMessage('Kubuno: this view has no code-behind.')
      await vscode.window.showTextDocument(vscode.Uri.file(cb), { viewColumn: vscode.ViewColumn.Beside, preview: false })
    } else {
      await vscode.commands.executeCommand('kubuno.openDesigner', uri)
    }
  })
  cmd('kubuno.createDefaultHandler', () => designers.active?.createDefaultHandler(designers.active.selection))
  cmd('kubuno.deleteSelection', () => designers.active?.command('delete', designers.active.selection))
  cmd('kubuno.selectParent', () => designers.active?.selectParent())
  cmd('kubuno.restartLanguageServer', async () => {
    await ls.restart()
    service.invalidateRegistries()
  })
  cmd('kubuno.refreshExplorer', () => explorer.refresh())
  cmd('kubuno.showOutput', () => initLog().show(true))
  cmd('kubuno.newView', (arg) => newView(arg instanceof vscode.Uri ? arg : undefined))

  context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => void ls.restart()))
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('kubuno.languageServer.path')) void ls.restart()
    }),
  )

  // Build, run and debug: tasks and launch configurations contributed for every Kubuno checkout of the workspace.
  initDevCore(context)
  context.subscriptions.push(vscode.tasks.registerTaskProvider(TASK_TYPE, new KubunoTaskProvider()))
  context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, new KubunoDebugProvider()))
  context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, new KubunoDynamicConfigurations(), vscode.DebugConfigurationProviderTriggerKind.Dynamic))
  context.subscriptions.push(watchDevCoreSessions())

  log(`Kubuno extension ${String(context.extension.packageJSON.version)} on ${process.platform}-${process.arch}, VS Code ${vscode.version}`)
  await ls.start()
  return { designers, service, ls, describeSelection, explorer, explorerView: explorerView as vscode.TreeView<unknown> }
}

/** « New View or User Control… »: a `.kbview` (page, dialog) or `.kbcontrol` (user control) with its code-behind. */
async function newView(folder?: vscode.Uri): Promise<void> {
  if (!folder) {
    const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Create here', title: 'Folder of the new view (inside a web project)' })
    folder = picked?.[0]
  }
  if (!folder) return
  const project = findProject(path.join(folder.fsPath, 'x.kbview'))
  if (!project || project.target !== 'web') {
    void vscode.window.showWarningMessage('Kubuno: this folder is not inside a web views project (no kubuno.views.json).')
    return
  }
  const kind = await vscode.window.showQuickPick(
    [
      { label: 'View', description: '.kbview — a page, window or dialog', ext: '.kbview' },
      { label: 'User Control', description: '.kbcontrol — placed inside other views', ext: '.kbcontrol' },
    ],
    { placeHolder: 'Kind' },
  )
  if (!kind) return
  const name = await vscode.window.showInputBox({ prompt: 'Name (PascalCase, unique in the project)', validateInput: (v) => (/^[A-Z][A-Za-z0-9]*$/.test(v) ? null : 'PascalCase letters and digits') })
  if (!name) return
  const viewFile = path.join(folder.fsPath, name + kind.ext)
  const tsFile = path.join(folder.fsPath, name + '.ts')
  if (fs.existsSync(viewFile) || fs.existsSync(tsFile)) return void vscode.window.showWarningMessage(`Kubuno: ${name} already exists here.`)
  const markup =
    kind.ext === '.kbcontrol'
      ? `<UserControl x:Props="${name}Props" DesignWidth="360" DesignHeight="240">\n  <Stack Gap="8" Padding="16">\n    <Label Text="${name}"/>\n  </Stack>\n</UserControl>\n`
      : `<Stack x:Props="${name}Props" Gap="12" Padding="24">\n  <Label Text="${name}" Role="Title"/>\n</Stack>\n`
  const code = `import { ViewBase } from './${name}${kind.ext}'\n\nexport interface ${name}Props {}\n\nexport class ${name} extends ViewBase {\n}\n\nexport default ${name}.component()\n`
  fs.writeFileSync(viewFile, markup)
  fs.writeFileSync(tsFile, code)
  await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(viewFile), VIEW_TYPE)
}

export function deactivate(): void {
  /* disposables do the work */
}
