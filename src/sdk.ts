/**
 * The SDK package behind each brand.
 *
 * The Qoder editions publish the same API under different scopes, so the rest
 * of the plugin imports this module instead of a package name. The CN SDK is a
 * real dependency and is loaded eagerly; the international one is optional at
 * runtime — a deployment that only has a CN account may not have it installed —
 * so it is imported on demand and its absence is reported to the settings page
 * as a plain error instead of failing the plugin's mount.
 *
 * CodeBuddy has its own, unrelated API and is loaded dynamically for the same
 * reason: an account may never use it, and its package carries a large CLI.
 *
 * ## Why modules are reloaded
 *
 * Every Qoder SDK routes all queries through one **process-wide daemon** that
 * is initialized with the first query's launch configuration (CLI path,
 * interpreter, environment, proxy) and then refuses any different one for the
 * life of the process:
 *
 *     DaemonConfigurationConflictError:
 *       Global daemon is already initialized with different options
 *
 * The host is long-lived, so its configuration is not: a CLI can be
 * reinstalled, an edition can appear, an installer can change the machine
 * environment. When that happens the ready daemon no longer matches and every
 * later query fails until the process restarts — a state the settings page
 * cannot recover from on its own.
 *
 * So the module tracks the configuration signature it loaded under and takes a
 * fresh instance whenever the signature changes; {@link resetSdk} does the same
 * after a conflict is observed. A new instance has an empty daemon registry, so
 * it initializes against the current configuration instead of arguing with the
 * old one.
 *
 * @module dsh-agent-sdk-bridge/sdk
 */

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import * as cnSdk from '@qodercn-ai/qodercn-agent-sdk'
import type * as QoderSdk from '@qodercn-ai/qodercn-agent-sdk'
import type * as CodeBuddySdk from '@tencent-ai/agent-sdk'
import type { CodeBuddyRegion, QoderBrand } from './brand.ts'
import { brandProfile, codeBuddyEnvironment } from './brand.ts'
import { qoderCliOptions } from './cli.ts'

/** The subset of the Qoder SDK surface this plugin uses, as one module type. */
export type QoderSdkModule = typeof QoderSdk
/** The CodeBuddy SDK module, typed from its declarations. */
export type CodeBuddySdkModule = typeof CodeBuddySdk

/** One loaded generation: the configuration it was loaded for, and the module. */
interface Generation {
  signature: string
  module: Promise<QoderSdkModule>
}

const generations = new Map<QoderBrand, Generation>()
/** Brands whose next load must take a fresh instance even if the signature matches. */
const forced = new Set<QoderBrand>()
let counter = 0
let codeBuddySdk: Promise<CodeBuddySdkModule> | undefined

const require = createRequire(import.meta.url)

/**
 * The launch configuration a Qoder query would use, as a comparable string.
 *
 * Mirrors the fields the SDK's own daemon compares before reusing itself. The
 * environment is included because the SDK hands it to the CLI verbatim, and a
 * difference there is enough to make the daemon reject a query.
 *
 * @param brand - which edition's configuration to describe.
 * @returns a stable string that changes exactly when the configuration does.
 */
export function configurationSignature(brand: QoderBrand): string {
  const options = qoderCliOptions(brand)
  const env = Object.entries(options.env ?? {})
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return JSON.stringify({
    path: options.pathToQoderCLIExecutable ?? null,
    executable: options.executable ?? null,
    env,
  })
}

/**
 * Import one edition's SDK.
 *
 * A fresh instance is the same file imported under a unique URL: the module's
 * top-level daemon state is per instance, while the implementation is shared by
 * the module loader as usual.
 *
 * @param brand - which edition to load.
 * @param fresh - ignore the already-loaded instance and take a new one.
 */
async function importSdk(brand: QoderBrand, fresh: boolean): Promise<QoderSdkModule> {
  const specifier = brandProfile(brand).sdkPackage
  try {
    if (!fresh) return await import(/* @vite-ignore */ specifier) as QoderSdkModule
    const entry = pathToFileURL(require.resolve(specifier)).href
    counter += 1
    return await import(/* @vite-ignore */ `${entry}?generation=${counter}`) as QoderSdkModule
  } catch (error) {
    // Let a later read retry: the package may be installed while DSH is running.
    generations.delete(brand)
    forced.delete(brand)
    if (brand === 'cn') throw error
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`未安装国际版 SDK（${specifier}）：${detail}`)
  }
}

/**
 * Load the SDK for one Qoder edition, under its current configuration.
 *
 * @param brand - which edition's SDK to load.
 * @returns the SDK module.
 */
export function loadSdk(brand: QoderBrand): Promise<QoderSdkModule> {
  const signature = configurationSignature(brand)
  const current = generations.get(brand)
  if (current !== undefined && current.signature === signature && !forced.has(brand)) {
    return current.module
  }
  const mustReload = current !== undefined || forced.delete(brand)
  const module = importSdk(brand, mustReload)
  const generation = { signature, module }
  generations.set(brand, generation)
  module.catch(() => {
    if (generations.get(brand) === generation) generations.delete(brand)
  })
  return module
}

/**
 * Drop the loaded instance so the next {@link loadSdk} starts a new daemon.
 *
 * @param brand - which edition to reset.
 */
export function resetSdk(brand: QoderBrand): void {
  generations.delete(brand)
  forced.add(brand)
}

/**
 * Whether an error is the SDK's daemon refusing a different configuration.
 *
 * @param error - whatever a query threw.
 */
export function isDaemonConflict(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return text.includes('DaemonConfigurationConflictError')
    || text.includes('Global daemon is already initialized with different options')
}

/**
 * Run one idempotent SDK operation, recovering from a daemon conflict once.
 *
 * A conflict means the daemon was initialized under a configuration that no
 * longer applies. A fresh module instance starts an empty daemon with the
 * current one, so the retry succeeds without a restart. Only use this for
 * operations that can be repeated without side effects (reads), never for a
 * turn that may already have emitted output.
 *
 * @param brand - which edition to query.
 * @param run - the operation, given the module to use.
 */
export async function withSdk<T>(
  brand: QoderBrand,
  run: (sdk: QoderSdkModule) => Promise<T>,
): Promise<T> {
  try {
    return await run(await loadSdk(brand))
  } catch (error) {
    if (!isDaemonConflict(error)) throw error
    resetSdk(brand)
    return await run(await loadSdk(brand))
  }
}

/**
 * Open one cheap control query so a stale daemon is discovered before a turn
 * starts streaming.
 *
 * A turn cannot be retried once it has emitted output, so the session path has
 * to find out about a configuration conflict first. `getUsageInfo` is a
 * control request: it initializes the daemon and reads the account without
 * running a model turn.
 *
 * @param brand - which edition to probe.
 */
export async function probeDaemon(brand: QoderBrand): Promise<void> {
  const sdk = await loadSdk(brand)
  const q = sdk.query({
    prompt: (async function* () { await new Promise<never>(() => {}) })(),
    options: {
      ...qoderCliOptions(brand),
      auth: sdk.qodercliAuth(),
      tools: [],
      allowedTools: [],
      settingSources: [],
      maxTurns: 1,
    },
  })
  try {
    await q.getUsageInfo()
  } finally {
    await q.close().catch(() => undefined)
  }
}

/**
 * Load the CodeBuddy Agent SDK.
 *
 * Kept lazy because the package ships its own ~200 MB CLI and is useless to a
 * deployment that never enables CodeBuddy.
 */
export function loadCodeBuddySdk(): Promise<CodeBuddySdkModule> {
  codeBuddySdk ??= importCodeBuddySdk()
  return codeBuddySdk
}

async function importCodeBuddySdk(): Promise<CodeBuddySdkModule> {
  const specifier = brandProfile('codebuddy').sdkPackage
  try {
    return await import(/* @vite-ignore */ specifier) as CodeBuddySdkModule
  } catch (error) {
    codeBuddySdk = undefined
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`CodeBuddy SDK 不可用（${specifier}）：${detail}`)
  }
}

/** The SDK auth environment for a CodeBuddy login region. */
export { codeBuddyEnvironment }
export type { CodeBuddyRegion }
