/**
 * Launch configurations of type `kubuno`, resolved into a real debugger's configuration (no `launch.json` to
 * write per repository):
 *
 * - `"target": "core"` — the dev core (`kubuno-core` of the workspace with one module, `devCore.ts`) under
 *   CodeLLDB (`lldb`, every OS), else `cppvsdbg` (Windows) or `cppdbg` (gdb, Linux / macOS) from the C/C++
 *   extension; its pre-launch task is « prepare dev core (<module>) ». Once the core answers, the module's page
 *   opens in the browser (`kubuno.dev.openBrowser`).
 * - `"target": "browser"` — the module's page in a browser debugged by VS Code's JavaScript debugger, with the
 *   source maps of the module's `web/dist` (breakpoints in the TypeScript of `web/src`).
 */
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { log } from '../log'
import { devCoreDir, devCoreEnv, devPort, stopDevModules } from './devCore'
import { buildEnv, cargoOut, exe, TASK_TYPE } from './tasks'
import { type Checkout, findCheckouts } from './workspace'
import { desktopApps, desktopDefaultArgs, desktopOs, desktopOut, desktopTaskLabel } from './desktop'

export const DEBUG_TYPE = 'kubuno'

let desktopSandbox: string | null = null

/** The sandboxed profile of desktop runs (`KUBUNO_SANDBOX_DIR`): one folder, so the apps share its accounts and broker. */
export function initDesktopSandbox(context: vscode.ExtensionContext): void {
  desktopSandbox = path.join(context.globalStorageUri.fsPath, 'desktop-sandbox')
}

/** « Kubuno: Debug Desktop App… » / « Run Desktop App… »: picks a desktop app of the running OS and starts it. */
export async function pickDesktopApp(noDebug: boolean): Promise<void> {
  const all = findCheckouts()
  const apps = all.flatMap((c) => desktopApps(c).map((a) => ({ a, folder: c.folder })))
  if (apps.length === 0) return void vscode.window.showInformationMessage(`Kubuno: no desktop app for ${desktopOs()} in the workspace.`)
  const pick = await vscode.window.showQuickPick(
    apps.map(({ a, folder }) => ({ label: a.bin, description: `${a.id} · ${a.pkg}`, a, folder })),
    { placeHolder: noDebug ? 'Desktop app to run' : 'Desktop app to debug', matchOnDescription: true },
  )
  if (!pick) return
  await vscode.debug.startDebugging(pick.folder, { type: DEBUG_TYPE, request: 'launch', name: `Kubuno: ${pick.a.bin} (desktop)`, target: 'desktop', module: pick.a.id, app: pick.a.bin }, { noDebug })
}

/**
 * `"target": "desktop"`: a native desktop app of the running OS (`desktop.ts`), its debug build under the native
 * debugger, with its build task as pre-launch task.
 */
async function resolveDesktop(config: vscode.DebugConfiguration, all: Checkout[]): Promise<vscode.DebugConfiguration | undefined> {
  const apps = all.flatMap((c) => desktopApps(c))
  const a = apps.find((x) => x.bin === config.app && (!config.module || x.id === config.module)) ?? apps.find((x) => x.bin === config.app)
  if (!a) return void vscode.window.showErrorMessage(`Kubuno: no desktop app "${String(config.app)}" for ${desktopOs()} in the workspace (${apps.map((x) => x.bin).join(', ') || 'none'}).`)
  const type = nativeDebugger()
  if (!type) {
    const pick = await vscode.window.showErrorMessage('Kubuno: debugging a desktop app needs CodeLLDB (or the C/C++ extension).', 'Install CodeLLDB')
    if (pick) await vscode.commands.executeCommand('workbench.extensions.installExtension', 'vadimcn.vscode-lldb')
    return undefined
  }
  const program = path.join(desktopOut(a.workspace, buildEnv()), exe(a.bin))
  const args: string[] = Array.isArray(config.args) ? config.args.map(String) : desktopDefaultArgs(a.bin)
  const env: Record<string, string> = {}
  if (config.sandbox !== false && desktopSandbox) {
    fs.mkdirSync(desktopSandbox, { recursive: true })
    env.KUBUNO_SANDBOX_DIR = desktopSandbox
  }
  if (config.env && typeof config.env === 'object') for (const [k, v] of Object.entries(config.env as Record<string, unknown>)) env[k] = String(v)
  log(`desktop: ${program} ${args.join(' ')}, debugger ${type}${env.KUBUNO_SANDBOX_DIR ? `, sandbox ${env.KUBUNO_SANDBOX_DIR}` : ''}`)
  const base = { name: config.name, request: 'launch', program, args, cwd: a.workspace, preLaunchTask: config.preLaunchTask ?? `${TASK_TYPE}: ${desktopTaskLabel(a)}`, noDebug: config.noDebug }
  // The Linux and macOS entry points run the portable app's text interface today: it reads the terminal, so it gets
  // one; the Windows apps are windows (their log goes to the debug console).
  const terminal = process.platform !== 'win32'
  if (type === 'lldb') return { ...base, type, env, sourceLanguages: ['rust'], breakpointMode: 'file', terminal: terminal ? 'integrated' : 'console' }
  const environment = Object.entries(env).map(([name, value]) => ({ name, value }))
  if (type === 'cppvsdbg') return { ...base, type, environment, console: 'internalConsole' }
  return { ...base, type, environment, MIMode: 'gdb', externalConsole: false }
}

function nativeDebugger(): 'lldb' | 'cppvsdbg' | 'cppdbg' | null {
  const pref = vscode.workspace.getConfiguration('kubuno').get<string>('dev.debugger', 'auto')
  const lldb = !!vscode.extensions.getExtension('vadimcn.vscode-lldb')
  const cpp = !!vscode.extensions.getExtension('ms-vscode.cpptools')
  if (pref === 'lldb') return lldb ? 'lldb' : null
  if (pref === 'cppvsdbg' || pref === 'cppdbg') return cpp ? pref : null
  if (lldb) return 'lldb'
  if (cpp) return process.platform === 'win32' ? 'cppvsdbg' : 'cppdbg'
  return null
}

/** Polls the dev core until it answers, then opens `url` in the browser. */
function openWhenUp(url: string, origin: string, timeoutMs = 180_000): void {
  const end = Date.now() + timeoutMs
  const probe = (): void => {
    const req = http.get(origin, (res) => {
      res.resume()
      log(`dev core answers (${res.statusCode}): opening ${url}`)
      void vscode.env.openExternal(vscode.Uri.parse(url))
    })
    req.on('error', () => (Date.now() < end ? setTimeout(probe, 1000) : log(`dev core: no answer on ${origin}`)))
    req.setTimeout(2000, () => req.destroy())
  }
  probe()
}

/** Opens the module's page once a dev core session's core answers. */
const running = new Set<vscode.DebugSession>()

export function watchDevCoreSessions(): vscode.Disposable {
  const isDevCore = (s: vscode.DebugSession): boolean => typeof s.configuration.kubunoOrigin === 'string'
  return vscode.Disposable.from(
    vscode.debug.onDidStartDebugSession((s) => {
      if (isDevCore(s)) running.add(s)
      const url = s.configuration.kubunoOpen as string | undefined
      if (url) openWhenUp(url, String(s.configuration.kubunoOrigin))
    }),
    vscode.debug.onDidTerminateDebugSession(async (s) => {
      if (!isDevCore(s)) return
      running.delete(s)
      const n = await stopDevModules()
      if (n) log(`dev core stopped: ${n} module process(es) it left running were stopped`)
    }),
  )
}

/** The launch configurations offered in « Select and Start Debugging » (no resolution: `KubunoDebugProvider` does it once). */
export class KubunoDynamicConfigurations implements vscode.DebugConfigurationProvider {
  provideDebugConfigurations(): vscode.DebugConfiguration[] {
    return new KubunoDebugProvider().provideDebugConfigurations()
  }
}

export class KubunoDebugProvider implements vscode.DebugConfigurationProvider {
  provideDebugConfigurations(): vscode.DebugConfiguration[] {
    const all = findCheckouts()
    const m = all.find((c) => c.id !== 'core' && c.server)
    const id = m?.id ?? 'drive'
    // The native desktop apps of the running OS (Kubuno Desktop, Kubuno Documents, …), after the dev core ones.
    const desktop = all.flatMap((c) => desktopApps(c)).map((a) => ({ type: DEBUG_TYPE, request: 'launch', name: `Kubuno: ${a.bin} (desktop)`, target: 'desktop', module: a.id, app: a.bin }))
    return [
      { type: DEBUG_TYPE, request: 'launch', name: `Kubuno: dev core + ${id}`, target: 'core', module: id },
      { type: DEBUG_TYPE, request: 'launch', name: `Kubuno: ${id} web (browser)`, target: 'browser', module: id },
      ...desktop,
    ]
  }

  async resolveDebugConfiguration(_folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration): Promise<vscode.DebugConfiguration | null | undefined> {
    // VS Code chains the resolvers of a type: never touch a configuration another resolver already turned into
    // another debugger's (the browser one becomes `chrome`).
    if (config.type && config.type !== DEBUG_TYPE) return config
    if (!config.type && !config.request) {
      // F5 without a launch.json: the dev core with the first module.
      const first = this.provideDebugConfigurations()[0]
      Object.assign(config, first)
    }
    const all = findCheckouts()
    if (config.target === 'desktop') return resolveDesktop(config, all)
    const core = all.find((c) => c.id === 'core')
    const id = String(config.module ?? all.find((c) => c.id !== 'core' && c.server)?.id ?? 'drive')
    const m = all.find((c) => c.id === id)
    const port = Number(config.port ?? devPort())
    const url = `http://127.0.0.1:${port}/${id}`
    if (config.target === 'browser') {
      if (!m?.web) return void vscode.window.showErrorMessage(`Kubuno: no web/ for "${id}" in the workspace.`)
      const browser = vscode.workspace.getConfiguration('kubuno').get<string>('dev.browser', 'chrome')
      // Paths as the editor sees them: a breakpoint is set on the editor's path, and a checkout reached through a
      // symbolic link or a Windows junction (~/ws/drive → ~/src/drive, C:\build → E:\build) would otherwise be
      // resolved to its real path by the source maps, and the breakpoint would stay unbound.
      const web = m.editorWeb ?? m.web
      const hostWeb = core?.editorWeb ?? core?.web ?? null
      const origin = `http://127.0.0.1:${port}`
      // The module's build (web/dist) is served at /modules/<id>/ (entry-<hash>.js, chunks/…), the core's web host
      // build (core/web/dist) at the root (/assets, /shared…). Their source maps name the sources relative to the
      // compiled file (../../src/views/X.ts from chunks/), so mapping each compiled URL to its dist folder is enough
      // for every module and for the host. The most specific prefix comes first.
      const overrides: Record<string, string> = { [`${origin}/modules/${id}/*`]: `${path.join(web, 'dist')}/*` }
      if (hostWeb) overrides[`${origin}/*`] = `${path.join(hostWeb, 'dist')}/*`
      // js-debug uses an override only when the local file exists and matches what is served. The core serves a
      // module's entry renamed (entry.js → entry-<hash>.js) and its own shared chunks fail that check too; js-debug
      // then resolves the map's relative sources from « webRoot + URL path » (drive/web + /shared/ → drive/src/…, a
      // folder that does not exist). The same prefixes as URL paths make that fallback land in the right dist/.
      const pathMapping: Record<string, string> = { [`/modules/${id}/`]: `${path.join(web, 'dist')}${path.sep}` }
      if (hostWeb) pathMapping['/'] = `${path.join(hostWeb, 'dist')}${path.sep}`
      return {
        type: browser === 'edge' ? 'msedge' : 'chrome',
        request: 'launch',
        name: config.name,
        url,
        webRoot: web,
        sourceMaps: true,
        // `"trace": true` in the Kubuno configuration reaches js-debug (its log path is printed in the debug console).
        ...(config.trace ? { trace: config.trace } : {}),
        sourceMapPathOverrides: overrides,
        pathMapping,
      }
    }
    if (!core?.server) return void vscode.window.showErrorMessage('Kubuno: the workspace has no core checkout (core/server/Cargo.toml).')
    if (!m) return void vscode.window.showErrorMessage(`Kubuno: module "${id}" is not in the workspace.`)
    const type = nativeDebugger()
    if (!type) {
      const pick = await vscode.window.showErrorMessage('Kubuno: debugging the core needs CodeLLDB (or the C/C++ extension).', 'Install CodeLLDB')
      if (pick) await vscode.commands.executeCommand('workbench.extensions.installExtension', 'vadimcn.vscode-lldb')
      return undefined
    }
    const program = path.join(cargoOut(core.server), exe('kubuno-core'))
    // One dev core at a time: a running one would restart its module, which holds its port and (on Windows) keeps its
    // binary locked against the deploy step. Then stop what an earlier run left behind.
    for (const s of [...running]) await vscode.debug.stopDebugging(s)
    await stopDevModules()
    const env = devCoreEnv(core)
    const cwd = devCoreDir()
    const open = vscode.workspace.getConfiguration('kubuno').get<boolean>('dev.openBrowser', true) && config.openBrowser !== false
    log(`dev core: ${program} on port ${port} with ${id}, folder ${cwd}, debugger ${type}, database ${env.KV__DATABASE__URL ? env.KV__DATABASE__URL.replace(/:[^:@/]*@/, ':***@') : `SQLite in ${env.KV__DATABASE__PATH}`}`)
    // `kubunoOpen` is read back when the session starts, after the pre-launch build (`watchDevCoreSessions`).
    const base = { kubunoOpen: open ? url : undefined, kubunoOrigin: `http://127.0.0.1:${port}/`, name: config.name, request: 'launch', program, cwd, preLaunchTask: config.preLaunchTask ?? `${TASK_TYPE}: prepare dev core (${id})`, noDebug: config.noDebug }
    // Breakpoints matched by file name: the binary records the real paths of the sources, while the editor may show
    // them through a symbolic link or a Windows junction (~/ws/core → ~/src/core, C:\build → E:\build), and LLDB then
    // leaves full-path breakpoints unresolved.
    if (type === 'lldb') return { ...base, type, args: [], env, sourceLanguages: ['rust'], console: 'internalConsole', breakpointMode: 'file' }
    const environment = Object.entries(env).map(([name, value]) => ({ name, value }))
    if (type === 'cppvsdbg') return { ...base, type, args: [], environment, console: 'integratedTerminal' }
    return { ...base, type, args: [], environment, MIMode: 'gdb', externalConsole: false }
  }
}
