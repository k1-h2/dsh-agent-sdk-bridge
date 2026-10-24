/**
 * CodeBuddy's account, catalog, login and warm sessions.
 *
 * The SDK is the CodeBuddy Code SDK (`@tencent-ai/agent-sdk`). It bundles its
 * own CLI, so unlike the Qoder brands there is no global install and no batch
 * helper: login is an SDK call whose region is `external` (international) or
 * `internal` (mainland). Enterprise/IOA/self-hosted login is out of scope.
 *
 * One CodeBuddy provider serves both regions; the region is a setting, so the
 * models and account shown always belong to the selected login.
 *
 * @module dsh-agent-sdk-bridge/codebuddy
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { EMPTY_RESPONSE_CODE, ToolCallId } from '@deepseek-ai/dsh-llm'
import type {
  FinishReason, GenerateOptions, StreamChunk, TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type {
  CanUseTool, Message, RawLanguageModel, UserMessage,
} from '@tencent-ai/agent-sdk'
import type { CodeBuddyRegion } from './brand.ts'
import { jsonSchemaToShape } from './jsonschema.ts'
import type { Live } from './live.ts'
import { readLive } from './live.ts'
import { codeBuddyEnvironment, loadCodeBuddySdk } from './sdk.ts'
import type { ToolResultPayload } from './session.ts'
import { MCP_SERVER_NAME, ToolResultPairing, TurnQueue } from './session.ts'
import { TurnOutputAccounting, estimateTextTokens } from './tokens.ts'

/** Default context capacity assumed for a CodeBuddy model that declares none. */
export const CODEBUDDY_DEFAULT_CONTEXT_WINDOW = 200_000
/** Default output cap when the catalog declares none. */
export const CODEBUDDY_DEFAULT_MAX_TOKENS = 32_000
/** How long one CodeBuddy account/catalog read stays fresh. */
export const CODEBUDDY_CACHE_TTL_MS = 300_000
/** Give up on one CodeBuddy control round trip after this long. */
export const CODEBUDDY_FETCH_TIMEOUT_MS = 30_000
/** How long a login waits for the browser before giving up. */
const LOGIN_TIMEOUT_MS = 300_000

/** The session object the SDK's createSession returns (not a named export). */
type SessionImpl = ReturnType<typeof import('@tencent-ai/agent-sdk').unstable_v2_createSession>

const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`

/** One model as the settings page and the adapter see it. */
export interface CodeBuddyModel {
  id: string
  name: string
  description?: string
  maxInputTokens?: number
  maxOutputTokens?: number
  contextWindows: number[]
  defaultContextWindow: number
  vision: boolean
  reasoningEfforts?: string[]
  defaultEffort?: string
  /** Credit multiplier, parsed from the catalog's `x0.79 credits` string. */
  priceFactor?: number
}

/** One signed-in CodeBuddy account. */
export interface CodeBuddyAccount {
  email?: string
  organization?: string
  subscriptionType?: string
}

/** One credit package inside a CodeBuddy quota reading. */
export interface CodeBuddyQuotaPackage {
  name: string
  total: number
  used: number
  /** Epoch milliseconds, when the package expires. */
  end?: number
}

/** Account credits, read from CodeBuddy's billing endpoint. */
export interface CodeBuddyQuota {
  remaining: number
  total: number
  used: number
  /** Earliest still-valid package expiry, in epoch milliseconds. */
  cycleEnd?: number
  packages: CodeBuddyQuotaPackage[]
}

/** The account reading served to the settings page. */
export interface CodeBuddyUsageSnapshot {
  at: number
  account?: CodeBuddyAccount
  quota?: CodeBuddyQuota
  /** Why the quota lookup failed, when the account itself was readable. */
  quotaError?: string
  error?: string
}

/** The public billing hosts; both regions speak the same quota protocol. */
const CODEBUDDY_ENDPOINTS: Record<CodeBuddyRegion, string> = {
  global: 'https://www.codebuddy.ai',
  cn: 'https://copilot.tencent.com',
}
const QUOTA_PATH = '/v2/billing/meter/get-user-resource'
const QUOTA_RANGE_END = '2099-12-31 23:59:59'
/** Cosmetic fingerprint headers the upstream checks; kept in step with the CLI. */
const CLIENT_VERSION = '2.174.0'

/** Tokens obtained from a successful login or a silent auth read, per region. */
const bearerTokens = new Map<CodeBuddyRegion, string>()

/** Remember a bearer token in memory only; it is never written to disk. */
function rememberBearerToken(region: CodeBuddyRegion, token: string): void {
  if (token.length > 0) bearerTokens.set(region, token)
}

/** Login progress for one region. */
export interface CodeBuddyAuthStatus {
  running: boolean
  region: CodeBuddyRegion
  startedAt?: number
  finishedAt?: number
  /** Browser URL, once the CLI hands one over. */
  url?: string
  user?: { userId: string, userName: string, userNickname: string }
  error?: string
}

/** Parse the catalog's `x0.79 credits` string into a number. */
function priceFactorOf(model: RawLanguageModel): number | undefined {
  const match = /x\s*([0-9]+(?:\.[0-9]+)?)/i.exec(model.credits ?? '')
  if (match === null) return undefined
  const value = Number(match[1])
  return Number.isFinite(value) ? value : undefined
}

/** Turn one raw catalog entry into the model row this plugin uses. */
export function toCodeBuddyModel(model: RawLanguageModel): CodeBuddyModel {
  const windows = new Set<number>(model.contextWindow?.supportedLengths ?? [])
  const declared = model.contextWindow?.defaultLength
    ?? model.maxInputTokens
    ?? model.maxAllowedSize
    ?? CODEBUDDY_DEFAULT_CONTEXT_WINDOW
  windows.add(declared)
  return {
    id: model.id,
    name: model.name ?? model.id,
    ...(model.description ?? model.descriptionZh ?? model.descriptionEn) === undefined
      ? {}
      : { description: (model.description ?? model.descriptionZh ?? model.descriptionEn) as string },
    ...model.maxInputTokens === undefined ? {} : { maxInputTokens: model.maxInputTokens },
    ...model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens },
    contextWindows: [...windows].sort((a, b) => a - b),
    defaultContextWindow: declared,
    vision: model.supportsImages === true && model.disabledMultimodal !== true,
    ...model.reasoning?.supportedEfforts === undefined
      ? model.supportsReasoning === true ? { reasoningEfforts: ['low', 'medium', 'high'] } : {}
      : { reasoningEfforts: [...model.reasoning.supportedEfforts] },
    ...model.reasoning?.defaultEffort === undefined ? {} : { defaultEffort: model.reasoning.defaultEffort },
    ...priceFactorOf(model) === undefined ? {} : { priceFactor: priceFactorOf(model) as number },
  }
}

/** Run one short-lived session and hand it to `run`, always closing it. */
async function withSession<T>(
  region: CodeBuddyRegion,
  run: (session: SessionImpl) => Promise<T>,
  timeoutMs: number,
  options: { sessionId?: string, model?: string, systemPrompt?: string } = {},
): Promise<T> {
  const sdk = await loadCodeBuddySdk()
  const session = sdk.unstable_v2_createSession({
    environment: codeBuddyEnvironment(region),
    sessionId: options.sessionId ?? randomUUID(),
    ...options.model === undefined ? {} : { model: options.model },
    ...options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt },
    settingSources: [],
    persistSession: false,
  })
  try {
    await withTimeout(session.connect(), timeoutMs)
    return await withTimeout(run(session), timeoutMs)
  } finally {
    session.close()
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error(`CodeBuddy request timed out after ${ms}ms`)) }, ms)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

/**
 * The account's model catalog for one region.
 *
 * CodeBuddy only answers this after the CLI has started, so the read costs one
 * process boot. Results are cached per region and fall back to the last good
 * list when a refresh fails.
 */
export class CodeBuddyCatalog {
  private readonly snapshots = new Map<CodeBuddyRegion, { at: number, models: readonly CodeBuddyModel[] }>()
  private readonly inflight = new Map<CodeBuddyRegion, Promise<readonly CodeBuddyModel[]>>()
  private readonly failures = new Map<CodeBuddyRegion, string>()

  constructor(
    private readonly region: Live<CodeBuddyRegion>,
    private readonly ttlMs: Live<number> = CODEBUDDY_CACHE_TTL_MS,
    private readonly timeoutMs: Live<number> = CODEBUDDY_FETCH_TIMEOUT_MS,
  ) {}

  /** Models for the current region; a failed refresh keeps the last good list. */
  async models(): Promise<readonly CodeBuddyModel[]> {
    const region = readLive(this.region, 'global')
    const ttl = readLive(this.ttlMs, CODEBUDDY_CACHE_TTL_MS)
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
  error(): string | undefined {
    return this.failures.get(readLive(this.region, 'global'))
  }

  invalidate(region?: CodeBuddyRegion): void {
    if (region === undefined) this.snapshots.clear()
    else this.snapshots.delete(region)
    this.failures.clear()
  }

  private async fetch(region: CodeBuddyRegion): Promise<readonly CodeBuddyModel[]> {
    const timeout = readLive(this.timeoutMs, CODEBUDDY_FETCH_TIMEOUT_MS)
    return await withSession(region, async session => {
      const raw = await session.getAvailableModelsRaw()
      return raw.map(toCodeBuddyModel)
    }, timeout)
  }
}

/** Read the signed-in account once per TTL. */
export class CodeBuddyAccountReader {
  private cached: { at: number, snapshot: CodeBuddyUsageSnapshot, region: CodeBuddyRegion } | undefined
  private inflight: Promise<CodeBuddyUsageSnapshot> | undefined

  constructor(
    private readonly region: Live<CodeBuddyRegion>,
    private readonly ttlMs: Live<number> = CODEBUDDY_CACHE_TTL_MS,
    private readonly timeoutMs: Live<number> = CODEBUDDY_FETCH_TIMEOUT_MS,
  ) {}

  async read(fresh = false): Promise<CodeBuddyUsageSnapshot> {
    const region = readLive(this.region, 'global')
    if (!fresh && this.cached !== undefined && this.cached.region === region
      && Date.now() - this.cached.at < readLive(this.ttlMs, CODEBUDDY_CACHE_TTL_MS)) return this.cached.snapshot
    this.inflight ??= this.fetch(region).finally(() => { this.inflight = undefined })
    const snapshot = await this.inflight
    this.cached = { at: snapshot.at, snapshot, region }
    return snapshot
  }

  invalidate(): void {
    this.cached = undefined
  }

  private async fetch(region: CodeBuddyRegion): Promise<CodeBuddyUsageSnapshot> {
    const at = Date.now()
    try {
      const account = await readAccount(region, readLive(this.timeoutMs, CODEBUDDY_FETCH_TIMEOUT_MS))
      // An unauthenticated CLI answers with an empty object rather than an
      // error, which must not read as "signed in with no details".
      if (Object.keys(account).length === 0) {
        return { at, error: `${region === 'cn' ? 'CodeBuddy 国内版' : 'CodeBuddy 国际版'}尚未登录，请在页面顶部选择该区域并登录。` }
      }
      try {
        const quota = await readQuotaWithToken(region)
        return { at, account, quota }
      } catch (quotaError) {
        return {
          at,
          account,
          quotaError: quotaError instanceof Error ? quotaError.message : String(quotaError),
        }
      }
    } catch (error) {
      return { at, error: authErrorText(region, error) }
    }
  }
}

/**
 * Read the signed-in account through a one-shot query.
 *
 * `createSession` exposes models but not the account, while `query()` exposes
 * `accountInfo()`; the prompt never yields, so no model turn is started.
 */
async function readAccount(region: CodeBuddyRegion, timeoutMs: number): Promise<CodeBuddyAccount> {
  const sdk = await loadCodeBuddySdk()
  const q = sdk.query({
    prompt: inertInput(),
    options: {
      environment: codeBuddyEnvironment(region),
      tools: [],
      settingSources: [],
      maxTurns: 1,
    },
  })
  try {
    await withTimeout(q.connect(), timeoutMs)
    return await withTimeout(q.accountInfo(), timeoutMs)
  } finally {
    await q.return().catch(() => undefined)
  }
}

/** Streaming prompt that never yields, so no model turn runs. */
async function* inertInput(): AsyncGenerator<never> {
  await new Promise<never>(() => {})
}

/** Turn a raw SDK failure into a sentence the settings page can act on. */
export function authErrorText(region: CodeBuddyRegion, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  const label = region === 'cn' ? 'CodeBuddy 国内版' : 'CodeBuddy 国际版'
  if (/auth|login|登录|credential|401|unauthor/i.test(detail)) {
    return `${label}尚未登录，请在页面顶部选择该区域并登录。`
  }
  return detail
}

/**
 * The account's credits, read from CodeBuddy's billing endpoint.
 *
 * The SDK exposes no quota call, but the CLI's own account page uses
 * `POST /v2/billing/meter/get-user-resource` on the same host. The response is
 * a list of independently expiring credit packages; `CycleCapacity*Precise`
 * is the live balance, while the top-level `TotalDosage` is a stale
 * period-scoped figure and is deliberately ignored.
 *
 * @param payload - the endpoint's JSON answer.
 */
export function parseCodeBuddyQuota(payload: unknown): CodeBuddyQuota {
  const data = (payload as { data?: unknown } | null)?.data as Record<string, unknown> | undefined
  if (data === null || data === undefined || typeof data !== 'object') throw new Error('额度响应缺少 data')
  const response = data.Response as Record<string, unknown> | undefined
  const error = response?.Error as { Code?: unknown, Message?: unknown } | undefined
  if (error?.Code !== undefined && error.Code !== 0 && error.Code !== '0') {
    throw new Error(`${String(error.Code)}: ${String(error.Message ?? '')}`)
  }
  const source = (response?.Data as Record<string, unknown> | undefined)?.Accounts
    ?? response?.Accounts
    ?? (data.Data as Record<string, unknown> | undefined)?.Accounts
    ?? data.Accounts
  if (!Array.isArray(source)) throw new Error('额度响应缺少 Accounts')

  const now = Date.now()
  let total = 0
  let remaining = 0
  let cycleEnd: number | undefined
  const packages: CodeBuddyQuotaPackage[] = []
  for (const entry of source as Record<string, unknown>[]) {
    if (entry === null || typeof entry !== 'object') continue
    if (Number(entry.Status) !== 0) continue
    const packageTotal = cycleCapacity(entry, 'CycleCapacitySize')
    if (packageTotal <= 0) continue
    const packageRemaining = Math.max(0, cycleCapacity(entry, 'CycleCapacityRemain'))
    total += packageTotal
    remaining += packageRemaining
    const end = parseLocalTime(entry.CycleEndTime)
    if (packageRemaining > 0 || (end !== undefined && end > now)) {
      packages.push({
        name: String(entry.PackageName ?? ''),
        total: packageTotal,
        used: Math.max(0, packageTotal - packageRemaining),
        ...end === undefined ? {} : { end },
      })
    }
    if (end !== undefined && end > now && packageRemaining > 0) {
      cycleEnd = cycleEnd === undefined ? end : Math.min(cycleEnd, end)
    }
  }
  return {
    remaining,
    total,
    used: Math.max(0, total - remaining),
    ...cycleEnd === undefined ? {} : { cycleEnd },
    packages,
  }
}

function numeric(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function cycleCapacity(entry: Record<string, unknown>, key: string): number {
  return numeric(entry[`${key}Precise`]) ?? numeric(entry[key]) ?? 0
}

function parseLocalTime(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const parsed = Date.parse(value.trim().replace(' ', 'T'))
  return Number.isFinite(parsed) ? parsed : undefined
}

function formatLocalTime(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * A bearer token for the region, from a recent login or a silent SDK read.
 *
 * `authenticate` returns the CLI's existing account token without opening a
 * browser when the region is already signed in, so this stays a read. When it
 * is not signed in the call times out; callers treat that as "log in first".
 */
async function readBearerToken(region: CodeBuddyRegion): Promise<string> {
  const cached = bearerTokens.get(region)
  if (cached !== undefined) return cached
  const sdk = await loadCodeBuddySdk()
  const result = await withTimeout(sdk.unstable_v2_authenticate({
    environment: codeBuddyEnvironment(region),
    timeout: 3000,
    onAuthUrl: () => {
      // A quota read must never pop a browser; the page owns login.
    },
  }), 6000)
  rememberBearerToken(region, result.userinfo.token)
  return result.userinfo.token
}

/** Query the billing endpoint once. */
export async function fetchCodeBuddyQuota(
  region: CodeBuddyRegion,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CodeBuddyQuota> {
  const endpoint = CODEBUDDY_ENDPOINTS[region]
  const host = new URL(endpoint).host
  const body = {
    PageNumber: 1,
    PageSize: 200,
    Status: [0, 3],
    PackageEndTimeRangeBegin: formatLocalTime(new Date()),
    PackageEndTimeRangeEnd: QUOTA_RANGE_END,
  }
  const response = await fetchImpl(`${endpoint}${QUOTA_PATH}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
      'x-requested-with': 'XMLHttpRequest',
      'x-stainless-arch': process.arch === 'arm64' ? 'arm64' : 'x64',
      'x-stainless-lang': 'js',
      'x-stainless-os': process.platform === 'darwin' ? 'MacOS' : process.platform === 'win32' ? 'Windows' : 'Linux',
      'x-stainless-package-version': '6.25.0',
      'x-stainless-retry-count': '0',
      'x-stainless-runtime': 'node',
      'x-stainless-runtime-version': process.version,
      'x-conversation-id': randomUUID(),
      'x-conversation-request-id': randomBytes(16).toString('hex'),
      'x-conversation-message-id': randomUUID().replace(/-/g, ''),
      'x-request-id': randomUUID().replace(/-/g, ''),
      'x-agent-intent': 'craft',
      'x-agent-purpose': 'conversation',
      'x-ide-type': 'CLI',
      'x-ide-name': 'CLI',
      'x-ide-version': CLIENT_VERSION,
      'user-agent': `CLI/${CLIENT_VERSION} CodeBuddy/${CLIENT_VERSION}`,
      'x-private-data': 'false',
      'x-codebuddy-request': '1',
      'x-product': 'SaaS',
      'x-domain': host,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  const text = await response.text()
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error('CodeBuddy 登录已过期，请重新登录')
    }
    const detail = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)
    throw new Error(`CodeBuddy 额度接口返回 HTTP ${response.status}${detail === '' ? '' : `：${detail}`}`)
  }
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error('CodeBuddy 额度接口返回了非 JSON 内容')
  }
  return parseCodeBuddyQuota(payload)
}

/** Read quota, retrying once with a fresh token after an auth failure. */
async function readQuotaWithToken(region: CodeBuddyRegion): Promise<CodeBuddyQuota> {
  const token = await readBearerToken(region).catch((error: unknown) => {
    throw new Error(authErrorText(region, error))
  })
  try {
    return await fetchCodeBuddyQuota(region, token)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    if (!/401|登录已过期|unauthor|token/i.test(detail)) throw error
    bearerTokens.delete(region)
    const renewed = await readBearerToken(region).catch((renewError: unknown) => {
      throw new Error(authErrorText(region, renewError))
    })
    return await fetchCodeBuddyQuota(region, renewed)
  }
}

interface AuthRun {
  status: CodeBuddyAuthStatus
}

/**
 * Browser login/logout per region.
 *
 * The SDK owns the browser flow: it emits a URL, waits for the CLI to report
 * the result, and stores the credential where the CLI reads it. This manager
 * only remembers progress so the settings page can poll it.
 */
export class CodeBuddyAuth {
  private readonly runs = new Map<CodeBuddyRegion, AuthRun>()

  /** Start a login; refuses while the same region is already logging in. */
  start(
    region: CodeBuddyRegion,
    onFinish?: (ok: boolean) => void,
  ): { started: true } | { started: false, error: string } {
    const existing = this.runs.get(region)
    if (existing?.status.running === true) return { started: false, error: '该区域正在登录，请先在浏览器中完成。' }
    const status: CodeBuddyAuthStatus = { running: true, region, startedAt: Date.now() }
    this.runs.set(region, { status })
    void this.login(region, status, onFinish)
    return { started: true }
  }

  status(region: CodeBuddyRegion): CodeBuddyAuthStatus {
    return this.runs.get(region)?.status ?? { running: false, region }
  }

  /** Clear the cached credential for one region. */
  async logout(region: CodeBuddyRegion): Promise<{ ok: true } | { ok: false, error: string }> {
    try {
      const sdk = await loadCodeBuddySdk()
      await withTimeout(
        sdk.unstable_v2_logout({ environment: codeBuddyEnvironment(region) }),
        CODEBUDDY_FETCH_TIMEOUT_MS,
      )
      this.runs.delete(region)
      bearerTokens.delete(region)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async login(
    region: CodeBuddyRegion,
    status: CodeBuddyAuthStatus,
    onFinish?: (ok: boolean) => void,
  ): Promise<void> {
    try {
      const sdk = await loadCodeBuddySdk()
      const result = await sdk.unstable_v2_authenticate({
        environment: codeBuddyEnvironment(region),
        timeout: LOGIN_TIMEOUT_MS,
        onAuthUrl: (state) => {
          status.url = state.authUrl
          openBrowser(state.authUrl)
        },
      })
      status.running = false
      status.finishedAt = Date.now()
      status.user = {
        userId: result.userinfo.userId,
        userName: result.userinfo.userName,
        userNickname: result.userinfo.userNickname,
      }
      rememberBearerToken(region, result.userinfo.token)
      onFinish?.(true)
    } catch (error) {
      status.running = false
      status.finishedAt = Date.now()
      status.error = authErrorText(region, error)
      onFinish?.(false)
    }
  }
}

/** Open a URL in the user's browser without going through a shell string. */
function openBrowser(url: string): void {
  try {
    const command = process.platform === 'win32'
      ? { file: 'cmd.exe', args: ['/d', '/c', 'start', '', url] }
      : process.platform === 'darwin'
        ? { file: 'open', args: [url] }
        : { file: 'xdg-open', args: [url] }
    const child = spawn(command.file, command.args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
  } catch {
    // The URL is also shown in the page; failing to open a browser is not fatal.
  }
}

/** One tool-use block under assembly in the active turn. */
interface PendingTool {
  chunkIndex: number
  callId: string
  name: string
  arguments: string
}

/** Per-turn output accounting shared with the Qoder session. */
type TurnUsage = { input_tokens: number, output_tokens: number, cache_read_input_tokens?: number | null, cache_creation_input_tokens?: number | null }

/**
 * One warm CodeBuddy session for a host session id.
 *
 * Mirrors the Qoder session's shape: the host's tool calls are exposed through
 * an in-process MCP server; each handler parks until the host delivers that
 * round's results on its next request. The inner CLI keeps the conversation,
 * so a continuation carries only new user text.
 */
export class CodeBuddySession {
  private session: SessionImpl | null = null
  private mcp: ReturnType<typeof import('@tencent-ai/agent-sdk').createSdkMcpServer> | null = null
  private readonly pairing = new ToolResultPairing()
  private readonly registered = new Map<string, string>()
  private queue: TurnQueue | null = null
  private disposed = false
  private abortPending = false
  private turnEndKind: string | undefined
  private blockIndex = 0
  private textBlock: { index: number, text: string } | undefined
  private reasoningBlock: { index: number, text: string } | undefined
  private tools: PendingTool[] = []
  private openTool: PendingTool | undefined
  private callCounter = 0
  private readonly callNonce = randomUUID().slice(0, 8)
  private lastUsage: TurnUsage | undefined
  private resultUsage: TurnUsage | undefined
  private readonly output = new TurnOutputAccounting()
  private inputChars = 0
  private readonly toolResultTimeoutMs: number
  private readonly abortGraceMs: number
  private region: CodeBuddyRegion = 'global'
  private model = ''
  private effort: string | undefined
  private systemPrompt: string | undefined
  private cwd: string | undefined
  /** Host messages already fed to the inner session, for continuation planning. */
  fedMessages: readonly import('@deepseek-ai/dsh-llm').RequestMessage[] | undefined
  /** Host system prompt last applied; informational for the adapter. */
  fedSystem: string | undefined

  constructor(
    readonly sessionId: string,
    initialModel: string,
    runtime: { toolResultTimeoutMs?: Live<number>, abortGraceMs?: Live<number> } = {},
  ) {
    this.model = initialModel
    this.toolResultTimeoutMs = readLive(runtime.toolResultTimeoutMs, 120_000)
    this.abortGraceMs = readLive(runtime.abortGraceMs, 5_000)
  }

  /** Point the session at a region, model and optional system prompt. */
  configure(region: CodeBuddyRegion, model: string, options: { effort?: string, system?: string, cwd?: string } = {}): void {
    this.region = region
    this.model = model
    this.effort = options.effort
    this.systemPrompt = options.system
    if (options.cwd !== undefined) this.cwd = options.cwd
  }

  /** Register any host tools whose schema this session's MCP server lacks. */
  ensureTools(tools: readonly { name: string, description: string, parameters?: unknown }[]): void {
    if (this.mcp === null) return
    for (const schema of tools) {
      const hash = JSON.stringify(schema.parameters ?? {})
      if (this.registered.get(schema.name) === hash) continue
      const shape = jsonSchemaToShape((schema.parameters ?? {}) as Record<string, unknown>)
      try {
        this.mcp.instance.registerTool(schema.name, {
          description: schema.description.length > 0 ? schema.description : schema.name,
          inputSchema: shape,
        }, async () => {
          const result = await this.pairing.claim(this.toolResultTimeoutMs)
          return {
            content: result.content,
            ...result.isError ? { isError: true } : {},
          }
        })
      } catch {
        continue
      }
      this.registered.set(schema.name, hash)
    }
  }

  /** Hand the host's tool results to parked or buffered handlers. */
  deliverToolResults(tail: readonly { role: string, toolCallId?: unknown, content?: unknown, isError?: boolean }[]): void {
    let freshUserTurn = false
    const delivered = new Set<string>()
    for (const message of tail) {
      if (message.role === 'user') {
        freshUserTurn = true
        continue
      }
      if (message.role !== 'tool') continue
      delivered.add(this.pairing.deliver(String(message.toolCallId), {
        content: renderCodeBuddyResult(message.content),
        isError: message.isError === true,
      }))
    }
    this.pairing.beginHostRequest(delivered, freshUserTurn)
  }

  /** Run one host turn; `feed` is new user text, or null for a tool continuation. */
  async *stream(options: GenerateOptions, feed: string | null): AsyncGenerator<StreamChunk> {
    if (this.queue !== null) throw new Error(`CodeBuddy session ${this.sessionId} already has a turn in flight`)
    if (this.disposed) throw new Error(`CodeBuddy session ${this.sessionId} was disposed`)
    const session = await this.ensureStarted()
    this.queue = new TurnQueue()
    this.resetTurnState()
    const signal = options.signal
    let abortTimer: ReturnType<typeof setTimeout> | undefined
    const onAbort = (): void => {
      this.abortPending = true
      void session.interrupt().catch(() => undefined)
      abortTimer = setTimeout(() => this.endTurn({ kind: 'aborted', failure: { message: 'CodeBuddy session aborted by host', code: 'ABORTED' } }), this.abortGraceMs)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      // A model switch on a warm session is a control request; waiting for it
      // keeps the next prompt on the model the host just resolved.
      await session.setModel(this.model)
      if (feed !== null && feed.length > 0) {
        this.inputChars += feed.length
        await session.send(feed)
      }
      void this.consume(session)
      for await (const item of this.queue) {
        if (item.kind === 'chunk') {
          yield item.chunk
          continue
        }
        if (item.usage !== undefined) yield { type: 'usage', usage: item.usage }
        yield { type: 'finish', reason: item.reason }
        return
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
      if (abortTimer !== undefined) clearTimeout(abortTimer)
      if (this.turnEndKind === 'aborted' || this.turnEndKind === 'error') this.pairing.forgetUnclaimed()
      this.queue = null
      this.abortPending = false
    }
  }

  /** Tear the inner CLI down; parked handlers settle with a cancellation. */
  close(): void {
    if (this.disposed) return
    this.disposed = true
    this.pairing.clear()
    this.session?.close()
    this.session = null
  }

  private async ensureStarted(): Promise<SessionImpl> {
    if (this.session !== null) return this.session
    const sdk = await loadCodeBuddySdk()
    this.mcp ??= sdk.createSdkMcpServer({ name: MCP_SERVER_NAME, tools: [] })
    const session = sdk.unstable_v2_createSession({
      environment: codeBuddyEnvironment(this.region),
      sessionId: randomUUID(),
      model: this.model,
      mcpServers: { [MCP_SERVER_NAME]: this.mcp },
      canUseTool: this.canUseTool as CanUseTool,
      settingSources: [],
      includePartialMessages: true,
      persistSession: false,
      ...this.effort === undefined ? {} : { effort: this.effort as never },
      ...this.systemPrompt === undefined ? {} : { systemPrompt: this.systemPrompt },
      ...this.cwd === undefined ? {} : { cwd: this.cwd },
    })
    this.session = session
    return session
  }

  private canUseTool = (toolName: string, _input: Record<string, unknown>, options: { toolUseID?: string }) => {
    if (toolName.startsWith(MCP_TOOL_PREFIX)) {
      if (options.toolUseID !== undefined) this.pairing.announce(options.toolUseID)
      return Promise.resolve({ behavior: 'allow', ...options.toolUseID === undefined ? {} : { toolUseID: options.toolUseID } })
    }
    return Promise.resolve({
      behavior: 'deny',
      message: '本会话是宿主 agent 的 LLM 后端，不直接执行工具。宿主的工具已通过 MCP 挂入，直接调用它们即可。',
      ...options.toolUseID === undefined ? {} : { toolUseID: options.toolUseID },
    })
  }

  private async consume(session: SessionImpl): Promise<void> {
    try {
      for await (const message of session.stream()) {
        this.handle(message)
        if (this.queue === null || this.queue.isClosed) return
      }
      this.endTurn({ kind: 'error', failure: { message: 'CodeBuddy session stream ended unexpectedly', code: 'STREAM_CLOSED' } })
    } catch (error) {
      this.endTurn({
        kind: 'error',
        failure: { message: authErrorText(this.region, error), code: 'BACKEND_TURN_ERROR' },
      })
    }
  }

  private handle(message: Message): void {
    if (message.type === 'stream_event') {
      const event = message.event
      if (event.type === 'message_start') {
        const usage = (event.message as { usage?: TurnUsage }).usage
        if (usage !== undefined) this.lastUsage = usage
        return
      }
      if (event.type === 'content_block_start') {
        const block = event.content_block as { type?: string, id?: string, name?: string, input?: unknown }
        if (block?.type === 'tool_use') {
          const callId = `cb-${this.callNonce}-${++this.callCounter}`
          if (typeof block.id === 'string' && block.id.length > 0) this.pairing.mapHostCall(callId, block.id)
          const chunkIndex = this.blockIndex++
          const initial = block.input !== undefined && block.input !== null && Object.keys(block.input as object).length > 0
            ? JSON.stringify(block.input)
            : ''
          this.openTool = { chunkIndex, callId, name: (block.name ?? '').replace(MCP_TOOL_PREFIX, ''), arguments: initial }
          this.countOutput(this.openTool.name)
          this.countOutput(initial)
          this.emit({ type: 'block-start', index: chunkIndex, blockType: 'tool-call' })
          this.emit({ type: 'tool-call-delta', index: chunkIndex, id: ToolCallId(callId), name: this.openTool.name, argumentsDelta: '' })
        }
        return
      }
      if (event.type === 'content_block_delta') {
        const delta = event.delta as { type?: string, text?: string, thinking?: string, partial_json?: string }
        if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text.length > 0) {
          if (this.textBlock === undefined) {
            this.textBlock = { index: this.blockIndex++, text: '' }
            this.emit({ type: 'block-start', index: this.textBlock.index, blockType: 'text' })
          }
          this.textBlock.text += delta.text
          this.countOutput(delta.text)
          this.emit({ type: 'text-delta', index: this.textBlock.index, text: delta.text })
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking.length > 0) {
          if (this.reasoningBlock === undefined) {
            this.reasoningBlock = { index: this.blockIndex++, text: '' }
            this.emit({ type: 'block-start', index: this.reasoningBlock.index, blockType: 'reasoning' })
          }
          this.reasoningBlock.text += delta.thinking
          this.output.addReasoning(delta.thinking)
          this.emit({ type: 'reasoning-delta', index: this.reasoningBlock.index, text: delta.thinking })
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string' && this.openTool !== undefined) {
          this.openTool.arguments += delta.partial_json
          this.countOutput(delta.partial_json)
          this.emit({ type: 'tool-call-delta', index: this.openTool.chunkIndex, id: ToolCallId(this.openTool.callId), argumentsDelta: delta.partial_json })
        }
        return
      }
      if (event.type === 'content_block_stop') {
        if (this.openTool !== undefined) {
          this.emit({
            type: 'block-end',
            index: this.openTool.chunkIndex,
            block: { type: 'tool-call', id: ToolCallId(this.openTool.callId), name: this.openTool.name, arguments: this.openTool.arguments },
          })
          this.tools.push(this.openTool)
          this.openTool = undefined
        }
        return
      }
      if (event.type === 'message_delta') {
        const usage = (event as { usage?: TurnUsage }).usage
        if (usage !== undefined) this.lastUsage = usage
        return
      }
      if (event.type === 'message_stop') {
        if (this.tools.length > 0) this.endTurn({ kind: 'tool-calls' })
        return
      }
      return
    }
    if (message.type === 'assistant') {
      if (this.textBlock === undefined && this.tools.length === 0) {
        for (const block of message.message.content) {
          if (block.type === 'tool_use') {
            this.countOutput(block.name)
            this.countOutput(JSON.stringify(block.input ?? ''))
          }
        }
        const text = message.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
        if (text.length > 0) {
          this.textBlock = { index: this.blockIndex++, text }
          this.countOutput(text)
          this.emit({ type: 'block-start', index: this.textBlock.index, blockType: 'text' })
          this.emit({ type: 'text-delta', index: this.textBlock.index, text })
        }
      }
      return
    }
    if (message.type === 'result') {
      this.resultUsage = message.usage as TurnUsage
      if (this.abortPending) {
        this.endTurn({ kind: 'aborted', failure: { message: 'CodeBuddy turn aborted by host', code: 'ABORTED' } })
        return
      }
      if (this.tools.length > 0) {
        this.endTurn({ kind: 'tool-calls' })
        return
      }
      if (message.is_error === true) {
        const errors = 'errors' in message && Array.isArray(message.errors) ? message.errors.join('; ') : 'unknown error'
        this.endTurn({ kind: 'error', failure: { message: `CodeBuddy turn failed: ${errors}`, code: 'BACKEND_TURN_ERROR' } })
        return
      }
      if (this.textBlock === undefined && this.reasoningBlock === undefined) {
        this.endTurn({ kind: 'error', failure: { message: 'CodeBuddy returned a completed response with no content', code: EMPTY_RESPONSE_CODE } })
        return
      }
      this.endTurn({ kind: 'stop' })
    }
  }

  private resetTurnState(): void {
    this.blockIndex = 0
    this.textBlock = undefined
    this.reasoningBlock = undefined
    this.openTool = undefined
    this.tools = []
    this.inputChars = 0
    this.output.reset()
    this.lastUsage = undefined
    this.resultUsage = undefined
    this.turnEndKind = undefined
  }

  private emit(chunk: StreamChunk): void {
    this.queue?.push({ kind: 'chunk', chunk })
  }

  private countOutput(text: string): void {
    this.output.addOutput(text)
  }

  private usage(): TokenUsage {
    const metered = this.lastUsage ?? this.resultUsage
    if (metered !== undefined) {
      const cacheRead = metered.cache_read_input_tokens ?? 0
      const cacheWrite = metered.cache_creation_input_tokens ?? 0
      const input = Math.max(0, metered.input_tokens - cacheRead - cacheWrite)
      const output = this.output.usage()
      return {
        inputTokens: input,
        outputTokens: output.outputTokens,
        ...output.reasoningTokens === undefined ? {} : { reasoningTokens: output.reasoningTokens },
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        totalTokens: input + cacheRead + cacheWrite + output.outputTokens,
      }
    }
    const input = Math.max(1, estimateTextTokens(this.inputChars, 0))
    const output = this.output.usage()
    return {
      inputTokens: input,
      outputTokens: Math.max(1, output.outputTokens),
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: input + Math.max(1, output.outputTokens),
    }
  }

  private endTurn(reason: FinishReason): void {
    if (this.queue === null) return
    this.turnEndKind = reason.kind
    if (this.textBlock !== undefined) {
      this.emit({ type: 'block-end', index: this.textBlock.index, block: { type: 'text', text: this.textBlock.text } })
    }
    if (this.reasoningBlock !== undefined) {
      this.emit({ type: 'block-end', index: this.reasoningBlock.index, block: { type: 'reasoning', text: this.reasoningBlock.text } })
    }
    this.queue.push({ kind: 'turn-end', reason, usage: this.usage() })
    this.queue.close()
  }
}

/** Render host tool-result blocks into the MCP content the inner model reads. */
function renderCodeBuddyResult(blocks: unknown): ToolResultPayload['content'] {
  if (!Array.isArray(blocks)) return [{ type: 'text', text: String(blocks ?? '') }]
  const content: ToolResultPayload['content'] = []
  for (const block of blocks as { type?: string, text?: string, attachment?: unknown }[]) {
    if (block.type === 'text') content.push({ type: 'text', text: block.text ?? '' })
    else if (block.type === 'image') content.push({ type: 'text', text: '[图片结果未转发给 CodeBuddy]' })
    else content.push({ type: 'text', text: JSON.stringify(block) })
  }
  return content
}

/**
 * Warm sessions keyed by host session id. A region change retires the old
 * session rather than mutating one, because the CLI process was started with
 * the previous region's endpoint.
 */
export class CodeBuddySessionManager {
  private readonly sessions = new Map<string, { session: CodeBuddySession, region: CodeBuddyRegion }>()

  constructor(
    readonly maxSessions: Live<number>,
    private readonly runtime: { toolResultTimeoutMs?: Live<number>, abortGraceMs?: Live<number> } = {},
  ) {}

  forSession(sessionId: string, region: CodeBuddyRegion, model: string): CodeBuddySession {
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
    const session = new CodeBuddySession(sessionId, model, this.runtime)
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
export async function codeBuddyColdStream(
  region: CodeBuddyRegion,
  prompt: string,
  model: string | undefined,
  options: GenerateOptions,
): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  let text = ''
  const signal = options.signal
  const sdk = await loadCodeBuddySdk()
  const session = sdk.unstable_v2_createSession({
    environment: codeBuddyEnvironment(region),
    sessionId: randomUUID(),
    ...model === undefined ? {} : { model },
    settingSources: [],
    persistSession: false,
  })
  const onAbort = (): void => { void session.interrupt().catch(() => undefined) }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    await session.send(prompt)
    for await (const message of session.stream()) {
      if (signal?.aborted === true) break
      if (message.type === 'assistant') {
        text += message.message.content
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join('')
      }
    }
  } catch (error) {
    if (signal?.aborted !== true) throw error
  } finally {
    signal?.removeEventListener('abort', onAbort)
    session.close()
  }
  if (signal?.aborted === true) {
    chunks.push({ type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted by host', code: 'ABORTED' } } })
    return chunks
  }
  if (text.length === 0) {
    chunks.push({ type: 'finish', reason: { kind: 'error', failure: { message: 'CodeBuddy side-channel returned no content', code: EMPTY_RESPONSE_CODE } } })
    return chunks
  }
  chunks.push({ type: 'block-start', index: 0, blockType: 'text' })
  for (let i = 0; i < text.length; i += 192) chunks.push({ type: 'text-delta', index: 0, text: text.slice(i, i + 192) })
  chunks.push({ type: 'block-end', index: 0, block: { type: 'text', text } })
  chunks.push({ type: 'usage', usage: { inputTokens: Math.max(1, Math.ceil(prompt.length / 4)), outputTokens: Math.max(1, Math.ceil(text.length / 4)) } })
  chunks.push({ type: 'finish', reason: { kind: 'stop' } })
  return chunks
}
