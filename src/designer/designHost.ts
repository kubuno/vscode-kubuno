/**
 * The design page in a VS Code webview: the static build of `@kubuno/host-runtime` (the same page Visual Studio
 * shows in WebView2, vskubuno docs/WEB-VIEWS.md §18), loaded from the extension's `dist/design-host/` (or the
 * folder of `kubuno.designer.hostRuntimePath`).
 *
 * The page speaks to its host through `window.chrome.webview` (WebView2's API). Here a small shim placed before
 * the page's own script maps it onto the webview API: `postMessage` → `acquireVsCodeApi().postMessage`, the
 * `message` listeners ← the webview's `message` events. Nothing else of the page changes.
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

/** The shim: WebView2's `window.chrome.webview` over the VS Code webview API. */
const SHIM = `
(function () {
  const vscode = acquireVsCodeApi();
  const listeners = [];
  const deliver = function (data) {
    for (const l of listeners) { try { l({ data: data }); } catch (err) { console.error(err); } }
  };
  // Toolbox placement, Windows Forms style: a Toolbox item is armed (kbArmTool), then a click on the surface
  // places it. VS Code blocks pointer events on every webview while an HTML5 drag is in progress, so a drag from
  // the Toolbox view never reaches this page; the armed tool drives the page's own host-drag protocol instead
  // (dragEnter / dragOver / drop / dragLeave, as Visual Studio's OLE drop target does).
  let armed = null;
  const disarm = function (used) {
    if (armed === null) return;
    armed = null;
    document.documentElement.style.cursor = '';
    deliver({ type: 'dragLeave' });
    vscode.postMessage({ type: 'kbToolDisarmed', used: used });
  };
  window.addEventListener('pointermove', function (e) {
    if (armed !== null) deliver({ type: 'dragOver', x: e.clientX, y: e.clientY });
  }, true);
  const swallow = function (e) {
    if (armed === null) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  window.addEventListener('pointerdown', swallow, true);
  window.addEventListener('pointerup', swallow, true);
  window.addEventListener('click', function (e) {
    if (armed === null) return;
    swallow(e);
    deliver({ type: 'drop', x: e.clientX, y: e.clientY });
    armed = null;
    document.documentElement.style.cursor = '';
    vscode.postMessage({ type: 'kbToolDisarmed', used: true });
  }, true);
  window.addEventListener('keydown', function (e) {
    if (armed !== null && e.key === 'Escape') { swallow(e); disarm(false); }
  }, true);
  window.addEventListener('message', function (e) {
    const d = e.data;
    if (d && d.type === 'kbArmTool') {
      if (d.name) {
        armed = d.name;
        document.documentElement.style.cursor = 'copy';
        deliver({ type: 'dragEnter', component: d.name });
      } else disarm(false);
      return;
    }
    deliver(d);
  });
  const webview = {
    postMessage: function (m) { vscode.postMessage(m); },
    addEventListener: function (type, l) { if (type === 'message') listeners.push(l); },
    removeEventListener: function (type, l) { const k = listeners.indexOf(l); if (k >= 0) listeners.splice(k, 1); },
  };
  window.chrome = Object.assign(window.chrome || {}, { webview: webview });
  window.addEventListener('error', function (e) {
    vscode.postMessage({ type: 'surfaceError', message: String(e.message || e), line: e.lineno || 0, column: e.colno || 0 });
  });
  window.addEventListener('unhandledrejection', function (e) {
    vscode.postMessage({ type: 'log', message: 'unhandled rejection: ' + String(e.reason && (e.reason.stack || e.reason.message) || e.reason) });
  });
})();
`

export function designPageHtml(webview: vscode.Webview, dir: string): string {
  const index = path.join(dir, 'index.html')
  if (!fs.existsSync(index)) {
    return `<!doctype html><html><body style="font-family:sans-serif;padding:16px;color:var(--vscode-foreground)">
      <h3>Kubuno designer</h3><p>The design host page is missing (<code>${escapeHtml(index)}</code>).
      Build the extension (<code>npm run build</code>) or set <code>kubuno.designer.hostRuntimePath</code>.</p></body></html>`
  }
  const nonce = crypto.randomBytes(16).toString('base64')
  const base = webview.asWebviewUri(vscode.Uri.file(dir)).toString().replace(/\/?$/, '/')
  const src = webview.cspSource
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
    <script nonce="${nonce}">${SHIM}</script>`
  return html.replace(/<head>/i, `<head>\n    ${head}`)
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
