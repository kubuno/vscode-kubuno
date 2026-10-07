import * as assert from 'node:assert'
import { applySplices, KbviewDocument } from '../../src/views/kbviewModel'
import { codeBehindEdits, defaultHandlerName } from '../../src/views/handlerFallback'

const VIEW = `<!-- c -->
<UserControl x:Props="P" OnLoad="x_load">
  <Stack Gap="8">
    <Label Text="a &amp; b"/>
    <Button x:Name="ok" Text="OK"/>
  </Stack>
  <Panel/>
</UserControl>
`

const apply = (text: string, f: (d: KbviewDocument) => ReturnType<KbviewDocument['apply']>): string => applySplices(text, f(new KbviewDocument(text)))

suite('kbview model (fallback without the language server)', () => {
  test('stable ids are element-child ordinal paths', () => {
    const d = new KbviewDocument(VIEW)
    assert.strictEqual(d.root?.name, 'UserControl')
    assert.strictEqual(d.resolve('0')?.name, 'Stack')
    assert.strictEqual(d.resolve('0.1')?.name, 'Button')
    assert.strictEqual(d.resolve('1')?.name, 'Panel')
    assert.strictEqual(d.attribute('0.0', 'Text'), 'a & b')
    assert.strictEqual(d.elementAt(VIEW.indexOf('Text="OK"'))?.id, '0.1')
    assert.strictEqual(d.resolve('9'), undefined)
  })
  test('setAttribute replaces a value or adds the attribute', () => {
    assert.match(apply(VIEW, (d) => d.setAttribute('0', 'Gap', '24')), /<Stack Gap="24">/)
    assert.match(apply(VIEW, (d) => d.setAttribute('0.1', 'Variant', 'Ghost')), /<Button x:Name="ok" Text="OK" Variant="Ghost"\/>/)
    assert.match(apply(VIEW, (d) => d.setAttribute('1', 'Padding', '4')), /<Panel Padding="4"\/>/)
    assert.deepStrictEqual(new KbviewDocument(VIEW).setAttribute('7', 'X', '1'), [])
  })
  test('removeAttribute / removeElement keep the layout tidy', () => {
    assert.match(apply(VIEW, (d) => d.removeAttribute('0', 'Gap')), /<Stack>/)
    const out = apply(VIEW, (d) => d.removeElement('0.0'))
    assert.ok(!out.includes('<Label'))
    assert.match(out, /<Stack Gap="8">\n    <Button/)
  })
  test('insertChild at an index, at the end, and into a self-closing element', () => {
    assert.match(apply(VIEW, (d) => d.insertChild('0', 1, '<Label />')), /<Label Text="a &amp; b"\/>\n    <Label \/>\n    <Button/)
    assert.match(apply(VIEW, (d) => d.insertChild('0', 9, '<Label />')), /<Button x:Name="ok" Text="OK"\/>\n    <Label \/>\n  <\/Stack>/)
    assert.match(apply(VIEW, (d) => d.insertChild('1', 0, '<Label />')), /<Panel>\n    <Label \/>\n  <\/Panel>/)
  })
  test('moveElement uses Vec semantics (the index once the element is removed)', () => {
    const down = apply(VIEW, (d) => d.moveElement('0.0', '0', 1))
    assert.ok(down.indexOf('<Button') < down.indexOf('<Label'), down)
    const across = apply(VIEW, (d) => d.moveElement('0.1', '1', 0))
    assert.match(across, /<Panel>\n    <Button x:Name="ok" Text="OK"\/>\n  <\/Panel>/)
    assert.deepStrictEqual(new KbviewDocument(VIEW).moveElement('0', '0.1', 0), [])
  })
  test('handler names and code-behind edits follow kubuno/createHandler', () => {
    assert.strictEqual(defaultHandlerName('Button', 'ok_button', false, 'X', 'OnClick'), 'ok_button_click')
    assert.strictEqual(defaultHandlerName('Label', undefined, false, 'X', 'OnClick'), 'label_click')
    assert.strictEqual(defaultHandlerName('UserControl', undefined, true, 'AccountMenu', 'OnLoad'), 'account_menu_load')
    const ts = `import { bind, type MouseEventArgs } from '@kubuno/views'\nimport { ViewBase } from './X.kbcontrol'\n\nexport class X extends ViewBase {\n  a(): void {\n    const s = '}'\n  }\n}\n`
    const edits = codeBehindEdits(ts, 'label_click', 'Label', 'MouseEventArgs', true)!
    let out = ts
    for (const e of [...edits].sort((a, b) => b.offset - a.offset)) out = out.slice(0, e.offset) + e.text + out.slice(e.replaceEnd ?? e.offset)
    assert.match(out, /import \{ bind, type MouseEventArgs, type Label \} from '@kubuno\/views'/)
    assert.match(out, /  }\n\n  label_click\(_sender: Label, _e: MouseEventArgs\): void \{\n    \/\/ TODO: implement label_click\n  \}\n\}\n$/)
  })
})
