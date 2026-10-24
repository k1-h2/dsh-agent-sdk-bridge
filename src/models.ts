/**
 * Live model catalog retrieval from one edition's local Qoder CLI. One
 * short-lived inner session sends the SDK's `get_models` control request; the
 * response (including account-custom models) stays fresh for a TTL, concurrent
 * callers share one in-flight fetch, and the static CN catalog is the fallback
 * while that edition's CLI is unreachable.
 *
 * The CN and international editions publish different catalogs, so cache and
 * fallback are kept per brand: a list fetched from one account must never be
 * served to the other route.
 *
 * @module dsh-llm-qoder/models
 */

import type { ModelInfo } from '@qodercn-ai/qodercn-agent-sdk'
import type { QoderBrand } from './brand.ts'
import { brandProfile } from './brand.ts'
import type { QoderCatalogModel } from './catalog.ts'
import { QODER_MODELS } from './catalog.ts'
import { cliConflictMessage, foreignCliOverride, qoderCliOptions } from './cli.ts'
import type { Live } from './live.ts'
import { readLive } from './live.ts'
import { loadSdk } from './sdk.ts'

/** How long a fetched catalog stays fresh by default. */
export const DEFAULT_MODEL_CACHE_TTL_MS = 5 * 60_000
/** Give up on one CLI catalog fetch after this long by default. */
export const DEFAULT_FETCH_TIMEOUT_MS = 20_000

/** One fetched catalog snapshot with its freshness stamp. */
interface CatalogSnapshot {
  at: number
  models: readonly ModelInfo[]
}

/**
 * Last successful catalog per brand, shared by every {@link QoderModelCatalog}
 * in this process.
 *
 * A settings write does NOT restart this plugin — a volatile edit is committed
 * into the running cells (see `live.ts`) — so the cache now only has to survive
 * a real remount: enabling the plugin, a profile reload, or a DSH restart. It
 * matters in exactly those cases, because the first settings read after the
 * remount would otherwise cold-start the Qoder CLI and stall the page for
 * seconds.
 *
 * The entry carries its own timestamp and is only used while it is still within
 * the requesting catalog's TTL, so normal freshness is unchanged.
 */
const sharedSnapshots = new Map<QoderBrand, CatalogSnapshot>()

/** Cached live CLI catalog with a static fallback. */
export class QoderModelCatalog {
  private cached: CatalogSnapshot | undefined
  private inflight: Promise<readonly ModelInfo[]> | undefined
  /** Why the last refresh failed, for the settings page's guidance. */
  private failure: string | undefined

  /**
   * @param brand - which edition's CLI answers.
   * @param ttlMs - how long a fetched catalog stays fresh before a re-fetch.
   *   Read per use, so a settings edit takes effect on the next read.
   * @param fetchTimeoutMs - how long one CLI catalog fetch may take before the
   *   static fallback takes over.
   */
  constructor(
    private readonly brand: QoderBrand,
    private readonly ttlMs: Live<number>,
    private readonly fetchTimeoutMs: Live<number> = DEFAULT_FETCH_TIMEOUT_MS,
  ) {}

  /**
   * Raw live entries; the stale snapshot when a refresh fails, else nothing.
   *
   * Filtered to the subscription's official models here, so the picker and the
   * settings page cannot disagree about what the account has.
   */
  async liveModels(): Promise<readonly ModelInfo[]> {
    const ttlMs = readLive(this.ttlMs, DEFAULT_MODEL_CACHE_TTL_MS)
    const fresh = (snapshot: CatalogSnapshot | undefined): boolean =>
      snapshot !== undefined && Date.now() - snapshot.at < ttlMs
    // Own cache first, then the process-wide one a previous adapter left behind.
    const cached = this.cached ?? sharedSnapshots.get(this.brand)
    if (fresh(cached) && cached !== undefined) {
      this.cached = cached
      return officialOnly(cached.models)
    }
    this.inflight ??= this.fetch().finally(() => { this.inflight = undefined })
    try {
      const models = await this.inflight
      const snapshot: CatalogSnapshot = { at: Date.now(), models }
      this.cached = snapshot
      sharedSnapshots.set(this.brand, snapshot)
      this.failure = undefined
      return officialOnly(models)
    } catch (error) {
      this.failure = error instanceof Error ? error.message : String(error)
      // A failed refresh keeps serving the last good list rather than dropping
      // to the static fallback, which would hide the account's real models.
      return officialOnly((this.cached ?? sharedSnapshots.get(this.brand))?.models ?? [])
    }
  }

  /** Why the last refresh failed, or undefined when it succeeded. */
  get error(): string | undefined {
    return this.failure
  }

  /**
   * Drop the cached catalog so the next read goes back to the CLI.
   *
   * What the CLI answers depends on state this plugin does not own — whether it
   * is installed at all, and which account is signed in — and an empty answer is
   * cached like any other. So after the setup helper has run, the page's next
   * read must not be served from a snapshot taken before that login existed.
   */
  invalidate(): void {
    this.cached = undefined
    sharedSnapshots.delete(this.brand)
    this.failure = undefined
  }

  /** dsh catalog entries: the enabled live list, or the static fallback. */
  async models(): Promise<readonly QoderCatalogModel[]> {
    const live = (await this.liveModels()).filter(model => model.isEnabled !== false)
    if (live.length === 0) return brandProfile(this.brand).staticCatalog ? QODER_MODELS : []
    return live.map(model => ({
      id: model.value,
      name: model.displayName.length > 0 ? model.displayName : model.value,
      ...model.description.length > 0 ? { description: model.description } : {},
      // Carry only a verified affirmative: a false or absent flag stays off the
      // entry, so a non-VL live model and the static fallback look identical.
      ...model.isVl === true ? { isVl: true } : {},
    }))
  }

  private async fetch(): Promise<readonly ModelInfo[]> {
    const conflict = foreignCliOverride(this.brand)
    if (conflict !== undefined) throw new Error(cliConflictMessage(this.brand))
    const sdk = await loadSdk(this.brand)
    const q = sdk.query({
      prompt: inertInput(),
      options: {
        ...qoderCliOptions(this.brand),
        auth: sdk.qodercliAuth(),
        tools: [],
        allowedTools: [],
        settingSources: [],
        maxTurns: 1,
      },
    })
    try {
      return await withTimeout(q.getAvailableModels({ fetchStrategy: 'live' }), readLive(this.fetchTimeoutMs, DEFAULT_FETCH_TIMEOUT_MS))
    } finally {
      await q.close().catch(() => undefined)
    }
  }
}

/**
 * Keep only the subscription's official models.
 *
 * The CLI also returns models the account added itself (`source` is `user` or
 * `custom`): bring-your-own-key routes, which upstream serves on a separate
 * provider. DSH runs on the subscription catalog and has no use for those, so
 * they are dropped at this single layer — the picker, the settings page and
 * the request path all read from here and cannot diverge.
 *
 * @param models - entries as the CLI reported them.
 * @returns the same list without account-added entries.
 */
function officialOnly(models: readonly ModelInfo[]): readonly ModelInfo[] {
  return models.filter(model => model.source !== 'user' && model.source !== 'custom')
}

/**
 * The credit multiplier upstream quotes for one model.
 *
 * Present on every live entry as `priceFactor`; `0` means the model is free.
 * Returned as a number rather than a formatted string so callers decide how to
 * render it.
 *
 * @param entry - one live catalog entry.
 * @returns the multiplier, or undefined when upstream did not quote one.
 */
export function priceFactorOf(entry: { priceFactor?: number }): number | undefined {
  const value = entry.priceFactor
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** Streaming prompt that never yields, so no model turn runs during the fetch. */
async function* inertInput(): AsyncGenerator<never> {
  await new Promise<never>(() => {})
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error(`qoder request timed out after ${ms}ms`)) }, ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error: unknown) => { clearTimeout(timer); reject(error) },
    )
  })
}
