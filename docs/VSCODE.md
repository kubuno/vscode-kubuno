# Kubuno in Visual Studio Code — study and prototype (2026-10-07)

> Question: can Kubuno be developed from **any OS** by moving (part of) vskubuno — the Visual Studio 2026
> extension — to Visual Studio Code, with a visual designer, a Toolbox and a Properties window like other VS Code
> designer extensions? This note answers with evidence from a working prototype (this repository) built and
> tested on Windows 11 and on Ubuntu 24.04 (Xvfb), and recommends a plan.

## 1. Summary

- **Web views: yes, now.** The web design page (`@kubuno/host-runtime`, core `web/src/views/design`) runs
  unchanged in a VS Code webview behind a 40-line shim that maps WebView2's `window.chrome.webview` onto
  `acquireVsCodeApi()`. The prototype opens the core's `WaffleMenu.kbcontrol` and drive's
  `DuplicatesDialog.kbview` with a clean render on both OSes, with selection sync both ways, Properties edits
  written as `WorkspaceEdit`s, Toolbox drag and drop (from a palette docked in the designer) through the real page, and handler creation in the TypeScript
  code-behind. 15 integration tests pass on Windows (with `kubuno-views-ls`) and 13 on Linux
  (without it).
- **The language server does not build outside Windows** (§4): it links `kubuno-desktop-views`, the Win32
  framework crate. The prototype runs the Windows binary unchanged through `vscode-languageclient` and falls
  back to its own XML model elsewhere. A 3–5 day refactor in core makes it portable.
- **Desktop views**: their surface is Win32/Direct2D. Recommended path (§5): a remote Windows render
  server short term (≈ 3–4 weeks), the cross-platform renderer only together with the desktop Linux/macOS plan.
- **Recommendation** (§8): keep both IDEs; share the language server, the design page and the generators; make VS
  Code the cross-OS IDE for web views and modules first; do not migrate the desktop designer before the
  renderer is portable.

## 2. How comparable VS Code extensions build designers

| Extension | Surface | Toolbox / properties | Document sync | What we take |
|---|---|---|---|---|
| **Draw.io Integration** (hediet.vscode-drawio) | `CustomTextEditorProvider`, the draw.io web app in a webview | draw.io's own panels inside the webview | the text document is the truth; the webview posts changes, the extension applies `WorkspaceEdit`s; Live Share works because of that | exactly our model: `TextDocument` = buffer, page = gesture → intent |
| **Figma for VS Code** | webview panels | webview side views | none (read-only design data) | webview views in the side bar for panels |
| **Flutter / Dart** | DevTools (Widget Inspector) in a webview, served by the DevTools server; *Flutter Property Editor* as a side bar webview view (2025) | property editor = `WebviewView` | edits go through the Dart analysis server (LSP-style requests) → `WorkspaceEdit` | the Properties pane as a `WebviewView` fed by language-server requests |
| **Avalonia for VS Code** | XAML previewer: frames rendered by the Avalonia designer host process and shown in a webview (HTML transport) | none (text editing + preview) | text is the truth | precedent for **remote/out-of-process rendering streamed into a webview** (§5 b) |
| **.NET MAUI / C# Dev Kit**, **Uno Platform** | no in-editor designer: XAML Hot Reload, Uno's *Hot Design* runs inside the running app | — | — | confirms there is no XAML-designer-in-VS-Code precedent to reuse |
| **Qt for VS Code** (Qt Group) | none in the editor: `.ui` files open in the external Qt Widgets Designer | — | file on disk | the external-tool fallback, not what we want |
| **Android layout preview** | Android Studio only; VS Code extensions only offer XML language support | — | — | — |

Platform facts the design relies on (all exercised by the prototype):

- `CustomTextEditorProvider` (not `CustomEditorProvider`): VS Code owns undo/redo, dirty state, save, hot exit
  and backups; the designer only applies `WorkspaceEdit`s. The XML is an ordinary text editor opened beside the
  designer — that *is* the Design | XML split, and the language server serves it like any `.kbview` editor.
- Panels are `WebviewView`s in an activity bar container (Toolbox, Properties) and a `TreeView` (Projects).
  The Document Outline comes for free from the server's `textDocument/documentSymbol` (visible as breadcrumbs in
  `captures/windows-waffle.png`).
- **Toolbox drag and drop.** Measured in VS Code 1.140 (sources of the workbench and of the webview host page
  read in the installed build, real input with `xdotool` on a live GNOME/Xorg session and under Xvfb):
  - The webview host page forwards a drag to the workbench only when every item is a *file*; any other HTML5 drag
    stays inside the webviews. So a private MIME type (`application/vnd.kubuno.toolbox-item`, the same technique
    as the *WinForms Designer for VS Code* extension's `application/vnd.winforms-toolbox-item`) is the right
    payload — `text/plain` is not needed, and during the drag only the types are readable, so the item's name is
    sent ahead through the extension.
  - **But the workbench blocks the editor's webview** as soon as a drag passes over workbench DOM: every visible
    webview editor registers a listener on the main window that sets `pointer-events: none` on its iframe on
    `dragover` (and lifts it only for `dragover` with Shift, `dragend`, or a mouse move without buttons). A drag
    from the side bar Toolbox (a `WebviewView`) to the designer always crosses the sash, so the design page never
    sees `dragenter` (logged: the Toolbox's `dragstart`/`dragend` arrive, the page gets nothing — with or without
    Shift, measured on the live session). A `TreeDragAndDropController` Toolbox starts its drag in the workbench
    and is blocked the same way. Whatever the WinForms extension does, a cross-webview drop into an editor
    webview is not reliable in this VS Code version.
  - **Solution: the Toolbox docked inside the designer webview** (a palette beside the surface, collapsible,
    filter, same groups as the side bar view, setting `kubuno.designer.palette`). The drag never leaves the page:
    native HTML5 drag and drop with the private type, translated in the shim (`media/designer-shim.js`) into the
    page's host-drag protocol (`dragEnter` / `dragOver` / `drop` / `dragLeave`, the messages Visual Studio's OLE
    drop target sends), so the page draws its own insertion markers while hovering and inserts at the pointer —
    the WinForms behaviour. Verified with real input on the live Xorg session of 192.168.1.100 and under Xvfb
    (`captures/linux-drag-hover.png`, `linux-drag-after.png`: a `Label` dropped between the header's label and
    its pencil, at the marker).
  - Kept as alternatives: click an item (palette or side bar Toolbox) to arm it, then click the surface
    (Windows Forms' other gesture; `linux-place-*.png`); double-click / Enter inserts into the selection. The side
    bar Toolbox keeps its drag code, which works whenever VS Code lets the drag through (no workbench pixel
    crossed, e.g. a future VS Code).

## 3. What is reused as is

| Piece | Status in the prototype |
|---|---|
| `kubuno-views-ls` (completion, hover, diagnostics, outline, F12, `kubuno/applyEdit`, `elementAtOffset`, `rangeOfElement`, `registry`, `createHandler`) | used through `vscode-languageclient` 9, stdio, no options — the exact binary vskubuno ships (Windows). Completion, diagnostics, outline and `createHandler` verified in the Windows test run. |
| The web design page (`@kubuno/host-runtime` 0.1.2 from npm, bundled mode) | loaded as the webview document (`<base>` = the package's `dist/`, CSP with `'wasm-unsafe-eval'` for the compiler's WebAssembly); protocol unchanged, transport = shim. The compiler, themes, fonts, `setHostRegistry`, `projectComponents`, `setDocumentInfo`, design data, `renderStatus` all work. |
| `@kubuno/views-compiler` / `@kubuno/views` | inside the page (WASM); the page's `renderStatus` diagnostics become VS Code diagnostics when no language server runs. |
| rust-analyzer | the official `rust-lang.rust-analyzer` extension (all OSes) — nothing to write. |
| F5 | CodeLLDB (Linux/macOS/Windows) or `cppvsdbg` (Windows/MSVC) launch configurations for `cargo build` outputs; the dev core of vskubuno's `WEB.md` (SSH build on the Linux host, tunnel to the dev database) becomes a `tasks.json` + `launch.json` pair. Not in the prototype. |
| Tasks: `cargo`, `npm run build`, `build_kbpkg.sh`, `deploy_local.sh` | `TaskProvider` or plain `tasks.json` with problem matchers (`$rustc`, `$tsc`). Not in the prototype. |

The project-mode page (the project's own Vite dev server, real code-behind, HMR) needs one small core change: the
page only knows the WebView2 transport and a test hook, so it cannot be hosted in an `<iframe>` inside the
webview. Adding a `window.parent.postMessage` transport to `openChannel` (`protocol.ts`) is about half a day.

## 4. The language server outside Windows

`cargo build -p kubuno-desktop-views-ls` on Ubuntu (`/kubuno/tmp/agent-vscode/ls-build.log`) fails in
`windows-future` (`cannot find function marshaler in windows_core::imp`). Cause, from `cargo tree -i`:

```
kubuno-desktop-views-ls → kubuno-desktop-views (windows/, Win32 framework)
  → kubuno-desktop-ui / -controls / -resources → windows 0.62, accesskit_windows
```

The server uses `kubuno_desktop_views` in 25 files for portable things — `syntax`, `ast`, `edit` (already
re-exported from the portable `kubuno-desktop-views-syntax`, WV-1), plus the **desktop registry**
(`registry::*`, `controls::ALL`, built by the `component!` macros of the Win32 controls), `validate`,
`binding::{parse_binding, Value, ViewModel}`, `event_handlers`, `messages`, `icon::catalog_json`.

**Proposed fix (core, not done here — other agents work there), 3–5 days:**

1. Move the registry *model* and the validator's registry-dependent half to a common crate, and have the
   desktop registry exported as JSON (`registry::export::export()`, already the `kubuno/registry` payload)
   into a checked-in snapshot regenerated by a test on Windows (the web profile already reads its registry
   from JSON, `web/project.rs`).
2. In `kubuno-desktop-views-ls/Cargo.toml`, make `kubuno-desktop-views` a `[target.'cfg(windows)'.dependencies]`;
   on other OSes the desktop profile reads the snapshot and the Windows-only extras (`kubuno/renderIcon`,
   `kubuno/crateComponents`) answer `null`.
3. CI builds `kubuno-views-ls` for linux-x64, linux-arm64, darwin-arm64, win32-x64; the VSIX is packaged per
   platform (`vsce package --target …`, binary in `bin/<platform>-<arch>/`, which the extension already looks
   for).

Meanwhile the prototype's fallback (`src/views/kbviewModel.ts`, `handlerFallback.ts`) implements the designer's
needs with the server's contract (ordinal ids, Vec-semantics moves, `<x:Name>_<event>` snake_case handler names,
`@kubuno/views` type imports); it is a stop-gap, the server stays the reference.

## 5. Desktop views on Linux and macOS

The desktop designer surface is `view_embed` (Win32 window, Direct2D), reparented into Visual Studio. Options:

| | What | Fidelity | Cost | Risks |
|---|---|---|---|---|
| **(a)** web renderer of the desktop element set | render desktop `.kbview`s with the web runtime, mapping the shared canonical names (`Button`, `Stack`, `Panel`…, conformance suite: 0 name failures) | medium: shared elements look *web*, not Direct2D (fonts, metrics, focus visuals); absolute layout/Dock/Anchor reproducible; ribbon, owner-draw, data grids, Rust custom controls (`#[derive(Component)]`) → placeholders; Rust code-behind never runs | 6–8 weeks for ~100 desktop element kinds incl. ribbon | a designer that lies about the result; a third renderer to keep in sync |
| **(b)** remote Windows render server | `view_embed` (or a sibling) renders off-screen (Direct2D on a WIC bitmap), streams frames + its layout map over WebSocket; the webview shows the frame and draws adorners from the layout map; input goes back as the DSG-6 protocol already defines (it is already a process speaking a line protocol) | exact (the real framework, the project's own build) | 3–4 weeks | needs a reachable Windows host (the bench has one, as it has the Linux build host for VS); latency ~50–100 ms on LAN; one session per designer |
| **(c)** port the renderer to wgpu / skia | the framework's paint layer on a cross-platform backend | exact, local | months (Direct2D, DirectWrite text, accessibility, OLE drag and drop, IME…) | only worth it as part of the desktop Linux/macOS plan |

**Recommendation: (b) now, (c) with the desktop Linux/macOS plan, not (a).** (b) reuses the DSG-6 protocol and
the existing surface, gives exact fidelity and follows the bench's existing pattern (remote build host). When
(c) lands, the same webview client switches from frames to a local surface. (a) is only acceptable as a
"wireframe" fallback when no Windows host is configured.

## 6. The project system

VS Code has no `.slnx` / `.rsproj` / `.esproj`. The prototype's **Projects** view builds the same tree from the
workspace: modules (a folder with `module.toml`, and `core`) → platforms (`web`, `server`, `desktop`, `mobile`,
`common`) → for a web platform with `kubuno.views.json`, its views and user controls by folder (233 for the core,
39 for drive), opened in the designer. A multi-root workspace over `Z:\src` (or any clone) is enough; the
language server and the project detection walk up from each file exactly as in Visual Studio. Generation goes
through commands (prototype: *New View or User Control…* writes `X.kbview`/`X.kbcontrol` + `X.ts`); module
templates, `build_kbpkg`, release scripts become commands and tasks.

## 7. Parity matrix (vskubuno → VS Code)

Effort: S ≤ 2 days, M ≤ 1 week, L ≤ 3 weeks, XL more.

| Feature | Prototype | Effort to parity | Notes |
|---|---|---|---|
| Web designer surface (render, selection, move/resize, reorder, keyboard, context menu) | ✅ | S | all from the page; context menu = QuickPick (no native menu at a point in webviews) |
| Design \| XML split, selection sync both ways | ✅ | — | |
| Toolbox (registry tabs, filter, project controls, user controls) | ✅ drag and drop from the palette docked in the designer, click-to-place, double-click insert | S | icons (Lucide set as in VS) |
| Properties (categories, enums, booleans, text, unknown attributes) | ✅ | M | binding picker (`kubuno/bindingPaths`), icon picker, resource picker, collection editors |
| Events tab, ⚡ new handler, double-click handler | ✅ (LS on Windows, fallback elsewhere) | S | compatible-handlers dropdown (`kubuno/compatibleHandlers`) |
| F7 / Shift+F7 | ✅ | — | |
| Undo/redo, save, dirty | ✅ (VS Code's) | — | |
| Completion, diagnostics, hover, outline, F12, rename | ✅ via the LS (Windows) | M (LS portability, §4) | |
| Project-mode page (dev server, code-behind, HMR) | ❌ | S + core ½ day | iframe transport in `protocol.ts` |
| Live data mode | ❌ (not in VS either) | M | |
| Resources editor (`.kbres`) | ❌ | M | custom editor (grid) over the same model |
| Settings / data components, Data Sources | ❌ | M–L | desktop mostly |
| Menus « Type here », ribbon editing, smart tags | ❌ | L | in-page adorners exist on desktop only; web side to write |
| Desktop designer | ❌ | §5 | |
| Dev assistant (AI in the IDE) | ❌ | M | VS Code's chat / language model API, or the MCP server already designed for VS |
| Dev core F5, remote Linux build, debug | ❌ | M | tasks + CodeLLDB + SSH (Remote-SSH can even run the whole IDE on the Linux host) |
| Publish (.kbpkg, release, Docker) | ❌ | S–M | commands wrapping `_tools/` scripts |
| Rust (rust-analyzer, cargo) | free | — | official extensions |

## 8. Lots and recommendation

**Keep both IDEs, share everything below the UI.** Visual Studio keeps the desktop designer and the Windows
Rust debugging; VS Code becomes the cross-OS IDE for web views, modules and Rust servers. Shared: the language
server (one binary per OS), the design page (`@kubuno/host-runtime`), the generators and templates (move them
to the language server or a small npm package so both IDEs call the same code). A migration would throw away the
desktop designer and the WinForms-grade Properties window for nothing in return today.

| Lot | Content | Effort |
|---|---|---|
| VSC-1 | Portable `kubuno-views-ls` (§4) + per-platform VSIX in CI | 1 week |
| VSC-2 | Project-mode page in the webview (core iframe transport, dev server discovery from `.kubuno/design-server.json`, « Start the dev server » command) | 1 week |
| VSC-3 | Properties parity: binding / icon / resource pickers, compatible handlers, collection editors | 2 weeks |
| VSC-4 | Tasks, launch configs, dev core F5 over SSH, publish commands | 1–2 weeks |
| VSC-5 | Resources editor, templates/generators shared with VS | 2 weeks |
| VSC-6 | Desktop surface via the remote Windows render server (§5 b) | 3–4 weeks |
| VSC-7 | Menus « Type here », ribbon, smart tags on the web surface | 3 weeks |
| VSC-8 | Marketplace / Open VSX publishing (when the user decides) | 2 days |

## 9. The prototype (this repository)

- `src/designer/` — the custom editor and the webview shim; `src/views/` — Toolbox / Properties views, the
  `ViewService` (language server first, `kbviewModel` fallback), handler fallback; `src/lsp/` — the client;
  `src/project/` — web project detection (the server's rule), registries, the Projects view.
- Tests: `npm test` (`@vscode/test-electron`, a throw-away workspace copied from `core/` and `drive/`;
  `KUBUNO_VIEWS_LS` to use a server, `KUBUNO_SRC` for the checkout). Linux: `xvfb-run -a npm test`.
- Screenshots: `scripts/demo-linux.sh` (Xvfb + ImageMagick), `scripts/place-linux.sh` (real mouse placement with
  `xdotool`), `scripts/demo-windows.ps1` (PrintWindow).

Verified 2026-10-07: Windows 11 (VS Code 1.140, `kubuno-views-ls` of vskubuno, 175 % DPI): 15/15 tests (with the screenshot run); Ubuntu
24.04 under Xvfb (VS Code 1.140, no server): 13/13, the language-server test skipped; VSIX (2.8 MB) installs. Limits: no project-mode
page, no desktop views, drag and drop only from the palette docked in the designer (not from the side bar view), Properties editors are plain fields.

**Live Linux desktop (2026-10-07, 192.168.1.100, Ubuntu 24.04.5, GNOME on Xorg, VS Code 1.140 snap, the VSIX
installed with `code --install-extension`, clones of `core` and `drive` from GitLab):** the designer renders
WaffleMenu and drive's DriveSettingsPage; the palette's drag and drop inserts at the marker; a click on the surface
selects the element, moves the XML caret and fills Properties; `Text` edited in Properties is written to the XML
and rendered; a double-click creates `label_click` in `WaffleMenu.ts` (built-in fallback, no language server on
Linux); F7 opens the code-behind. Differences from Xvfb: none in behaviour; the window manager and DPI are real,
and a first opening of a folder is in **Restricted Mode** — the extension now declares limited support (designer
on, language server off until the workspace is trusted). In bundled mode drive's own translations are not loaded
(keys such as `drive_settings_title` show), as in Visual Studio's bundled mode — the project-mode page (VSC-2)
loads them.
