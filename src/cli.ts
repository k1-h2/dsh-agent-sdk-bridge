/**
 * Finding the local Qoder CLI of one edition, and the Node that has to run it.
 *
 * The SDK's default transport runs its worker runtime on a Node worker thread,
 * which is a thread *inside* the DSH process. On Windows that puts the worker's
 * bundled sharp (libvips 8.17) into the same address space as DSH's own sharp
 * (libvips 8.18), and the loader satisfies the worker's `libvips-42.dll` import
 * from the module already registered under that name. The ABI mismatch that
 * follows fails every turn carrying an image, with libvips reporting
 * `colourspace: parameter space not set` and the CLI answering
 * `image_processing_failed`.
 *
 * A child process has its own address space, and is how an installed
 * `qoderclicn` runs by itself anyway, so sessions hand the SDK an entry it can
 * spawn. Naming that entry is all it takes: the SDK picks its process transport
 * for any `pathToQoderCLIExecutable` that is not a worker-runtime module, which
 * is exactly the transport that must not be used here.
 *
 * Nothing is invented. The CLI is looked for where the setup helper installs
 * it and where the SDK bundles it; the Node to run it is the host's own, DSH's
 * shipped runtime, or whatever `PATH` answers. When none of that is present the
 * lookup returns nothing and the SDK keeps its default transport — worse for
 * images, but not this module's place to fail a session over.
 *
 * @module dsh-qoder-link/cli
 */

import { existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import * as path from 'node:path'
import type { Options } from '@qodercn-ai/qodercn-agent-sdk'
import type { QoderBrand } from './brand.ts'
import { brandProfile } from './brand.ts'

/** The query options that move a session onto the CLI's own process. */
export type QoderCliOptions = Pick<Options, 'pathToQoderCLIExecutable' | 'executable' | 'env'>

/**
 * The switch that makes the CLI report its real token metering.
 *
 * The CLI prices every provider request, but before a usage record leaves the
 * process it zeroes `input_tokens`, `output_tokens` and both cache buckets
 * unless this switch is on — its own bundle guards the real values with
 * `if (options?.exposeTokenCounts || tokenUsageRequested())`, and otherwise
 * emits `{ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0,
 * cache_read_input_tokens: 0 }` while keeping `credits` and the context ratio.
 * That is why every counter the harness shows is an estimate here, and why
 * `缓存命中` reads 0% no matter how much of a prompt the cache served.
 *
 * The names are the CLI's own env-catalog entries (`ENV_EXPOSE_TOKEN_USAGE`),
 * brand-prefixed per build — the CN CLI reads `QODERCN_…`, the international
 * one `QODER_…` — and both are set because which build answers is the lookup's
 * decision, not this module's. The value is read as a boolean (`1`/`true`/`yes`).
 */
const EXPOSE_TOKEN_USAGE: NodeJS.ProcessEnv = {
  QODERCN_EXPOSE_TOKEN_USAGE: '1',
  QODER_EXPOSE_TOKEN_USAGE: '1',
}

/** A CLI entry that can be spawned, plus the directory of the Node that runs it. */
export interface QoderCli {
  /** Path to the CLI: a native binary, or a script the Node below runs. */
  path: string
  /** Directory holding the interpreter for a script entry; absent for a binary. */
  nodeDir?: string
}

/**
 * What the lookup reads. Injectable so a test can describe a machine instead of
 * having to be one, and so a caller can point the search somewhere else.
 */
export interface CliLookup {
  /** Environment to read; defaults to this process's. */
  env?: NodeJS.ProcessEnv
  /** Platform whose layouts to follow; defaults to this process's. */
  platform?: NodeJS.Platform
  /** File-existence probe; defaults to the real filesystem. */
  exists?(candidate: string): boolean
  /** Directory listing; defaults to the real filesystem. */
  readdir?(dir: string): readonly string[]
  /** The running interpreter; defaults to this process's executable. */
  execPath?: string
  /** Whether that interpreter is Electron rather than Node; defaults to the truth. */
  electron?: boolean
}

/**
 * A CLI the SDK can spawn, or nothing when this machine offers none.
 *
 * Candidates are tried in the order a user's own shell would resolve them:
 * an explicit `QODERCLI_PATH` first, then the npm global roots, then the
 * native builds the SDK and the CLI's own installer place. Each brand only
 * ever sees its own package and state directory — handing the CN SDK the intl
 * CLI (or the other way round) would speak one edition's protocol to the other
 * edition's account. A worker-runtime module is skipped wherever it turns up,
 * since the SDK answers such a path with the in-process worker this module
 * exists to avoid.
 *
 * @param brand - which edition's CLI to look for.
 * @param lookup - the machine to inspect; defaults to this process's.
 */
export function resolveQoderCli(brand: QoderBrand = 'cn', lookup: CliLookup = {}): QoderCli | undefined {
  const env = lookup.env ?? process.env
  const platform = lookup.platform ?? process.platform
  const exists = lookup.exists ?? existsSync
  const suffix = platform === 'win32' ? '.exe' : ''
  const node = resolveNode(lookup)
  for (const candidate of candidates(brand, env, suffix, node)) {
    if (!exists(candidate) || isWorkerRuntime(candidate)) continue
    if (!isScript(candidate)) return { path: candidate }
    if (node !== undefined) return { path: candidate, nodeDir: path.dirname(node) }
  }
  return undefined
}

/**
 * Query options that route a session through the CLI's own process.
 *
 * Empty when no CLI was found: the caller spreads this into its options, so an
 * empty answer leaves the SDK's default transport in place.
 *
 * @param brand - which edition's CLI the session speaks to.
 * @param lookup - the machine to inspect; defaults to this process's.
 */
export function qoderCliOptions(brand: QoderBrand = 'cn', lookup: CliLookup = {}): QoderCliOptions {
  const cli = resolveQoderCli(brand, lookup)
  if (cli === undefined) return {}
  // The SDK reads `env` as the child's whole environment rather than a delta, so
  // every branch hands over the environment the CLI would have inherited anyway
  // — handing over `PATH` alone would strip the CLI of the directories it keeps
  // its own state in — plus the switch that unzeroes its token metering.
  if (cli.nodeDir === undefined) {
    return {
      pathToQoderCLIExecutable: cli.path,
      env: { ...process.env, ...EXPOSE_TOKEN_USAGE },
    }
  }
  return {
    pathToQoderCLIExecutable: cli.path,
    // A bare name, because that is what the SDK's option accepts: the child
    // resolves it against PATH, so the interpreter's own directory is put in
    // front of the inherited PATH instead of being spelled out here.
    executable: 'node',
    env: { ...process.env, PATH: `${cli.nodeDir}${path.delimiter}${process.env.PATH ?? ''}`, ...EXPOSE_TOKEN_USAGE },
  }
}

/**
 * Whether a CLI path belongs to the other edition.
 *
 * `QODERCLI_PATH` predates the international edition and is set globally by
 * some CN installs. Both SDKs read that one variable from the parent process
 * before anything else, so an intl session would otherwise spawn the CN CLI and
 * answer with the CN account. A path that names an edition is therefore never
 * offered to the other one; a neutral custom build is still honoured for both.
 */
export function isForeignCliPath(brand: QoderBrand, candidate: string): boolean {
  const text = candidate.replace(/\\/g, '/').toLowerCase()
  const chinese = text.includes('qoderclicn') || text.includes('@qodercn-ai') || text.includes('/.qoder-cn/')
  const global = !chinese
    && (text.includes('@qoder-ai') || text.includes('/.qoder/') || /(^|[/_-])qodercli(\.exe|\.js|$)/.test(text))
  return brand === 'global' ? chinese : global
}

/**
 * A `QODERCLI_PATH` that names the other edition, when this one has no CLI.
 *
 * The SDKs read that variable from the parent process before any option this
 * plugin can pass, so when it is foreign and this edition has nothing of its
 * own, the only honest answer is a configuration error — spawning the other
 * edition's CLI would answer with the other edition's account.
 *
 * @param brand - the edition the caller is about to start.
 * @param lookup - the machine to inspect; defaults to this process's.
 */
export function foreignCliOverride(brand: QoderBrand, lookup: CliLookup = {}): string | undefined {
  const env = lookup.env ?? process.env
  const override = env.QODERCLI_PATH
  if (override === undefined || override.length === 0) return undefined
  if (!isForeignCliPath(brand, override)) return undefined
  if (resolveQoderCli(brand, lookup) !== undefined) return undefined
  return override
}

/**
 * The error text for {@link foreignCliOverride}.
 *
 * Deliberately says nothing about the variable or the path that caused it: the
 * page's job here is to tell the user which CLI to install, not to explain the
 * plugin's environment plumbing. The technical reason stays in the lookup.
 */
export function cliConflictMessage(brand: QoderBrand): string {
  const command = brandProfile(brand).cliCommands[0]
  return `未检测到可用的 ${command}，请先安装并登录后再使用此版本。`
}

/** Paths the CLI may live at, most explicit first. */
function candidates(brand: QoderBrand, env: NodeJS.ProcessEnv, suffix: string, nodePath: string | undefined): string[] {
  const profile = brandProfile(brand)
  const found: string[] = []
  const push = (value: string | undefined): void => {
    if (value !== undefined && value.length > 0 && !found.includes(value)) found.push(value)
  }
  // Brand-specific overrides first, then the shared one only when it does not
  // name the other edition (see {@link isForeignCliPath}).
  push(brand === 'cn' ? env.QODERCN_CLI_PATH : env.QODER_CLI_PATH)
  if (env.QODERCLI_PATH !== undefined && !isForeignCliPath(brand, env.QODERCLI_PATH)) {
    push(env.QODERCLI_PATH)
  }
  for (const root of nodeModulesRoots(env, nodePath)) {
    for (const pkg of profile.cliPackages) {
      const dir = path.join(root, pkg.scope, pkg.name)
      // npm's own global shim points at `bundle/`; a flat layout has no such dir.
      push(path.join(dir, 'bundle', `${pkg.name}.js`))
      push(path.join(dir, `${pkg.name}.js`))
    }
  }
  const sdk = sdkDir(profile.sdkPackage)
  if (sdk !== undefined) {
    for (const pkg of profile.cliPackages) push(path.join(sdk, 'dist', '_bundled', `${pkg.name}${suffix}`))
  }
  // The CLI's own per-user install root, where its installer puts a native build.
  const home = env.QODER_CLI_HOME === undefined || env.QODER_CLI_HOME.length === 0 ? homedir() : env.QODER_CLI_HOME
  for (const pkg of profile.cliPackages) {
    push(path.join(home, profile.configDirName, 'local', `${pkg.name}${suffix}`))
  }
  return found
}

/** `node_modules` roots a global install can land in. */
function nodeModulesRoots(env: NodeJS.ProcessEnv, nodePath: string | undefined): string[] {
  const roots: string[] = []
  const push = (value: string | undefined): void => {
    if (value !== undefined && value.length > 0 && !roots.includes(value)) roots.push(value)
  }
  // npm's own prefix wins over the default one, which on Windows is
  // %APPDATA%\npm; the rest are the unix layouts — a prefix install (nvm,
  // /usr/local) and the per-user prefix nobody sets but plenty of machines have.
  push(env.NPM_CONFIG_PREFIX === undefined ? undefined : path.join(env.NPM_CONFIG_PREFIX, 'node_modules'))
  push(env.APPDATA === undefined ? undefined : path.join(env.APPDATA, 'npm', 'node_modules'))
  push(path.join(homedir(), '.npm-global', 'node_modules'))
  if (nodePath !== undefined) push(path.join(path.dirname(path.dirname(nodePath)), 'lib', 'node_modules'))
  return roots
}

/**
 * The Node that runs a CLI script: this process when it *is* Node, else DSH's
 * shipped runtime, else whatever `PATH` answers.
 *
 * DSH's runtime comes first among the fallbacks because it is the one Node a
 * DSH install guarantees, whatever the user's PATH says — an Electron host
 * launched from a desktop shortcut inherits an environment that need not carry
 * Node at all.
 */
function resolveNode(lookup: CliLookup): string | undefined {
  const env = lookup.env ?? process.env
  const platform = lookup.platform ?? process.platform
  const exists = lookup.exists ?? existsSync
  const name = platform === 'win32' ? 'node.exe' : 'node'
  const execPath = lookup.execPath ?? process.execPath
  const electron = lookup.electron ?? process.versions.electron !== undefined
  if (!electron && path.basename(execPath).toLowerCase() === name) return execPath
  const home = env.DSH_HOME === undefined || env.DSH_HOME.length === 0 ? path.join(homedir(), '.dsh') : env.DSH_HOME
  const runtimes = path.join(home, 'dsh-runtimes')
  for (const runtime of listDir(runtimes, lookup)) {
    const candidate = path.join(runtimes, runtime, 'dependencies', 'node', 'bin', name)
    if (exists(candidate)) return candidate
  }
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (dir.length === 0) continue
    const candidate = path.join(dir, name)
    if (exists(candidate)) return candidate
  }
  return undefined
}

/**
 * Directory of the installed SDK, for the native CLI build it may carry.
 *
 * The international package is optional, so a missing one answers undefined
 * here rather than failing the lookup.
 */
function sdkDir(packageName: string): string | undefined {
  try {
    return path.dirname(createRequire(import.meta.url).resolve(packageName))
  } catch {
    return undefined
  }
}

/** Listing that answers nothing rather than throwing on a missing directory. */
function listDir(dir: string, lookup: CliLookup): readonly string[] {
  const read = lookup.readdir ?? ((target: string): readonly string[] => readdirSync(target))
  try {
    return read(dir)
  } catch {
    return []
  }
}

/** Whether the SDK would run this entry through an interpreter. */
function isScript(entry: string): boolean {
  return /\.(?:js|mjs|cjs|ts|tsx|jsx)$/i.test(entry)
}

/**
 * Whether the SDK would answer this entry with its in-process worker runtime,
 * which is the transport this module exists to avoid. Kept in step with the
 * SDK's own recognition rule so a path is never silently routed back in-process.
 */
function isWorkerRuntime(entry: string): boolean {
  return /^(?:qoder(?:cli|clicn|cn)?-)?worker-runtime(?:\.obf)?\.mjs$/i.test(path.basename(entry))
}
