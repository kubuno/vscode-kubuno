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
  /**
   * `web/` as the editor sees it (through the workspace's links, when the checkout is reached through a symbolic
   * link or a junction); `web` is the real path. Debuggers match breakpoints against the editor's path.
   */
  editorWeb: string | null
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

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

function checkoutAt(linked: string, folder: vscode.WorkspaceFolder): Checkout | null {
  // The real path: Vite (rolldown) resolves its root through links, and a checkout reached through a Windows
  // junction or a symbolic link (C:\build → E:\build) then fails with "fileName … must be neither absolute nor
  // relative" for index.html. Every task runs in the real folder.
  let dir = linked
  try {
    dir = fs.realpathSync.native(linked)
  } catch {
    /* keep the path as given */
  }
  const cargo = read(path.join(dir, 'server', 'Cargo.toml'))
  const server = cargo !== null ? path.join(dir, 'server') : null
  const web = fs.existsSync(path.join(dir, 'web', 'package.json')) ? path.join(dir, 'web') : null
  const editorWeb = web ? path.join(linked, 'web') : null
  if (cargo !== null && /^\s*name\s*=\s*"kubuno-core"/m.test(cargo)) return { id: 'core', dir, folder, server, web, entrypoint: null, editorWeb }
  const manifest = read(path.join(dir, 'module.toml'))
  if (manifest === null || (server === null && web === null)) return null
  const id = tomlValue(manifest, 'module', 'id') ?? path.basename(dir)
  return { id, dir, folder, server, web, entrypoint: tomlValue(manifest, 'process', 'entrypoint'), editorWeb }
}

/** Every checkout of the workspace (a folder itself, then its direct children). */
export function findCheckouts(): Checkout[] {
  const out: Checkout[] = []
  const seen = new Set<string>()
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const root = folder.uri.fsPath
    const dirs = [root]
    try {
      for (const e of fs.readdirSync(root, { withFileTypes: true })) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue
        const full = path.join(root, e.name)
        // A symbolic link or a Windows junction to a checkout counts: `isDirectory()` of the entry does not
        // follow links, `statSync` does.
        if (e.isDirectory() || (e.isSymbolicLink() && isDir(full))) dirs.push(full)
      }
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
