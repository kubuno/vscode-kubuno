import * as vscode from 'vscode'

let channel: vscode.OutputChannel | null = null

export function initLog(): vscode.OutputChannel {
  channel ??= vscode.window.createOutputChannel('Kubuno')
  return channel
}

export function log(message: string): void {
  const time = new Date().toISOString().slice(11, 23)
  initLog().appendLine(`[${time}] ${message}`)
}
