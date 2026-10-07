/**
 * Build tasks for Kubuno checkouts, contributed by a `TaskProvider` (no hand-written `tasks.json` per repository):
 * `cargo build` of the core and of each module's server, `npm ci` / build / typecheck of each web part, and
 * « prepare dev core », which builds the core and a module and lays out the dev core folder (see `devCore.ts`).
 *
 * Every task runs in a pseudoterminal driven by the extension (`CustomExecution`), not in a shell: the same code
 * on Linux, Windows and macOS (no `&&`, quoting or `.cmd` differences), and the output is rewritten so that every
 * file `cargo` and `tsc` print is absolute — the `kubuno-rustc` / `kubuno-tsc` problem matchers then put errors
 * in the Problems panel whatever folder the tool ran in.
 */
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { type Checkout, findCheckouts } from './workspace'
import { deployModule, devCoreDir } from './devCore'

export const TASK_TYPE = 'kubuno'

export interface KubunoTaskDefinition extends vscode.TaskDefinition {
  type: typeof TASK_TYPE
  /** `cargo-build`, `npm-ci`, `web-build`, `web-typecheck`, `prepare-dev-core`. */
  action: string
  /** `core` or a module id. */
  target: string
  release?: boolean
}

/** The environment of every build: the configured Cargo target folder and SQLx's offline cache. */
export function buildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, SQLX_OFFLINE: 'true', CARGO_TERM_COLOR: 'always', FORCE_COLOR: '1' }
  // VS Code's extension host sets NO_COLOR; with FORCE_COLOR every Node tool would warn about the pair.
  delete env.NO_COLOR
  const cfg = vscode.workspace.getConfiguration('kubuno')
  const target = cfg.get<string>('dev.cargoTargetDir')?.trim()
  if (target) env.CARGO_TARGET_DIR = target
  // Extra variables of the builds (e.g. CARGO_INCREMENTAL=0, CARGO_PROFILE_DEV_DEBUG=1 on a small disk).
  for (const [k, v] of Object.entries(cfg.get<Record<string, string>>('dev.buildEnv') ?? {})) env[k] = String(v)
  return env
}

/** Where `cargo build` puts the binaries of a Cargo workspace (`CARGO_TARGET_DIR` or `<server>/target`). */
export function cargoOut(server: string, release = false): string {
  const target = buildEnv().CARGO_TARGET_DIR ?? path.join(server, 'target')
  return path.join(target, release ? 'release' : 'debug')
}

export const exe = (name: string): string => (process.platform === 'win32' ? `${name}.exe` : name)

const ESC = /\x1b\[[0-9;]*m/g

/**
 * Makes the file of a `cargo` / `tsc` diagnostic absolute: `  --> src/main.rs:4:5` (cargo, relative to the Cargo
 * workspace) and `src/a.ts(3,1): error` / `src/a.ts:3:1 - error` (tsc, relative to the project).
 */
export function absolutize(line: string, cwd: string): string {
  const plain = line.replace(ESC, '')
  const cargo = /^(\s*-->\s+)(.+?):(\d+):(\d+)\s*$/.exec(plain)
  if (cargo && !path.isAbsolute(cargo[2])) return `${cargo[1]}${path.join(cwd, cargo[2])}:${cargo[3]}:${cargo[4]}`
  const tsc = /^([^\s(:][^(:]*?)(\(\d+,\d+\): |:\d+:\d+ - )((?:error|warning) TS\d+.*)$/.exec(plain)
  if (tsc && !path.isAbsolute(tsc[1])) return `${path.join(cwd, tsc[1])}${tsc[2]}${tsc[3]}`
  return line
}

/** Runs one command in `cwd`, streaming to the terminal; resolves with the exit code. */
export function run(write: (s: string) => void, command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, register?: (kill: () => void) => void): Promise<number> {
  return new Promise((resolve) => {
    write(`\x1b[1m> ${command} ${args.join(' ')}\x1b[0m   (${cwd})\r\n`)
    // npm and npx are `.cmd` scripts on Windows: only a shell starts them.
    const shell = process.platform === 'win32' && /^(npm|npx)$/.test(command)
    const child = spawn(command, args, { cwd, env, shell, windowsHide: true })
    register?.(() => child.kill())
    let pending = ''
    const out = (d: Buffer): void => {
      pending += d.toString()
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() ?? ''
      for (const l of lines) write(absolutize(l, cwd) + '\r\n')
    }
    child.stdout.on('data', out)
    child.stderr.on('data', out)
    child.on('error', (err) => {
      write(`\x1b[31m${command}: ${err.message}\x1b[0m\r\n`)
      resolve(127)
    })
    child.on('close', (code) => {
      if (pending) write(absolutize(pending, cwd) + '\r\n')
      resolve(code ?? 1)
    })
  })
}

type Step = (write: (s: string) => void, register: (kill: () => void) => void) => Promise<number>

/** A pseudoterminal that runs steps one after the other and stops at the first failure. */
class StepsTerminal implements vscode.Pseudoterminal {
  private readonly writer = new vscode.EventEmitter<string>()
  private readonly closer = new vscode.EventEmitter<number>()
  readonly onDidWrite = this.writer.event
  readonly onDidClose = this.closer.event
  private kill: (() => void) | null = null
  private cancelled = false

  constructor(private readonly steps: Step[]) {}

  open(): void {
    void this.go()
  }

  close(): void {
    this.cancelled = true
    this.kill?.()
  }

  private async go(): Promise<void> {
    const write = (s: string): void => this.writer.fire(s)
    const started = Date.now()
    for (const step of this.steps) {
      const t0 = Date.now()
      // A step that throws (a locked file, a missing folder) fails the task instead of leaving it running forever.
      const code = await step(write, (k) => (this.kill = k)).catch((err: Error) => {
        write(`[31m${err.message}[0m
`)
        return 1
      })
      write(`\x1b[2m(${((Date.now() - t0) / 1000).toFixed(1)} s)\x1b[0m\r\n`)
      if (code !== 0 || this.cancelled) {
        write(`\r\n\x1b[31mFailed (exit ${code}) after ${((Date.now() - started) / 1000).toFixed(1)} s\x1b[0m\r\n`)
        this.closer.fire(code || 1)
        return
      }
    }
    write(`\r\n\x1b[32mDone in ${((Date.now() - started) / 1000).toFixed(1)} s\x1b[0m\r\n`)
    this.closer.fire(0)
  }
}

const cmd = (command: string, args: string[], cwd: string): Step => (write, register) => run(write, command, args, cwd, buildEnv(), register)

/** The steps of « cargo build » for a checkout (the core builds its server and its CLI). */
export function cargoSteps(c: Checkout, release = false): Step[] {
  if (!c.server) return []
  const args = ['build', ...(release ? ['--release'] : [])]
  if (c.id === 'core') args.push('--bin', 'kubuno-core', '--bin', 'kubuno')
  return [cmd('cargo', args, c.server)]
}

/** Whether `npm ci` / `npm install` completed here (npm writes `node_modules/.package-lock.json` at the end). */
function installed(web: string): boolean {
  try {
    return fs.statSync(path.join(web, 'node_modules', '.package-lock.json')).mtimeMs >= fs.statSync(path.join(web, 'package-lock.json')).mtimeMs
  } catch {
    return false
  }
}

/** `npm ci` when the dependencies are not installed (or older than the lock), then the build with source maps. */
export function webBuildSteps(c: Checkout): Step[] {
  if (!c.web) return []
  const web = c.web
  const steps: Step[] = []
  if (!installed(web)) steps.push(cmd('npm', ['ci', '--no-audit', '--no-fund'], web))
  steps.push(cmd('npm', ['run', 'build', '--', '--sourcemap'], web))
  return steps
}

function task(c: Checkout, action: string, name: string, steps: Step[], matchers: string[], group?: vscode.TaskGroup, release = false): vscode.Task {
  const def: KubunoTaskDefinition = { type: TASK_TYPE, action, target: c.id, ...(release ? { release } : {}) }
  const t = new vscode.Task(def, c.folder, name, TASK_TYPE, new vscode.CustomExecution(async () => new StepsTerminal(steps)), matchers)
  if (group) t.group = group
  t.presentationOptions = { reveal: vscode.TaskRevealKind.Always, clear: true }
  return t
}

/** The tasks of one checkout. */
export function tasksFor(c: Checkout, all: Checkout[]): vscode.Task[] {
  const out: vscode.Task[] = []
  if (c.server) {
    out.push(task(c, 'cargo-build', `${c.id}: cargo build`, cargoSteps(c), ['$kubuno-rustc'], vscode.TaskGroup.Build))
    out.push(task(c, 'cargo-build', `${c.id}: cargo build --release`, cargoSteps(c, true), ['$kubuno-rustc'], vscode.TaskGroup.Build, true))
  }
  if (c.web) {
    const web = c.web
    out.push(task(c, 'npm-ci', `${c.id}: npm ci (web)`, [cmd('npm', ['ci', '--no-audit', '--no-fund'], web)], [], vscode.TaskGroup.Build))
    out.push(task(c, 'web-build', `${c.id}: build web`, webBuildSteps(c), ['$kubuno-tsc'], vscode.TaskGroup.Build))
    out.push(task(c, 'web-typecheck', `${c.id}: typecheck web (kbview-tsc -b)`, [cmd('npm', ['run', 'typecheck'], web)], ['$kubuno-tsc'], vscode.TaskGroup.Build))
  }
  const core = all.find((x) => x.id === 'core')
  if (c.id !== 'core' && core && c.server) {
    out.push(prepareTask(core, c))
  }
  return out
}

/** « prepare dev core (<module>) »: builds the core, its web host and the module, then deploys the module. */
export function prepareTask(core: Checkout, m: Checkout): vscode.Task {
  // Cargo is incremental and cheap when nothing changed; a web part is built only when it has no build yet (its
  // « build web » task rebuilds it on demand), so F5 does not pay a Vite build every time.
  const web = (c: Checkout): Step[] => (c.web && fs.existsSync(path.join(c.web, 'dist')) ? [] : webBuildSteps(c))
  const steps: Step[] = [...cargoSteps(core), ...web(core), ...cargoSteps(m), ...web(m), (write) => deployModule(m, devCoreDir(), write)]
  return task(m, 'prepare-dev-core', `prepare dev core (${m.id})`, steps, ['$kubuno-rustc', '$kubuno-tsc'], vscode.TaskGroup.Build)
}

export class KubunoTaskProvider implements vscode.TaskProvider {
  provideTasks(): vscode.Task[] {
    const all = findCheckouts()
    return all.flatMap((c) => tasksFor(c, all))
  }

  resolveTask(t: vscode.Task): vscode.Task | undefined {
    const def = t.definition as KubunoTaskDefinition
    const all = findCheckouts()
    const c = all.find((x) => x.id === def.target)
    if (!c) return undefined
    return tasksFor(c, all).find((x) => (x.definition as KubunoTaskDefinition).action === def.action && !!(x.definition as KubunoTaskDefinition).release === !!def.release)
  }
}
