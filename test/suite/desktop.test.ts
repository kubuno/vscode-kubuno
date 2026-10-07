/**
 * The desktop apps found in a checkout's `desktop/` Cargo workspace, per OS (`src/dev/desktop.ts`): the manifest
 * parsing on fixtures, then the real core / office / drive checkouts next to this repository when they are there.
 */
import * as assert from 'node:assert'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { desktopApps, desktopOs, memberBinaries, workspaceMembers } from '../../src/dev/desktop'

suite('Desktop apps', () => {
  test('workspace members, comments and backslashes', () => {
    const m = workspaceMembers('[workspace]\nresolver = "2"\nmembers  = [\n    "common/a",\n    # "windows/old",\n    "windows\\\\b", "linux/c",\n]\n')
    assert.deepStrictEqual(m, ['common/a', 'windows/b', 'linux/c'])
  })

  test('binaries: [[bin]] names, else the package with src/main.rs', () => {
    const withBin = '[package]\nname = "kubuno-desktop-shell"\nversion.workspace = true\n\n[[bin]]\nname = "kubuno-desktop"\npath = "src/main.rs"\n\n[dependencies]\nx = "1"\n'
    assert.deepStrictEqual(memberBinaries(withBin, true), { pkg: 'kubuno-desktop-shell', bins: ['kubuno-desktop'] })
    assert.deepStrictEqual(memberBinaries('[package]\nname = "drive"\n[dependencies]\n', true), { pkg: 'drive', bins: ['drive'] })
    assert.deepStrictEqual(memberBinaries('[package]\nname = "a-lib"\n', false), { pkg: 'a-lib', bins: [] })
  })

  test('apps of each OS folder, tools left out', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubuno-desktop-'))
    const put = (rel: string, text: string): void => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
      fs.writeFileSync(path.join(dir, rel), text)
    }
    put('desktop/Cargo.toml', '[workspace]\nmembers = ["common/x", "windows/shell", "windows/data-tool", "linux/shell-linux"]\n')
    put('desktop/common/x/Cargo.toml', '[package]\nname = "x"\n')
    put('desktop/windows/shell/Cargo.toml', '[package]\nname = "shell"\n[[bin]]\nname = "kubuno-desktop"\n')
    put('desktop/windows/data-tool/Cargo.toml', '[package]\nname = "kubuno-desktop-data-tool"\n[[bin]]\nname = "kubuno-data-tool"\n')
    put('desktop/linux/shell-linux/Cargo.toml', '[package]\nname = "shell-linux"\n[[bin]]\nname = "kubuno-desktop"\n')
    try {
      assert.deepStrictEqual(desktopApps({ id: 'core', dir }, 'windows').map((a) => `${a.pkg}:${a.bin}`), ['shell:kubuno-desktop'])
      assert.deepStrictEqual(desktopApps({ id: 'core', dir }, 'linux').map((a) => `${a.pkg}:${a.bin}`), ['shell-linux:kubuno-desktop'])
      assert.deepStrictEqual(desktopApps({ id: 'core', dir }, 'macos'), [])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('real checkouts (when present next to this repository)', function () {
    const src = process.env.KUBUNO_SRC ?? path.resolve(__dirname, '..', '..', '..')
    const bins = (id: string, o: 'windows' | 'linux'): string[] => desktopApps({ id, dir: path.join(src, id) }, o).map((a) => a.bin)
    if (!fs.existsSync(path.join(src, 'core', 'desktop', 'Cargo.toml'))) return this.skip()
    assert.deepStrictEqual(bins('core', 'windows'), ['kubuno-desktop'])
    assert.deepStrictEqual(bins('core', 'linux'), ['kubuno-desktop'])
    if (fs.existsSync(path.join(src, 'office', 'desktop', 'Cargo.toml'))) {
      assert.ok(bins('office', 'windows').includes('kubuno-documents') && bins('office', 'windows').includes('kubuno-spreadsheets'))
      assert.deepStrictEqual(bins('office', 'linux'), ['kubuno-documents'])
    }
    assert.ok(['windows', 'linux', 'macos'].includes(desktopOs()))
  })
})
