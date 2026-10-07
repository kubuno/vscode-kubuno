/**
 * The Kubuno « Projects » view: what Visual Studio shows through the solution (`Kubuno.slnx`, `.rsproj`, `.esproj`)
 * built from the workspace instead — VS Code has no project system. Modules (a folder with a `module.toml`, and
 * the core) → platforms (`web`, `server`, `desktop`, `mobile`, `common`) → for a web platform with a
 * `kubuno.views.json`, its views and user controls by folder, opened in the designer.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { VIEW_TYPE } from '../designer/designerProvider'
import { walkFiles } from './webProject'

const PLATFORMS: Record<string, { label: string; icon: string }> = {
  web: { label: 'Web', icon: 'globe' },
  server: { label: 'Server', icon: 'server' },
  desktop: { label: 'Desktop', icon: 'device-desktop' },
  mobile: { label: 'Mobile', icon: 'device-mobile' },
  common: { label: 'Common', icon: 'package' },
}

type Node =
  | { kind: 'module'; dir: string; name: string }
  | { kind: 'platform'; dir: string; platform: string; module: string }
  | { kind: 'folder'; dir: string; root: string }
  | { kind: 'view'; file: string }

function isModule(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'module.toml')) || (fs.existsSync(path.join(dir, 'server')) && fs.existsSync(path.join(dir, 'web')))
}

export class KubunoExplorer implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>()
  readonly onDidChangeTreeData = this.changed.event
  private viewCache = new Map<string, string[]>()
  /** One object per node, so `TreeView.reveal` finds the elements it was given (it compares by identity). */
  private readonly nodes = new Map<string, Node>()

  private intern(n: Node): Node {
    const key = n.kind === 'view' ? `view:${n.file}` : `${n.kind}:${n.dir}`
    let v = this.nodes.get(key)
    if (!v) {
      v = n
      this.nodes.set(key, v)
    }
    return v
  }

  getParent(n: Node): Node | undefined {
    switch (n.kind) {
      case 'module':
        return undefined
      case 'platform': {
        const dir = path.dirname(n.dir)
        return this.intern({ kind: 'module', dir, name: path.basename(dir) })
      }
      case 'folder':
      case 'view': {
        const own = n.kind === 'view' ? n.file : n.dir
        const parent = path.dirname(own)
        const root = n.kind === 'folder' ? n.root : this.webRootOf(n.file)
        if (!root) return undefined
        if (parent === path.join(root, 'src')) {
          const mod = path.dirname(root)
          return this.intern({ kind: 'platform', dir: root, platform: path.basename(root), module: path.basename(mod) })
        }
        return this.intern({ kind: 'folder', dir: parent, root })
      }
    }
  }

  private webRootOf(file: string): string | null {
    for (let d = path.dirname(file); ; d = path.dirname(d)) {
      if (fs.existsSync(path.join(d, 'kubuno.views.json'))) return d
      if (path.dirname(d) === d) return null
    }
  }

  /** The node of a view file (for `TreeView.reveal`). */
  viewNode(file: string): Node {
    return this.intern({ kind: 'view', file })
  }

  refresh(): void {
    this.viewCache.clear()
    this.nodes.clear()
    this.changed.fire(undefined)
  }

  getTreeItem(n: Node): vscode.TreeItem {
    switch (n.kind) {
      case 'module': {
        const t = new vscode.TreeItem(n.name, vscode.TreeItemCollapsibleState.Collapsed)
        t.id = `module:${n.dir}`
        t.iconPath = new vscode.ThemeIcon(n.name === 'core' ? 'symbol-namespace' : 'extensions')
        t.contextValue = 'kubunoModule'
        t.resourceUri = vscode.Uri.file(n.dir)
        t.description = moduleVersion(n.dir)
        return t
      }
      case 'platform': {
        const p = PLATFORMS[n.platform]
        const hasViews = n.platform === 'web' && fs.existsSync(path.join(n.dir, 'kubuno.views.json'))
        const t = new vscode.TreeItem(p.label, hasViews ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None)
        t.iconPath = new vscode.ThemeIcon(p.icon)
        t.description = hasViews ? `${this.views(n.dir).length} views` : path.basename(n.dir)
        t.tooltip = n.dir
        if (!hasViews) t.command = { command: 'revealInExplorer', title: 'Reveal', arguments: [vscode.Uri.file(n.dir)] }
        return t
      }
      case 'folder': {
        const t = new vscode.TreeItem(path.basename(n.dir), vscode.TreeItemCollapsibleState.Collapsed)
        t.iconPath = vscode.ThemeIcon.Folder
        t.resourceUri = vscode.Uri.file(n.dir)
        return t
      }
      case 'view': {
        const uri = vscode.Uri.file(n.file)
        const t = new vscode.TreeItem(path.basename(n.file), vscode.TreeItemCollapsibleState.None)
        t.resourceUri = uri
        t.iconPath = new vscode.ThemeIcon(n.file.endsWith('.kbcontrol') ? 'symbol-class' : 'window')
        t.command = { command: 'vscode.openWith', title: 'Open in the designer', arguments: [uri, VIEW_TYPE] }
        t.contextValue = 'kubunoView'
        return t
      }
    }
  }

  private views(webDir: string): string[] {
    let v = this.viewCache.get(webDir)
    if (!v) {
      v = walkFiles(path.join(webDir, 'src'), ['.kbview', '.kbcontrol']).sort()
      this.viewCache.set(webDir, v)
    }
    return v
  }

  getChildren(n?: Node): Node[] {
    return this.children(n).map((c) => this.intern(c))
  }

  private children(n?: Node): Node[] {
    if (!n) {
      const out: Node[] = []
      for (const f of vscode.workspace.workspaceFolders ?? []) {
        const dir = f.uri.fsPath
        if (isModule(dir)) {
          out.push({ kind: 'module', dir, name: path.basename(dir) })
          continue
        }
        let entries: fs.Dirent[] = []
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true })
        } catch {
          /* unreadable workspace folder */
        }
        for (const e of entries) {
          if (e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.') && isModule(path.join(dir, e.name))) {
            out.push({ kind: 'module', dir: path.join(dir, e.name), name: e.name })
          }
        }
      }
      return out.sort((a, b) => ((a as { name: string }).name === 'core' ? -1 : (b as { name: string }).name === 'core' ? 1 : (a as { name: string }).name.localeCompare((b as { name: string }).name)))
    }
    if (n.kind === 'module') {
      return Object.keys(PLATFORMS)
        .filter((p) => fs.existsSync(path.join(n.dir, p)))
        .map((p) => ({ kind: 'platform', dir: path.join(n.dir, p), platform: p, module: n.name }))
    }
    if (n.kind === 'platform') return this.folderChildren(path.join(n.dir, 'src'), n.dir)
    if (n.kind === 'folder') return this.folderChildren(n.dir, n.root)
    return []
  }

  /** The sub-folders holding views (directly or deeper) and the views of `dir`. */
  private folderChildren(dir: string, webDir: string): Node[] {
    const all = this.views(webDir)
    const folders = new Set<string>()
    const files: Node[] = []
    for (const f of all) {
      if (!f.startsWith(dir + path.sep)) continue
      const rest = f.slice(dir.length + 1)
      const k = rest.indexOf(path.sep)
      if (k < 0) files.push({ kind: 'view', file: f })
      else folders.add(path.join(dir, rest.slice(0, k)))
    }
    return [...[...folders].sort().map((d): Node => ({ kind: 'folder', dir: d, root: webDir })), ...files]
  }
}

function moduleVersion(dir: string): string | undefined {
  try {
    const t = fs.readFileSync(path.join(dir, 'module.toml'), 'utf8')
    return /^version\s*=\s*"([^"]+)"/m.exec(t)?.[1]
  } catch {
    return undefined
  }
}
