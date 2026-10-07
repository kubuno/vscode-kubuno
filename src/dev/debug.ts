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
import * as http from 'node:http'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { log } from '../log'
import { devCoreDir, devCoreEnv, devPort } from './devCore'
import { cargoOut, exe, TASK_TYPE } from './tasks'
import { findCheckouts } from './workspace'

export const DEBUG_TYPE = 'kubuno'

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
export function watchDevCoreSessions(): vscode.Disposable {
  return vscode.debug.onDidStartDebugSession((s) => {
    const url = s.configuration.kubunoOpen as string | undefined
    if (url) openWhenUp(url, String(s.configuration.kubunoOrigin))
  })
}

export class KubunoDebugProvider implements vscode.DebugConfigurationProvider {
  provideDebugConfigurations(): vscode.DebugConfiguration[] {
    const m = findCheckouts().find((c) => c.id !== 'core' && c.server)
    const id = m?.id ?? 'drive'
    return [
      { type: DEBUG_TYPE, request: 'launch', name: `Kubuno: dev core + ${id}`, target: 'core', module: id },
      { type: DEBUG_TYPE, request: 'launch', name: `Kubuno: ${id} web (browser)`, target: 'browser', module: id },
    ]
  }

  async resolveDebugConfiguration(_folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration): Promise<vscode.DebugConfiguration | null | undefined> {
    if (!config.type && !config.request) {
      // F5 without a launch.json: the dev core with the first module.
      const first = this.provideDebugConfigurations()[0]
      Object.assign(config, first)
    }
    const all = findCheckouts()
    const core = all.find((c) => c.id === 'core')
    const id = String(config.module ?? all.find((c) => c.id !== 'core' && c.server)?.id ?? 'drive')
    const m = all.find((c) => c.id === id)
    const port = Number(config.port ?? devPort())
    const url = `http://127.0.0.1:${port}/${id}`
    if (config.target === 'browser') {
      if (!m?.web) return void vscode.window.showErrorMessage(`Kubuno: no web/ for "${id}" in the workspace.`)
      const browser = vscode.workspace.getConfiguration('kubuno').get<string>('dev.browser', 'chrome')
      return {
        type: browser === 'edge' ? 'msedge' : 'chrome',
        request: 'launch',
        name: config.name,
        url,
        webRoot: m.web,
        sourceMaps: true,
        // The core serves the module's build at /modules/<id>/frontend/; the source maps point into web/src.
        sourceMapPathOverrides: { [`http://127.0.0.1:${port}/modules/${id}/frontend/*`]: `${path.join(m.web, 'dist')}/*` },
        resolveSourceMapLocations: [`${m.web}/**`, '!**/node_modules/**'],
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
    const env = devCoreEnv(core)
    const cwd = devCoreDir()
    const open = vscode.workspace.getConfiguration('kubuno').get<boolean>('dev.openBrowser', true) && config.openBrowser !== false
    log(`dev core: ${program} on port ${port} with ${id}, folder ${cwd}, debugger ${type}, database ${env.KV__DATABASE__URL.replace(/:[^:@/]*@/, ':***@')}`)
    // `kubunoOpen` is read back when the session starts, after the pre-launch build (`watchDevCoreSessions`).
    const base = { kubunoOpen: open ? url : undefined, kubunoOrigin: `http://127.0.0.1:${port}/`, name: config.name, request: 'launch', program, cwd, preLaunchTask: config.preLaunchTask ?? `${TASK_TYPE}: prepare dev core (${id})`, noDebug: config.noDebug }
    if (type === 'lldb') return { ...base, type, args: [], env, sourceLanguages: ['rust'], console: 'internalConsole' }
    const environment = Object.entries(env).map(([name, value]) => ({ name, value }))
    if (type === 'cppvsdbg') return { ...base, type, args: [], environment, console: 'integratedTerminal' }
    return { ...base, type, args: [], environment, MIMode: 'gdb', externalConsole: false }
  }
}
