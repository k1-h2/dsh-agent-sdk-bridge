/**
 * MiniMax Code over the Agent Client Protocol.
 *
 * `mcode acp` is a stdio ACP server: the plugin starts one process per warm
 * host session, negotiates capabilities, creates one ACP session, and streams
 * `session/update` notifications back to the harness. Host tools are injected
 * as an HTTP MCP server (`mcpServers` in `session/new`), so a tool call the
 * model makes reaches this plugin and then the harness, exactly like the
 * CodeBuddy path.
 *
 * Two MiniMax behaviours shape this module:
 *
 * - ACP has no way to turn off the CLI's built-in tools. The model may call
 *   `bash`/`write`/`read` directly, which would bypass the harness. The client
 *   watches `tool_call` notifications and cancels the prompt before execution;
 *   the turn is then retried with a correction. Host MCP tools are the only
 *   calls allowed through.
 * - The CLI stores one auth state per region and selects it with
 *   `MAVIS_REGION`; every process is pinned so the mainland and international
 *   accounts can coexist.
 *
 * @module dsh-agent-sdk-bridge/minimax
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import {
  ClientSideConnection, ndJsonStream, PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk'
import { EMPTY_RESPONSE_CODE, ToolCallId } from '@deepseek-ai/dsh-llm'
import type {
  FinishReason, GenerateOptions, RequestMessage, StreamChunk, TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { MinimaxRegion } from './brand.ts'
import { minimaxCliRegion } from './brand.ts'
import type { Live } from './live.ts'
import { readLive } from './live.ts'
import { resolveMinimaxCli, minimaxCliArgs } from './minimax-cli.ts'
import { estimateTextTokens } from './tokens.ts'

/** Default context capacity shown for a MiniMax model that declares none. */
export const MINIMAX_DEFAULT_CONTEXT_WINDOW = 512_000
/** Default output cap; the published MiniMax models allow 128k. */
export const MINIMAX_DEFAULT_MAX_TOKENS = 128_000
/** How long one model catalog stays fresh. */
export const MINIMAX_CACHE_TTL_MS = 300_000
/** Bound for one ACP control round trip. */
export const MINIMAX_FETCH_TIMEOUT_MS = 30_000
/** The MCP server name the model sees; its tools are `mcp__dsh-host__*`. */
export const MINIMAX_MCP_SERVER = 'dsh-host'
/** Context choices the hosted models publish. */
const MINIMAX_CONTEXT_CHOICES = [MINIMAX_DEFAULT_CONTEXT_WINDOW, 1_000_000]
/** How many native-tool corrections a turn may trigger before it fails. */
const MAX_NATIVE_TOOL_RETRIES = 2

/** One model as the settings page and the adapter see it. */
export interface MinimaxModel {
  id: string
  name: string
  description?: string
  contextWindows: number[]
  defaultContextWindow: number
  vision: boolean
  reasoning: boolean
  reasoningEfforts: string[]
  defaultEffort?: string
}

/** One tool call's result, in the shape the MCP bridge returns. */
export interface MinimaxMcpToolResult {
  content: { type: 'text', text: string }[]
  isError?: boolean
}

/** Login progress and state for one region. */
export interface MinimaxAuthStatus {
  running: boolean
  region: MinimaxRegion
  signedIn: boolean
  startedAt?: number
  finishedAt?: number
  /** Authorization URL, once the CLI prints one. */
  url?: string
  /** Expiry of the stored access token, when reported. */
  expiresAt?: number
  error?: string
}

/** One rolling quota window reported by the coding-plan endpoint. */
export interface MinimaxQuotaWindow {
  id: string
  label: string
  /** Percent still available; absent when the CLI reports no percentage. */
  remainingPercent?: number
  /** When this window resets. */
  resetAt?: number
  /** The plan does not count this window (status 3). */
  unlimited: boolean
  /** Remaining units, when the endpoint reports a count instead of a ratio. */
  remainingCount?: number
  totalCount?: number
}

/** Which quota model the account is on. */
export interface MinimaxPlanInfo {
  kind: 'token-plan' | 'credits' | 'free'
  hasTokenPlan: boolean
  /** Plan name the account itself reports, when it has one. */
  name?: string
  tier?: string
  expiresAt?: number
  subscriptionType?: string
}

/** Credit balance from the membership record. */
export interface MinimaxCreditInfo {
  remaining: number
  purchasedRemaining?: number
  freeRemaining?: number
}

/** Display identity of the signed-in MiniMax account. */
export interface MinimaxAccountInfo {
  name?: string
  email?: string
  avatar?: string
  userId?: string
}

/** What the settings page shows for a MiniMax account. */
export interface MinimaxUsageSnapshot {
  at: number
  region: MinimaxRegion
  signedIn: boolean
  /** Whether the `mcode` executable was found. */
  installed: boolean
  /** The site refused this machine's network and redirected to the other one. */
  regionBlocked?: boolean
  error?: string
  account?: MinimaxAccountInfo
  plan?: MinimaxPlanInfo
  credits?: MinimaxCreditInfo
  /** Coding-plan windows, empty for accounts without a token plan. */
  windows?: MinimaxQuotaWindow[]
}

/** The per-user CLI state directory. */
export function minimaxDataDir(): string {
  const override = process.env.MINIMAX_DATA_DIR?.trim() || process.env.MAVIS_DATA_DIR?.trim()
  return override !== undefined && override.length > 0 ? override : join(homedir(), '.minimax')
}

/** Path of one region's auth-state file. */
export function minimaxAuthStatePath(region: MinimaxRegion): string {
  const buildEnv = process.env.MAVIS_BUILD_ENV?.trim() || 'prod'
  return join(minimaxDataDir(), 'auth', buildEnv, minimaxCliRegion(region), 'mcode-public', 'auth-state.json')
}

/** Path of the credential file the CLI writes its OAuth token to. */
function minimaxAuthRecordPath(region: MinimaxRegion): string {
  const buildEnv = process.env.MAVIS_BUILD_ENV?.trim() || 'prod'
  return join(minimaxDataDir(), 'auth', buildEnv, minimaxCliRegion(region), 'mcode-public', 'auth.json')
}

/** The CLI command name, for error text. */
export function minimaxCliCommand(): string {
  return 'mcode'
}

/** The host-side MCP namespace the CLI exposes for the injected server. */
const HOST_TOOL_PREFIXES = [`mcp__${MINIMAX_MCP_SERVER}__`, `mcp__${MINIMAX_MCP_SERVER.replace(/[^a-zA-Z0-9]/g, '_')}__`]

/** Whether a CLI tool name belongs to this plugin's MCP server. */
export function isHostMcpTool(name: string): boolean {
  return HOST_TOOL_PREFIXES.some(prefix => name.startsWith(prefix))
}

/** The host-side name of an MCP tool, without the namespace. */
export function hostMcpToolName(name: string): string {
  for (const prefix of HOST_TOOL_PREFIXES) {
    if (name.startsWith(prefix)) return name.slice(prefix.length)
  }
  return name
}

/** Thinking-effort values an ACP config option advertises, minus `default`. */
function effortValues(options: readonly any[] | null | undefined): string[] {
  if (!Array.isArray(options)) return []
  return options
    .map((entry: any) => typeof entry?.value === 'string' ? entry.value : '')
    .filter((value: string) => value.length > 0 && value !== 'default')
}

/** Build one row from a model option entry and the efforts that model accepts. */
function modelRow(entry: any, efforts: readonly string[]): MinimaxModel | undefined {
  if (typeof entry?.value !== 'string' || entry.value.length === 0) return undefined
  return {
    id: entry.value,
    name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : entry.value,
    ...typeof entry.description === 'string' && entry.description.length > 0 ? { description: entry.description } : {},
    contextWindows: [...MINIMAX_CONTEXT_CHOICES],
    defaultContextWindow: MINIMAX_DEFAULT_CONTEXT_WINDOW,
    vision: true,
    reasoning: efforts.length > 0,
    reasoningEfforts: [...efforts],
  }
}

/** The model config option's values as rows. */
export function minimaxModelsFromConfigOptions(options: readonly any[] | null | undefined): MinimaxModel[] {
  if (!Array.isArray(options)) return []
  const modelOption = options.find(option => option?.category === 'model' || option?.id === 'model')
  const effortOption = options.find(option => option?.id === 'thinkingEffort' || option?.category === 'thought_level')
  const efforts = effortValues(effortOption?.options)
  if (!Array.isArray(modelOption?.options)) return []
  const seen = new Set<string>()
  const models: MinimaxModel[] = []
  for (const entry of modelOption.options) {
    if (typeof entry?.value !== 'string' || entry.value.length === 0 || seen.has(entry.value)) continue
    seen.add(entry.value)
    const row = modelRow(entry, efforts)
    if (row !== undefined) models.push(row)
  }
  return models
}

/**
 * Read one region's stored auth state, without spawning anything.
 *
 * The file records its own region; a copy left over from another build or a
 * CLI that rotates its layout must not be read as this region's login.
 */
function readAuthState(region: MinimaxRegion): { status?: string, expiresAtMs?: number } | undefined {
  try {
    const parsed = JSON.parse(readFileSync(minimaxAuthStatePath(region), 'utf8')) as {
      status?: unknown
      expiresAtMs?: unknown
      region?: unknown
    }
    if (typeof parsed.region === 'string' && parsed.region !== minimaxCliRegion(region)) return undefined
    return {
      ...typeof parsed.status === 'string' ? { status: parsed.status } : {},
      ...typeof parsed.expiresAtMs === 'number' ? { expiresAtMs: parsed.expiresAtMs } : {},
    }
  } catch {
    return undefined
  }
}

/** Whether the region has a stored login. */
export function minimaxSignedIn(region: MinimaxRegion): boolean {
  return readAuthState(region)?.status === 'authenticated'
}

// ── Account and quota ──────────────────────────────────────────────────────
//
// The CLI's own account calls run against MiniMax's signed gateway. Its web
// console and TUI read the same endpoints, so the numbers here match what the
// user sees on minimax's site: a coding-plan subscription exposes rolling
// windows, a credit balance exposes the remaining amount.
//
// The signed gateway needs `yy`/`x-timestamp`/`x-signature` derived with the
// CLI's own salt; the quota endpoint takes a plain bearer token plus the
// account's `op_group_id`.

/** Signed account gateway (the CLI's `agent` host). */
const MINIMAX_ACCOUNT_HOSTS: Readonly<Record<MinimaxRegion, string>> = {
  cn: 'https://agent.minimaxi.com',
  global: 'https://agent.minimax.io',
}

/** Host serving the coding-plan quota. */
const MINIMAX_QUOTA_HOSTS: Readonly<Record<MinimaxRegion, string>> = {
  cn: 'https://www.minimaxi.com',
  global: 'https://platform.minimax.io',
}

/** Salt the CLI signs account requests with. */
const MINIMAX_ACCOUNT_SALT = 'I*7Cf%WZ#S&%1RlZJ&C2'
/** Bound for one account/quota read. */
const MINIMAX_USAGE_TIMEOUT_MS = 15_000
/** How long one quota reading stays fresh. */
export const MINIMAX_USAGE_CACHE_TTL_MS = 60_000
/** Bound for one region-reachability probe. */
const MINIMAX_REGION_PROBE_TIMEOUT_MS = 5_000
/** How long one reachability verdict stays fresh. */
const MINIMAX_REGION_ACCESS_TTL_MS = 30_000

/** Domains the two sites serve their API and console from. */
const MINIMAX_INTL_DOMAIN = 'minimax.io'
const MINIMAX_CN_DOMAIN = 'minimaxi.com'

function hostMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`)
}

/**
 * Whether a URL points at the other site.
 *
 * MiniMax's edge answers a request from the wrong side of the border with a
 * 307 to the other site (`.io` -> `.minimaxi.com` and the reverse). The two
 * are different origins, so a redirect also drops the Authorization header;
 * that is why the CLI reports `401 token is required` instead of an
 * actionable error, and why a stale token is not the real cause.
 */
export function minimaxHostBelongsToOtherRegion(region: MinimaxRegion, target: string | URL): boolean {
  let hostname: string
  try {
    hostname = typeof target === 'string' ? new URL(target).hostname : target.hostname
  } catch {
    return false
  }
  return region === 'global'
    ? hostMatches(hostname, MINIMAX_CN_DOMAIN)
    : hostMatches(hostname, MINIMAX_INTL_DOMAIN)
}

/** The sentence the card and the chat surface show for a refused region. */
export function minimaxRegionBlockMessage(region: MinimaxRegion): string {
  return region === 'global'
    ? '本机 IP 不在 MiniMax 国际站的服务区域，国际站已拒绝连接（请求被重定向到国内站）。请切换到国内站，或更换网络后重试。'
    : '本机 IP 不在 MiniMax 国内站的服务区域，国内站已拒绝连接（请求被重定向到国际站）。请切换到国际站，或更换网络后重试。'
}

/** A region whose hosts refused this machine's network. */
export class MinimaxRegionBlockedError extends Error {
  constructor(readonly region: MinimaxRegion) {
    super(minimaxRegionBlockMessage(region))
    this.name = 'MinimaxRegionBlockedError'
  }
}

const regionAccessCache = new Map<MinimaxRegion, { at: number, blocked: boolean }>()

/** Forget a cached reachability verdict. */
export function invalidateMinimaxRegionAccess(region?: MinimaxRegion): void {
  if (region === undefined) regionAccessCache.clear()
  else regionAccessCache.delete(region)
}

function rememberRegionAccess(region: MinimaxRegion, blocked: boolean): void {
  regionAccessCache.set(region, { at: Date.now(), blocked })
}

/** The last verdict, for synchronous rendering under the card. */
export function minimaxRegionBlockedCached(region: MinimaxRegion): boolean {
  const cached = regionAccessCache.get(region)
  return cached?.blocked === true && Date.now() - cached.at < MINIMAX_REGION_ACCESS_TTL_MS
}

/**
 * Probe the region's account host for a cross-region redirect.
 *
 * Only a redirect to the other site's domain counts as a block. A timeout or
 * DNS failure leaves the previous verdict alone, so callers report the real
 * network error instead of blaming the IP.
 */
export async function minimaxRegionBlocked(
  region: MinimaxRegion,
  options: { fresh?: boolean; fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<boolean> {
  const cached = regionAccessCache.get(region)
  if (options.fresh !== true && cached !== undefined && Date.now() - cached.at < MINIMAX_REGION_ACCESS_TTL_MS) {
    return cached.blocked
  }
  const fetchImpl = options.fetchImpl ?? fetch
  const timeout = AbortSignal.timeout(MINIMAX_REGION_PROBE_TIMEOUT_MS)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
  try {
    const response = await fetchImpl(`${MINIMAX_ACCOUNT_HOSTS[region]}/`, {
      redirect: 'manual',
      signal,
      headers: { Accept: 'text/html,application/json' },
    })
    const location = response.headers.get('location')
    const blocked = response.status >= 300 && response.status < 400
      && location !== null
      && minimaxHostBelongsToOtherRegion(region, location)
    rememberRegionAccess(region, blocked)
    return blocked
  } catch {
    return cached?.blocked === true
  }
}

/** Whether one response is the edge redirecting this machine to the other site. */
function redirectTargetsOtherRegion(
  region: MinimaxRegion,
  requestUrl: URL,
  response: Response,
): boolean {
  if (response.status < 300 || response.status >= 400) return false
  const location = response.headers.get('location')
  if (location === null) return false
  try {
    return minimaxHostBelongsToOtherRegion(region, new URL(location, requestUrl))
  } catch {
    return false
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Read the OAuth access token the CLI stored for one region. */
function readStoredToken(region: MinimaxRegion): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(minimaxAuthRecordPath(region), 'utf8')) as {
      records?: Record<string, { accessToken?: unknown }>
    }
    for (const record of Object.values(parsed.records ?? {})) {
      const token = record?.accessToken
      if (typeof token === 'string' && token.trim().length > 0) return token.trim()
    }
  } catch {
    // Missing or unreadable; the caller reports a re-login.
  }
  return undefined
}

function minimaxMd5(value: string): string {
  return createHash('md5').update(value).digest('hex')
}

/** Build one signed-gateway URL exactly as the CLI does. */
function minimaxAccountUrl(
  region: MinimaxRegion,
  path: string,
  nowMs: number,
  realUserId?: string,
): URL {
  const url = new URL(path, MINIMAX_ACCOUNT_HOSTS[region])
  const lang = region === 'cn' ? 'zh' : 'en'
  url.search = new URLSearchParams({
    device_platform: 'mcode',
    biz_id: '3',
    app_id: '3001',
    version_code: '22201',
    unix: String(nowMs),
    timezone_offset: String(new Date().getTimezoneOffset() * -60),
    sys_language: lang,
    lang,
    device_id: '0',
    os_name: process.platform,
    browser_name: 'mcode',
    user_id: realUserId?.trim() || '0',
    client: 'mcode',
  }).toString()
  return url
}

interface MinimaxAccountCall {
  method?: 'GET' | 'POST'
  body?: Record<string, unknown>
  realUserId?: string
  token: string
  fetchImpl: typeof fetch
  signal?: AbortSignal
}

/** One request to the signed gateway, with the CLI's signature headers. */
async function minimaxAccountCall(
  region: MinimaxRegion,
  path: string,
  call: MinimaxAccountCall,
): Promise<Record<string, unknown>> {
  const now = Date.now()
  const url = minimaxAccountUrl(region, path, now, call.realUserId)
  const target = `${url.pathname}${url.search}`
  const body = call.body === undefined ? '' : JSON.stringify(call.body)
  const seconds = Math.floor(now / 1000)
  const response = await call.fetchImpl(url, {
    method: call.method ?? 'GET',
    redirect: 'manual',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'MiniMaxCode',
      Authorization: `Bearer ${call.token}`,
      yy: minimaxMd5(`${encodeURIComponent(target)}_${body}${minimaxMd5(String(now))}ooui`),
      'x-timestamp': String(seconds),
      'x-signature': minimaxMd5(`${seconds}${MINIMAX_ACCOUNT_SALT}${body}`),
    },
    ...body === '' ? {} : { body },
    ...call.signal === undefined ? {} : { signal: call.signal },
  })
  if (redirectTargetsOtherRegion(region, url, response)) {
    rememberRegionAccess(region, true)
    throw new MinimaxRegionBlockedError(region)
  }
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`MiniMax 账号接口返回了意外的重定向（HTTP ${response.status}）。`)
  }
  if (!response.ok) {
    if ((response.status === 401 || response.status === 403) && minimaxRegionBlockedCached(region)) {
      throw new MinimaxRegionBlockedError(region)
    }
    throw new Error(response.status === 401 || response.status === 403
      ? 'MiniMax 登录已过期：先发一条消息让 CLI 自动续期，或重新登录后再刷新额度。'
      : `MiniMax 账号接口返回 HTTP ${response.status}。`)
  }
  const payload = asRecord(await response.json())
  if (payload === undefined) throw new Error('MiniMax 账号接口返回了无法解析的响应。')
  const statusInfo = asRecord(payload.statusInfo)
  const statusCode = asNumber(statusInfo?.code)
  if (statusCode !== undefined && statusCode !== 0) {
    throw new Error(asString(statusInfo?.message) ?? `MiniMax 账号接口错误 ${statusCode}。`)
  }
  const baseResp = asRecord(payload.base_resp)
  const baseCode = asNumber(baseResp?.status_code)
  if (baseCode !== undefined && baseCode !== 0) {
    throw new Error(asString(baseResp?.status_msg) ?? `MiniMax 账号接口错误 ${baseCode}。`)
  }
  return payload
}

/** One window's numbers, named the way the coding-plan endpoint reports them. */
function quotaWindow(
  bucket: Record<string, unknown>,
  kind: 'interval' | 'weekly',
): Omit<MinimaxQuotaWindow, 'id' | 'label'> | undefined {
  const prefix = kind === 'interval' ? 'current_interval' : 'current_weekly'
  const status = asNumber(bucket[`${prefix}_status`])
  const unlimited = status === 3
  const percent = asNumber(bucket[`${prefix}_remaining_percent`])
  const total = asNumber(bucket[`${prefix}_total_count`])
  const used = asNumber(bucket[`${prefix}_usage_count`])
  // The endpoint calls the count field `usage_count`, but the CLI reads it as
  // the remaining amount; keep that interpretation so the card agrees with the
  // TUI. A percentage, when present, always wins.
  const remaining = percent ?? (total !== undefined && total > 0 && used !== undefined
    ? (used / total) * 100
    : undefined)
  const resetAt = asNumber(bucket[kind === 'interval' ? 'end_time' : 'weekly_end_time'])
  if (remaining === undefined && !unlimited && (resetAt === undefined || resetAt <= 0)) return undefined
  return {
    ...remaining === undefined || unlimited
      ? {}
      : { remainingPercent: Math.round(Math.min(100, Math.max(0, remaining))) },
    ...resetAt !== undefined && resetAt > 0 ? { resetAt } : {},
    unlimited,
    ...kind === 'interval' && used !== undefined ? { remainingCount: Math.max(0, used) } : {},
    ...kind === 'interval' && total !== undefined ? { totalCount: Math.max(0, total) } : {},
  }
}

/** Turn one `model_remains` bucket into its 5-hour and weekly rows. */
function windowRows(
  id: string,
  label: string,
  bucket: Record<string, unknown>,
): MinimaxQuotaWindow[] {
  const rows: MinimaxQuotaWindow[] = []
  const interval = quotaWindow(bucket, 'interval')
  if (interval !== undefined) rows.push({ id: `${id}:5h`, label: `${label} · 5 小时`, ...interval })
  const weekly = quotaWindow(bucket, 'weekly')
  if (weekly !== undefined) rows.push({ id: `${id}:7d`, label: `${label} · 本周`, ...weekly })
  return rows
}

/** Parse `/v1/api/openplatform/coding_plan/remains`. */
function parseMinimaxRemains(payload: Record<string, unknown> | undefined): MinimaxQuotaWindow[] {
  if (payload === undefined) return []
  const baseResp = asRecord(payload.base_resp)
  const code = asNumber(baseResp?.status_code)
  // 2062 is "no active token plan", not an error worth showing.
  if (code !== undefined && code !== 0) return []
  const buckets = Array.isArray(payload.model_remains)
    ? payload.model_remains
        .map(asRecord)
        .filter((bucket): bucket is Record<string, unknown> => bucket !== undefined)
    : []
  const rows: MinimaxQuotaWindow[] = []
  const general = buckets[0]
  if (general !== undefined) rows.push(...windowRows('general', '通用', general))
  const video = buckets.find(bucket => {
    const name = asString(bucket.model_name) ?? ''
    return /video/i.test(name) && (asNumber(bucket.current_interval_total_count) ?? 0) > 0
  })
  if (video !== undefined) rows.push(...windowRows('video', '视频', video))
  return rows
}

/**
 * Build a snapshot from the three account documents.
 *
 * Split out from the network path so the mapping is testable without a live
 * account: the membership record is the source of the plan and credit
 * balance, `remains` only exists for token-plan subscribers.
 */
export function minimaxUsageFromParts(parts: {
  region: MinimaxRegion
  at?: number
  installed?: boolean
  userInfo?: Record<string, unknown>
  workspaces?: readonly Record<string, unknown>[]
  membership?: Record<string, unknown>
  remains?: Record<string, unknown>
}): MinimaxUsageSnapshot {
  const userInfo = parts.userInfo ?? {}
  const membership = parts.membership ?? {}
  const personal = parts.workspaces?.find(workspace => asNumber(workspace.workspace_type) === 0)
    ?? parts.workspaces?.[0]

  const name = asString(userInfo.name)
  const email = asString(userInfo.email)
  const avatar = asString(userInfo.avatar)
  const userId = asString(userInfo.userID)
  const account = name === undefined && email === undefined && avatar === undefined && userId === undefined
    ? undefined
    : {
        ...name === undefined ? {} : { name },
        ...email === undefined ? {} : { email },
        ...avatar === undefined ? {} : { avatar },
        ...userId === undefined ? {} : { userId },
      }

  const summary = asRecord(membership.op_credit_summary) ?? asRecord(personal?.op_credit_summary)
  const remaining = asNumber(summary?.total_remaining_amount)
    ?? asNumber(personal?.opcredit_balance)
    ?? asNumber(membership.opcredit_balance)
  const purchased = asNumber(summary?.purchased_remaining_amount)
  const free = asNumber(summary?.free_remaining_amount)
  const credits = remaining === undefined
    ? undefined
    : {
        remaining,
        ...purchased === undefined ? {} : { purchasedRemaining: purchased },
        ...free === undefined ? {} : { freeRemaining: free },
      }

  const hasTokenPlan = membership.has_token_plan === true || personal?.has_token_plan === true
  const kind = hasTokenPlan ? 'token-plan' : credits !== undefined && credits.remaining > 0 ? 'credits' : 'free'
  const planName = asString(membership.plan_name) ?? asString(personal?.plan_name)
  const tier = asString(membership.token_plan_tier) ?? asString(personal?.token_plan_tier)
  const expiresRaw = asNumber(membership.token_plan_expires_at)
    ?? asNumber(personal?.token_plan_expires_at)
    ?? asNumber(membership.expires_at)
  const expiresAt = expiresRaw !== undefined && expiresRaw > 0 ? expiresRaw : undefined
  const subscriptionType = asString(membership.subscription_type)
  const windows = parseMinimaxRemains(parts.remains)

  return {
    at: parts.at ?? Date.now(),
    region: parts.region,
    signedIn: true,
    installed: parts.installed ?? true,
    ...account === undefined ? {} : { account },
    plan: {
      kind,
      hasTokenPlan,
      ...planName === undefined ? {} : { name: planName },
      ...tier === undefined ? {} : { tier },
      ...expiresAt === undefined ? {} : { expiresAt },
      ...subscriptionType === undefined ? {} : { subscriptionType },
    },
    ...credits === undefined ? {} : { credits },
    ...windows.length === 0 ? {} : { windows },
  }
}

/** Read the quota for a token-plan subscriber; a plain account has none. */
async function readMinimaxRemains(
  region: MinimaxRegion,
  token: string,
  groupId: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<Record<string, unknown> | undefined> {
  const url = new URL('/v1/api/openplatform/coding_plan/remains', MINIMAX_QUOTA_HOSTS[region])
  const response = await fetchImpl(url, {
    redirect: 'manual',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'X-Group-Id': groupId,
    },
    signal,
  })
  if (redirectTargetsOtherRegion(region, url, response)) {
    rememberRegionAccess(region, true)
    throw new MinimaxRegionBlockedError(region)
  }
  if (response.status >= 300 && response.status < 400) return undefined
  if (!response.ok) {
    if ((response.status === 401 || response.status === 403) && minimaxRegionBlockedCached(region)) {
      throw new MinimaxRegionBlockedError(region)
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error('MiniMax 登录已过期：先发一条消息让 CLI 自动续期，或重新登录后再刷新额度。')
    }
    return undefined
  }
  return asRecord(await response.json())
}

const usageCache = new Map<MinimaxRegion, { at: number, snapshot: MinimaxUsageSnapshot }>()
const usageInflight = new Map<MinimaxRegion, Promise<MinimaxUsageSnapshot>>()

/** Drop a cached quota reading, so the next request re-reads it. */
export function invalidateMinimaxUsage(region?: MinimaxRegion): void {
  if (region === undefined) {
    usageCache.clear()
    return
  }
  usageCache.delete(region)
}

/**
 * Read one region's account, plan and quota.
 *
 * A failed account call keeps the login state and reports the reason in
 * `error`; the settings card shows the account it already knows with that
 * message instead of silently claiming nothing is configured.
 */
export async function minimaxUsage(
  region: MinimaxRegion,
  options: {
    fresh?: boolean
    token?: string
    fetchImpl?: typeof fetch
    signal?: AbortSignal
  } = {},
): Promise<MinimaxUsageSnapshot> {
  const installed = resolveMinimaxCli() !== undefined
  const token = options.token ?? readStoredToken(region)
  const signedIn = token !== undefined || minimaxSignedIn(region)
  if (!signedIn) {
    return { at: Date.now(), region, signedIn: false, installed }
  }
  if (await minimaxRegionBlocked(region, {
    fresh: options.fresh,
    fetchImpl: options.fetchImpl,
    signal: options.signal,
  })) {
    return {
      at: Date.now(),
      region,
      signedIn: true,
      installed,
      regionBlocked: true,
      error: minimaxRegionBlockMessage(region),
    }
  }
  if (token === undefined) {
    return {
      at: Date.now(),
      region,
      signedIn: true,
      installed,
      error: '未找到 MiniMax 登录凭据，请重新登录。',
    }
  }
  if (options.token === undefined && options.fresh !== true) {
    const cached = usageCache.get(region)
    if (cached !== undefined && Date.now() - cached.at < MINIMAX_USAGE_CACHE_TTL_MS) return cached.snapshot
  }
  let pending = usageInflight.get(region)
  if (pending === undefined) {
    pending = readUsage(region, token, installed, options)
      .finally(() => { usageInflight.delete(region) })
    usageInflight.set(region, pending)
  }
  const snapshot = await pending
  if (snapshot.error === undefined && options.token === undefined) {
    usageCache.set(region, { at: snapshot.at, snapshot })
  }
  return snapshot
}

async function readUsage(
  region: MinimaxRegion,
  token: string,
  installed: boolean,
  options: { fetchImpl?: typeof fetch, signal?: AbortSignal },
): Promise<MinimaxUsageSnapshot> {
  const timeout = AbortSignal.timeout(MINIMAX_USAGE_TIMEOUT_MS)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
  const fetchImpl = options.fetchImpl ?? fetch
  try {
    const info = await minimaxAccountCall(region, '/v1/api/user/info', { token, fetchImpl, signal })
    const data = asRecord(info.data)
    const userInfo = asRecord(data?.userInfo) ?? asRecord(info.userInfo) ?? {}
    const realUserId = asString(userInfo.realUserID) ?? asString(userInfo.real_user_id)
    const extra = await minimaxAccountCall(region, '/matrix/api/v1/user/get_user_extra_info', {
      method: 'POST',
      body: {},
      realUserId,
      token,
      fetchImpl,
      signal,
    })
    const rawWorkspaces = Array.isArray(extra.workspaces)
      ? extra.workspaces
      : Array.isArray(asRecord(extra.data)?.workspaces)
        ? (asRecord(extra.data)?.workspaces as unknown[])
        : []
    const workspaces = rawWorkspaces
      .map(asRecord)
      .filter((workspace): workspace is Record<string, unknown> => workspace !== undefined)
    const personal = workspaces.find(workspace => asNumber(workspace.workspace_type) === 0)
      ?? workspaces[0]
    const workspaceId = asNumber(personal?.workspace_id)
    const membership = workspaceId === undefined
      ? {}
      : await minimaxAccountCall(region, '/matrix/api/v1/commerce/get_membership_info', {
          method: 'POST',
          body: { workspace_id: workspaceId },
          realUserId,
          token,
          fetchImpl,
          signal,
        })
    const groupId = asString(membership.op_group_id) ?? asString(personal?.op_group_id)
    const hasTokenPlan = membership.has_token_plan === true || personal?.has_token_plan === true
    const remains = hasTokenPlan && groupId !== undefined
      ? await readMinimaxRemains(region, token, groupId, fetchImpl, signal)
      : undefined
    return minimaxUsageFromParts({ region, installed, userInfo, workspaces, membership, remains })
  } catch (error) {
    const blocked = error instanceof MinimaxRegionBlockedError
    return {
      at: Date.now(),
      region,
      signedIn: true,
      installed,
      ...blocked ? { regionBlocked: true } : {},
      error: blocked
        ? minimaxRegionBlockMessage(region)
        : error instanceof Error ? error.message : String(error),
    }
  }
}

/** Trim CLI output to a short, token-free sentence. */
function outputTail(lines: readonly string[]): string {
  return lines
    .slice(-4)
    .map(line => line.replace(/mmo(at|rt)_[A-Za-z0-9_-]+/g, 'mmo***'))
    .join(' ')
    .slice(0, 400)
}

/**
 * Browser login/logout, one run per region.
 *
 * The CLI owns the OAuth device flow and the credential file. The plugin only
 * starts the process, surfaces the authorization URL while it waits, and then
 * re-reads the auth-state file to decide whether the region is signed in.
 */
export class MinimaxAuth {
  private readonly runs = new Map<MinimaxRegion, {
    status: MinimaxAuthStatus
    child: ChildProcess
    lines: string[]
    finish: (code: number | null) => void
  }>()

  status(region: MinimaxRegion): MinimaxAuthStatus {
    const run = this.runs.get(region)
    if (run !== undefined) return run.status
    const state = readAuthState(region)
    return {
      running: false,
      region,
      signedIn: state?.status === 'authenticated',
      ...state?.expiresAtMs === undefined ? {} : { expiresAt: state.expiresAtMs },
    }
  }

  /** Start the CLI's browser login. */
  start(region: MinimaxRegion, onFinish?: (ok: boolean) => void): { started: true } | { started: false, error: string } {
    const existing = this.runs.get(region)
    if (existing !== undefined && existing.status.running) {
      return { started: false, error: '该区域正在登录，请先在浏览器中完成授权。' }
    }
    const spec = resolveMinimaxCli()
    if (spec === undefined) {
      return { started: false, error: '未安装 MiniMax Code CLI（mcode），请先安装后再登录。' }
    }

    const status: MinimaxAuthStatus = { running: true, region, signedIn: false, startedAt: Date.now() }
    const run = {
      status,
      child: undefined as unknown as ChildProcess,
      lines: [] as string[],
      finish: (_code: number | null): void => {},
    }
    const env: NodeJS.ProcessEnv = { ...process.env, MAVIS_REGION: minimaxCliRegion(region) }
    delete env.MAVIS_AGENT
    delete env.MAVIS_SESSION
    const child = spawn(spec.command, minimaxCliArgs(spec, ['login', '--region', region === 'cn' ? 'cn' : 'global']), {
      cwd: homedir(),
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    run.child = child
    this.runs.set(region, run)

    const absorb = (chunk: Buffer): void => {
      const text = String(chunk)
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        run.lines.push(trimmed)
        const match = /^(?:Open:\s*)?(https?:\/\/\S+)/.exec(trimmed)
        if (match !== null) status.url = match[1]
      }
      while (run.lines.length > 40) run.lines.shift()
    }
    child.stdout?.on('data', absorb)
    child.stderr?.on('data', absorb)

    const finish = (code: number | null): void => {
      if (!status.running) return
      status.running = false
      status.finishedAt = Date.now()
      const state = readAuthState(region)
      status.signedIn = state?.status === 'authenticated'
      if (state?.expiresAtMs !== undefined) status.expiresAt = state.expiresAtMs
      // The CLI refuses to sign in to the second region while the other one is
      // signed in. That failure must surface even though the target region's
      // older credential file may still say `authenticated`.
      if (code !== 0) status.error = outputTail(run.lines) || '登录未完成'
      else if (!status.signedIn) status.error = outputTail(run.lines) || '登录未完成'
      try {
        onFinish?.(status.signedIn)
      } catch {
        // The caller's callback must not break the status bookkeeping.
      }
    }
    run.finish = finish
    child.on('error', error => {
      status.error = `无法启动 mcode：${error.message}`
      finish(null)
    })
    child.on('close', code => { finish(code) })
    return { started: true }
  }

  /** Sign one region out; the other region is untouched. */
  async logout(region: MinimaxRegion): Promise<MinimaxAuthStatus> {
    const spec = resolveMinimaxCli()
    if (spec === undefined) {
      return { running: false, region, signedIn: false, error: '未安装 MiniMax Code CLI（mcode）。' }
    }
    const env: NodeJS.ProcessEnv = { ...process.env, MAVIS_REGION: minimaxCliRegion(region) }
    delete env.MAVIS_AGENT
    delete env.MAVIS_SESSION
    const result = await new Promise<{ code: number | null, lines: string[] }>(resolve => {
      const lines: string[] = []
      const child = spawn(spec.command, minimaxCliArgs(spec, ['logout', '--region', region === 'cn' ? 'cn' : 'global']), {
        cwd: homedir(),
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const absorb = (chunk: Buffer): void => {
        for (const line of String(chunk).split(/\r?\n/)) {
          if (line.trim() !== '') lines.push(line.trim())
        }
        while (lines.length > 40) lines.shift()
      }
      child.stdout?.on('data', absorb)
      child.stderr?.on('data', absorb)
      const timer = setTimeout(() => {
        child.kill()
        resolve({ code: null, lines })
      }, 20_000)
      child.on('error', () => {
        clearTimeout(timer)
        resolve({ code: null, lines })
      })
      child.on('close', code => {
        clearTimeout(timer)
        resolve({ code, lines })
      })
    })
    this.runs.delete(region)
    const state = readAuthState(region)
    const signedIn = state?.status === 'authenticated'
    return {
      running: false,
      region,
      signedIn,
      ...state?.expiresAtMs === undefined ? {} : { expiresAt: state.expiresAtMs },
      ...result.code !== 0 ? { error: outputTail(result.lines) || '退出登录未完成' } : {},
    }
  }

  /** Cancel any login process (plugin disposal). */
  stop(): void {
    for (const run of this.runs.values()) {
      if (run.status.running) run.child.kill()
    }
  }
}

/** One event the ACP client or the MCP bridge delivers to a turn. */
type SessionEvent =
  | { kind: 'text', text: string }
  | { kind: 'reasoning', text: string }
  | { kind: 'usage', used: number, size: number }
  | { kind: 'host-tool', callId: string, name: string, args: Record<string, unknown> }
  | { kind: 'native-tool', name: string }
  | { kind: 'prompt-done', stopReason: string }
  | { kind: 'prompt-error', error: Error }
  | { kind: 'closed', error: Error }

/** A single-consumer async event queue. */
class EventQueue {
  private readonly items: SessionEvent[] = []
  private waiter: ((event: SessionEvent | undefined) => void) | null = null
  private closed = false

  push(event: SessionEvent): void {
    if (this.closed) return
    if (this.waiter !== null) {
      const settle = this.waiter
      this.waiter = null
      settle(event)
      return
    }
    this.items.push(event)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.waiter !== null) {
      const settle = this.waiter
      this.waiter = null
      settle(undefined)
    }
  }

  get isClosed(): boolean {
    return this.closed
  }

  next(): Promise<SessionEvent | undefined> {
    const item = this.items.shift()
    if (item !== undefined) return Promise.resolve(item)
    if (this.closed) return Promise.resolve(undefined)
    return new Promise<SessionEvent | undefined>(resolve => { this.waiter = resolve })
  }
}

/** A pending host tool call, waiting for the harness to deliver its result. */
interface PendingHostCall {
  resolve: (result: MinimaxMcpToolResult) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/** Render a harness tool result for the MCP caller. */
function renderToolResult(content: unknown): MinimaxMcpToolResult {
  const text = (value: unknown): string => {
    if (typeof value === 'string') return value
    if (value === null || value === undefined) return ''
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      if (typeof block === 'string') {
        parts.push(block)
        continue
      }
      if (block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
        parts.push(text((block as { text?: unknown }).text))
        continue
      }
      parts.push(text(block))
    }
    const joined = parts.join('\n').trim()
    return { content: [{ type: 'text', text: joined === '' ? '（宿主工具没有返回内容）' : joined }] }
  }
  const joined = text(content).trim()
  return { content: [{ type: 'text', text: joined === '' ? '（宿主工具没有返回内容）' : joined }] }
}

/** Options for one ACP process. */
interface MinimaxAcpOptions {
  region: MinimaxRegion
  cwd: string
  systemPrompt: string
  /** HTTP MCP endpoint for host tools; absent for catalog/title calls. */
  mcpUrl?: string
  mcpToken?: string
  /** Disable all CLI tools (catalog and title reads need none). */
  disableTools?: boolean
  timeoutMs?: number
  onUpdate?: (update: SessionEvent) => void
  onExit?: (error: Error) => void
  onPermissionDenied?: (toolName: string) => void
}

/**
 * One `mcode acp` process and its ACP session.
 *
 * The class only speaks protocol: model/effort config, prompts, cancellation,
 * and the translation of `session/update` into {@link SessionEvent}s. Turn
 * policy (tool calls, retries, harness chunks) lives in {@link MinimaxSession}.
 */
export class MinimaxAcp {
  private child: ChildProcess | null = null
  private conn: ClientSideConnection | null = null
  private sessionId: string | undefined
  private configOptions: any[] = []
  private systemFile: string | undefined
  private tempDir: string | undefined
  private closing = false
  private stderr: string[] = []
  private readonly options: MinimaxAcpOptions

  constructor(options: MinimaxAcpOptions) {
    this.options = options
  }

  /** The model/effort options the CLI currently offers. */
  get optionsList(): readonly any[] {
    return this.configOptions
  }

  /** The selected model config value. */
  get currentModel(): string | undefined {
    const option = this.configOptions.find(entry => entry?.category === 'model' || entry?.id === 'model')
    return typeof option?.currentValue === 'string' ? option.currentValue : undefined
  }

  /** Start the process and create one ACP session. */
  async start(): Promise<void> {
    const spec = resolveMinimaxCli()
    if (spec === undefined) {
      throw new Error('未安装 MiniMax Code CLI（mcode）。请在设置页安装，或运行 npm install -g @minimax-ai/code。')
    }
    const timeout = this.options.timeoutMs ?? MINIMAX_FETCH_TIMEOUT_MS
    const directory = mkdtempSync(join(tmpdir(), 'dsh-minimax-acp-'))
    const systemFile = join(directory, 'system.md')
    writeFileSync(systemFile, this.options.systemPrompt, 'utf8')
    this.systemFile = systemFile
    this.tempDir = directory

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MAVIS_REGION: minimaxCliRegion(this.options.region),
      ...this.options.disableTools === true ? { MAVIS_LOCAL_RUNTIME_DISABLE_TOOLS: '1' } : {},
    }
    delete env.MAVIS_AGENT
    delete env.MAVIS_SESSION
    const child = spawn(
      spec.command,
      minimaxCliArgs(spec, ['acp', '--system-prompt-file', systemFile]),
      { cwd: this.options.cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    this.child = child
    child.stderr?.on('data', (chunk: Buffer) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim() !== '') this.stderr.push(line.trim())
      }
      while (this.stderr.length > 30) this.stderr.shift()
    })
    child.on('exit', (code, signal) => {
      if (this.closing) return
      const detail = outputTail(this.stderr) || `mcode acp 退出（code=${String(code)}, signal=${String(signal)}）`
      this.options.onExit?.(new Error(detail))
    })
    if (child.stdin === null || child.stdout === null) {
      throw new Error('mcode acp 没有可用的 stdio。')
    }

    const client = {
      sessionUpdate: (params: { sessionId?: string, update?: any }): void => {
        if (params.sessionId !== undefined && this.sessionId !== undefined && params.sessionId !== this.sessionId) return
        const update = params.update
        if (update === null || typeof update !== 'object') return
        switch (update.sessionUpdate) {
          case 'agent_message_chunk': {
            const text = typeof update.content?.text === 'string' ? update.content.text : ''
            if (text.length > 0) this.options.onUpdate?.({ kind: 'text', text })
            return
          }
          case 'agent_thought_chunk': {
            const text = typeof update.content?.text === 'string' ? update.content.text : ''
            if (text.length > 0) this.options.onUpdate?.({ kind: 'reasoning', text })
            return
          }
          case 'usage_update': {
            const used = typeof update.used === 'number' ? update.used : 0
            const size = typeof update.size === 'number' ? update.size : 0
            if (size > 0) this.options.onUpdate?.({ kind: 'usage', used, size })
            return
          }
          case 'tool_call':
          case 'tool_call_update': {
            const name = typeof update.title === 'string' && update.title.length > 0
              ? update.title
              : typeof update.name === 'string' ? update.name : ''
            if (name.length === 0) return
            if (!isHostMcpTool(name)) {
              // Built-in tool: the session cancels the prompt before it runs.
              if (update.sessionUpdate === 'tool_call' || update.status === 'in_progress') {
                this.options.onUpdate?.({ kind: 'native-tool', name })
              }
              return
            }
            return
          }
          default:
            return
        }
      },
      requestPermission: async (params: any): Promise<any> => {
        const name = typeof params?.toolCall?.title === 'string' && params.toolCall.title.length > 0
          ? params.toolCall.title
          : typeof params?.toolCall?.name === 'string' ? params.toolCall.name : ''
        const options = Array.isArray(params?.options) ? params.options : []
        if (isHostMcpTool(name)) {
          const allow = options.find((entry: any) => entry?.kind === 'allow_once')
            ?? options.find((entry: any) => entry?.kind === 'allow_always')
            ?? options[0]
          if (allow !== undefined) return { outcome: { outcome: 'selected', optionId: allow.optionId } }
          return { outcome: { outcome: 'cancelled' } }
        }
        this.options.onPermissionDenied?.(name)
        const deny = options.find((entry: any) => entry?.kind === 'reject_once')
          ?? options.find((entry: any) => entry?.kind === 'reject_always')
        return deny === undefined
          ? { outcome: { outcome: 'cancelled' } }
          : { outcome: { outcome: 'selected', optionId: deny.optionId } }
      },
    }

    const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))
    const conn = new ClientSideConnection(() => client as any, stream)
    this.conn = conn

    const init = await withTimeout(conn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'dsh-agent-sdk-bridge', version: '1.1.0' },
    }), timeout, 'mcode acp initialize')
    void init

    const mcpServers = this.options.mcpUrl === undefined
      ? []
      : [{
          type: 'http',
          name: MINIMAX_MCP_SERVER,
          url: this.options.mcpUrl,
          headers: [{ name: 'Authorization', value: `Bearer ${this.options.mcpToken ?? ''}` }],
        }]
    const session = await withTimeout(conn.newSession({
      cwd: this.options.cwd,
      mcpServers: mcpServers as any,
    }), timeout, 'mcode acp session/new')
    this.sessionId = session.sessionId
    this.configOptions = Array.isArray(session.configOptions) ? [...session.configOptions] : []
  }

  /** Run one prompt; resolves when the agent's turn ends. */
  async prompt(text: string): Promise<{ stopReason: string }> {
    if (this.conn === null || this.sessionId === undefined) throw new Error('ACP 会话尚未启动。')
    const response = await this.conn.prompt({
      sessionId: this.sessionId,
      prompt: [{ type: 'text', text }],
    } as any)
    return { stopReason: String(response.stopReason) }
  }

  /** Ask the agent to stop the active turn. */
  async cancel(): Promise<void> {
    if (this.conn === null || this.sessionId === undefined) return
    try {
      await this.conn.cancel({ sessionId: this.sessionId })
    } catch {
      // A turn that already ended has nothing to cancel.
    }
  }

  /** Set a session config option and remember the updated list. */
  async setConfig(id: string, value: string): Promise<void> {
    if (this.conn === null || this.sessionId === undefined) return
    const option = this.configOptions.find(entry => entry?.id === id)
    if (option === undefined) return
    if (option.currentValue === value) return
    const allowed = Array.isArray(option.options)
      ? option.options.some((entry: any) => entry?.value === value)
      : true
    if (!allowed) return
    const response = await this.conn.setSessionConfigOption({
      sessionId: this.sessionId,
      configId: id,
      value,
    } as any)
    if (Array.isArray(response.configOptions)) this.configOptions = [...response.configOptions]
  }

  /**
   * List the models the CLI actually accepts, with each model's own efforts.
   *
   * The advertised option list can contain values the agent rejects (0.6.12
   * lists a `M3.1-Flash` non-thinking value and answers `Invalid model
   * reasoning` when it is selected). Selecting each value once is the only
   * reliable filter, and it also reveals that non-thinking models drop the
   * `thinkingEffort` option entirely, so reasoning has to be reported per
   * model rather than once for the catalog.
   */
  async probeModels(): Promise<MinimaxModel[]> {
    const modelOption = this.configOptions.find(entry => entry?.category === 'model' || entry?.id === 'model')
    if (!Array.isArray(modelOption?.options)) return []
    const initial = typeof modelOption.currentValue === 'string' ? modelOption.currentValue : undefined
    const seen = new Set<string>()
    const models: MinimaxModel[] = []
    for (const entry of modelOption.options) {
      if (typeof entry?.value !== 'string' || entry.value.length === 0 || seen.has(entry.value)) continue
      seen.add(entry.value)
      try {
        await this.setConfig(String(modelOption.id), entry.value)
      } catch {
        continue
      }
      const effortOption = this.configOptions.find(option => option?.id === 'thinkingEffort' || option?.category === 'thought_level')
      const row = modelRow(entry, effortValues(effortOption?.options))
      if (row !== undefined) models.push(row)
    }
    if (initial !== undefined && this.currentModel !== initial) {
      try {
        await this.setConfig(String(modelOption.id), initial)
      } catch {
        // The restore is best effort; the caller never prompts this session.
      }
    }
    return models
  }

  /** Select the model (and, when supported, the thinking effort). */
  async selectModel(model: string, effort?: string): Promise<void> {
    const modelOption = this.configOptions.find(entry => entry?.category === 'model' || entry?.id === 'model')
    if (modelOption !== undefined) {
      const values = Array.isArray(modelOption.options)
        ? modelOption.options.map((entry: any) => entry?.value)
        : []
      if (values.includes(model)) await this.setConfig(String(modelOption.id), model)
    }
    if (effort !== undefined && effort.length > 0 && effort !== 'default') {
      const effortOption = this.configOptions.find(entry => entry?.id === 'thinkingEffort' || entry?.category === 'thought_level')
      if (effortOption !== undefined) {
        try {
          await this.setConfig(String(effortOption.id), effort)
        } catch {
          // A model that no longer advertises this effort still accepts the
          // turn with its own default; failing here would lose the request.
        }
      }
    }
  }

  /** Exit the session and reap the process. */
  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    const conn = this.conn
    const sessionId = this.sessionId
    this.conn = null
    this.sessionId = undefined
    if (conn !== null && sessionId !== undefined) {
      await withTimeout(conn.closeSession({ sessionId } as any), 3_000, 'mcode acp session/close').catch(() => undefined)
    }
    this.child?.kill()
    this.child = null
    if (this.tempDir !== undefined) {
      try {
        rmSync(this.tempDir, { recursive: true, force: true })
      } catch {
        // The temp directory may already be gone.
      }
      this.tempDir = undefined
    }
    this.systemFile = undefined
  }
}

/** A one-shot ACP process used by the catalog and title side channels. */
async function withAcp<T>(
  region: MinimaxRegion,
  timeoutMs: number,
  run: (acp: MinimaxAcp) => Promise<T>,
  options: { systemPrompt?: string, disableTools?: boolean } = {},
): Promise<T> {
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-minimax-side-'))
  const acp = new MinimaxAcp({
    region,
    cwd,
    systemPrompt: options.systemPrompt ?? 'You are a helper. Do not use tools.',
    disableTools: options.disableTools ?? true,
    timeoutMs,
  })
  try {
    await acp.start()
    return await run(acp)
  } finally {
    await acp.close()
    try {
      rmSync(cwd, { recursive: true, force: true })
    } catch {
      // Best effort.
    }
  }
}

/** Read the model list for one region (cached). */
export class MinimaxCatalog {
  private readonly snapshots = new Map<MinimaxRegion, { at: number, models: readonly MinimaxModel[] }>()
  private readonly inflight = new Map<MinimaxRegion, Promise<readonly MinimaxModel[]>>()
  private readonly failures = new Map<MinimaxRegion, string>()

  constructor(
    private readonly region: Live<MinimaxRegion>,
    private readonly ttlMs: Live<number> = MINIMAX_CACHE_TTL_MS,
    private readonly timeoutMs: Live<number> = MINIMAX_FETCH_TIMEOUT_MS,
  ) {}

  /** Models for one region; a failed refresh keeps the last good list. */
  async models(requested?: MinimaxRegion): Promise<readonly MinimaxModel[]> {
    const region = requested ?? readLive(this.region, 'cn')
    if (await minimaxRegionBlocked(region)) {
      this.invalidate(region)
      return []
    }
    const ttl = readLive(this.ttlMs, MINIMAX_CACHE_TTL_MS)
    const cached = this.snapshots.get(region)
    if (cached !== undefined && Date.now() - cached.at < ttl) return cached.models
    let pending = this.inflight.get(region)
    if (pending === undefined) {
      pending = this.fetch(region).finally(() => { this.inflight.delete(region) })
      this.inflight.set(region, pending)
    }
    try {
      const models = await pending
      this.snapshots.set(region, { at: Date.now(), models })
      this.failures.delete(region)
      return models
    } catch (error) {
      this.failures.set(region, error instanceof Error ? error.message : String(error))
      return cached?.models ?? []
    }
  }

  /** Why the last refresh failed, or undefined when it succeeded. */
  error(requested?: MinimaxRegion): string | undefined {
    return this.failures.get(requested ?? readLive(this.region, 'cn'))
  }

  invalidate(region?: MinimaxRegion): void {
    if (region === undefined) {
      this.snapshots.clear()
      this.failures.clear()
      return
    }
    this.snapshots.delete(region)
    this.failures.delete(region)
  }

  private async fetch(region: MinimaxRegion): Promise<readonly MinimaxModel[]> {
    if (!minimaxSignedIn(region)) {
      throw new Error(`${region === 'cn' ? 'MiniMax 国内站' : 'MiniMax 国际站'}尚未登录，请先在设置页登录。`)
    }
    if (await minimaxRegionBlocked(region)) {
      throw new MinimaxRegionBlockedError(region)
    }
    const timeout = readLive(this.timeoutMs, MINIMAX_FETCH_TIMEOUT_MS)
    return await withAcp(region, timeout, async acp => acp.probeModels(), {
      systemPrompt: 'You are a helper used only to list models. Do not call any tool.',
      disableTools: true,
    })
  }
}

/** One shared HTTP MCP server for every warm MiniMax session. */
export class MinimaxMcpServer {
  private server: Server | undefined
  private port = 0
  private readonly bridges = new Map<string, MinimaxMcpBridge>()

  /** The base URL, or undefined before {@link start}. */
  get baseUrl(): string | undefined {
    return this.server === undefined ? undefined : `http://127.0.0.1:${this.port}`
  }

  /** Bind to an ephemeral loopback port. */
  async start(): Promise<void> {
    if (this.server !== undefined) return
    const server = createServer((req, res) => { void this.handle(req, res) })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (address === null || typeof address === 'string') {
      server.close()
      throw new Error('无法为 MiniMax 宿主工具分配本地端口。')
    }
    this.port = address.port
    this.server = server
  }

  /** Add one session's bridge under a random token. */
  register(bridge: MinimaxMcpBridge): { url: string, token: string } {
    if (this.server === undefined) throw new Error('MiniMax MCP server 尚未启动。')
    const token = randomBytes(24).toString('hex')
    this.bridges.set(token, bridge)
    return { url: `${this.baseUrl}/mcp/${token}`, token }
  }

  unregister(token: string): void {
    this.bridges.delete(token)
  }

  /** Close the server and release every session. */
  close(): void {
    this.bridges.clear()
    this.server?.close()
    this.server = undefined
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const match = /^\/mcp\/([a-f0-9]+)$/.exec(url.pathname)
    const bridge = match === null ? undefined : this.bridges.get(match[1])
    if (bridge === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"unknown MCP session"}')
      return
    }
    if (req.method === 'GET') {
      res.writeHead(405).end()
      return
    }
    if (req.method === 'DELETE') {
      res.writeHead(200).end()
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end()
      return
    }
    // The path token is unguessable, and the bearer header is required on top
    // of it so a local process cannot reuse a URL it saw in a log.
    if (req.headers.authorization !== `Bearer ${match?.[1] ?? ''}`) {
      res.writeHead(403).end()
      return
    }
    let raw = ''
    for await (const chunk of req) {
      raw += chunk
      if (raw.length > 8 * 1024 * 1024) {
        res.writeHead(413).end()
        return
      }
    }
    let message: any
    try {
      message = JSON.parse(raw)
    } catch {
      res.writeHead(400).end()
      return
    }
    const id = message?.id
    const reply = (payload: unknown): void => {
      const body = JSON.stringify(payload)
      res.writeHead(200, {
        'content-type': 'application/json',
        'mcp-session-id': match?.[1] ?? 'dsh-host',
      }).end(body)
    }
    if (message?.method === undefined) {
      res.writeHead(202).end()
      return
    }
    if (id === undefined) {
      // Notifications, including notifications/initialized.
      res.writeHead(202).end()
      return
    }
    try {
      switch (message.method) {
        case 'initialize':
          reply({
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
              capabilities: { tools: {} },
              serverInfo: { name: MINIMAX_MCP_SERVER, version: '1.0.0' },
            },
          })
          return
        case 'ping':
          reply({ jsonrpc: '2.0', id, result: {} })
          return
        case 'tools/list':
          reply({ jsonrpc: '2.0', id, result: { tools: bridge.tools() } })
          return
        case 'tools/call': {
          const name = typeof message.params?.name === 'string' ? message.params.name : ''
          const args = message.params?.arguments !== null && typeof message.params?.arguments === 'object'
            ? message.params.arguments as Record<string, unknown>
            : {}
          const result = await bridge.call(name, args)
          reply({ jsonrpc: '2.0', id, result })
          return
        }
        default:
          reply({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method ${String(message.method)}` } })
          return
      }
    } catch (error) {
      reply({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        },
      })
    }
  }
}

/** One session's view of the MCP server. */
export class MinimaxMcpBridge {
  private schemas: readonly { name: string, description: string, parameters?: unknown }[] = []

  constructor(
    private readonly callHost: (name: string, args: Record<string, unknown>) => Promise<MinimaxMcpToolResult>,
  ) {}

  setTools(tools: readonly { name: string, description: string, parameters?: unknown }[]): void {
    this.schemas = tools
  }

  tools(): { name: string, description: string, inputSchema: Record<string, unknown> }[] {
    return this.schemas.map(schema => ({
      name: schema.name,
      description: schema.description.length > 0 ? schema.description : schema.name,
      inputSchema: schema.parameters !== null && typeof schema.parameters === 'object'
        ? schema.parameters as Record<string, unknown>
        : { type: 'object', properties: {} },
    }))
  }

  async call(name: string, args: Record<string, unknown>): Promise<MinimaxMcpToolResult> {
    if (!this.schemas.some(schema => schema.name === name)) {
      return { content: [{ type: 'text', text: `未知工具：${name}` }], isError: true }
    }
    return await this.callHost(name, args)
  }
}

/** The result of one warm session's turn. */
interface TurnState {
  textBlock?: { index: number, text: string }
  reasoningBlock?: { index: number, text: string }
  blockIndex: number
  inputChars: number
  outputChars: number
  reasoningChars: number
  /** Context occupancy the agent reported, the best input-count signal. */
  contextUsed?: number
}

/** A prompt that asks the model to retry without native tools. */
const NATIVE_TOOL_CORRECTION = [
  'SYSTEM NOTICE (not from the user):',
  'The built-in tools (bash, read, write, edit, glob, grep, web_fetch, task, and every other native tool)',
  'are disabled in this deployment. Any call to them is cancelled before execution.',
  'The only valid tools are the host MCP tools whose names begin with mcp__dsh-host__.',
  'Re-answer the user\'s last request using only those host tools. Do not mention this notice.',
].join('\n')

/** The tool policy appended to the host system prompt. */
const HOST_TOOL_POLICY = [
  '## Host tool protocol',
  'You are the model backend of DeepSeek Harness.',
  'The ONLY tools you may call are the host MCP tools exposed by the `dsh-host` MCP server;',
  'their names begin with `mcp__dsh-host__`. The built-in tools (bash, read, write, edit, glob,',
  'grep, web_fetch, task, and every other native tool) are disabled in this deployment: calling',
  'one aborts the turn before execution. Never mention this rule to the user.',
].join('\n')

/**
 * One warm MiniMax conversation for a harness session id.
 *
 * The ACP agent owns the history. A turn ends either when the prompt finishes
 * or when a host tool call is handed to the harness; in the latter case the
 * ACP prompt stays open until the harness returns the result on its next
 * request, exactly like the CodeBuddy bridge.
 */
export class MinimaxSession {
  private acp: MinimaxAcp | null = null
  private readonly events = new EventQueue()
  private readonly bridge: MinimaxMcpBridge
  private readonly pending = new Map<string, PendingHostCall>()
  private readonly toolResultTimeoutMs: number
  private readonly abortGraceMs: number
  private readonly callNonce = randomUUID().slice(0, 8)
  private toolCounter = 0
  private promptInFlight = false
  private activeTurn = false
  private disposed = false
  private region: MinimaxRegion = 'cn'
  private model = ''
  private effort: string | undefined
  private systemPrompt = ''
  private workspace: string | undefined
  /** The harness workspace; absent means the session owns a temp directory. */
  private requestedCwd: string | undefined
  private ownsWorkspace = false
  private mcpToken: string | undefined
  private toolSchemas: readonly { name: string, description: string, parameters?: unknown }[] = []
  private nativeViolation = false
  private cancelSent = false
  private correctionCount = 0
  private observedContextWindow: number | undefined
  /** Was the last turn closed with tool-calls, leaving the ACP prompt open? */
  private awaitingToolResults = false
  /** Host messages already fed to the ACP session, for continuation planning. */
  fedMessages: readonly RequestMessage[] | undefined
  /** Host system prompt last applied; informational for the adapter. */
  fedSystem: string | undefined

  constructor(
    readonly sessionId: string,
    initialModel: string,
    private readonly mcpServer: MinimaxMcpServer,
    runtime: { toolResultTimeoutMs?: Live<number>, abortGraceMs?: Live<number> } = {},
  ) {
    this.model = initialModel
    this.toolResultTimeoutMs = readLive(runtime.toolResultTimeoutMs, 120_000)
    this.abortGraceMs = readLive(runtime.abortGraceMs, 5_000)
    this.bridge = new MinimaxMcpBridge((name, args) => this.handleToolCall(name, args))
  }

  /** Model context window observed from a real turn, when one was reported. */
  get contextWindow(): number | undefined {
    return this.observedContextWindow
  }

  /**
   * Whether the ACP session still owns an unfinished turn.
   *
   * A turn closed with `tool-calls` keeps its prompt open while the host runs
   * the tools, so this stays true between the two host requests. A brand-new
   * user message in that state cannot be injected; the adapter rebuilds the
   * session and feeds the whole history instead.
   */
  get busy(): boolean {
    return this.promptInFlight || this.activeTurn
  }

  /**
   * Point the session at a region, model and system prompt.
   *
   * @returns true when the warm ACP process was dropped, which means the
   * conversation state must be rebuilt from the durable history.
   */
  configure(
    region: MinimaxRegion,
    model: string,
    options: { effort?: string, system?: string, cwd?: string } = {},
  ): boolean {
    const nextSystem = options.system ?? ''
    const nextCwd = options.cwd
    let reset = false
    if (this.acp !== null && (
      nextSystem !== this.systemPrompt
      || region !== this.region
      || nextCwd !== this.requestedCwd
    )) {
      // systemPrompt and cwd are fixed when the ACP process starts. Drop the
      // warm session so the adapter's next turn rebuilds it.
      void this.dropAcp()
      this.fedMessages = undefined
      reset = true
    }
    this.region = region
    this.model = model
    this.effort = options.effort
    this.systemPrompt = nextSystem
    this.requestedCwd = nextCwd
    return reset
  }

  /** Register the host tools this session's MCP server advertises. */
  ensureTools(tools: readonly { name: string, description: string, parameters?: unknown }[]): void {
    this.toolSchemas = tools
    this.bridge.setTools(tools)
  }

  /** Hand the host's tool results to parked handlers. */
  deliverToolResults(tail: readonly { role: string, toolCallId?: unknown, content?: unknown, isError?: boolean }[]): void {
    let freshUserTurn = false
    for (const message of tail) {
      if (message.role === 'user') {
        freshUserTurn = true
        continue
      }
      if (message.role !== 'tool') continue
      const callId = message.toolCallId === undefined ? '' : String(message.toolCallId)
      const pending = this.pending.get(callId)
      if (pending === undefined) continue
      clearTimeout(pending.timer)
      this.pending.delete(callId)
      pending.resolve({
        ...renderToolResult(message.content),
        ...message.isError === true ? { isError: true } : {},
      })
    }
    if (freshUserTurn && this.pending.size > 0) {
      // The user interrupted a tool round; the ACP turn cannot receive these
      // results any more, so settle it and let the next prompt rebuild.
      for (const [callId, pending] of this.pending) {
        clearTimeout(pending.timer)
        pending.reject(new Error('宿主开始了新的用户轮次，未返回的工具结果已取消。'))
        this.pending.delete(callId)
      }
      if (this.promptInFlight) {
        void this.acp?.cancel()
      }
      this.awaitingToolResults = false
    }
  }

  /** Run one harness turn. `feed` is new user text, or null for a continuation. */
  async *stream(options: GenerateOptions, feed: string | null): AsyncGenerator<StreamChunk> {
    if (this.disposed) throw new Error(`MiniMax session ${this.sessionId} was disposed`)
    if (this.activeTurn) throw new Error(`MiniMax session ${this.sessionId} already has a turn in flight`)
    this.activeTurn = true
    const signal = options.signal
    const turn: TurnState = {
      blockIndex: 0,
      inputChars: feed?.length ?? 0,
      outputChars: 0,
      reasoningChars: 0,
    }
    let abortRequested = false
    let abortTimer: ReturnType<typeof setTimeout> | undefined
    let onAbortListener: (() => void) | undefined

    try {
      await this.ensureStarted()
      if (!this.promptInFlight) {
        await this.startPrompt(feed ?? '')
        this.awaitingToolResults = false
      } else if (feed !== null && feed.length > 0 && !this.awaitingToolResults) {
        throw new Error('MiniMax 会话正忙：上一轮尚未结束。')
      }

      const onAbort = (): void => {
        abortRequested = true
        void this.acp?.cancel()
        abortTimer = setTimeout(() => { void this.dropAcp() }, this.abortGraceMs)
      }
      onAbortListener = onAbort
      signal?.addEventListener('abort', onAbort, { once: true })

      while (true) {
        if (signal?.aborted === true) {
          if (!abortRequested) onAbort()
          rejectPending(this.pending, new Error('MiniMax 会话被宿主中止。'))
          this.promptInFlight = false
          this.awaitingToolResults = false
          yield* this.finish(turn, { kind: 'aborted', failure: { message: 'MiniMax turn aborted by host', code: 'ABORTED' } })
          return
        }
        const event = await raceAbort(this.events.next(), signal)
        if (event === undefined) {
          // raceAbort resolves undefined for an abort too; the loop head
          // settles that case with an `aborted` finish.
          if (abortRequested) continue
          yield* this.finish(turn, { kind: 'error', failure: { message: 'MiniMax ACP stream closed', code: 'STREAM_CLOSED' } })
          return
        }
        switch (event.kind) {
          case 'text': {
            turn.outputChars += event.text.length
            if (turn.textBlock === undefined) {
              turn.textBlock = { index: turn.blockIndex++, text: '' }
              yield { type: 'block-start', index: turn.textBlock.index, blockType: 'text' }
            }
            turn.textBlock.text += event.text
            yield { type: 'text-delta', index: turn.textBlock.index, text: event.text }
            continue
          }
          case 'reasoning': {
            turn.reasoningChars += event.text.length
            if (turn.reasoningBlock === undefined) {
              turn.reasoningBlock = { index: turn.blockIndex++, text: '' }
              yield { type: 'block-start', index: turn.reasoningBlock.index, blockType: 'reasoning' }
            }
            turn.reasoningBlock.text += event.text
            yield { type: 'reasoning-delta', index: turn.reasoningBlock.index, text: event.text }
            continue
          }
          case 'usage': {
            if (event.size > 0) this.observedContextWindow = event.size
            if (event.used > 0) turn.contextUsed = event.used
            continue
          }
          case 'host-tool': {
            // Close the prose before the tool block so the harness assembler
            // sees text -> tool-call rather than an end frame after it.
            if (turn.textBlock !== undefined) {
              yield { type: 'block-end', index: turn.textBlock.index, block: { type: 'text', text: turn.textBlock.text } }
              turn.textBlock = undefined
            }
            if (turn.reasoningBlock !== undefined) {
              yield { type: 'block-end', index: turn.reasoningBlock.index, block: { type: 'reasoning', text: turn.reasoningBlock.text } }
              turn.reasoningBlock = undefined
            }
            const index = turn.blockIndex++
            yield { type: 'block-start', index, blockType: 'tool-call' }
            const args = JSON.stringify(event.args)
            yield {
              type: 'tool-call-delta',
              index,
              id: ToolCallId(event.callId),
              name: event.name,
              argumentsDelta: args,
            }
            yield {
              type: 'block-end',
              index,
              block: { type: 'tool-call', id: ToolCallId(event.callId), name: event.name, arguments: args },
            }
            this.awaitingToolResults = true
            yield* this.finish(turn, { kind: 'tool-calls' })
            return
          }
          case 'native-tool': {
            if (!this.cancelSent) {
              this.cancelSent = true
              this.nativeViolation = true
              await this.acp?.cancel()
            }
            continue
          }
          case 'prompt-done': {
            this.promptInFlight = false
            this.cancelSent = false
            if (abortRequested) {
              rejectPending(this.pending, new Error('MiniMax 会话被宿主中止。'))
              yield* this.finish(turn, { kind: 'aborted', failure: { message: 'MiniMax turn aborted by host', code: 'ABORTED' } })
              return
            }
            if (this.nativeViolation) {
              this.nativeViolation = false
              this.correctionCount += 1
              if (this.correctionCount <= MAX_NATIVE_TOOL_RETRIES) {
                await new Promise(resolve => setTimeout(resolve, 350))
                try {
                  await this.startPrompt(NATIVE_TOOL_CORRECTION)
                  this.awaitingToolResults = false
                  continue
                } catch (error) {
                  yield* this.finish(turn, {
                    kind: 'error',
                    failure: {
                      message: `MiniMax 内置工具不可用，重试失败：${error instanceof Error ? error.message : String(error)}`,
                      code: 'BACKEND_TURN_ERROR',
                    },
                  })
                  return
                }
              }
              yield* this.finish(turn, {
                kind: 'error',
                failure: {
                  message: 'MiniMax 连续尝试调用内置工具。本插件只允许宿主 MCP 工具，已取消本轮。',
                  code: 'BACKEND_TURN_ERROR',
                },
              })
              return
            }
            if (event.stopReason === 'end_turn' || event.stopReason === 'max_tokens') {
              yield* this.finish(turn, event.stopReason === 'max_tokens' ? { kind: 'max-tokens' } : { kind: 'stop' })
              return
            }
            if (event.stopReason === 'cancelled') {
              yield* this.finish(turn, { kind: 'aborted', failure: { message: 'MiniMax turn cancelled', code: 'ABORTED' } })
              return
            }
            yield* this.finish(turn, { kind: 'stop' })
            return
          }
          case 'prompt-error': {
            this.promptInFlight = false
            this.cancelSent = false
            yield* this.finish(turn, {
              kind: 'error',
              failure: { message: event.error.message, code: 'BACKEND_TURN_ERROR' },
            })
            return
          }
          case 'closed': {
            this.promptInFlight = false
            yield* this.finish(turn, {
              kind: 'error',
              failure: { message: event.error.message, code: 'BACKEND_TURN_ERROR' },
            })
            return
          }
        }
      }
    } finally {
      if (onAbortListener !== undefined) signal?.removeEventListener('abort', onAbortListener)
      if (abortTimer !== undefined) clearTimeout(abortTimer)
      this.activeTurn = false
    }
  }

  /** Tear the ACP process down; parked handlers settle with a cancellation. */
  close(): void {
    if (this.disposed) return
    this.disposed = true
    rejectPending(this.pending, new Error('MiniMax 会话已关闭。'))
    this.events.close()
    const workspace = this.workspace
    const owned = this.ownsWorkspace
    this.workspace = undefined
    this.ownsWorkspace = false
    void this.dropAcp().finally(() => {
      if (workspace === undefined || !owned) return
      try {
        rmSync(workspace, { recursive: true, force: true })
      } catch {
        // Best effort.
      }
    })
  }

  private async ensureStarted(): Promise<void> {
    if (this.acp !== null) return
    await this.mcpServer.start()
    if (this.workspace === undefined) {
      if (this.requestedCwd !== undefined) {
        this.workspace = this.requestedCwd
        this.ownsWorkspace = false
      } else {
        this.workspace = mkdtempSync(join(tmpdir(), 'dsh-minimax-session-'))
        this.ownsWorkspace = true
      }
    }
    this.bridge.setTools(this.toolSchemas)
    const registered = this.mcpServer.register(this.bridge)
    this.mcpToken = registered.token
    const system = `${this.systemPrompt.trim()}\n\n${HOST_TOOL_POLICY}\n`
    const acp = new MinimaxAcp({
      region: this.region,
      cwd: this.workspace,
      systemPrompt: system,
      mcpUrl: registered.url,
      mcpToken: registered.token,
      onUpdate: update => { this.events.push(update) },
      onExit: error => { this.events.push({ kind: 'closed', error }) },
    })
    try {
      await acp.start()
      await acp.selectModel(this.model, this.effort)
      this.acp = acp
    } catch (error) {
      await acp.close()
      this.mcpServer.unregister(registered.token)
      this.mcpToken = undefined
      throw error
    }
  }

  private async startPrompt(text: string): Promise<void> {
    const acp = this.acp
    if (acp === null) throw new Error('MiniMax ACP 尚未启动。')
    this.promptInFlight = true
    this.cancelSent = false
    void this.launchPrompt(acp, text, 0)
  }

  /**
   * Start one ACP prompt and publish its outcome.
   *
   * Cancelling a turn makes the next `session/prompt` fail with "Session
   * already has an active Turn" for a short while even though the cancelled
   * prompt has already resolved. That race is routine here: the native-tool
   * correction is sent immediately after such a cancel, so it is retried with
   * a short backoff instead of being reported as a failed turn.
   */
  private async launchPrompt(acp: MinimaxAcp, text: string, attempt: number): Promise<void> {
    try {
      const response = await acp.prompt(text)
      this.events.push({ kind: 'prompt-done', stopReason: response.stopReason })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/401 token is required/i.test(message)) {
        // With a China IP the international edge redirects to the mainland
        // host, which drops the Authorization header; the CLI then reports a
        // missing token. Refresh the verdict in the background and explain the
        // real cause instead of asking for another login.
        void minimaxRegionBlocked(this.region, { fresh: true })
        const hint = minimaxRegionBlockedCached(this.region)
          ? minimaxRegionBlockMessage(this.region)
          : this.region === 'global'
            ? 'MiniMax 国际站拒绝了本机连接（401 token is required）。通常是本机网络 IP 不在国际站服务区域；请检查网络后重试，或切换到国内站。'
            : 'MiniMax 国内站拒绝了本机连接（401 token is required）。请检查网络或重新登录后重试。'
        this.events.push({ kind: 'prompt-error', error: new Error(hint) })
        return
      }
      const retryable = /active Turn|already has an active/i.test(message)
      if (retryable && attempt < 4 && !this.disposed && this.acp === acp) {
        await new Promise(resolve => setTimeout(resolve, 200 * 2 ** attempt))
        if (!this.disposed && this.acp === acp) {
          await this.launchPrompt(acp, text, attempt + 1)
          return
        }
      }
      this.events.push({ kind: 'prompt-error', error: error instanceof Error ? error : new Error(message) })
    }
  }

  private async dropAcp(): Promise<void> {
    const acp = this.acp
    this.acp = null
    this.promptInFlight = false
    this.awaitingToolResults = false
    if (acp !== null) await acp.close()
    if (this.mcpToken !== undefined) {
      this.mcpServer.unregister(this.mcpToken)
      this.mcpToken = undefined
    }
  }

  private async handleToolCall(name: string, args: Record<string, unknown>): Promise<MinimaxMcpToolResult> {
    if (this.disposed) return { content: [{ type: 'text', text: 'MiniMax 会话已关闭。' }], isError: true }
    const callId = `mm-${this.callNonce}-${++this.toolCounter}`
    const result = new Promise<MinimaxMcpToolResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(callId)
        reject(new Error(`宿主工具 ${name} 在 ${Math.round(this.toolResultTimeoutMs / 1000)} 秒内没有返回结果。`))
      }, this.toolResultTimeoutMs)
      this.pending.set(callId, { resolve, reject, timer })
    })
    this.events.push({ kind: 'host-tool', callId, name, args })
    try {
      return await result
    } catch (error) {
      return {
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      }
    }
  }

  private async *finish(turn: TurnState, reason: FinishReason): AsyncGenerator<StreamChunk> {
    if (turn.textBlock !== undefined) {
      yield { type: 'block-end', index: turn.textBlock.index, block: { type: 'text', text: turn.textBlock.text } }
    }
    if (turn.reasoningBlock !== undefined) {
      yield { type: 'block-end', index: turn.reasoningBlock.index, block: { type: 'reasoning', text: turn.reasoningBlock.text } }
    }
    // The CLI reports whole-context occupancy, which is the real prompt size;
    // the character estimate is only the fallback for providers that omit it.
    const inputTokens = turn.contextUsed !== undefined
      ? Math.max(1, turn.contextUsed)
      : Math.max(1, estimateTextTokens(turn.inputChars, 0))
    const outputTokens = Math.max(1, estimateTextTokens(turn.outputChars + turn.reasoningChars, 0))
    const usage: TokenUsage = {
      inputTokens,
      outputTokens,
      ...turn.reasoningChars === 0 ? {} : { reasoningTokens: Math.max(1, estimateTextTokens(turn.reasoningChars, 0)) },
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: inputTokens + outputTokens,
    }
    yield { type: 'usage', usage }
    yield { type: 'finish', reason }
    if (reason.kind !== 'tool-calls' && !this.disposed) {
      this.correctionCount = 0
    }
  }
}

/** Reject every parked handler with the same reason. */
function rejectPending(pending: Map<string, PendingHostCall>, error: Error): void {
  for (const [callId, entry] of pending) {
    clearTimeout(entry.timer)
    entry.reject(error)
    pending.delete(callId)
  }
}

/** Wait for a promise, or give up after `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error(`${label} timed out after ${ms}ms`)) }, ms)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

/** Await a queue read, giving up when the harness aborts the turn. */
function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.resolve(undefined)
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort)
      resolve(undefined)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/** Warm session pool, keyed by harness session id. */
export class MinimaxSessionManager {
  private readonly sessions = new Map<string, { session: MinimaxSession, region: MinimaxRegion }>()

  constructor(
    readonly maxSessions: Live<number>,
    private readonly mcpServer: MinimaxMcpServer,
    private readonly runtime: { toolResultTimeoutMs?: Live<number>, abortGraceMs?: Live<number> } = {},
  ) {}

  forSession(sessionId: string, region: MinimaxRegion, model: string): MinimaxSession {
    const existing = this.sessions.get(sessionId)
    if (existing !== undefined) {
      if (existing.region !== region) {
        existing.session.close()
        this.sessions.delete(sessionId)
      } else {
        this.sessions.delete(sessionId)
        this.sessions.set(sessionId, existing)
        return existing.session
      }
    }
    const session = new MinimaxSession(sessionId, model, this.mcpServer, this.runtime)
    this.sessions.set(sessionId, { session, region })
    const cap = readLive(this.maxSessions, 8)
    while (this.sessions.size > cap) {
      const oldest = this.sessions.keys().next()
      if (oldest.done === true) break
      const victim = this.sessions.get(oldest.value)
      this.sessions.delete(oldest.value)
      victim?.session.close()
    }
    return session
  }

  dispose(sessionId: string): void {
    const entry = this.sessions.get(sessionId)
    if (entry === undefined) return
    this.sessions.delete(sessionId)
    entry.session.close()
  }

  closeAll(): void {
    for (const entry of this.sessions.values()) entry.session.close()
    this.sessions.clear()
  }
}

/** A one-shot turn, used for titles and compaction summaries. */
export async function minimaxColdStream(
  region: MinimaxRegion,
  prompt: string,
  model: string | undefined,
  options: GenerateOptions,
): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  let text = ''
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-minimax-cold-'))
  const acp = new MinimaxAcp({
    region,
    cwd,
    systemPrompt: 'You are a concise helper used only for titles and summaries. Do not call any tool.',
    disableTools: true,
    onUpdate: update => {
      if (update.kind === 'text') text += update.text
    },
  })
  const signal = options.signal
  const onAbort = (): void => { void acp.cancel() }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    await acp.start()
    if (model !== undefined) await acp.selectModel(model)
    const response = await acp.prompt(prompt)
    if (signal?.aborted === true || response.stopReason === 'cancelled') {
      chunks.push({ type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted by host', code: 'ABORTED' } } })
      return chunks
    }
    if (text.trim().length === 0) {
      chunks.push({ type: 'finish', reason: { kind: 'error', failure: { message: 'MiniMax side-channel returned no content', code: EMPTY_RESPONSE_CODE } } })
      return chunks
    }
    chunks.push({ type: 'block-start', index: 0, blockType: 'text' })
    for (let index = 0; index < text.length; index += 192) {
      chunks.push({ type: 'text-delta', index: 0, text: text.slice(index, index + 192) })
    }
    chunks.push({ type: 'block-end', index: 0, block: { type: 'text', text } })
    const inputTokens = Math.max(1, estimateTextTokens(prompt.length, 0))
    const outputTokens = Math.max(1, estimateTextTokens(text.length, 0))
    chunks.push({ type: 'usage', usage: { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: inputTokens + outputTokens } })
    chunks.push({ type: 'finish', reason: { kind: 'stop' } })
    return chunks
  } finally {
    signal?.removeEventListener('abort', onAbort)
    await acp.close()
    try {
      rmSync(cwd, { recursive: true, force: true })
    } catch {
      // Best effort.
    }
  }
}
