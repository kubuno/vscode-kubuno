# Kubuno for Visual Studio Code

Design and edit [Kubuno](https://github.com/kubuno) views — `.kbview` pages and `.kbcontrol` user controls of the
web UI — in Visual Studio Code, on Windows, Linux and macOS.

It is the cross-platform counterpart of **vskubuno**, the Visual Studio 2026 extension, and reuses its parts:
the same design page (`@kubuno/host-runtime`), the same language server (`kubuno-views-ls`) and the same
editing protocol. The study behind it, with the feature parity matrix and the plan, is in
[`docs/VSCODE.md`](docs/VSCODE.md).

## Features

- **Kubuno View Designer** — opening a `.kbview` / `.kbcontrol` of a web project shows the view rendered by the
  real Kubuno runtime (React, `@ui`, themes, fonts, translations), with the XML in a text editor beside it.
  Selecting on the surface moves the XML caret, moving the XML caret selects on the surface. Move, resize,
  reorder, delete, copy/paste and duplicate are written to the XML as ordinary, undoable edits.
- **Toolbox** — every element of the project's registry, grouped, filterable, with the project's own controls
  and user controls. Click an item, then click the surface to place it (or double-click to insert it into the
  selection).
- **Properties** — the selection's properties by category with enum and boolean pickers, and its events: ⚡
  creates the handler in the TypeScript code-behind (or opens it). Double-clicking an element creates its
  default event handler.
- **Language server** — completion, hover, diagnostics, outline and go-to-definition from `kubuno-views-ls`
  when it is available for the OS (setting `kubuno.languageServer.path`, `bin/<platform>-<arch>/` of the
  extension, or the `PATH`). Without it the designer still works: it edits the XML itself and shows the
  compiler's diagnostics.
- **Projects** — the Kubuno modules of the workspace, their platforms and their views by folder.
- **F7** toggles view and code-behind; **Shift+F7** opens the designer from the code-behind.

## Build

```bash
npm install
npm run build        # bundles the extension and copies @kubuno/host-runtime's page to dist/design-host
npm run typecheck
npm test             # real VS Code (downloaded), workspace copied from ../core and ../drive
npm run package      # vscode-kubuno-<version>.vsix
```

On Linux without a display: `xvfb-run -a npm test`. Environment for the tests: `KUBUNO_SRC` (the folder holding
`core/` and `drive/`), `KUBUNO_VIEWS_LS` (a language server executable), `KUBUNO_VSCODE` (a VS Code executable).

## License

AGPL-3.0-or-later.
