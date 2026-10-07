# Kubuno for VS Code — Linux / Windows test matrix

One scenario list, run identically on both machines with real input:

| | Linux | Windows |
|---|---|---|
| Machine | 192.168.1.100, Ubuntu 24.04, GNOME on Xorg (`DISPLAY=:1`, 3429×1873, 100 %) | 192.168.1.101, Windows 11, 3429×1873 at **175 %** |
| VS Code | 1.140 snap, isolated profile (`--user-data-dir`, `--extensions-dir`) | 1.140 user setup, isolated profile |
| Input | `xdotool` on the live session | `SendInput` (mouse, keys, Unicode characters), window TOPMOST, under the shared lock |
| Language server | **none** — `kubuno-views-ls` does not build on Linux (VSCODE.md §4); the built-in fallback serves the designer | `kubuno-views-ls.exe` of vskubuno (build of 2026-10-01, with its `std-*.dll` and `kubuno_ui-*.dll`) |
| Workspace | the same copy of `core/web` + `drive` (`kbm-ws`), opened from a fresh untrusted folder | same |

Captures: `C:\kubuno-build\agent-vscode\matrix\{linux,windows}\NN-name.png` (full resolution).

## Scenarios and results (first pass, 2026-10-07)

OK = works; KO = defect (cause and status in the next section); N/A = cannot apply on that OS (reason given);
— = not run yet (the campaign was paused, see the last section). "LS" marks a result that depends on the language
server, which exists on Windows only.

| # | Scenario | Linux | Windows |
|---|---|---|---|
| 01 | Install the `.vsix` (`code --install-extension`) | OK | OK |
| 02 | Activation (Output › Kubuno: version, OS, LS state) | OK — "kubuno-views-ls was not found for linux-x64" | OK — after trust, LS started (see 05) |
| 03 | Activity bar icon (current Kubuno mark), Projects / Toolbox / Properties | OK | OK |
| 04 | Restricted Mode: the designer works, the LS is not started | OK | OK |
| 05 | Trust the folder | OK (nothing to start) | KO then OK — the LS failed to start ("connection got disposed"): the binary was copied without `std-*.dll` / `kubuno_ui-*.dll` (environment, not the extension); with them it runs |
| 06 | `WaffleMenu.kbcontrol` (core) opens in the designer by default, XML beside | OK | OK |
| 07 | `DriveSettingsPage.kbview` (drive): white page, dashed boundary | OK | OK |
| 08 | Click on the surface → XML caret + Properties | OK | OK (LS breadcrumbs `Stack › Panel › Stack › Label`) |
| 09 | Caret in the XML → selection on the surface | OK | OK |
| 10 | Properties edit (`Text`) written to the XML and rendered | OK | OK |
| 11 | Undo / redo from the designer | **KO → fixed** (one Ctrl+Z undid two edits) | **KO → fixed** (same) |
| 12 | Palette drag and drop: insertion marker, drop at the pointer | OK | OK, **KO → fixed** for the layout: LS inserted `<Label/></Panel>` on one line |
| 13 | Side bar Toolbox: click an item, click the surface | OK (the first click did not arm once; second try OK) | OK |
| 14 | Side bar Toolbox: double-click inserts into the selection | OK | OK (same layout defect as 12 → fixed) |
| 15 | Double-click an element → handler in the `.ts` | OK (built-in writer: `button_click`) | **KO → fixed** (LS answered an empty result; nothing created) |
| 16 | F7 from the designer → code-behind | **KO → fixed** (code-behind + a second designer opened) | **KO → fixed** (same) |
| 17 | Delete key on a selected element | OK | — |
| 18 | Select parent (command) | OK | — |
| 19 | New view / new user control (command, folder picker) | OK | — |
| 20 | XML completion | N/A — no LS (only word suggestions) | **KO, open** (LS): desktop attributes (`Anchor`, `Dock`…) offered on a web view |
| 21 | Hover | N/A — no LS | — |
| 22 | Diagnostics | OK — the design page's compiler (`unknown element Bogus`) | **KO, open** (LS): 27–38 false errors on valid web attributes (`Class`, `HtmlTag`, `ReactHost`) — same cause as 20 |
| 23 | Outline (Ctrl+Shift+O, breadcrumbs) | N/A — no LS ("no symbol information") | OK |
| 24 | Go to definition | N/A — no LS | — |
| 25 | Width presets (390 / 768 / 1440 / Fit) | OK | OK |
| 26 | Light and dark VS Code themes; page Light / Dark preview | OK | — |
| 27 | Non-ASCII input (é, ü, Arabic) in Properties and in the XML | OK | OK (Properties) |
| 28 | 175 % scale | N/A — the VM display has no scaling | OK — the whole Windows pass ran at 175 % |

Automated suites (`npm test`, real VS Code 1.140): Linux under Xvfb 13 passing, 2 pending (LS test skipped, no
LS); Windows with the LS after the fixes: 16 passing, 1 pending, **1 failing** (completion, scenario 20).

## Causes and fixes

- **11 / 16 — keys run twice.** VS Code's webview host forwards every keydown of the page to the workbench, which
  runs its keybindings (undo, redo, save, and this extension's F7). The page also sends the keys it does not use as
  `unhandledKey`, and the extension ran undo / redo / save / F7 a second time. Fixed: only F4 (no keybinding) is
  handled from `unhandledKey`. Same on both OSes.
- **Properties double commit.** Enter committed the value, then the blur committed it again (an extra, identical
  undo step). Fixed in `media/properties.js`.
- **12 / 14 — layout with the LS.** The server's `insertChild` is a verbatim splice; its `insertFragment` lays the
  element out on its own indented line (the built-in model already did). The extension now sends `insertFragment`
  and falls back to `insertChild` for servers without it. Windows only (Linux has no LS).
- **15 — empty `kubuno/createHandler`.** The server answers an empty result when it cannot resolve the element,
  event or code-behind ("degrade to no-op"); the extension now falls back to its built-in writer.
- **20 / 22 — Windows URIs.** VS Code sends `file:///c%3A/…`; the server converts URIs with
  `url::Url::to_file_path`, which rejects a `c%3A` drive segment, so no project marker is found and the desktop
  profile is used. The extension now sends `file:///c:/…` (client `uriConverters` and its own requests). The
  completion test still fails with this 2026-10-01 server build — not resolved yet (next steps).

## Where the campaign stopped (paused by the user, 2026-10-07) and next steps

Done: scenario list; first pass on Linux (01–27) and Windows (01–16, 25, 27, 28); five fixes above with
integration tests (`test/suite/designer.test.ts`, `model.test.ts`), verified on Windows (`npm test`). Not yet
re-run with real input on either OS, and not yet run on Linux after the fixes.

1. Rebuild the `.vsix`, reinstall it on both machines, re-run 11, 12, 14, 15, 16 with real input on both OSes and
   `npm test` under Xvfb on Linux.
2. Windows: run 17–19, 21, 24, 26, 27 (XML).
3. Scenario 20/22: check what `kubuno/registry` and `textDocument/completion` answer with `file:///c:/` URIs; try
   a `kubuno-views-ls` built from today's core (the 2026-10-01 build may predate the web profile fixes). If the
   server is at fault, report it in core.
4. Part 2 (build, run and debug Kubuno from VS Code, Linux vs Windows): not started. Ready on .100: rustup (user),
   build-essential, pkg-config, libssl-dev, clang, mold, Xvfb, PostgreSQL 16 (service stopped and disabled). Dev
   core recipe: `KV__SERVER__PORT=18680`, `KV__SERVER__HOST=127.0.0.1`, `KV__DATABASE__URL` on a throwaway
   database, `KV__SERVER__INTERNAL_SECRET` / `KV__AUTH__JWT_SECRET` (≥ 32 bytes, non-numeric),
   `KUBUNO_PATHS_MODE=user` plus `KV__SERVER__{FRONTEND_DIST,MODULES_DIR,MODULES_INSTALL_DIR,MODULES_CONFIG_DIR,MODULES_DATA_DIR}`,
   the module deployed as `<modules>/drive/{module.toml,kubuno-drive[.exe],frontend/}`. To add to the extension:
   task and debug configuration providers (cargo / npm / `kbview-tsc -b` with problem matchers, CodeLLDB or
   cppvsdbg launch of `kubuno-core`).
