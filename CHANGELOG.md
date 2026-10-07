# Changelog

All notable changes to this extension are documented here (format: Keep a Changelog).

## [Unreleased]

### Added

- Kubuno View Designer for web `.kbview` / `.kbcontrol` files: the `@kubuno/host-runtime` design page in a
  webview, the XML beside it, selection synchronised both ways, every gesture written to the XML as an undoable
  edit.
- Toolbox docked in the designer with drag and drop onto the surface (insertion markers, drop at the pointer),
  side bar Toolbox view (click-to-place on the surface, double-click to insert into the selection), Properties view
  (properties by category, events with handler creation), Projects view (modules → platforms → views).
- `kubuno-views-ls` client: completion, hover, diagnostics, outline, go-to-definition and the designer's
  requests; a built-in fallback when no server exists for the OS.
- Commands: open designer / XML, view code (F7), create default handler, delete, select parent, new view or
  user control, restart the language server.
- Activity bar and extension icons use the current Kubuno mark (hexagon and cube).
- Restricted Mode support: the designer works in an untrusted workspace, the language server starts once it is
  trusted.
- Integration tests on a real VS Code (`@vscode/test-electron`), screenshot scripts for Linux (Xvfb) and Windows.
- A Linux / Windows test matrix (`docs/VSCODE-TEST-MATRIX.md`).

### Fixed

- Ctrl+Z, Ctrl+Y, Ctrl+S and F7 pressed on the design surface ran twice (one Ctrl+Z undid two edits, F7 opened
  the code-behind and then a second designer): VS Code already forwards these keys to its keybindings.
- A Properties value confirmed with Enter was written a second time when the field lost focus.
- With the language server, an element inserted from the Toolbox was glued to the closing tag of its parent; it
  now gets its own indented line.
- With the language server, a double-click that the server could not resolve created no handler; the built-in
  writer now creates it.
