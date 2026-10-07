/**
 * The Kubuno checkouts of the workspace, for the build / run / debug tooling: the core (a folder whose
 * `server/Cargo.toml` is the `kubuno-core` package) and the modules (a folder with a `module.toml` and a
 * `server/Cargo.toml`). A workspace folder can be one checkout or hold several side by side (`~/projects/kubuno`).
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'

export interface Checkout {
  /** `core` or the module id. */
  id: string
  dir: string
  folder: vscode.WorkspaceFolder
  /** `server/` (a Cargo workspace or crate). */
  server: string | null
  /** `web/` with a `package.json`. */
  web: string | null
  /** Module only: the `[process].entrypoint` of `module.toml`. */
  entrypoint: string | null
}

function read(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** `key = "value"` of a TOML section (enough for `module.toml`'s flat fields). */
export function tomlValue(text: string, section: string, key: string): string | null {
  const start = text.search(new RegExp(`^\\[${section.replace('.', '\\.')}\\]\\s*$`, 'm'))
  if (start < 0) return null
  const body = text.slice(start).split(/\r?\n/).slice(1)
  for (const line of body) {
    if (/^\s*\[/.test(line)) break
    const m = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`).exec(line)
    if (m) return m[1]
  }
  return null
}

function checkoutAt(dir: string, folder: vscode.WorkspaceFolder): Checkout | null {
  const cargo = read(path.join(dir, 'server', 'Cargo.toml'))
  const server = cargo !== null ? path.join(dir, 'server') : null
  const web = fs.existsSync(path.join(dir, 'web', 'package.json')) ? path.join(dir, 'web') : null
  if (cargo !== null && /^\s*name\s*=\s*"kubuno-core"/m.test(cargo)) return { id: 'core', dir, folder, server, web, entrypoint: null }
  const manifest = read(path.join(dir, 'module.toml'))
  if (manifest === null || (server === null && web === null)) return null
  const id = tomlValue(manifest, 'module', 'id') ?? path.basename(dir)
  return { id, dir, folder, server, web, entrypoint: tomlValue(manifest, 'process', 'entrypoint') }
}

/** Every checkout of the workspace (a folder itself, then its direct children). */
export function findCheckouts(): Checkout[] {
  const out: Checkout[] = []
  const seen = new Set<string>()
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const root = folder.uri.fsPath
    const dirs = [root]
    try {
      for (const e of fs.readdirSync(root, { withFileTypes: true })) if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') dirs.push(path.join(root, e.name))
    } catch {
      /* unreadable folder */
    }
    for (const d of dirs) {
      const c = checkoutAt(d, folder)
      if (c && !seen.has(c.id)) {
        seen.add(c.id)
        out.push(c)
      }
    }
  }
  return out
}
