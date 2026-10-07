/**
 * The dev core: the workspace's own `kubuno-core` build, run (or debugged) with one module, on its own port and
 * data folder — never the installed service, its database or its folders.
 *
 * Layout (`kubuno.dev.folder`, default `<extension global storage>/dev-core-<port>`):
 *
 *     modules/<id>/{module.toml, kubuno-<id>[.exe], frontend/}   ← « prepare dev core » deploys the module here
 *     modules-store/ modules-config/ modules-data/ files/ logs/ db/ config/ cache/ run/ backups/
 *     dev-secrets.json                                            ← internal secret + JWT secret, generated once
 *
 * The core reads everything from `KV__…` / `KUBUNO_PATHS_…` variables (core `config/settings.rs`,
 * `kubuno-paths`), the same on every OS. The database is `kubuno.dev.databaseUrl` (a throw-away PostgreSQL,
 * MySQL or SQLite database), SQLite in `db/` by default.
 */
import * as crypto from 'node:crypto'
import * as os from 'node:os'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { cargoOut, exe } from './tasks'
import type { Checkout } from './workspace'

let storage: string | null = null

export function initDevCore(context: vscode.ExtensionContext): void {
  storage = context.globalStorageUri.fsPath
}

export function devPort(): number {
  return vscode.workspace.getConfiguration('kubuno').get<number>('dev.port', 18680)
}

export function devCoreDir(): string {
  const configured = vscode.workspace.getConfiguration('kubuno').get<string>('dev.folder')?.trim()
  if (configured) return configured
  return path.join(storage ?? path.join(os.tmpdir(), 'kubuno-vscode'), `dev-core-${devPort()}`)
}

const SUBDIRS = ['modules', 'modules-store', 'modules-config', 'modules-data', 'files', 'logs', 'db', 'config', 'cache', 'run', 'backups', 'themes']

function secrets(dir: string): { internal: string; jwt: string } {
  const file = path.join(dir, 'dev-secrets.json')
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as { internal: string; jwt: string }
  } catch {
    // Non-numeric (the `KV__` loader parses numbers), at least 32 bytes (the core refuses shorter secrets).
    const s = { internal: `kubunodev_${crypto.randomBytes(32).toString('hex')}`, jwt: `kubunodev_${crypto.randomBytes(32).toString('hex')}` }
    fs.writeFileSync(file, JSON.stringify(s, null, 2), { mode: 0o600 })
    return s
  }
}

/** Creates the folders and returns the core's environment. */
export function devCoreEnv(core: Checkout): Record<string, string> {
  const dir = devCoreDir()
  for (const d of SUBDIRS) fs.mkdirSync(path.join(dir, d), { recursive: true })
  const s = secrets(dir)
  const cfg = vscode.workspace.getConfiguration('kubuno')
  const db = cfg.get<string>('dev.databaseUrl')?.trim() || `sqlite://${path.join(dir, 'db').replace(/\\/g, '/')}`
  const p = (sub: string): string => path.join(dir, sub)
  const env: Record<string, string> = {
    KV__SERVER__HOST: '127.0.0.1',
    KV__SERVER__PORT: String(devPort()),
    KV__SERVER__INTERNAL_SECRET: s.internal,
    KV__AUTH__JWT_SECRET: s.jwt,
    KV__DATABASE__URL: db,
    KV__DATABASE__PATH: p('db'),
    KV__SERVER__FRONTEND_DIST: path.join(core.dir, 'web', 'dist'),
    KV__SERVER__MODULES_DIR: p('modules'),
    KV__SERVER__MODULES_INSTALL_DIR: p('modules-store'),
    KV__SERVER__MODULES_CONFIG_DIR: p('modules-config'),
    KV__SERVER__MODULES_DATA_DIR: p('modules-data'),
    KV__SERVER__THEMES_DIR: fs.existsSync(path.join(core.dir, 'web', 'themes')) ? path.join(core.dir, 'web', 'themes') : p('themes'),
    KV__STORAGE__LOCAL_PATH: p('files'),
    KV__LOGGING__LOG_DIR: p('logs'),
    KUBUNO_PATHS_MODE: 'user',
    KUBUNO_PATHS_CONFIG_DIR: p('config'),
    KUBUNO_PATHS_STATE_DIR: dir,
    KUBUNO_PATHS_DATA_DIR: dir,
    KUBUNO_PATHS_LOG_DIR: p('logs'),
    KUBUNO_PATHS_CACHE_DIR: p('cache'),
    KUBUNO_PATHS_RUNTIME_DIR: p('run'),
    KUBUNO_PATHS_BACKUP_DIR: p('backups'),
    KUBUNO_PATHS_MODULES_STORE: p('modules-store'),
    KUBUNO_PATHS_MODULES_CONFIG_DIR: p('modules-config'),
    KUBUNO_PATHS_MODULES_DATA_DIR: p('modules-data'),
    KUBUNO_DATA_KEY_FILE: path.join(dir, 'data.key'),
    KUBUNO_INITIAL_PASSWORD_FILE: path.join(dir, 'initial-admin-password'),
    RUST_LOG: cfg.get<string>('dev.rustLog') || 'info',
  }
  const admin = cfg.get<string>('dev.adminPassword')?.trim()
  if (admin) env.KUBUNO_ADMIN_PASSWORD = admin
  return env
}

function copyDir(from: string, to: string): void {
  fs.rmSync(to, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.cpSync(from, to, { recursive: true })
}

/** Deploys a module's build into the dev core (`module.toml`, its server binary, `web/dist` as `frontend/`). */
export async function deployModule(m: Checkout, dir: string, write: (s: string) => void): Promise<number> {
  write(`\x1b[1m> deploy ${m.id} to ${dir}\x1b[0m\r\n`)
  if (!m.server || !m.entrypoint) {
    write(`\x1b[31m${m.id}: module.toml has no [process].entrypoint or no server/\x1b[0m\r\n`)
    return 1
  }
  const bin = path.join(cargoOut(m.server), exe(m.entrypoint))
  if (!fs.existsSync(bin)) {
    write(`\x1b[31m${bin} is missing (cargo build first)\x1b[0m\r\n`)
    return 1
  }
  const target = path.join(dir, 'modules', m.id)
  fs.mkdirSync(target, { recursive: true })
  fs.copyFileSync(path.join(m.dir, 'module.toml'), path.join(target, 'module.toml'))
  // A running module keeps its binary locked on Windows: copy beside, then rename over it.
  const dest = path.join(target, exe(m.entrypoint))
  fs.copyFileSync(bin, dest + '.new')
  fs.renameSync(dest + '.new', dest)
  if (process.platform !== 'win32') fs.chmodSync(dest, 0o755)
  if (m.web && fs.existsSync(path.join(m.web, 'dist'))) copyDir(path.join(m.web, 'dist'), path.join(target, 'frontend'))
  write(`deployed ${dest}${m.web ? ' and its frontend' : ''}\r\n`)
  return 0
}
