/**
 * The MiniMax Code CLI (`mcode`): locating it and running its installer.
 *
 * MiniMax ships `@minimax-ai/code` as a global npm package whose `mcode`
 * launcher is a Node shim. Its native SQLite dependency is installed by a
 * postinstall script, and npm 12 blocks install scripts unless they are named
 * with `--allow-scripts`; a plain `npm i -g` leaves a CLI that cannot start.
 * The installer below therefore passes the flags the package documents.
 *
 * @module dsh-agent-sdk-bridge/minimax-cli
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, delimiter } from 'node:path'
import { TextDecoder } from 'node:util'

/** How to invoke the CLI: an executable plus its leading arguments. */
export interface MinimaxCliSpec {
  command: string
  args: string[]
  /** The JavaScript entry, when the launcher resolves to one. */
  cliPath?: string
}

/** The npm package and the version verified to work with native SQLite. */
const PACKAGE = '@minimax-ai/code'
const INSTALL_VERSION = '0.6.12'
const INSTALL_FLAGS = [
  '--ignore-scripts=false',
  '--include=optional',
  '--allow-scripts=@minimax-ai/code,better-sqlite3',
  '--registry', 'https://registry.npmjs.org/',
  '--foreground-scripts',
]

function fromJsEntry(path: string): MinimaxCliSpec {
  return { command: process.execPath, args: [path], cliPath: path }
}

function fromShim(shim: string): MinimaxCliSpec | undefined {
  if (shim.endsWith('.cmd') || shim.endsWith('.bat')) {
    // npm's Windows shim forwards to the package's cli.js. Reading it avoids a
    // cmd.exe layer, which keeps ACP's stdio byte-clean.
    try {
      const text = readFileSync(shim, 'utf8')
      const match = /["']([^"']*node_modules[\\/]@minimax-ai[\\/]code[\\/]cli\.js)["']/.exec(text)
      if (match !== null && existsSync(match[1])) return fromJsEntry(match[1])
    } catch {
      // Fall through to the sibling-package guess below.
    }
    const sibling = join(dirname(shim), 'node_modules', '@minimax-ai', 'code', 'cli.js')
    if (existsSync(sibling)) return fromJsEntry(sibling)
    return {
      command: process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/c', shim],
    }
  }
  if (shim.endsWith('.js') || shim.endsWith('.mjs')) return fromJsEntry(shim)
  try {
    const real = realpathSync(shim)
    if (real.endsWith('.js') || real.endsWith('.mjs')) return fromJsEntry(real)
  } catch {
    // A path that cannot be resolved is still usable as a command.
  }
  return { command: shim, args: [] }
}

/**
 * Locate `mcode`.
 *
 * `MCODE_CLI_PATH` wins (a cli.js path or an executable); otherwise the PATH
 * shims and the global npm prefixes are checked. The explicit cli.js lookup
 * matters on Windows, where spawning a `.cmd` for ACP would put cmd.exe between
 * the protocol streams.
 */
export function resolveMinimaxCli(): MinimaxCliSpec | undefined {
  const override = process.env.MCODE_CLI_PATH?.trim()
  if (override !== undefined && override.length > 0 && existsSync(override)) {
    return fromShim(override)
  }

  const names = process.platform === 'win32'
    ? ['mcode.cmd', 'mcode.exe', 'mcode']
    : ['mcode']
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (directory.trim() === '') continue
    for (const name of names) {
      const candidate = join(directory, name)
      if (existsSync(candidate)) return fromShim(candidate)
    }
  }

  const home = homedir()
  const candidates = process.platform === 'win32'
    ? [
        join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'npm', 'node_modules', PACKAGE, 'cli.js'),
        join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'npm', 'node_modules', PACKAGE, 'cli.js'),
        join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', 'node_modules', PACKAGE, 'cli.js'),
      ]
    : [
        join(home, '.npm-global', 'lib', 'node_modules', PACKAGE, 'cli.js'),
        join('/usr', 'local', 'lib', 'node_modules', PACKAGE, 'cli.js'),
        join('/usr', 'lib', 'node_modules', PACKAGE, 'cli.js'),
        join(home, '.local', 'lib', 'node_modules', PACKAGE, 'cli.js'),
      ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return fromJsEntry(candidate)
  }
  return undefined
}

/** The spawn argument list for one CLI invocation. */
export function minimaxCliArgs(spec: MinimaxCliSpec, args: readonly string[]): string[] {
  return [...spec.args, ...args]
}

/** What the settings page may ask the installer to do. */
export type MinimaxSetupMode = 'install' | 'uninstall'

/** Whether a value names an installer action. */
export function isMinimaxSetupMode(value: unknown): value is MinimaxSetupMode {
  return value === 'install' || value === 'uninstall'
}

/** One installer run's state, kept for the process lifetime. */
interface SetupRun {
  child: ChildProcess
  mode: MinimaxSetupMode
  startedAt: number
  finishedAt?: number
  code?: number | null
  lines: string[]
  pending: string
  decoder: TextDecoder
  truncated: boolean
}

/** Cap on kept output. */
const MAX_LINES = 400

let current: SetupRun | undefined

/** Snapshot the page polls. */
export interface MinimaxSetupStatus {
  running: boolean
  mode?: MinimaxSetupMode
  startedAt?: number
  finishedAt?: number
  code?: number | null
  lines: string[]
  truncated: boolean
  installed: boolean
  cliPath?: string
}

function absorb(run: SetupRun, chunk: Uint8Array, done: boolean): void {
  run.pending += run.decoder.decode(chunk, { stream: !done })
  const parts = run.pending.split(/\r\n|\r|\n/)
  run.pending = done ? '' : (parts.pop() ?? '')
  for (const part of parts) {
    if (part.trim() === '') continue
    run.lines.push(part)
  }
  if (done && run.pending.trim() !== '') run.lines.push(run.pending.trim())
  while (run.lines.length > MAX_LINES) {
    run.lines.shift()
    run.truncated = true
  }
}

/**
 * Start the npm installer or uninstaller.
 *
 * The command is fixed: the mode is an allow-list and no user input reaches
 * argv. npm itself is run through cmd.exe on Windows because npm is a `.cmd`
 * shim and Node refuses to spawn it directly on recent versions.
 */
export function startMinimaxSetup(
  mode: MinimaxSetupMode,
  onFinish?: (code: number | null) => void,
): { started: true } | { started: false, reason: 'busy' | 'unsupported', error: string } {
  if (current !== undefined && current.finishedAt === undefined) {
    return { started: false, reason: 'busy', error: '已经有一次 MiniMax CLI 安装在跑了，请等它结束。' }
  }
  if (process.platform !== 'win32' && mode === 'install') {
    return {
      started: false,
      reason: 'unsupported',
      error: '一键安装 MiniMax CLI 目前只支持 Windows；请在终端手动执行 npm install -g @minimax-ai/code。',
    }
  }

  const npmArgs = mode === 'install'
    ? ['install', '--global', `${PACKAGE}@${INSTALL_VERSION}`, ...INSTALL_FLAGS]
    : ['uninstall', '--global', PACKAGE]
  const command = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'npm'
  const args = process.platform === 'win32'
    ? ['/d', '/c', 'npm', ...npmArgs]
    : npmArgs

  const run: SetupRun = {
    child: undefined as unknown as ChildProcess,
    mode,
    startedAt: Date.now(),
    lines: [],
    pending: '',
    decoder: new TextDecoder('utf-8'),
    truncated: false,
  }
  const child = spawn(command, args, {
    cwd: homedir(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  run.child = child
  current = run

  const finish = (code: number | null): void => {
    if (run.finishedAt !== undefined) return
    run.finishedAt = Date.now()
    run.code = code
    try {
      onFinish?.(code)
    } catch (error) {
      run.lines.push(`收尾回调失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  child.stdout?.on('data', (chunk: Buffer) => absorb(run, chunk, false))
  child.stderr?.on('data', (chunk: Buffer) => absorb(run, chunk, false))
  child.on('error', error => {
    run.lines.push(`无法启动 npm：${error instanceof Error ? error.message : String(error)}`)
    finish(null)
  })
  child.on('close', code => {
    absorb(run, new Uint8Array(), true)
    finish(code)
  })
  return { started: true }
}

/** The latest installer run, with any not-yet-newlined tail included. */
export function readMinimaxSetupStatus(): MinimaxSetupStatus {
  const spec = resolveMinimaxCli()
  const installed = spec !== undefined
  if (current === undefined) {
    return { running: false, lines: [], truncated: false, installed, ...spec?.cliPath === undefined ? {} : { cliPath: spec.cliPath } }
  }
  const run = current
  const lines = run.pending.trim() === ''
    ? run.lines
    : [...run.lines, run.pending.trim()]
  return {
    running: run.finishedAt === undefined,
    mode: run.mode,
    startedAt: run.startedAt,
    ...run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt, code: run.code ?? null },
    lines,
    truncated: run.truncated,
    installed,
    ...spec?.cliPath === undefined ? {} : { cliPath: spec.cliPath },
  }
}

/** Abandon a running installer. */
export function stopMinimaxSetup(): void {
  if (current !== undefined && current.finishedAt === undefined) current.child.kill()
}

/** A small object facade for callers that prefer a service shape. */
export class MinimaxCliSetup {
  readonly start = startMinimaxSetup
  readonly status = readMinimaxSetupStatus
  readonly stop = stopMinimaxSetup
}
