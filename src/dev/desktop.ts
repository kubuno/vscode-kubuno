/**
 * The native desktop apps of a Kubuno checkout: `<checkout>/desktop/` is one Cargo workspace for every OS, laid out
 * `common/` (portable) + `windows/` / `linux/` / `macos/` (what each OS does differently, with its entry points).
 * The apps of the running OS are the binaries of the workspace members under its folder (Kubuno Desktop
 * `kubuno-desktop`, Kubuno Documents `kubuno-documents`, Drive `drive`, …); the framework's tools (`*-tool`,
 * the views language server `*-ls`) are left out.
 *
 * For each app the extension contributes a build task (`<id>: desktop build <bin>`, `cargo build -p <package>` in
 * the desktop workspace) and a launch configuration (`Kubuno: <bin> (desktop)`, the debug build under CodeLLDB /
 * cppvsdbg / gdb with that task as pre-launch task). Kubuno Desktop is single-instance per user session: a debug
 * run is a developer instance (`--dev-instance vscode`), and every run uses a sandboxed profile
 * (`KUBUNO_SANDBOX_DIR`) unless the configuration says `"sandbox": false`.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Checkout } from './workspace'

export type DesktopOs = 'windows' | 'linux' | 'macos'

export interface DesktopApp {
  /** The checkout id (`core`, `office`, `drive`, …). */
  id: string
  /** The desktop Cargo workspace (`<checkout>/desktop`). */
  workspace: string
  /** The Cargo package (`kubuno-desktop-shell`). */
  pkg: string
  /** The binary (`kubuno-desktop`), without `.exe`. */
  bin: string
  os: DesktopOs
}

/** The desktop folder of the running OS. */
export function desktopOs(platform: NodeJS.Platform = process.platform): DesktopOs {
  return platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : 'linux'
}

function read(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** `<checkout>/desktop` when it is a Cargo workspace. */
export function desktopWorkspace(dir: string): string | null {
  const ws = path.join(dir, 'desktop')
  const text = read(path.join(ws, 'Cargo.toml'))
  return text !== null && /^\s*\[workspace\]\s*$/m.test(text) ? ws : null
}

/** The `members = [ … ]` of a workspace manifest (comments dropped). */
export function workspaceMembers(manifest: string): string[] {
  const m = /^\s*members\s*=\s*\[([\s\S]*?)\]/m.exec(manifest)
  if (!m) return []
  return m[1]
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, ''))
    .flatMap((l) => [...l.matchAll(/"([^"]+)"/g)].map((x) => x[1].replace(/\\+/g, '/')))
}

/** The package name and the binaries of a member manifest (`[[bin]] name`, else the package when it has `src/main.rs`). */
export function memberBinaries(manifest: string, hasMain: boolean): { pkg: string | null; bins: string[] } {
  const pkgSection = /^\s*\[package\]\s*$([\s\S]*?)(?=^\s*\[)/m.exec(manifest + '\n[')
  const pkg = pkgSection ? (/^\s*name\s*=\s*"([^"]+)"/m.exec(pkgSection[1])?.[1] ?? null) : null
  const bins: string[] = []
  const re = /^\s*\[\[bin\]\]\s*$([\s\S]*?)(?=^\s*\[)/gm
  for (const b of (manifest + '\n[').matchAll(re)) {
    const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(b[1])?.[1]
    if (name) bins.push(name)
  }
  if (bins.length === 0 && hasMain && pkg) bins.push(pkg)
  return { pkg, bins }
}

/** Packages that are tools of the framework, not apps. */
const TOOL = /-(tool|ls)$/

/** The desktop apps of a checkout for an OS (the running one by default). */
export function desktopApps(c: Pick<Checkout, 'id' | 'dir'>, os: DesktopOs = desktopOs()): DesktopApp[] {
  const ws = desktopWorkspace(c.dir)
  if (!ws) return []
  const manifest = read(path.join(ws, 'Cargo.toml'))
  if (manifest === null) return []
  const out: DesktopApp[] = []
  for (const member of workspaceMembers(manifest)) {
    if (!member.startsWith(`${os}/`)) continue
    const dir = path.join(ws, ...member.split('/'))
    const text = read(path.join(dir, 'Cargo.toml'))
    if (text === null) continue
    const { pkg, bins } = memberBinaries(text, fs.existsSync(path.join(dir, 'src', 'main.rs')))
    if (!pkg || TOOL.test(pkg)) continue
    for (const bin of bins) out.push({ id: c.id, workspace: ws, pkg, bin, os })
  }
  return out
}

/** Where `cargo build` puts the binaries of a desktop workspace (`CARGO_TARGET_DIR` or `<desktop>/target`). */
export function desktopOut(workspace: string, env: NodeJS.ProcessEnv, release = false): string {
  return path.join(env.CARGO_TARGET_DIR ?? path.join(workspace, 'target'), release ? 'release' : 'debug')
}

/** The label of an app's build task (also the pre-launch task of its launch configuration, prefixed `kubuno: `). */
export const desktopTaskLabel = (a: Pick<DesktopApp, 'id' | 'bin'>): string => `${a.id}: desktop build ${a.bin}`

/** The arguments a debug run adds: Kubuno Desktop runs as a developer instance next to the session's own. */
export function desktopDefaultArgs(bin: string): string[] {
  return bin === 'kubuno-desktop' ? ['--dev-instance', 'vscode'] : []
}
