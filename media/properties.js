// The Properties view: the selected element's properties (by category) and events, edited in place.
;(function () {
  const vscode = acquireVsCodeApi()
  const app = document.getElementById('app')
  const state = vscode.getState() || { tab: 'properties' }
  let model = null

  function el(tag, cls, text) {
    const e = document.createElement(tag)
    if (cls) e.className = cls
    if (text !== undefined) e.textContent = text
    return e
  }

  function render() {
    app.textContent = ''
    if (!model || model.type !== 'element') {
      app.appendChild(el('p', 'kb-empty', 'Select an element in the Kubuno View Designer.'))
      return
    }
    const head = el('div', 'kb-prop-head')
    const title = el('div', 'kb-prop-title')
    title.appendChild(el('strong', '', model.xName || '(unnamed)'))
    title.appendChild(el('span', 'kb-dim', '  ' + model.element))
    head.appendChild(title)
    if (model.path.length) {
      const crumbs = el('div', 'kb-crumbs')
      for (const p of model.path) {
        const a = el('a', '', p.name)
        a.href = '#'
        a.addEventListener('click', (e) => {
          e.preventDefault()
          vscode.postMessage({ type: 'select', id: p.id, name: p.name })
        })
        crumbs.appendChild(a)
        crumbs.appendChild(el('span', 'kb-dim', ' › '))
      }
      crumbs.appendChild(el('span', '', model.element))
      head.appendChild(crumbs)
    }
    const tabs = el('div', 'kb-tabs')
    for (const [id, label] of [['properties', 'Properties'], ['events', '⚡ Events']]) {
      const b = el('button', 'kb-tab' + (state.tab === id ? ' kb-on' : ''), label)
      b.addEventListener('click', () => {
        state.tab = id
        vscode.setState(state)
        render()
      })
      tabs.appendChild(b)
    }
    head.appendChild(tabs)
    app.appendChild(head)
    if (!model.known) app.appendChild(el('p', 'kb-warn', 'Unknown element: the registry does not describe ' + model.element + '.'))
    if (state.tab === 'events') renderEvents()
    else renderProperties()
  }

  function renderProperties() {
    const byCat = new Map()
    for (const p of model.properties) {
      if (!byCat.has(p.category)) byCat.set(p.category, [])
      byCat.get(p.category).push(p)
    }
    const table = el('div', 'kb-grid')
    for (const [cat, rows] of byCat) {
      table.appendChild(el('div', 'kb-cat', cat))
      for (const p of rows) {
        const name = el('label', 'kb-pname' + (p.value !== null ? ' kb-set' : ''), p.name)
        name.title = p.doc
        const cell = el('div', 'kb-pval')
        cell.appendChild(editor(p))
        table.appendChild(name)
        table.appendChild(cell)
      }
    }
    app.appendChild(table)
  }

  function commit(p, value) {
    vscode.postMessage({ type: 'set', id: model.id, name: p.name, value })
  }

  function editor(p) {
    const bound = p.value !== null && /^\{/.test(p.value)
    if (!bound && (p.kind === 'enum' || p.kind === 'bool')) {
      const s = el('select', 'kb-input')
      s.dataset.prop = p.name
      const values = p.kind === 'bool' ? ['true', 'false'] : p.values
      const def = el('option', '', p.defaultValue ? '(' + p.defaultValue + ')' : '')
      def.value = ''
      s.appendChild(def)
      for (const v of values) {
        const o = el('option', '', v)
        o.value = v
        s.appendChild(o)
      }
      s.value = p.value === null ? '' : p.value
      s.addEventListener('change', () => commit(p, s.value))
      return s
    }
    const i = el('input', 'kb-input')
    i.dataset.prop = p.name
    i.value = p.value === null ? '' : p.value
    i.placeholder = p.defaultValue
    i.spellcheck = false
    // Enter commits, and so does the blur that follows (focus moving to the surface): commit a value once, not
    // twice - the second identical edit was an extra undo step.
    let committed = p.value === null ? '' : p.value
    const done = () => {
      const v = i.value
      if (committed !== v) {
        committed = v
        commit(p, v)
      }
    }
    i.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done()
      if (e.key === 'Escape') i.value = committed
    })
    i.addEventListener('blur', done)
    return i
  }

  function renderEvents() {
    if (!model.events.length) {
      app.appendChild(el('p', 'kb-empty', 'This element has no events.'))
      return
    }
    const table = el('div', 'kb-grid')
    for (const e of model.events) {
      const name = el('label', 'kb-pname' + (e.handler ? ' kb-set' : ''), e.display)
      name.title = e.doc + (e.args ? '  (' + e.args + ')' : '')
      const cell = el('div', 'kb-pval kb-event')
      const v = el('span', 'kb-handler', e.handler || '')
      const b = el('button', 'kb-btn', e.handler ? 'Go' : '⚡ New')
      b.dataset.event = e.name
      b.title = e.handler ? 'Open the handler' : 'Create a handler in the code-behind'
      b.addEventListener('click', () => vscode.postMessage({ type: 'handler', id: model.id, name: e.name }))
      cell.addEventListener('dblclick', () => vscode.postMessage({ type: 'handler', id: model.id, name: e.name }))
      cell.appendChild(v)
      cell.appendChild(b)
      table.appendChild(name)
      table.appendChild(cell)
    }
    app.appendChild(table)
  }

  window.addEventListener('message', (e) => {
    if (!e.data) return
    const active = document.activeElement
    const editing = active && active.dataset && active.dataset.prop && model && e.data.id === model.id
    model = e.data
    if (editing) {
      // Keep the field being typed in: refresh the other values only.
      const prop = active.dataset.prop
      render()
      const again = app.querySelector('[data-prop="' + CSS.escape(prop) + '"]')
      if (again) again.focus()
    } else render()
  })
  render()
  vscode.postMessage({ type: 'ready' })
})()
