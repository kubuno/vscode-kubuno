/**
 * The `kubuno-views-ls` client: completion, hover, diagnostics, outline, go-to-definition for `.kbview` /
 * `.kbcontrol`, and the designer's custom requests (`kubuno/applyEdit`, `kubuno/elementAtOffset`,
 * `kubuno/rangeOfElement`, `kubuno/registry`, `kubuno/createHandler`).
 *
 * The server is the one Visual Studio runs (vskubuno), started over stdio with no options. It is optional: when
 * no executable exists for this OS, every caller falls back to the extension's own XML model.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { LanguageClient, type LanguageClientOptions, type ServerOptions, TransportKind } from 'vscode-languageclient/node'
import { log } from '../log'

const EXE = process.platform === 'win32' ? 'kubuno-views-ls.exe' : 'kubuno-views-ls'

export type LsState = 'running' | 'missing' | 'failed' | 'starting'

export class ViewsLanguageServer implements vscode.Disposable {
  private client: LanguageClient | null = null
  private status: vscode.StatusBarItem
  state: LsState = 'missing'
  executable: string | null = null
  private readonly changed = new vscode.EventEmitter<LsState>()
  readonly onDidChangeState = this.changed.event

  constructor(private readonly context: vscode.ExtensionContext) {
    this.status = vscode.window.createStatusBarItem('kubuno.ls', vscode.StatusBarAlignment.Right, 100)
    this.status.name = 'Kubuno views language server'
    this.status.command = 'kubuno.showOutput'
  }

  /** The executable: the setting, then `bin/<platform>-<arch>/` of the extension, then the `PATH`. */
  findExecutable(): string | null {
    const configured = vscode.workspace.getConfiguration('kubuno').get<string>('languageServer.path')?.trim()
    if (configured) return fs.existsSync(configured) ? configured : null
    const shipped = path.join(this.context.extensionPath, 'bin', `${process.platform}-${process.arch}`, EXE)
    if (fs.existsSync(shipped)) return shipped
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
      if (!dir) continue
      const f = path.join(dir, EXE)
      if (fs.existsSync(f)) return f
    }
    return null
  }

  async start(): Promise<void> {
    this.executable = this.findExecutable()
    if (!this.executable) {
      this.setState('missing')
      log(`kubuno-views-ls was not found for ${process.platform}-${process.arch}: the designer uses its built-in XML editor.`)
      return
    }
    this.setState('starting')
    const run = { command: this.executable, transport: TransportKind.stdio }
    const serverOptions: ServerOptions = { run, debug: run }
    const clientOptions: LanguageClientOptions = {
      documentSelector: [{ language: 'kbview' }, { pattern: '**/*.{kbview,kbcontrol}' }],
      outputChannelName: 'Kubuno Views Language Server',
      synchronize: { fileEvents: vscode.workspace.createFileSystemWatcher('**/*.{ts,tsx,kbres,json}') },
    }
    this.client = new LanguageClient('kubuno.views', 'Kubuno Views', serverOptions, clientOptions)
    try {
      await this.client.start()
      this.setState('running')
      log(`kubuno-views-ls started: ${this.executable}`)
    } catch (err) {
      this.setState('failed')
      log(`kubuno-views-ls failed to start: ${(err as Error).message}`)
      this.client = null
    }
  }

  async restart(): Promise<void> {
    await this.stop()
    await this.start()
  }

  async stop(): Promise<void> {
    const c = this.client
    this.client = null
    if (c) await c.stop().catch(() => undefined)
    this.setState('missing')
  }

  get running(): boolean {
    return this.state === 'running' && this.client !== null
  }

  /** A custom request; `undefined` when the server is not running or the request failed. */
  async request<T>(method: string, params: unknown): Promise<T | undefined> {
    if (!this.running || !this.client) return undefined
    try {
      return await this.client.sendRequest<T>(method, params)
    } catch (err) {
      log(`${method} failed: ${(err as Error).message}`)
      return undefined
    }
  }

  /** Converts an LSP `WorkspaceEdit` (`changes` or `documentChanges`) to VS Code's. */
  async toWorkspaceEdit(edit: unknown): Promise<vscode.WorkspaceEdit | undefined> {
    if (!this.client || !edit) return undefined
    return this.client.protocol2CodeConverter.asWorkspaceEdit(edit as never)
  }

  private setState(s: LsState): void {
    this.state = s
    const text: Record<LsState, string> = {
      running: '$(check) Kubuno LS',
      starting: '$(sync~spin) Kubuno LS',
      missing: '$(circle-slash) Kubuno LS',
      failed: '$(error) Kubuno LS',
    }
    const tip: Record<LsState, string> = {
      running: `kubuno-views-ls is running (${this.executable ?? ''})`,
      starting: 'kubuno-views-ls is starting',
      missing: `kubuno-views-ls is not available for ${process.platform}-${process.arch}: the designer edits the XML itself (no completion, handlers written by the extension)`,
      failed: 'kubuno-views-ls failed to start (see Output › Kubuno)',
    }
    this.status.text = text[s]
    this.status.tooltip = tip[s]
    this.status.show()
    this.changed.fire(s)
  }

  dispose(): void {
    void this.stop()
    this.status.dispose()
    this.changed.dispose()
  }
}
