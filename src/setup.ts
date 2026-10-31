/**
 * Runs the bundled Windows helper that installs and signs into a Qoder CLI
 * (one helper per edition: `qoderclicn` for CN, `qodercli` for international).
 *
 * The settings page cannot do this by itself: a browser has no way to start a
 * local process, and the plugin's own process is the one that already talks to
 * the CLI. So the page asks this module, and this module spawns
 * {@link SCRIPT_NAME} — the same script a user can double-click — with one of
 * two fixed flags, and buffers its output so the page can show progress while
 * the browser sign-in is still open.
 *
 * Nothing user-supplied reaches the command line: the mode is an allow-list of
 * two keys mapped to two literal flags, and the script path comes from this
 * package's own layout. The helper is idempotent, so a second press re-checks
 * rather than reinstalling.
 *
 * @module dsh-agent-sdk-bridge/setup
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TextDecoder } from 'node:util'
import type { QoderBrand } from './brand.ts'
import { brandProfile } from './brand.ts'
import { installedCliVersion, requiredCliVersion, resolveQoderCli } from './cli.ts'

/** File name of the CN helper, shipped under this package's `scripts/` directory. */
export const SCRIPT_NAME = 'setup-qoderclicn.bat'

/** The helper script for one edition. */
export function scriptNameOf(brand: QoderBrand): string {
  return brandProfile(brand).setupScript ?? SCRIPT_NAME
}

/** What the page may ask for: install/sign in, only sign in, sign out, uninstall. */
export type SetupMode = 'configure' | 'login' | 'logout' | 'uninstall'

/** The one command-line flag each mode maps to. Never a user-supplied string. */
const FLAGS: Record<SetupMode, string> = {
  configure: '--gui',
  login: '--login',
  logout: '--logout',
  uninstall: '--uninstall',
}

/** Whether a value is one of the modes the page may request. */
export function isSetupMode(value: unknown): value is SetupMode {
  return value === 'configure' || value === 'login' || value === 'logout' || value === 'uninstall'
}

/** Cap on kept output, so a chatty `npm install` cannot grow without bound. */
const MAX_LINES = 400

/** One run's state, kept for the lifetime of the process plus its tail. */
interface Run {
  child: ChildProcess
  brand: QoderBrand
  mode: SetupMode
  startedAt: number
  finishedAt?: number
  code?: number | null
  lines: string[]
  /** Text decoded but not yet terminated by a newline. */
  pending: string
  decoder: TextDecoder
  truncated: boolean
  /** Set when the page cancelled this run, so it can say so instead of a code. */
  cancelled?: boolean
}

/** The latest run per edition: the two installers may run independently. */
const current = new Map<QoderBrand, Run>()

/** Snapshot the page polls. Always safe to render; empty before the first run. */
export interface SetupStatus {
  running: boolean
  mode?: SetupMode
  startedAt?: number
  finishedAt?: number
  /** Exit code once finished; `null` when the process could not be started. */
  code?: number | null
  lines: string[]
  truncated: boolean
  /**
   * Whether this edition's CLI is on the machine right now.
   *
   * Read from the same lookup a session uses, not from the last run's exit
   * code: after an uninstall the page must offer "install" again, and a run
   * that ended successfully months ago says nothing about today's machine.
   */
  installed: boolean
  /** Version of the installed CLI, when its package manifest could be read. */
  cliVersion?: string
  /** Version this plugin's SDK speaks; the helper installs exactly this one. */
  requiredCliVersion?: string
  /**
   * The installed CLI speaks a different protocol build than the SDK.
   *
   * Sessions then die with a bare exit code, so the page warns here — before a
   * sign-in — instead of letting the user log in and hit the failure in chat.
   */
  versionMismatch?: boolean
  /** Whether the last run was stopped from the page rather than finishing. */
  cancelled?: boolean
}

/**
 * Locate one edition's helper inside this package.
 *
 * The host half is bundled to `lib/index.js`, and tests import `src/*.ts`, so
 * both layouts resolve to the same `scripts/` directory one level up.
 *
 * @param brand - which edition's script to find.
 */
export function setupScriptPath(brand: QoderBrand = 'cn'): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const script = scriptNameOf(brand)
  for (const candidate of [
    path.resolve(here, '..', 'scripts', script),
    path.resolve(here, 'scripts', script),
  ]) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** Append decoded text to a run, splitting it into displayable lines. */
function absorb(run: Run, chunk: Uint8Array, done: boolean): void {
  run.pending += run.decoder.decode(chunk, { stream: !done })
  const parts = run.pending.split(/\r\n|\r|\n/)
  run.pending = done ? '' : (parts.pop() ?? '')
  for (const part of parts) {
    // cmd.exe echoes a bare prompt line as whitespace-only; keep the tail dense.
    if (part.trim() === '') continue
    run.lines.push(part)
  }
  if (done && run.pending.trim() !== '') run.lines.push(run.pending.trim())
  while (run.lines.length > MAX_LINES) {
    run.lines.shift()
    run.truncated = true
  }
}

/** Why a run could not start, so the caller can pick a status of its own. */
export type SetupFailure = 'busy' | 'unsupported' | 'missing-script'

/**
 * Start one edition's helper. Only one run per edition at a time; a finished
 * one stays readable.
 *
 * @param brand - which edition to configure.
 * @param mode - the fixed flag the page may ask for.
 * @param onFinish - called once with the exit code.
 */
export function startSetup(
  brand: QoderBrand,
  mode: SetupMode,
  onFinish?: (code: number | null) => void,
): { started: true } | { started: false; reason: SetupFailure; error: string } {
  const previous = current.get(brand)
  if (previous !== undefined && previous.finishedAt === undefined) {
    return { started: false, reason: 'busy', error: '已经有一次配置在跑了，请等它结束。' }
  }
  if (process.platform !== 'win32') {
    const command = brandProfile(brand).cliCommands[0]
    const action = mode === 'uninstall'
      ? '卸载'
      : mode === 'logout' ? '退出登录' : mode === 'login' ? '重新登录' : '配置'
    return {
      started: false,
      reason: 'unsupported',
      error: `一键${action}只支持 Windows，请在 CLI 所在机器上手动处理 ${command}。`,
    }
  }
  const script = setupScriptPath(brand)
  if (script === undefined) {
    return {
      started: false,
      reason: 'missing-script',
      error: `插件包里没有 ${scriptNameOf(brand)}，缺少 scripts/ 目录。`,
    }
  }

  const run: Run = {
    child: undefined as unknown as ChildProcess,
    brand,
    mode,
    startedAt: Date.now(),
    lines: [],
    pending: '',
    decoder: new TextDecoder('utf-8'),
    truncated: false,
  }
  // The helper writes nothing to stdin, and its own child CLI resolves its home
  // from it, so run from the user's home rather than inside the package.
  const child = spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', script, FLAGS[mode]], {
    cwd: homedir(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  run.child = child
  current.set(brand, run)

  // Settles the run exactly once and hands the caller the exit code, so the
  // page's next read of the catalog is not served from a pre-login snapshot.
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
    run.lines.push(`无法启动 ${scriptNameOf(brand)}：${error instanceof Error ? error.message : String(error)}`)
    finish(null)
  })
  child.on('close', code => {
    absorb(run, new Uint8Array(), true)
    finish(code)
  })
  return { started: true }
}

/**
 * The latest run of one edition, with any not-yet-newlined tail included for
 * live display.
 *
 * @param brand - which edition's run to report.
 */
export function readSetupStatus(brand: QoderBrand = 'cn'): SetupStatus {
  const installed = resolveQoderCli(brand) !== undefined
  const cliVersion = installed ? installedCliVersion(brand) : undefined
  const required = requiredCliVersion(brand)
  const build = {
    installed,
    ...cliVersion === undefined ? {} : { cliVersion },
    ...required === undefined ? {} : { requiredCliVersion: required },
    // Unknown on either side is not a mismatch: a native build carries no
    // manifest, and warning about a version nobody could read would be noise.
    ...cliVersion === undefined || required === undefined
      ? {}
      : { versionMismatch: cliVersion !== required },
  }
  const run = current.get(brand)
  if (run === undefined) return { running: false, lines: [], truncated: false, ...build }
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
    ...build,
    ...run.cancelled === true ? { cancelled: true } : {},
  }
}

/**
 * Abandon the running helper for one edition.
 *
 * `qodercli login` waits for the browser to finish the callback, so closing
 * that tab left the page polling a process that would never return. Killing
 * the run turns it into a finished one (`code` null) so the page can offer the
 * buttons again instead of showing a spinner forever.
 *
 * @param brand - which edition's run to stop.
 * @returns whether a run was actually in flight.
 */
export function cancelSetup(brand: QoderBrand): boolean {
  const run = current.get(brand)
  if (run === undefined || run.finishedAt !== undefined) return false
  run.lines.push('已取消：这次配置被手动终止，可以重新操作。')
  run.cancelled = true
  try {
    run.child.kill()
  } catch {
    // Already gone; settling below still releases the page.
  }
  // The child's `close` handler may arrive later (or never, if it never
  // spawned); settle here so the page is not left waiting on it. `finish()`
  // refuses to touch a settled run, so the late event cannot overwrite this.
  run.finishedAt = Date.now()
  run.code = null
  return true
}

/**
 * Abandon the running helper, if any.
 *
 * Called when the plugin is disposed. Killing `cmd.exe` does not reap the CLI it
 * already launched, but the helper's own wait is bounded, so nothing hangs on
 * the far end.
 */
export function stopSetup(): void {
  for (const run of current.values()) {
    if (run.finishedAt === undefined) run.child.kill()
  }
}
