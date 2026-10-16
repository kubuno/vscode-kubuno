/**
 * Web view projects: which project a `.kbview` / `.kbcontrol` belongs to, its registries and its user controls.
 *
 * The rule is the language server's (`kubuno-views-ls` `web/mod.rs`, vskubuno docs/WEB-VIEWS.md §16): walking up
 * from the view's folder, the first marker decides - `kubuno.views.json` (its `target`, web when absent), a
 * `package.json` depending on `@kubuno/views-compiler` or a `*.esproj` → web, a `Cargo.toml` naming
 * `kubuno-desktop` → desktop; nothing → desktop.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

export type ViewTarget = 'web' | 'desktop'

export interface ViewsConfig {
  target?: string
  hostRegistry?: string
  registries?: string[]
  sources?: string[]
  design?: { entry?: string; themes?: string }
}

export interface WebProject {
  target: ViewTarget
  /** The marker's folder (`core/web`, `drive/web`). */
  root: string
  config: ViewsConfig
}

export interface RegistryComponent {
  name: string
  family?: string
  category?: string | null
  toolbox_category?: string | null
  icon?: string
  doc?: string
  doc_fr?: string
  children?: string
  allowed_children?: string[]
  layout_kind?: string | null
  properties?: RegistryProperty[]
  events?: RegistryEvent[]
  default_event?: string | null
  default_property?: string | null
  non_visual?: boolean
  browsable?: boolean
  origin?: string
  [k: string]: unknown
}

export interface RegistryProperty {
  name: string
  kind: string | { Enum: string[] } | Record<string, unknown>
  default?: string | null
  doc?: string
  doc_fr?: string
  category?: string | null
  browsable?: boolean
  bindable?: boolean
  root_only?: boolean
  design_time?: boolean
  editor?: string | null
}

export interface RegistryEvent {
  name: string
  display_name?: string
  doc?: string
  doc_fr?: string
  category?: string | null
  args_type?: string
  browsable?: boolean
  root_only?: boolean
}

export interface Registry {
  /** The host registry's raw text (sent to the design page as `setHostRegistry`). */
  hostText: string | null
  /** Project registries (`registries` of `kubuno.views.json`) and user controls. */
  projectComponents: RegistryComponent[]
  /** Every component, host first. */
  components: RegistryComponent[]
  userControls: { name: string; module: string; file: string }[]
}

const readJson = <T>(file: string): T | null => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as T
  } catch {
    return null
  }
}

/** The project of a view file, or null when no marker is found (a desktop view by the rule above). */
export function findProject(viewFile: string): WebProject | null {
  let dir = path.dirname(viewFile)
  for (;;) {
    const cfg = path.join(dir, 'kubuno.views.json')
    if (fs.existsSync(cfg)) {
      const config = readJson<ViewsConfig>(cfg) ?? {}
      return { target: config.target === 'desktop' ? 'desktop' : 'web', root: dir, config }
    }
    const pkg = readJson<{ dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>(path.join(dir, 'package.json'))
    if (pkg && (pkg.dependencies?.['@kubuno/views-compiler'] || pkg.devDependencies?.['@kubuno/views-compiler'])) {
      return { target: 'web', root: dir, config: {} }
    }
    try {
      if (fs.readdirSync(dir).some((f) => f.endsWith('.esproj'))) return { target: 'web', root: dir, config: {} }
    } catch {
      /* unreadable folder: keep walking up */
    }
    const cargo = path.join(dir, 'Cargo.toml')
    if (fs.existsSync(cargo) && /kubuno-desktop/.test(fs.readFileSync(cargo, 'utf8'))) {
      return { target: 'desktop', root: dir, config: {} }
    }
    const up = path.dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

/** The host registry file: `hostRegistry` of the config, else `node_modules/@kubuno/ui/kbview-registry.web.json` upwards. */
export function hostRegistryFile(p: WebProject): string | null {
  if (p.config.hostRegistry) {
    const f = path.resolve(p.root, p.config.hostRegistry)
    if (fs.existsSync(f)) return f
  }
  let dir = p.root
  for (;;) {
    const f = path.join(dir, 'node_modules', '@kubuno', 'ui', 'kbview-registry.web.json')
    if (fs.existsSync(f)) return f
    const up = path.dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.kubuno', 'target', 'obj', 'bin'])

/** Every file with one of `exts` under `dir` (build and dependency folders skipped). */
export function walkFiles(dir: string, exts: readonly string[], out: string[] = [], depth = 0): string[] {
  if (depth > 12) return out
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walkFiles(path.join(dir, e.name), exts, out, depth + 1)
    } else if (exts.some((x) => e.name.endsWith(x))) {
      out.push(path.join(dir, e.name))
    }
  }
  return out
}

const posix = (p: string): string => p.split(path.sep).join('/')

/** Reads the registries of a web project from disk (the fallback when the language server is not running). */
export function loadRegistryFromDisk(p: WebProject): Registry {
  const hostFile = hostRegistryFile(p)
  const hostText = hostFile ? fs.readFileSync(hostFile, 'utf8') : null
  const host = hostText ? (JSON.parse(hostText.replace(/^﻿/, '')) as { components?: RegistryComponent[] }) : null
  const projectComponents: RegistryComponent[] = []
  for (const r of p.config.registries ?? []) {
    const json = readJson<{ components?: RegistryComponent[] }>(path.resolve(p.root, r))
    for (const c of json?.components ?? []) projectComponents.push({ ...c, origin: 'project' })
  }
  const userControls = listUserControls(p)
  return {
    hostText,
    projectComponents,
    components: [...(host?.components ?? []), ...projectComponents],
    userControls,
  }
}

/** One user control per `.kbcontrol` of the project's `sources` (its name is the file stem). */
export function listUserControls(p: WebProject): { name: string; module: string; file: string }[] {
  const out: { name: string; module: string; file: string }[] = []
  for (const s of p.config.sources ?? ['src']) {
    for (const f of walkFiles(path.resolve(p.root, s), ['.kbcontrol'])) {
      const rel = posix(path.relative(p.root, f)).replace(/\.kbcontrol$/, '')
      out.push({ name: path.basename(f, '.kbcontrol'), module: `/${rel}`, file: f })
    }
  }
  return out
}

/** The code-behind beside a view (`X.ts` / `X.tsx` / `X.kbcontrol.ts`), or null. */
export function codeBehindOf(viewFile: string): string | null {
  const dir = path.dirname(viewFile)
  const ext = path.extname(viewFile)
  const stem = path.basename(viewFile, ext)
  for (const c of [`${stem}.ts`, `${stem}.tsx`, `${stem}${ext}.ts`]) {
    const f = path.join(dir, c)
    if (fs.existsSync(f)) return f
  }
  return null
}

/** The class of a code-behind that extends `ViewBase` (`export class WaffleMenu extends ViewBase`). */
export function codeBehindClass(tsText: string): string | null {
  const m = /export\s+(?:default\s+)?class\s+([A-Za-z_$][\w$]*)\s+extends\s+ViewBase\b/.exec(tsText)
  return m ? m[1] : null
}

export function designDataOf(viewFile: string): unknown {
  return readJson(`${viewFile}.design.json`)
}

export function relativeToRoot(p: WebProject, file: string): string {
  return posix(path.relative(p.root, file))
}
