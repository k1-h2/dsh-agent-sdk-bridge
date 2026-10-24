/**
 * Account quota and usage, read through the CLI's own control protocol.
 *
 * The SDK exposes `getUsageInfo()`, which asks the CLI to query the account's
 * quota endpoint with the credentials the CLI already holds — the same numbers
 * the Qoder desktop and VS Code clients show on their account panel. Doing it
 * this way (rather than calling the endpoint ourselves) keeps token refresh,
 * endpoint election and encryption inside the CLI, which owns them.
 *
 * One short-lived query is enough: no model turn runs, and the answer is cached
 * for a minute so opening the settings page repeatedly does not spawn a CLI on
 * every render. Failures are returned, not thrown: a page that cannot read the
 * quota must still render the rest of its settings.
 *
 * @module dsh-qoder-link/usage
 */

import type { AccountInfo, UsageInfo } from '@qodercn-ai/qodercn-agent-sdk'
import type { Live } from './live.ts'
import { readLive } from './live.ts'
import { cliConflictMessage, foreignCliOverride, qoderCliOptions } from './cli.ts'
import { withTimeout } from './models.ts'
import type { QoderBrand } from './brand.ts'
import { brandProfile } from './brand.ts'
import { loadSdk } from './sdk.ts'

/** How long one quota reading stays fresh by default. */
export const DEFAULT_USAGE_CACHE_TTL_MS = 60_000
/** Upper bound on one quota round trip. */
export const DEFAULT_USAGE_TIMEOUT_MS = 20_000

/** One quota reading, successful or not. */
export interface UsageSnapshot {
  /** When the reading was taken. */
  at: number
  /** Account quota; absent when the CLI could not answer. */
  usage?: UsageInfo
  /** Signed-in account identity, when the CLI reports it. */
  account?: AccountInfo
  /** Why the quota is missing, in the CLI's own words. */
  error?: string
}

/** Streaming prompt that never yields, so no model turn runs during the read. */
async function* inertInput(): AsyncGenerator<never> {
  await new Promise<never>(() => {})
}

/** Cached quota reader for one brand. */
export class QoderUsage {
  private cached: UsageSnapshot | undefined
  private inflight: Promise<UsageSnapshot> | undefined

  /**
   * @param brand - which edition's CLI answers.
   * @param ttlMs - how long a reading stays fresh; read per use.
   * @param timeoutMs - how long one round trip may take.
   */
  constructor(
    private readonly brand: QoderBrand,
    private readonly ttlMs: Live<number> = DEFAULT_USAGE_CACHE_TTL_MS,
    private readonly timeoutMs: Live<number> = DEFAULT_USAGE_TIMEOUT_MS,
  ) {}

  /**
   * Read the quota, or serve the cached reading while it is still fresh.
   *
   * @param fresh - ignore the cache; the page's refresh button.
   * @returns the reading; `error` carries a failed lookup instead of throwing.
   */
  async read(fresh = false): Promise<UsageSnapshot> {
    const ttlMs = readLive(this.ttlMs, DEFAULT_USAGE_CACHE_TTL_MS)
    if (!fresh && this.cached !== undefined && Date.now() - this.cached.at < ttlMs) return this.cached
    this.inflight ??= this.fetch().finally(() => { this.inflight = undefined })
    const snapshot = await this.inflight
    this.cached = snapshot
    return snapshot
  }

  /** Drop the cached reading. */
  invalidate(): void {
    this.cached = undefined
  }

  private async fetch(): Promise<UsageSnapshot> {
    const at = Date.now()
    try {
      const conflict = foreignCliOverride(this.brand)
      if (conflict !== undefined) return { at, error: cliConflictMessage(this.brand) }
      const sdk = await loadSdk(this.brand)
      const timeoutMs = readLive(this.timeoutMs, DEFAULT_USAGE_TIMEOUT_MS)
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
        const usage = await withTimeout(q.getUsageInfo(), timeoutMs)
        // Account identity is secondary: a CLI that predates the control request
        // still delivers the quota, and the card simply omits the account line.
        const account = await withTimeout(q.accountInfo(), timeoutMs).catch(() => undefined)
        return {
          at,
          ...usage === null || usage === undefined ? { error: 'CLI 未返回额度信息' } : { usage },
          ...account === undefined ? {} : { account },
        }
      } finally {
        await q.close().catch(() => undefined)
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      // The quota card is the first thing a user sees on a machine without the
      // CLI. Point at installing it instead of echoing spawn/package errors.
      const command = brandProfile(this.brand).cliCommands[0]
      const missingCli = /ENOENT|not found|Cannot find package|未安装国际版 SDK/i.test(detail)
      return {
        at,
        error: missingCli ? `未检测到可用的 ${command}，请先安装并登录后再读取额度。` : detail,
      }
    }
  }
}
