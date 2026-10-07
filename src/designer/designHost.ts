/**
 * The design page in a VS Code webview: the static build of `@kubuno/host-runtime` (the same page Visual Studio
 * shows in WebView2, vskubuno docs/WEB-VIEWS.md §18), loaded from the extension's `dist/design-host/` (or the
 * folder of `kubuno.designer.hostRuntimePath`).
 *
 * The page speaks to its host through `window.chrome.webview` (WebView2's API). `media/designer-shim.js`, a
 * classic script run before the page's module, maps it onto the webview API and adds the Toolbox gestures (the
 * palette docked in the page, drag and drop, click-to-place). Nothing of the page itself changes.
 */
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'

export function designHostDir(context: vscode.ExtensionContext): string {
  const configured = vscode.workspace.getConfiguration('kubuno').get<string>('designer.hostRuntimePath')?.trim()
  if (configured && fs.existsSync(path.join(configured, 'index.html'))) return configured
  return path.join(context.extensionPath, 'dist', 'design-host')
}

export function hostRuntimeVersion(dir: string): string | null {
  try {
    return (JSON.parse(fs.readFileSync(path.join(dir, 'design-host.json'), 'utf8')) as { hostRuntime?: string }).hostRuntime ?? null
  } catch {
    return null
  }
}

export function designPageHtml(webview: vscode.Webview, dir: string, extensionUri: vscode.Uri): string {
  const index = path.join(dir, 'index.html')
  if (!fs.existsSync(index)) {
    return `<!doctype html><html><body style="font-family:sans-serif;padding:16px;color:var(--vscode-foreground)">
      <h3>Kubuno designer</h3><p>The design host page is missing (<code>${escapeHtml(index)}</code>).
      Build the extension (<code>npm run build</code>) or set <code>kubuno.designer.hostRuntimePath</code>.</p></body></html>`
  }
  const nonce = crypto.randomBytes(16).toString('base64')
  const base = webview.asWebviewUri(vscode.Uri.file(dir)).toString().replace(/\/?$/, '/')
  const src = webview.cspSource
  const shim = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'designer-shim.js')).toString()
  const csp = [
    `default-src 'none'`,
    `img-src ${src} data: blob: https: http:`,
    `font-src ${src} data:`,
    `style-src ${src} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}' ${src} 'wasm-unsafe-eval'`,
    `connect-src ${src} data: blob:`,
    `worker-src ${src} blob:`,
  ].join('; ')
  let html = fs.readFileSync(index, 'utf8')
  html = html.replace(/<script\b/g, `<script nonce="${nonce}"`)
  const head = `<meta http-equiv="Content-Security-Policy" content="${csp}">
    <base href="${base}">
    <script nonce="${nonce}" src="${shim}"></script>`
  return html.replace(/<head>/i, `<head>\n    ${head}`)
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
