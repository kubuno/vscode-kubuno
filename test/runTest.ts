/**
 * Runs the integration tests in a real VS Code (downloaded by `@vscode/test-electron`), on a throw-away
 * workspace made of copies of the core's and drive's views (nothing in those repositories is touched).
 *
 * Environment: `KUBUNO_SRC` (the folder holding `core/` and `drive/`, default: this repository's parent),
 * `KUBUNO_VIEWS_LS` (a `kubuno-views-ls` executable to use), `KUBUNO_DEMO=<seconds>` (keep the window open
 * with the designer, Toolbox and Properties shown, for screenshots), `KUBUNO_VSCODE` (a VS Code executable
 * instead of a downloaded one).
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { runTests } from '@vscode/test-electron'

function copy(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.cpSync(from, to, { recursive: true })
}

function makeWorkspace(src: string): string {
  // The real layout, in miniature: `core/` (web + server) and the `drive/` module, so the Projects view, the
  // project detection and the registries work exactly as on a checkout.
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'kubuno-vscode-ws-'))
  const core = path.join(src, 'core', 'web')
  const drive = path.join(src, 'drive')
  const registry = path.join(core, 'packages', 'ui', 'kbview-registry.web.json')
  copy(registry, path.join(ws, 'core', 'web', 'packages', 'ui', 'kbview-registry.web.json'))
  copy(path.join(core, 'kubuno.views.json'), path.join(ws, 'core', 'web', 'kubuno.views.json'))
  copy(path.join(core, 'src', 'core'), path.join(ws, 'core', 'web', 'src', 'core'))
  fs.mkdirSync(path.join(ws, 'core', 'server'), { recursive: true })
  fs.mkdirSync(path.join(ws, 'core', 'desktop'), { recursive: true })
  copy(path.join(drive, 'module.toml'), path.join(ws, 'drive', 'module.toml'))
  copy(path.join(drive, 'web', 'kubuno.views.json'), path.join(ws, 'drive', 'web', 'kubuno.views.json'))
  copy(path.join(drive, 'web', 'src'), path.join(ws, 'drive', 'web', 'src'))
  copy(registry, path.join(ws, 'drive', 'web', 'node_modules', '@kubuno', 'ui', 'kbview-registry.web.json'))
  fs.mkdirSync(path.join(ws, 'drive', 'server'), { recursive: true })
  const settings: Record<string, unknown> = {
    'workbench.startupEditor': 'none',
    'security.workspace.trust.enabled': false,
    'window.restoreWindows': 'none',
    'window.newWindowDimensions': 'maximized',
    'chat.disableAIFeatures': true,
    'workbench.secondarySideBar.defaultVisibility': 'hidden',
    'typescript.validate.enable': false,
  }
  if (process.env.KUBUNO_VIEWS_LS) settings['kubuno.languageServer.path'] = process.env.KUBUNO_VIEWS_LS
  fs.mkdirSync(path.join(ws, '.vscode'))
  fs.writeFileSync(path.join(ws, '.vscode', 'settings.json'), JSON.stringify(settings, null, 2))
  return ws
}

async function main(): Promise<void> {
  const root = path.resolve(__dirname, '..', '..')
  const src = process.env.KUBUNO_SRC ?? path.resolve(root, '..')
  const ws = makeWorkspace(src)
  console.log(`workspace: ${ws}`)
  try {
    await runTests({
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, 'suite', 'index.js'),
      // An isolated profile: never the user's own settings, extensions or open windows.
      launchArgs: [ws, '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', `--user-data-dir=${path.join(ws, '..', path.basename(ws) + '-profile')}`],
      extensionTestsEnv: { KUBUNO_TEST_WS: ws, KUBUNO_DEMO: process.env.KUBUNO_DEMO ?? '', KUBUNO_DEMO_FILE: process.env.KUBUNO_DEMO_FILE ?? '' },
      ...(process.env.KUBUNO_VSCODE ? { vscodeExecutablePath: process.env.KUBUNO_VSCODE } : {}),
    })
  } catch (err) {
    console.error('tests failed', err)
    process.exitCode = 1
  } finally {
    if (!process.env.KUBUNO_KEEP_WS) {
      fs.rmSync(ws, { recursive: true, force: true })
      fs.rmSync(path.join(ws, '..', path.basename(ws) + '-profile'), { recursive: true, force: true, maxRetries: 5 })
    }
  }
}

void main()
