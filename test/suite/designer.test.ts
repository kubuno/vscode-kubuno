/**
 * Integration tests in a real VS Code: the designer page (`@kubuno/host-runtime`) loads in the webview, renders
 * the core's WaffleMenu and drive's DuplicatesDialog, and every edit path goes back to the XML.
 */
import * as assert from 'node:assert'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import type { KubunoApi } from '../../src/extension'
import type { DesignerSession } from '../../src/designer/designerProvider'

const ws = process.env.KUBUNO_TEST_WS ?? vscode.workspace.workspaceFolders![0].uri.fsPath
const MENUS = path.join(ws, 'core', 'web', 'src', 'core', 'shell', 'menus')
const WAFFLE = path.join(MENUS, 'WaffleMenu.kbcontrol')
const DUPLICATES = path.join(ws, 'drive', 'web', 'src', 'dialogs', 'DuplicatesDialog.kbview')
const SETTINGS = path.join(ws, 'drive', 'web', 'src', 'views', 'DriveSettingsPage.kbview')

async function until<T>(what: string, f: () => T | undefined | null | false | Promise<T | undefined | null | false>, timeout = 30_000): Promise<T> {
  const end = Date.now() + timeout
  for (;;) {
    const v = await f()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Same file (case-insensitive on Windows, where VS Code lower-cases the drive letter). */
const same = (a: string, b: string): boolean => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)

async function openDesigner(api: KubunoApi, file: string): Promise<DesignerSession> {
  const uri = vscode.Uri.file(file)
  await vscode.commands.executeCommand('vscode.openWith', uri, 'kubuno.viewDesigner', vscode.ViewColumn.One)
  const s = await until('the designer session', () => api.designers.sessionFor(uri))
  await until('the page to be ready', () => s.ready)
  await until('a render status', () => s.lastStatus)
  return s
}

const statusOf = (s: DesignerSession): string => `${s.lastStatus?.state} ${JSON.stringify(s.lastStatus?.diagnostics)}`

suite('Kubuno designer (VS Code)', () => {
  let api: KubunoApi

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension<KubunoApi>('kubuno.vscode-kubuno')
    assert.ok(ext, 'extension present')
    api = await ext.activate()
    console.log(`language server: ${api.ls.state} (${api.ls.executable ?? 'none'})`)
  })

  test('WaffleMenu opens in the designer and the page renders it without errors', async () => {
    const s = await openDesigner(api, WAFFLE)
    const info = s.surfaceInfo as Record<string, unknown>
    assert.strictEqual(info.target, 'web')
    assert.strictEqual(info.mode, 'bundled')
    await until(`a clean render (${statusOf(s)})`, () => s.lastStatus?.state === 'clean')
    // The XML is open beside the designer.
    assert.ok(vscode.window.visibleTextEditors.some((e) => same(e.document.uri.fsPath, WAFFLE)), 'XML editor beside')
  })

  test('a selection on the surface selects the XML and fills Properties', async () => {
    const s = api.designers.sessionFor(vscode.Uri.file(WAFFLE))!
    await s.onMessage({ type: 'selectionChanged', id: '0.0.0.0.0.0.1', ids: ['0.0.0.0.0.0.1'], bounds: null })
    const ed = vscode.window.visibleTextEditors.find((e) => same(e.document.uri.fsPath, WAFFLE))!
    const line = ed.document.lineAt(ed.selection.active.line).text
    assert.match(line, /<IconButton x:Name="edit_button"/)
    const p = (await api.describeSelection(s)) as { element: string; xName: string; properties: { name: string; value: string | null }[]; events: { name: string; handler: string | null }[] }
    assert.strictEqual(p.element, 'IconButton')
    assert.strictEqual(p.xName, 'edit_button')
    assert.strictEqual(p.properties.find((r) => r.name === 'Icon')?.value, 'Pencil')
    assert.strictEqual(p.events.find((e) => e.name === 'OnClick')?.handler, 'edit_button_click')
  })

  test('the XML caret selects the element in the designer', async () => {
    const s = api.designers.sessionFor(vscode.Uri.file(WAFFLE))!
    const id = await api.service.elementAt(s.document, s.document.positionAt(s.document.getText().indexOf('<MenuLink') + 3))
    assert.strictEqual(id, '0.0.1')
  })

  test('a property edit writes the XML and the page renders it', async () => {
    const s = api.designers.sessionFor(vscode.Uri.file(WAFFLE))!
    const ok = await api.service.applyOps(s.document, [{ kind: 'setAttribute', elementId: '0.0.0.0.0.0', name: 'Gap', value: '24' }])
    assert.ok(ok)
    assert.match(s.document.getText(), /Justify="SpaceBetween" Gap="24" Padding="20, 16, 20, 4"/)
    await until('the page to render the new text', () => s.messages.filter((m) => m.type === 'renderStatus').length >= 2)
    await until(`a clean render (${statusOf(s)})`, () => s.lastStatus?.state === 'clean')
  })

  test('a Toolbox drop through the real design page inserts the element', async () => {
    const s = api.designers.sessionFor(vscode.Uri.file(WAFFLE))!
    const before = s.document.getText()
    s.post({ type: 'dragEnter', component: 'Label' })
    let hit: { x: number; y: number } | null = null
    for (let y = 60; y < 700 && !hit; y += 30) {
      for (let x = 20; x < 900 && !hit; x += 40) {
        const n = s.messages.length
        s.post({ type: 'dragOver', x, y })
        const reply = await until('dropTargetChanged', () => s.messages.slice(n).find((m) => m.type === 'dropTargetChanged'), 5000)
        const t = reply.target as { valid?: boolean } | null
        if (t?.valid) hit = { x, y }
      }
    }
    assert.ok(hit, 'a valid drop target somewhere on the surface')
    s.post({ type: 'drop', ...hit })
    await until('the inserted Label', () => s.document.getText() !== before && s.document.getText())
    assert.strictEqual((s.document.getText().match(/<Label/g) ?? []).length, (before.match(/<Label/g) ?? []).length + 1)
    await vscode.commands.executeCommand('undo')
  })

  test('a double-click creates the TypeScript handler (kubuno/createHandler or the fallback)', async () => {
    const s = api.designers.sessionFor(vscode.Uri.file(WAFFLE))!
    await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup')
    // The header's first Label has no OnClick.
    await s.onMessage({ type: 'doubleClick', elementId: '0.0.0.0.0.0.0' })
    await until('OnClick in the view', () => /<Label Text="\{Res shell.favorites\}"[^>]*OnClick="label_click"/.test(s.document.getText()))
    const ts = vscode.workspace.textDocuments.find((d) => same(d.uri.fsPath, path.join(MENUS, 'WaffleMenu.ts')))
    assert.ok(ts, 'the code-behind is open')
    assert.match(ts.getText(), /label_click\(_?sender: Label, _?e: MouseEventArgs\): void \{/)
    assert.match(ts.getText(), /type Label\b/)
  })

  test('the language server answers (completion, diagnostics) when it runs', async function () {
    if (!api.ls.running) {
      console.log('kubuno-views-ls not running on this OS: skipped')
      this.skip()
    }
    const s = api.designers.sessionFor(vscode.Uri.file(WAFFLE))!
    const text = s.document.getText()
    const pos = s.document.positionAt(text.indexOf('<MenuLink ') + '<MenuLink '.length)
    const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', s.document.uri, pos)
    const labels = list.items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label))
    assert.ok(labels.includes('Text') || labels.includes('Href'), `completion: ${labels.slice(0, 20).join(', ')}`)
    const edit = new vscode.WorkspaceEdit()
    edit.insert(s.document.uri, s.document.positionAt(text.indexOf('</Panel>\n  </ScrollArea>')), '<Bogus/>\n      ')
    await vscode.workspace.applyEdit(edit)
    await until('a language server diagnostic', () => vscode.languages.getDiagnostics(s.document.uri).some((d) => /Bogus/.test(d.message)))
    await vscode.commands.executeCommand('undo')
  })

  test('drive DuplicatesDialog opens and renders', async () => {
    const s = await openDesigner(api, DUPLICATES)
    await until(`a render (${statusOf(s)})`, () => s.lastStatus && s.lastStatus.state !== 'empty')
    console.log(`DuplicatesDialog: ${statusOf(s)}`)
    assert.ok(s.lastStatus?.state === 'clean' || s.lastStatus?.state === 'stale')
  })

  test('a key the page forwards (Ctrl+Z, F7) is not run a second time by the extension', async () => {
    const s = api.designers.sessionFor(vscode.Uri.file(WAFFLE))!
    const ok = await api.service.applyOps(s.document, [{ kind: 'setAttribute', elementId: '0.0.0.0.0.0', name: 'Gap', value: '12' }])
    assert.ok(ok)
    const after = s.document.getText()
    const editors = vscode.window.tabGroups.all.flatMap((g) => g.tabs).length
    // VS Code's webview host already hands these keys to the workbench keybindings; the page's `unhandledKey`
    // must not undo, save or toggle the code-behind again.
    await s.onMessage({ type: 'unhandledKey', key: 'z', ctrl: true, shift: false, alt: false })
    await s.onMessage({ type: 'unhandledKey', key: 'F7', ctrl: false, shift: false, alt: false })
    await sleep(500)
    assert.strictEqual(s.document.getText(), after)
    assert.strictEqual(vscode.window.tabGroups.all.flatMap((g) => g.tabs).length, editors)
    await vscode.commands.executeCommand('undo')
  })

  test('drive DriveSettingsPage: an inserted Button gets its own line and a handler', async () => {
    const s = await openDesigner(api, SETTINGS)
    const before = s.document.getText()
    await api.service.applyOps(s.document, [{ kind: 'insertChild', parentId: '0', index: 1, xml: '<Button />' }])
    const text = s.document.getText()
    assert.notStrictEqual(text, before)
    assert.match(text, /\n[ \t]*<Button ?\/>[ \t]*\r?\n[ \t]*<\/Panel>/, 'the new element on its own line')
    await s.onMessage({ type: 'doubleClick', elementId: '0.1' })
    await until('OnClick on the new Button', () => /<Button OnClick="button_click" ?\/>/.test(s.document.getText()))
    const ts = vscode.workspace.textDocuments.find((d) => same(d.uri.fsPath, path.join(path.dirname(SETTINGS), 'DriveSettingsPage.ts')))
    assert.ok(ts, 'the code-behind is open')
    assert.match(ts.getText(), /button_click\(_?sender: Button, _?e: MouseEventArgs\): void \{/)
  })

  test('demo layout (screenshots)', async function () {
    const seconds = Number(process.env.KUBUNO_DEMO || 0)
    if (!seconds) this.skip()
    this.timeout((seconds + 60) * 1000)
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
    const s = await openDesigner(api, process.env.KUBUNO_DEMO_FILE === 'drive' ? DUPLICATES : WAFFLE)
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar')
    await vscode.commands.executeCommand('notifications.clearAll')
    await vscode.commands.executeCommand('workbench.view.extension.kubuno')
    await vscode.commands.executeCommand('kubuno.toolbox.focus')
    await vscode.commands.executeCommand('kubuno.properties.focus')
    const file = s.document.uri.fsPath
    await api.explorerView.reveal(api.explorer.viewNode(file), { expand: true, select: true, focus: false }).then(undefined, (e: Error) => console.log(`reveal: ${e.message}`))
    await sleep(1500)
    s.select(process.env.KUBUNO_DEMO_FILE === 'drive' ? '1' : '0.0.0.0.0.0.1')
    await s.onMessage({ type: 'selectionChanged', id: s.selection, ids: [s.selection], bounds: null })
    s.panel.reveal(vscode.ViewColumn.One, true)
    fs.writeFileSync(path.join(ws, 'demo-ready'), String(Date.now()))
    console.log('demo: ready for screenshots')
    await sleep(seconds * 1000)
  })
})
