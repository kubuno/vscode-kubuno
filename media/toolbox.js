// The Toolbox view: groups of elements, a filter, drag and drop onto the designer, click-to-place, double-click to insert.
;(function () {
  const vscode = acquireVsCodeApi()
  const app = document.getElementById('app')
  const state = vscode.getState() || { filter: '', collapsed: {} }
  let model = null
  const TOOL_MIME = 'application/vnd.kubuno.toolbox-item'
  let armed = null
  let armTimer = null

  function el(tag, cls, text) {
    const e = document.createElement(tag)
    if (cls) e.className = cls
    if (text !== undefined) e.textContent = text
    return e
  }

  function initials(name) {
    const caps = name.replace(/[^A-Z]/g, '')
    return (caps.length >= 2 ? caps.slice(0, 2) : name.slice(0, 2)).toUpperCase()
  }

  function render() {
    app.textContent = ''
    const search = el('input', 'kb-search')
    search.type = 'search'
    search.placeholder = 'Search Toolbox'
    search.value = state.filter
    search.addEventListener('input', () => {
      state.filter = search.value
      vscode.setState(state)
      renderGroups(list)
    })
    app.appendChild(search)
    const list = el('div', 'kb-groups')
    app.appendChild(list)
    renderGroups(list)
  }

  function renderGroups(list) {
    list.textContent = ''
    if (!model || !model.groups.length) {
      list.appendChild(el('p', 'kb-empty', model && model.file ? 'No elements for this view.' : 'Open a .kbview or .kbcontrol in the Kubuno View Designer to see its Toolbox.'))
      return
    }
    const f = state.filter.trim().toLowerCase()
    for (const g of model.groups) {
      const items = g.items.filter((i) => !f || i.name.toLowerCase().includes(f))
      if (!items.length) continue
      const head = el('div', 'kb-group-head')
      const collapsed = !f && state.collapsed[g.name]
      head.textContent = (collapsed ? '▸ ' : '▾ ') + g.name
      head.addEventListener('click', () => {
        state.collapsed[g.name] = !state.collapsed[g.name]
        vscode.setState(state)
        renderGroups(list)
      })
      list.appendChild(head)
      if (collapsed) continue
      for (const i of items) {
        const row = el('div', 'kb-item' + (i.project ? ' kb-project' : ''))
        row.draggable = true
        row.tabIndex = 0
        row.title = i.doc || i.name
        row.dataset.name = i.name
        row.appendChild(el('span', 'kb-icon', initials(i.name)))
        row.appendChild(el('span', 'kb-name', i.name))
        // A private MIME type only: VS Code hands drags carrying text/plain, URIs or files to the workbench and
        // blocks the webviews meanwhile; this one stays a plain HTML5 drag the designer page receives.
        row.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData(TOOL_MIME, i.name)
          e.dataTransfer.effectAllowed = 'copy'
          vscode.postMessage({ type: 'dragStart', name: i.name })
        })
        row.addEventListener('dragend', () => vscode.postMessage({ type: 'dragEnd' }))
        if (armed === i.name) row.classList.add('kb-armed')
        // A click arms the tool (the next click on the design surface places it); a double-click inserts it
        // into the selection. The click waits a little so a double-click does not arm first.
        row.addEventListener('click', () => {
          clearTimeout(armTimer)
          armTimer = setTimeout(() => {
            armed = armed === i.name ? null : i.name
            vscode.postMessage({ type: 'arm', name: armed })
            renderGroups(document.querySelector('.kb-groups'))
          }, 250)
        })
        row.addEventListener('dblclick', () => {
          clearTimeout(armTimer)
          armed = null
          vscode.postMessage({ type: 'insert', name: i.name })
        })
        row.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') vscode.postMessage({ type: 'insert', name: i.name })
        })
        list.appendChild(row)
      }
    }
  }

  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'disarmed') {
      armed = null
      const list = document.querySelector('.kb-groups')
      if (list) renderGroups(list)
      return
    }
    if (e.data && e.data.type === 'toolbox') {
      model = e.data
      const list = document.querySelector('.kb-groups')
      if (list) renderGroups(list)
      else render()
    }
  })
  render()
  vscode.postMessage({ type: 'ready' })
})()
