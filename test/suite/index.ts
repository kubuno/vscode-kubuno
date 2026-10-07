import * as path from 'node:path'
import Mocha from 'mocha'

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: false, timeout: 90_000 })
  mocha.addFile(path.join(__dirname, 'model.test.js'))
  mocha.addFile(path.join(__dirname, 'designer.test.js'))
  return new Promise((resolve, reject) => {
    mocha.run((failures) => (failures ? reject(new Error(`${failures} test(s) failed`)) : resolve()))
  })
}
