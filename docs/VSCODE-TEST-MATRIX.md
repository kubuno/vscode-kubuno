# Kubuno for VS Code — Linux / Windows test matrix

One scenario list, run the same way on both machines with real input (2026-10-07).

| | Linux | Windows |
|---|---|---|
| Machine | 192.168.1.100, Ubuntu 24.04, GNOME on Xorg (`DISPLAY=:1`, 3429×1873, 100 %) | 192.168.1.101, Windows 11, 3429×1873 at **175 %** |
| VS Code | 1.140 snap, isolated profile (`--user-data-dir`, `--extensions-dir`) | 1.140 user setup, isolated profile |
| Input | `xdotool` on the live session | `SendInput` (mouse, keys, Unicode characters), window TOPMOST, under the shared lock |
| Language server | **none** — `kubuno-views-ls` does not build on Linux (VSCODE.md §4); the built-in fallback serves the designer | `kubuno-views-ls.exe` built from today's core (`cargo build --release -p kubuno-desktop-views-ls`) |
| Workspace | the same copy of `core/web` + `drive` (`kbm-ws`), opened as a new, untrusted folder | same |

Captures: `C:\kubuno-build\agent-vscode\matrix\{linux,windows}\NN-name.png` (full resolution). Side-by-side
montages of the key scenarios: `matrix\compare\*.png`.

## Part 1 — the designer and the views language

OK = works; KO = defect (cause below); N/A = cannot apply on that OS (reason given); "fixed" = KO in the first
pass, fixed in the extension, then re-run on both OSes with real input. "LS" marks a result that depends on the
language server, which runs on Windows only.

| # | Scenario | Linux | Windows |
|---|---|---|---|
| 01 | Install the `.vsix` (`code --install-extension`) | OK | OK |
| 02 | Activation (Output › Kubuno: version, OS, LS state) | OK — "kubuno-views-ls was not found for linux-x64" | OK — LS started once trusted |
| 03 | Activity bar icon (current Kubuno mark); Projects / Toolbox / Properties | OK | OK |
| 04 | Restricted Mode: the designer works, the LS is not started | OK | OK |
| 05 | Trust the folder → the LS starts | OK (nothing to start) | OK (a first KO came from an LS copied without its `std-*.dll`: environment, not the extension) |
| 06 | `WaffleMenu.kbcontrol` (core) opens in the designer by default, XML beside | OK | OK |
| 07 | `DriveSettingsPage.kbview` (drive): white page, dashed boundary | OK | OK |
| 08 | Click on the surface → XML caret + Properties | OK | OK |
| 09 | Caret in the XML → selection on the surface | OK | OK |
| 10 | Properties edit (`Text`) written to the XML and rendered | OK | OK |
| 11 | Undo / redo from the designer | **fixed** (one Ctrl+Z undid two edits) | **fixed** (same) |
| 12 | Palette drag and drop: insertion marker, drop at the pointer | OK | OK; **fixed** with the LS: the element was glued to `</Panel>` |
| 13 | Side bar Toolbox: click an item, click the surface | OK | OK |
| 14 | Side bar Toolbox: double-click inserts into the selection | OK | OK (layout fixed as in 12) |
| 15 | Double-click an element → handler in the `.ts` | OK (built-in writer) | **fixed** (LS answered an empty result: nothing was created) |
| 16 | F7 from the designer → code-behind | **fixed** (code-behind + a second designer) | **fixed** (same) |
| 17 | Delete key on a selected element | OK | OK |
| 18 | Select Parent (command) | OK; **fixed**: the XML caret did not follow | OK (same fix) |
| 19 | New view / new user control (command, folder picker) | OK | OK (the folder picker is a native dialog: the TOPMOST VS Code window hid it during the first try — test harness, not the extension) |
| 20 | XML completion | N/A — no LS (word suggestions only) | OK (LS) |
| 21 | Hover | N/A — no LS | OK (LS) |
| 22 | Diagnostics | OK — the design page's own compiler (`unknown element Bogus`) | OK (LS: `unknown element <Bogus>` only) |
| 23 | Outline (Ctrl+Shift+O, breadcrumbs) | N/A — no LS ("no symbol information") | OK (LS) |
| 24 | Go to definition | N/A — no LS | OK (LS) |
| 25 | Width presets (390 / 768 / 1440 / Fit) | OK | OK |
| 26 | Light and dark VS Code themes; page Light / Dark preview | OK | OK |
| 27 | Non-ASCII input (é, ü, Arabic) in Properties and in the XML, saved as UTF-8 | OK | OK |
| 28 | 175 % scale | N/A — the VM display has no scaling | OK — the whole Windows pass ran at 175 % |

**Summary, part 1:** Linux 23 OK (4 of them after a fix), 5 N/A (4 = no language server, 1 = no scaling), 0 KO
left. Windows 28 OK (6 after a fix), 0 KO left.

Automated suites (`npm test`, a real VS Code): Linux under Xvfb **16 passing, 2 pending** (the LS test is skipped,
no LS; the demo test only runs for screenshots); Windows with the LS **17 passing, 1 pending**.

### Causes and fixes (extension)

- **11 / 16 — keys run twice.** VS Code's webview host forwards every keydown of the page to the workbench, which
  runs its keybindings (undo, redo, save, this extension's F7). The page also sends the keys it does not use as
  `unhandledKey`, and the extension ran undo / redo / save / F7 again. Only F4 (no keybinding) is still handled
  from `unhandledKey`. Same on both OSes.
- **Properties double commit.** Enter committed the value and the blur that followed committed it again (an
  identical extra undo step). `media/properties.js` commits a value once.
- **12 / 14 — layout with the LS.** The server's `insertChild` is a verbatim splice; its `insertFragment` puts the
  element on its own indented line, as the built-in model does. The extension sends `insertFragment` and falls back
  to `insertChild`. Windows only (Linux has no LS).
- **15 — empty `kubuno/createHandler`.** The server answers an empty result when it cannot resolve the element,
  the event or the code-behind; the built-in writer now creates the handler then.
- **18 — Select Parent** moved the selection, not the XML caret.
- **20 / 22 in the first pass** (desktop attributes offered, false "unknown attribute" errors on web views) came
  from the 2026-10-01 server build, which predates the web profile detection; today's build answers with the web
  profile for both `file:///c%3A/…` and `file:///c:/…`. Nothing to change in the extension.

### Remaining differences, and why

- Completion, hover, outline and go-to-definition exist on Windows only: `kubuno-views-ls` does not build on Linux
  (`kubuno-desktop-views` → Win32 crates, VSCODE.md §4). On Linux the designer, Properties, handlers and the page's
  diagnostics come from the built-in fallback. Not faked; it closes with lot VSC-1.
- Diagnostics differ in wording and source: the LS on Windows, the design page's compiler on Linux.

## Part 2 — building, running and debugging Kubuno from VS Code

The extension now contributes, for every Kubuno checkout of the workspace (the core: `server/Cargo.toml` of
`kubuno-core`; a module: `module.toml` + `server/`), without any `tasks.json` / `launch.json` in the repositories:

- **Tasks** (`kubuno` task type, Ctrl+Shift+B): `<id>: cargo build` (and `--release`), `<id>: npm ci (web)`,
  `<id>: build web` (`npm ci` when needed, then `npm run build -- --sourcemap`), `<id>: typecheck web
  (kbview-tsc -b)`, `prepare dev core (<module>)`. They run in a pseudoterminal driven by the extension (no shell:
  the same code on every OS), print each step's duration, and rewrite the file names `cargo` / `tsc` print as
  absolute paths so the `$kubuno-rustc` / `$kubuno-tsc` problem matchers fill the Problems panel.
- **Launch configurations** (`kubuno` debug type, offered in « Select and Start Debugging », and F5 with no
  `launch.json`): `Kubuno: dev core + <module>` — the workspace's `kubuno-core` with the module deployed into its
  own data folder, port `kubuno.dev.port` (18680), under CodeLLDB (or cppvsdbg / gdb), with « prepare dev core » as
  pre-launch task; the module's page opens once the core answers. `Kubuno: <module> web (browser)` — Chrome or
  Edge under VS Code's JavaScript debugger, with source maps.
- Settings: `kubuno.dev.port`, `.databaseUrl` (a throw-away PostgreSQL/MySQL URL; empty = SQLite, one file per
  schema), `.folder`, `.cargoTargetDir`, `.buildEnv` (e.g. `CARGO_INCREMENTAL=0`, `CARGO_PROFILE_DEV_DEBUG=1`),
  `.debugger`, `.browser`, `.openBrowser`, `.adminPassword`, `.rustLog`.

Test setup: full clones of `core` and `drive` (Linux `~/kubuno/{core,drive}` opened through a `devws` folder of
symbolic links; Windows `E:\kubuno-build\agent-vscode\src`, reached through the `C:\kubuno-build` junction).
Both with `CARGO_INCREMENTAL=0` and `CARGO_PROFILE_DEV_DEBUG=1` (small targets; line-level debug info, enough for
breakpoints). Database: Linux a local PostgreSQL 16 (`kubuno_vscode_test`, dropped afterwards); Windows SQLite in
the dev core folder. Every task and launch was triggered with real keys (Ctrl+Shift+B, F5, F9, the debug picker).

| Scenario | Linux | Windows | Notes |
|---|---|---|---|
| Task list (Ctrl+Shift+B shows the `kubuno:` tasks of core and drive) | OK | OK | |
| core web host: `build web` | OK | **fixed**, then OK (≈ 10 s Vite) | Vite (rolldown) failed with "fileName … must be neither absolute nor relative" when the checkout is reached through a junction/link; tasks now run in the real path |
| core: `cargo build` (clean, dev) | OK — 212 s | OK — 448 s | Windows: MSVC link + Defender; Linux timing after the disk incident below |
| drive: `cargo build` (clean, dev) | OK — 84 s | OK — 182 s | shared crates fetched from GitHub tags on both |
| drive: `build web` (with `npm ci`) | OK — 21 s (`npm ci` already done) | OK — 63 s (incl. `npm ci`) | first Linux run: a partial `node_modules` (registry file only) skipped `npm ci`; fixed (the task checks `node_modules/.package-lock.json`) |
| Incremental `cargo build` (drive, one line changed) | OK — 3 s | OK — 7 s | |
| Incremental `cargo build` (core, one file changed) | — | OK — 212 s | `CARGO_INCREMENTAL=0` rebuilds the whole `kubuno-core` crate: keep incremental on when the disk allows |
| Rust error in the Problems panel (`E0308` from cargo) | OK | OK | absolute paths on both |
| TypeScript error in the Problems panel (`TS2322` from `kbview-tsc -b`) | OK | OK | |
| F5: prepare + dev core + drive on 18680, page opened | OK (PostgreSQL) | **fixed**, then OK (SQLite) | Windows/SQLite: `sqlite://<folder>` names one file, the core needs a folder (engine + path now); then sign-in failed on SQLite — core bug, fixed (below) |
| Sign in and browse drive in the browser | OK | OK (after the core fix) | |
| Rust breakpoint hit (`handlers/health.rs:18`, GET /health) under CodeLLDB | OK | OK | Linux: **fixed** — unresolved through the symbolic link; `breakpointMode: file` |
| TS breakpoint in drive's `DriveApp.ts` (browser session) | **fixed**, then OK | **fixed**, then OK | see « TypeScript breakpoints » below |
| TS breakpoint in the core web host (`core/web/src/views/render.tsx`) | OK | OK | same fix |
| Stop debugging leaves no process behind | **fixed** | **fixed** | the core does not stop its modules when killed: `kubuno-drive` kept port 3101 and (Windows) its binary locked; the extension stops them on session end and before a launch |

**Summary, part 2:** 14 OK on both OSes (7 after a fix), 0 KO left.

### Fixes made during part 2

- Extension: real paths for tasks (junctions/links), `node_modules` completeness check, SQLite = engine + folder,
  `breakpointMode: file` for CodeLLDB, stopping a running dev core and its module processes, a failing step fails
  the task instead of hanging, chained debug resolvers (the browser configuration was resolved twice).
- **core** (`server/src/handlers/auth/tokens.rs`): the password sign-in stored its refresh token without an `id`,
  which only PostgreSQL fills by default; on SQLite and MySQL every sign-in failed with "Erreur base de données"
  (`NOT NULL constraint failed: refresh_tokens.id`). The id is now generated as in the three other inserts.
  Found on Windows because the dev core used SQLite there; not OS-specific.

### TypeScript breakpoints (module and core web host)

Root cause, from a js-debug trace (`"trace": true` in the launch configuration, now passed through):

1. A breakpoint is set on the path **the editor** shows; when the checkout is reached through a symbolic link or
   a Windows junction (`~/kubuno/devws/drive` → `~/kubuno/drive`, `C:kubuno-build` → `E:kubuno-build`), the
   launch configuration gave js-debug the **real** path as `webRoot`, so the module's sources were resolved to
   another path than the breakpoint's and it stayed unbound.
2. js-debug maps a compiled URL to a local file through `sourceMapPathOverrides` only when that file exists and
   matches what is served. The core serves a module's entry renamed (`entry.js` → `entry-<hash>.js`) and its
   own shared chunks (`/shared/…`) did not pass the check either; js-debug then resolves the map's relative
   sources from « webRoot + URL path » — `drive/web` + `/shared/` + `../../src` → `drive/src/…`, the wrong
   folder seen in the first pass.

The source maps themselves are right (sources relative to the compiled file, `../../src/views/X.ts` from
`chunks/`), so nothing changes in the module builds or in a shared Vite preset. The fix is in the launch
configuration: editor-side paths for `webRoot` and the mappings, `/modules/<id>/` → the module's `web/dist` and
`/` → the core's `web/dist` both as `sourceMapPathOverrides` and as `pathMapping` (used by the fallback). It
works for any module id and for the core web host.

Verified with real input on both OSes (Linux on its own Xvfb display `:77`, because another agent was driving
the live `:1` session): `DriveApp.ts:182` (drive) and `render.tsx:918` (core web host) paused, the host frames
open `core/web/src` files (`matrixcompare13-ts-breakpoint.png`, `b15-host-breakpoint.png`).

### Incident: disk full on .100

The first clean `cargo build` of the core on .100 (default dev profile, incremental, full debug info, target in the
checkout) filled the root disk (43 GB, 4.8 GB free before). The user freed space; the partial targets were deleted
and the builds re-run with `CARGO_TARGET_DIR=~/kubuno/target`, `CARGO_INCREMENTAL=0`, `CARGO_PROFILE_DEV_DEBUG=1`
and a guard that stops cargo under 3 GB free (never triggered; lowest: 8.2 GB free). The 588 s of the failed run
are not comparable and are not in the table. With these settings the target stayed ≈ 3 GB for the core.

## Cleaning up

- .100: VS Code closed, dev core stopped, `kubuno_vscode_test` dropped, PostgreSQL stopped and disabled, targets
  and the dev core folder deleted; rustup, build-essential, pkg-config, libssl-dev, clang, mold, Xvfb and
  PostgreSQL 16 stay installed.
- .101: VS Code and the dev core stopped, the target and the clones on E: deleted.
