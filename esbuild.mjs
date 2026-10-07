// Bundles the extension host code and copies the design host page (the static build of `@kubuno/host-runtime`).
import * as esbuild from 'esbuild'
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const production = process.argv.includes('--production')
const watch = process.argv.includes('--watch')
const require = createRequire(import.meta.url)

function copyDesignHost() {
  const pkg = require.resolve('@kubuno/host-runtime/package.json')
  const from = join(dirname(pkg), 'dist')
  const to = join('dist', 'design-host')
  if (!existsSync(join(from, 'index.html'))) throw new Error(`@kubuno/host-runtime has no dist/index.html (${from})`)
  rmSync(to, { recursive: true, force: true })
  mkdirSync(to, { recursive: true })
  // Only the bundled page: the project-mode chunks are served by a project's own dev server.
  cpSync(from, to, { recursive: true, filter: (src) => !src.includes(`${join('dist', 'project')}`) })
}

const ctx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
})

copyDesignHost()
if (watch) {
  await ctx.watch()
} else {
  await ctx.rebuild()
  await ctx.dispose()
}
