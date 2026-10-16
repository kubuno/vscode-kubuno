// Loaded before the design page (@kubuno/host-runtime) in the Kubuno View Designer webview.
//
// 1. Bridge: the page speaks to its host through WebView2's `window.chrome.webview`; this maps it onto the VS Code
//    webview API (`postMessage` → `acquireVsCodeApi().postMessage`, `message` listeners ← the webview's messages).
// 2. Toolbox gestures, all driving the page's own host-drag protocol (`dragEnter` / `dragOver` / `drop` /
//    `dragLeave`, the messages Visual Studio's OLE drop target sends), so the page shows its insertion markers
//    and drops at the pointer exactly as in Visual Studio:
//    - drag and drop from the **palette docked in this page** (the Toolbox beside the surface);
//    - drag and drop from the side bar Toolbox view (private MIME type), when VS Code lets the drag reach this
//      page - it blocks every editor webview while a drag crosses the workbench (docs/VSCODE.md §2);
//    - an armed tool (click a Toolbox item, then click the surface), Windows Forms' other gesture.
;(function () {
  'use strict'
  const vscode = acquireVsCodeApi()
  const listeners = []
  const deliver = function (data) {
    for (const l of listeners) {
      try {
        l({ data: data })
      } catch (err) {
        console.error(err)
      }
    }
  }
  const post = function (m) {
    vscode.postMessage(m)
  }

  // ── Host-drag driver ──

  const TOOL_MIME = 'application/vnd.kubuno.toolbox-item'
  let entered = null // the component the page is told is being dragged
  const enter = function (name) {
    if (!name || entered === name) return
    if (entered !== null) deliver({ type: 'dragLeave' })
    entered = name
    deliver({ type: 'dragEnter', component: name })
  }
  const leave = function () {
    if (entered === null) return
    entered = null
    deliver({ type: 'dragLeave' })
  }

  // ── Armed tool (click-to-place) ──

  let armed = null
  const setArmed = function (name, notify) {
    const was = armed
    armed = name
    document.documentElement.style.cursor = name ? 'copy' : ''
    if (name) enter(name)
    else leave()
    if (was && !name && notify !== undefined) post({ type: 'kbToolDisarmed', used: notify })
    palette.render()
  }
  window.addEventListener(
    'pointermove',
    function (e) {
      if (armed !== null && !palette.contains(e.target)) deliver({ type: 'dragOver', x: e.clientX, y: e.clientY })
    },
    true,
  )
  const swallow = function (e) {
    e.preventDefault()
    e.stopImmediatePropagation()
  }
  window.addEventListener('pointerdown', function (e) { if (armed !== null && !palette.contains(e.target)) swallow(e) }, true)
  window.addEventListener('pointerup', function (e) { if (armed !== null && !palette.contains(e.target)) swallow(e) }, true)
  window.addEventListener(
    'click',
    function (e) {
      if (armed === null || palette.contains(e.target)) return
      swallow(e)
      deliver({ type: 'drop', x: e.clientX, y: e.clientY })
      entered = null
      setArmed(null, true)
    },
    true,
  )
  window.addEventListener(
    'keydown',
    function (e) {
      if (armed !== null && e.key === 'Escape') {
        swallow(e)
        setArmed(null, false)
      }
    },
    true,
  )

  // ── HTML5 drag and drop (palette in this page, or the side bar Toolbox) ──

  let toolDrag = null // the item's name: the data is unreadable until the drop, only the types are
  const isTool = function (e) {
    return !!e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], TOOL_MIME) >= 0
  }
  window.addEventListener(
    'dragenter',
    function (e) {
      if (!isTool(e)) return
      swallow(e)
      enter(toolDrag)
    },
    true,
  )
  window.addEventListener(
    'dragover',
    function (e) {
      if (!isTool(e)) return
      swallow(e)
      if (palette.contains(e.target)) {
        e.dataTransfer.dropEffect = 'none'
        return
      }
      e.dataTransfer.dropEffect = 'copy'
      enter(toolDrag)
      if (entered !== null) deliver({ type: 'dragOver', x: e.clientX, y: e.clientY })
    },
    true,
  )
  window.addEventListener(
    'dragleave',
    function (e) {
      if (!isTool(e)) return
      if (e.relatedTarget === null && (e.clientX <= 0 || e.clientY <= 0 || e.clientX >= innerWidth || e.clientY >= innerHeight)) leave()
    },
    true,
  )
  window.addEventListener(
    'drop',
    function (e) {
      if (!isTool(e)) return
      swallow(e)
      const name = e.dataTransfer.getData(TOOL_MIME) || toolDrag
      if (!palette.contains(e.target)) {
        enter(name)
        if (entered !== null) deliver({ type: 'drop', x: e.clientX, y: e.clientY })
        post({ type: 'kbToolDropped', name: name })
      } else leave()
      entered = null
      toolDrag = null
    },
    true,
  )
  window.addEventListener(
    'dragend',
    function () {
      leave()
      toolDrag = null
    },
    true,
  )

  // ── The palette: the Toolbox docked beside the surface ──

  const palette = (function () {
    const state = Object.assign({ open: true, filter: '', collapsed: {} }, (vscode.getState() || {}).palette || {})
    let groups = []
    let enabled = true
    let root = null
    const save = function () {
      const s = vscode.getState() || {}
      s.palette = state
      vscode.setState(s)
    }
    const css = `
      :root { --kb-pal-w: 0px; }
      html.kb-pal-on { --kb-pal-w: 196px; }
      html.kb-pal-on.kb-pal-closed { --kb-pal-w: 26px; }
      html.kb-pal-on .kbd-toolbar, html.kb-pal-on .kbd-canvas { left: var(--kb-pal-w) !important; }
      #kb-palette { position: fixed; left: 0; top: 0; bottom: 0; width: var(--kb-pal-w); z-index: 2147483000; box-sizing: border-box;
        display: none; flex-direction: column; overflow: hidden; user-select: none;
        background: var(--vscode-sideBar-background, #252526); color: var(--vscode-sideBar-foreground, var(--vscode-foreground, #ccc));
        border-right: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
        font: var(--vscode-font-size, 13px)/1.4 var(--vscode-font-family, sans-serif); }
      html.kb-pal-on #kb-palette { display: flex; }
      #kb-palette .kp-head { display: flex; align-items: center; gap: 4px; height: 32px; padding: 0 4px 0 8px; flex: none;
        font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
      #kb-palette .kp-head span { flex: 1; overflow: hidden; white-space: nowrap; }
      #kb-palette .kp-btn { width: 18px; height: 18px; border: 0; padding: 0; background: none; color: inherit; cursor: pointer; border-radius: 3px; }
      #kb-palette .kp-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.2)); }
      html.kb-pal-closed #kb-palette .kp-head span, html.kb-pal-closed #kb-palette .kp-body { display: none; }
      html.kb-pal-closed #kb-palette .kp-head { padding: 0 4px; }
      #kb-palette .kp-search { margin: 0 6px 6px; padding: 3px 6px; box-sizing: border-box; width: calc(100% - 12px); outline: none; font: inherit;
        color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); }
      #kb-palette .kp-search:focus { border-color: var(--vscode-focusBorder); }
      #kb-palette .kp-body { flex: 1; overflow: auto; display: flex; flex-direction: column; }
      #kb-palette .kp-list { flex: 1; overflow: auto; padding-bottom: 8px; }
      #kb-palette .kp-group { padding: 6px 8px 2px; font-size: 11px; font-weight: 600; cursor: pointer; opacity: .85; }
      #kb-palette .kp-item { display: flex; align-items: center; gap: 6px; padding: 2px 8px; cursor: grab; border-radius: 3px; margin: 0 4px; }
      #kb-palette .kp-item:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.15)); }
      #kb-palette .kp-item.kp-armed { background: var(--vscode-list-activeSelectionBackground, #04395e); color: var(--vscode-list-activeSelectionForeground, #fff); }
      #kb-palette .kp-icon { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 16px; border-radius: 3px; flex: none;
        font-size: 9px; font-weight: 700; color: var(--vscode-button-foreground, #fff); background: var(--vscode-button-background, #0e639c); }
      #kb-palette .kp-project .kp-icon { background: var(--vscode-charts-purple, #8a63d2); }
      #kb-palette .kp-empty { padding: 8px; opacity: .7; }
    `
    const initials = function (name) {
      const caps = name.replace(/[^A-Z]/g, '')
      return (caps.length >= 2 ? caps.slice(0, 2) : name.slice(0, 2)).toUpperCase()
    }
    const el = function (tag, cls, text) {
      const e = document.createElement(tag)
      if (cls) e.className = cls
      if (text !== undefined) e.textContent = text
      return e
    }
    let list = null
    let search = null
    let clickTimer = null
    const build = function () {
      if (root || !document.body) return
      const style = el('style')
      style.textContent = css
      document.head.appendChild(style)
      root = el('div')
      root.id = 'kb-palette'
      root.setAttribute('role', 'region')
      root.setAttribute('aria-label', 'Toolbox')
      const head = el('div', 'kp-head')
      const title = el('span', '', 'Toolbox')
      const toggle = el('button', 'kp-btn', '⟨')
      toggle.title = 'Hide or show the Toolbox'
      toggle.addEventListener('click', function () {
        state.open = !state.open
        save()
        apply()
      })
      head.append(title, toggle)
      const body = el('div', 'kp-body')
      search = el('input', 'kp-search')
      search.type = 'search'
      search.placeholder = 'Search Toolbox'
      search.value = state.filter
      search.addEventListener('input', function () {
        state.filter = search.value
        save()
        renderList()
      })
      list = el('div', 'kp-list')
      body.append(search, list)
      root.append(head, body)
      document.body.appendChild(root)
      root._toggle = toggle
      apply()
    }
    const apply = function () {
      const h = document.documentElement
      h.classList.toggle('kb-pal-on', enabled)
      h.classList.toggle('kb-pal-closed', !state.open)
      if (root) root._toggle.textContent = state.open ? '⟨' : '⟩'
      // The page lays its overlay out from the canvas on resize.
      window.dispatchEvent(new Event('resize'))
    }
    const renderList = function () {
      if (!list) return
      list.textContent = ''
      const f = state.filter.trim().toLowerCase()
      let shown = 0
      for (const g of groups) {
        const items = g.items.filter(function (i) { return !f || i.name.toLowerCase().indexOf(f) >= 0 })
        if (!items.length) continue
        const collapsed = !f && state.collapsed[g.name]
        const head = el('div', 'kp-group', (collapsed ? '▸ ' : '▾ ') + g.name)
        head.addEventListener('click', function () {
          state.collapsed[g.name] = !state.collapsed[g.name]
          save()
          renderList()
        })
        list.appendChild(head)
        if (collapsed) continue
        for (const i of items) {
          shown++
          const row = el('div', 'kp-item' + (i.project ? ' kp-project' : '') + (armed === i.name ? ' kp-armed' : ''))
          row.draggable = true
          row.title = (i.doc || i.name) + '\nDrag onto the surface, or click then click the surface; double-click inserts into the selection.'
          row.dataset.name = i.name
          row.append(el('span', 'kp-icon', initials(i.name)), el('span', '', i.name))
          row.addEventListener('dragstart', function (e) {
            if (armed !== null) setArmed(null, false)
            toolDrag = i.name
            e.dataTransfer.setData(TOOL_MIME, i.name)
            e.dataTransfer.effectAllowed = 'copy'
          })
          row.addEventListener('click', function () {
            clearTimeout(clickTimer)
            clickTimer = setTimeout(function () { setArmed(armed === i.name ? null : i.name, false) }, 250)
          })
          row.addEventListener('dblclick', function () {
            clearTimeout(clickTimer)
            if (armed !== null) setArmed(null, false)
            post({ type: 'kbInsert', name: i.name })
          })
          list.appendChild(row)
        }
      }
      if (!shown) list.appendChild(el('div', 'kp-empty', groups.length ? 'No match.' : 'Loading…'))
    }
    return {
      contains: function (t) { return !!root && t instanceof Node && root.contains(t) },
      set: function (m) {
        groups = Array.isArray(m.groups) ? m.groups : []
        enabled = m.enabled !== false
        build()
        apply()
        renderList()
      },
      render: renderList,
    }
  })()

  // ── Bridge ──

  window.addEventListener('message', function (e) {
    const d = e.data
    if (d && typeof d === 'object') {
      if (d.type === 'kbPalette') return palette.set(d)
      if (d.type === 'kbToolDrag') {
        toolDrag = d.name || null
        if (toolDrag === null) leave()
        return
      }
      if (d.type === 'kbArmTool') return setArmed(d.name || null, d.name ? undefined : false)
    }
    deliver(d)
  })
  const webview = {
    postMessage: function (m) { post(m) },
    addEventListener: function (type, l) { if (type === 'message') listeners.push(l) },
    removeEventListener: function (type, l) {
      const k = listeners.indexOf(l)
      if (k >= 0) listeners.splice(k, 1)
    },
  }
  window.chrome = Object.assign(window.chrome || {}, { webview: webview })
  window.addEventListener('error', function (e) {
    post({ type: 'surfaceError', message: String(e.message || e), line: e.lineno || 0, column: e.colno || 0 })
  })
  window.addEventListener('unhandledrejection', function (e) {
    post({ type: 'log', message: 'unhandled rejection: ' + String((e.reason && (e.reason.stack || e.reason.message)) || e.reason) })
  })
})()
