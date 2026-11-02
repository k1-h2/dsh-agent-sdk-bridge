/**
 * Live model catalog retrieval from one edition's local Qoder CLI. One
 * short-lived inner session sends the SDK's `get_models` control request; the
 * response (including account-custom models) stays fresh for a TTL, concurrent
 * callers share one in-flight fetch, and the static CN catalog is a fallback
 * only while that edition's CLI is installed but cannot answer — never for an
 * account that answered with an empty list (see {@link emptyCatalogFallback}).
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
import { cliConflictMessage, cliFailureText, foreignCliOverride, qoderCliOptions, resolveQoderCli } from './cli.ts'
import type { Live } from './live.ts'
import { readLive } from './live.ts'
import type { QoderSdkModule } from './sdk.ts'
import { withSdk } from './sdk.ts'

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

/**
 * Brands whose CLI has answered a catalogue read successfully at least once.
 *
 * An empty answer is the account speaking — signed out, or a plan with no
 * official models — and it must not be confused with a read that never
 * happened. Deliberately NOT cleared by {@link QoderModelCatalog.invalidate}:
 * a sign-out drops the catalogue, and the next read may fail outright (the CLI
 * was just re-authenticated, the network hiccuped), which would otherwise look
 * like "never reachable" and republish the static plan to an account with
 * nothing. Any successful read counts, including one whose models are all
 * switched off upstream: the plan only ever stands in for silence.
 */
const answeredCatalogs = new Set<QoderBrand>()

/** Cached live CLI catalog with a static fallback. */
export class QoderModelCatalog {
  private cached: CatalogSnapshot | undefined
  private inflight: { epoch: number, promise: Promise<readonly ModelInfo[]> } | undefined
  /** Why the last refresh failed, for the settings page's guidance. */
  private failure: string | undefined
  /**
   * Bumped by {@link invalidate}. A fetch that started before a sign-in carries
   * the previous account's entries, so it must not republish them after the
   * cache was dropped for that account change.
   */
  private epoch = 0

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
    const epoch = this.epoch
    const fresh = (snapshot: CatalogSnapshot | undefined): boolean =>
      snapshot !== undefined && Date.now() - snapshot.at < ttlMs
    // Own cache first, then the process-wide one a previous adapter left behind.
    const cached = this.cached ?? sharedSnapshots.get(this.brand)
    if (fresh(cached) && cached !== undefined) {
      this.cached = cached
      return officialOnly(cached.models)
    }
    let entry = this.inflight
    if (entry === undefined || entry.epoch !== epoch) {
      const promise = this.fetch()
      entry = { epoch, promise }
      this.inflight = entry
      const settled = entry
      const clear = (): void => {
        if (this.inflight === settled) this.inflight = undefined
      }
      void promise.then(clear, clear)
    }
    try {
      const models = await entry.promise
      // Read before the account changed: answer this reader, but leave the
      // cache to the fetch that the post-change read already started.
      if (epoch !== this.epoch) return officialOnly(models)
      const snapshot: CatalogSnapshot = { at: Date.now(), models }
      this.cached = snapshot
      sharedSnapshots.set(this.brand, snapshot)
      this.failure = undefined
      // A successful read — empty or not — is an answer. A later failed read
      // must not mistake it for "the CLI was never reachable" and publish the
      // captured plan.
      answeredCatalogs.add(this.brand)
      return officialOnly(models)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if (epoch === this.epoch) this.failure = cliFailureText(detail, this.brand)
      // A failed refresh keeps serving the last good list rather than dropping
      // to the static fallback, which would hide the account's real models.
      return officialOnly((this.cached ?? sharedSnapshots.get(this.brand))?.models ?? [])
    }
  }

  /**
   * The last successful live list, without fetching.
   *
   * The model picker resolves a route on every switch, and a switch must not
   * wait on a CLI cold start (up to the fetch timeout). Callers that need an
   * immediate answer read this and let {@link liveModels} refresh behind them;
   * `undefined` means nothing has been read yet, which only the first switch
   * has to wait for.
   */
  snapshot(): readonly ModelInfo[] | undefined {
    const cached = this.cached ?? sharedSnapshots.get(this.brand)
    return cached === undefined ? undefined : officialOnly(cached.models)
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
   *
   * The remembered empty answer is deliberately kept: it says the account has
   * nothing, which a later failed read must not turn back into the static plan.
   */
  invalidate(): void {
    this.cached = undefined
    sharedSnapshots.delete(this.brand)
    this.failure = undefined
    this.epoch += 1
    this.inflight = undefined
  }

  /** dsh catalog entries: the enabled live list, or the fallback {@link emptyCatalogFallback} allows. */
  async models(): Promise<readonly QoderCatalogModel[]> {
    const live = (await this.liveModels()).filter(model => model.isEnabled !== false)
    if (live.length === 0) {
      return emptyCatalogFallback(this.brand, {
        cliInstalled: resolveQoderCli(this.brand) !== undefined,
        answered: answeredCatalogs.has(this.brand),
      })
    }
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
    // Without a CLI of our own there is no configuration to initialize the
    // SDK's daemon with. Asking anyway pinned it to the SDK's defaults, and the
    // first query after the CLI was installed then conflicted with it for the
    // rest of the process's life (see `sdk.ts`).
    if (resolveQoderCli(this.brand) === undefined) throw new Error(cliConflictMessage(this.brand))
    return withSdk(this.brand, sdk => this.read(sdk))
  }

  private async read(sdk: QoderSdkModule): Promise<readonly ModelInfo[]> {
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
      const timeout = readLive(this.fetchTimeoutMs, DEFAULT_FETCH_TIMEOUT_MS)
      // Read the account first, then ask for that account's catalog.
      //
      // On SDK 1.0.58 a `get_models` call made before any account lookup
      // answers an empty list — even though the CLI's own `--list-models`
      // prints eleven entries for the same login. Passing the account's `uid`
      // (or simply having asked for the account in this session) returns the
      // real list, so the catalogue has to be read in that order. Reporting
      // the empty answer instead made the settings page show 0/0 and claim a
      // working install was missing.
      const account = await withTimeout(q.accountInfo(), timeout).catch(() => undefined)
      const uid = account?.userId
      const models = await withTimeout(
        q.getAvailableModels(uid === undefined ? {} : { uid }),
        timeout,
      )
      if (models.length > 0) return models
      // Still empty: ask the CLI for its on-disk copy, then the server copy,
      // before letting the page conclude the account has no models.
      for (const strategy of ['cache', 'live'] as const) {
        const fallback = await withTimeout(q.getAvailableModels({ ...uid === undefined ? {} : { uid }, fetchStrategy: strategy }), timeout)
          .catch(() => [] as ModelInfo[])
        if (fallback.length > 0) return fallback
      }
      return []
    } finally {
      await q.close().catch(() => undefined)
    }
  }
}

/**
 * What the picker may show when the live catalogue came back empty.
 *
 * The captured CN plan is a stand-in for exactly one situation: this edition's
 * CLI is installed, and the catalogue could not be read because the CLI or the
 * network was unavailable. Two cases must stay empty:
 *
 * - The CLI answered. That is the account speaking — signed out, or a plan
 *   with no official models — and publishing the plan here is what put every
 *   Qoder CN model back into the picker after a sign-out, where selecting one
 *   could only fail. `getAvailableModels()` answers a *successful* empty list
 *   while signed out (its `cache` and `live` strategies included, even with a
 *   populated `~/.qoder-cn/.models`), so this is the ordinary sign-out path,
 *   not an edge case.
 * - The CLI is not installed at all, so none of those models could run.
 *
 * @param brand - which edition's catalogue is empty.
 * @param state - whether that edition's CLI is on the machine, and whether a
 *   successful read has ever produced an answer.
 */
export function emptyCatalogFallback(
  brand: QoderBrand,
  state: { cliInstalled: boolean, answered: boolean },
): readonly QoderCatalogModel[] {
  if (!state.cliInstalled || state.answered) return []
  return brandProfile(brand).staticCatalog ? QODER_MODELS : []
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
