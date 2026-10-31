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
 * @module dsh-agent-sdk-bridge/cli
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
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
  //
  // `cliChildEnv` also drops a `QODERCLI_PATH` naming the *other* edition.
  // Both SDKs consult that variable before any option passed here, so leaving
  // it in place is what made an intl session answer with the CN account (and,
  // before that was understood, refuse to start at all on a machine whose CN
  // installer had exported it globally).
  const env = cliChildEnv(brand)
  if (cli.nodeDir === undefined) {
    return { pathToQoderCLIExecutable: cli.path, env }
  }
  return {
    pathToQoderCLIExecutable: cli.path,
    // A bare name, because that is what the SDK's option accepts: the child
    // resolves it against PATH, so the interpreter's own directory is put in
    // front of the inherited PATH instead of being spelled out here.
    executable: 'node',
    env: { ...env, PATH: `${cli.nodeDir}${path.delimiter}${env.PATH ?? ''}` },
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
 * Why this edition has no usable CLI, when `QODERCLI_PATH` explains it.
 *
 * `QODERCLI_PATH` predates the international edition and some installers
 * export it machine-wide. Both SDKs read it from the parent process before any
 * option this plugin can pass, so a value naming the *other* edition would
 * hand this edition's session the other account. The lookup therefore never
 * offers it ({@link isForeignCliPath}), and this reports the case where it is
 * all the machine has, so the page can ask for the right CLI to be installed.
 *
 * This is a diagnosis, not a second rule: an edition that finds its own CLI is
 * unaffected by the variable. That is what keeps one edition's install from
 * blocking the other's sign-in — the earlier code treated any foreign value as
 * fatal, so a machine that had only the intl CLI installed could not sign in
 * to CN even after installing it if the lookup missed the new package.
 *
 * @param brand - the edition the caller is about to start.
 * @param lookup - the machine to inspect; defaults to this process's.
 * @returns the foreign override when this edition has nothing of its own.
 */
export function foreignCliOverride(brand: QoderBrand, lookup: CliLookup = {}): string | undefined {
  const env = lookup.env ?? process.env
  const override = env.QODERCLI_PATH
  if (override === undefined || override.length === 0) return undefined
  if (!isForeignCliPath(brand, override)) return undefined
  // A CLI of our own always wins; the session then ignores the variable
  // entirely because it names the executable explicitly.
  if (resolveQoderCli(brand, lookup) !== undefined) return undefined
  return override
}

/**
 * The environment one session's child process receives.
 *
 * `QODERCLI_PATH` is stripped when it names the other edition: both SDKs read
 * it from the parent before honouring any option, so leaving it in place would
 * hand the intl session the CN CLI (and the CN account). Every other variable
 * is inherited untouched — the CLI keeps its state in `PATH`-relative dirs.
 *
 * @param brand - which edition's child is being started.
 * @param env - the environment to derive from; defaults to this process's.
 */
export function cliChildEnv(brand: QoderBrand, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = { ...env, ...EXPOSE_TOKEN_USAGE }
  const override = env.QODERCLI_PATH
  if (override !== undefined && override.length > 0 && isForeignCliPath(brand, override)) {
    delete child.QODERCLI_PATH
  }
  return child
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

/**
 * Turn a CLI failure into something a user can act on.
 *
 * The SDK reports an outdated CLI as `Qoder CLI process exited with code 42`,
 * which says nothing about the cause: CLI 1.1.81 removed the worker-session
 * handshake the older SDK spoke, and its own log says so
 * (`sdk_worker_removed: … Upgrade to the latest Qoder SDK version, or roll back
 * the CLI`). The only fix available to a user is reinstalling the pair through
 * the bundled helper, so say that instead of echoing the number.
 *
 * @param detail - the error text as the SDK reported it.
 * @param brand - which edition's helper the message should name.
 * @returns the original detail, prefixed with the actionable explanation.
 */
export function cliFailureText(detail: string, brand: QoderBrand): string {
  // The SDK routes every query through one process-wide daemon pinned to the
  // first launch configuration it saw. When the machine changes under it (a
  // reinstall, a new edition, a different environment) every query is rejected
  // with this message until the process restarts. The plugin now drops the SDK
  // instance at that point, so the next request recovers; say that instead of
  // echoing an English internal error into the page.
  if (/DaemonConfigurationConflict|Global daemon is already initialized with different options/i.test(detail)) {
    const command = brandProfile(brand).cliCommands[0]
    return `本机 ${command} 的运行配置在本次会话期间发生了变化，SDK 的本地守护进程仍按旧配置运行。`
      + `插件已重置这部分运行时，请重试一次；若仍失败，重启 DSH Web。原始信息：${detail}`
  }
  if (!/exit(?:ed)?(?: with)? code 42|sdk_worker_removed/i.test(detail)) return detail
  const profile = brandProfile(brand)
  const pkg = profile.cliPackages[0]
  const spec = pkg === undefined ? profile.cliCommands[0] : `${pkg.scope}/${pkg.name}`
  const required = requiredCliVersion(brand)
  const target = required === undefined ? spec : `${spec}@${required}`
  return `本机 ${profile.cliCommands[0]} 与插件使用的 SDK 版本不匹配（CLI 已移除旧版握手，退出码 42）。`
    + `请在设置页点「一键配置」重新安装配套版本，或手动执行 npm install -g ${target} 后重试。`
    + `原始信息：${detail}`
}

/**
 * The CLI version the installed SDK expects, read from its runtime manifest.
 *
 * Each SDK release pins one CLI build: the two speak a wire protocol that
 * changes between them, and a mismatch fails every session with a bare exit
 * code. The bundled helper reads the same file, so the page and the helper
 * agree on which build to install.
 *
 * @param brand - which edition's SDK to inspect.
 * @returns the pinned version, or undefined when the manifest is unreadable.
 */
export function requiredCliVersion(brand: QoderBrand): string | undefined {
  try {
    const dir = sdkDir(brandProfile(brand).sdkPackage)
    if (dir === undefined) return undefined
    const manifest = JSON.parse(readFileSync(path.join(dir, 'dist', 'runtime-manifest.json'), 'utf8')) as {
      qoderCliVersion?: unknown
    }
    return typeof manifest.qoderCliVersion === 'string' && manifest.qoderCliVersion.length > 0
      ? manifest.qoderCliVersion
      : undefined
  } catch {
    return undefined
  }
}

/**
 * The version of the installed CLI, read from its own package manifest.
 *
 * Read from disk rather than by running `--version`: a settings-page poll must
 * not spawn a process every second, and the npm package always ships a
 * manifest next to its entry. A native build without one answers undefined,
 * which callers treat as "unknown" and never as a mismatch.
 *
 * @param brand - which edition's CLI to inspect.
 * @returns the installed version, or undefined when it cannot be read.
 */
export function installedCliVersion(brand: QoderBrand): string | undefined {
  const cli = resolveQoderCli(brand)
  if (cli === undefined) return undefined
  for (const candidate of [
    path.join(path.dirname(cli.path), 'package.json'),
    path.join(path.dirname(path.dirname(cli.path)), 'package.json'),
  ]) {
    try {
      const manifest = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: unknown, version?: unknown }
      if (typeof manifest.name !== 'string' || !manifest.name.startsWith('@')) continue
      if (typeof manifest.version === 'string' && manifest.version.length > 0) return manifest.version
    } catch {
      // No manifest at this level: try the parent, then give up.
    }
  }
  return undefined
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
      // npm's own global shim points at `bundle/`; a flat layout has no such
      // dir. The package's own manifest is consulted too: the entry has moved
      // between releases, and guessing only `bundle/<name>.js` made a working
      // install look missing — the page then insisted the CLI was not there.
      for (const entry of packageEntries(dir, pkg.name, suffix)) push(entry)
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

/**
 * Every path one installed npm package can expose as its CLI.
 *
 * `main`/`bin` are read from the package's own manifest rather than guessed:
 * the entry point has changed between CLI releases, and hard-coding only
 * `bundle/<name>.js` reported an installed package as missing whenever it did
 * not match. Unreadable manifests fall back to the conventional entries.
 */
function packageEntries(dir: string, name: string, suffix: string): string[] {
  const entries: string[] = [
    path.join(dir, 'bundle', `${name}.js`),
    path.join(dir, `${name}.js`),
    path.join(dir, 'bundle', `${name}${suffix}`),
  ]
  try {
    const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
      main?: unknown
      bin?: unknown
    }
    if (typeof manifest.main === 'string') entries.push(path.join(dir, manifest.main))
    const bin = manifest.bin
    if (typeof bin === 'string') entries.push(path.join(dir, bin))
    else if (bin !== null && typeof bin === 'object') {
      for (const value of Object.values(bin)) {
        if (typeof value === 'string') entries.push(path.join(dir, value))
      }
    }
  } catch {
    // No readable manifest (or no package at all): the conventional entries
    // above are everything worth probing.
  }
  return entries
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
  if (nodePath !== undefined) {
    // A Windows install keeps globals directly under its prefix
    // (`<node>\\node_modules`); a unix one under `<prefix>/lib/node_modules`.
    // Only the unix shape used to be probed, so a Windows Node outside
    // %APPDATA%\\npm — a portable or per-drive install — had a working CLI the
    // lookup could not see, and the page kept asking to install it again.
    const prefix = path.dirname(nodePath)
    push(path.join(prefix, 'node_modules'))
    push(path.join(path.dirname(prefix), 'lib', 'node_modules'))
  }
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
    const entry = createRequire(import.meta.url).resolve(packageName)
    // `resolve` answers the package's entry *inside* its dist directory, so
    // climbing one level only lands on `dist`. Callers want the package root:
    // they join `dist/runtime-manifest.json` and `dist/_bundled/<cli>`, and a
    // doubled `dist/dist/…` made both probes miss.
    const dir = path.dirname(entry)
    return path.basename(dir) === 'dist' ? path.dirname(dir) : dir
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
