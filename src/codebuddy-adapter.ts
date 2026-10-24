/**
 * `CodeBuddyAdapter`: route the harness LLM seam onto a CodeBuddy account.
 *
 * One CodeBuddy provider serves both login regions; the account, catalog and
 * warm sessions all follow the configured region. The inner CLI owns the
 * conversation, so the adapter only decides what new text to send and which
 * tool round the host is answering.
 *
 * @module dsh-agent-sdk-bridge/codebuddy-adapter
 */

import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo,
  PreparedAdapterCall, RequestMessage, StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { CodeBuddyRegion } from './brand.ts'
import { codeBuddyColdStream, CodeBuddyAccountReader, CodeBuddyAuth, CodeBuddyCatalog, CodeBuddySessionManager, CODEBUDDY_DEFAULT_CONTEXT_WINDOW, CODEBUDDY_DEFAULT_MAX_TOKENS, CODEBUDDY_CACHE_TTL_MS, CODEBUDDY_FETCH_TIMEOUT_MS } from './codebuddy.ts'
import type { CodeBuddyModel, CodeBuddyUsageSnapshot } from './codebuddy.ts'
import { reasoningInfo, planContinuation } from './adapter.ts'
import type { Live } from './live.ts'
import { readLive, readLiveOptional } from './live.ts'
import { feedToText, renderInitialFeed } from './render.ts'

/** The CodeBuddy provider route. */
export const CODEBUDDY_PROVIDER = 'codebuddy'

/** Everything the adapter reads lazily from the plugin config. */
export interface CodeBuddyAdapterOptions {
  maxSessions?: Live<number>
  modelCacheTtlMs?: Live<number>
  catalogFetchTimeoutMs?: Live<number>
  toolResultTimeoutMs?: Live<number>
  abortGraceMs?: Live<number>
  defaultMaxTokens?: Live<number>
  defaultReasoningEffort?: Live<string | undefined>
  displayName?: Live<string>
  region?: Live<CodeBuddyRegion>
  /** Per-region deny-lists; the page edits each region's list separately. */
  disabledModels?: (region: CodeBuddyRegion) => readonly string[]
  /** Per-region context-window overrides, keyed by model id. */
  modelContextWindows?: (region: CodeBuddyRegion) => Readonly<Record<string, number>>
  modelAliases?: Live<Readonly<Record<string, string>>>
}

const NO_MODELS: readonly string[] = []
const NO_ALIASES: Readonly<Record<string, string>> = {}

/** Map a harness-side id onto a CodeBuddy model value. */
export function resolveCodeBuddyModelId(
  model: string,
  aliases: Readonly<Record<string, string>> = {},
): string {
  const configured = aliases[model] ?? aliases[model.toLowerCase()]
  if (configured !== undefined && configured.length > 0) return configured
  const stripped = model.startsWith('codebuddy-') ? model.slice('codebuddy-'.length) : model
  return stripped.length > 0 ? stripped : 'default-model'
}

function modelInfo(provider: string, model: CodeBuddyModel): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name,
    ...model.description === undefined ? {} : { description: model.description },
    inputModalities: model.vision ? ['text', 'image'] : ['text'],
  }
}

/** The CodeBuddy-backed adapter. */
export class CodeBuddyAdapter extends LlmAdapter {
  private readonly options: CodeBuddyAdapterOptions
  private readonly sessions: CodeBuddySessionManager
  private readonly catalog: CodeBuddyCatalog
  private readonly accounts: CodeBuddyAccountReader
  private readonly auth = new CodeBuddyAuth()
  private readonly disabledCache = new Map<CodeBuddyRegion, { key: string, set: ReadonlySet<string> }>()

  constructor(options: CodeBuddyAdapterOptions = {}) {
    super()
    this.options = options
    this.sessions = new CodeBuddySessionManager(options.maxSessions ?? 8, {
      toolResultTimeoutMs: options.toolResultTimeoutMs,
      abortGraceMs: options.abortGraceMs,
    })
    this.catalog = new CodeBuddyCatalog(
      options.region ?? (() => 'global'),
      options.modelCacheTtlMs ?? CODEBUDDY_CACHE_TTL_MS,
      options.catalogFetchTimeoutMs ?? CODEBUDDY_FETCH_TIMEOUT_MS,
    )
    this.accounts = new CodeBuddyAccountReader(
      options.region ?? (() => 'global'),
      options.modelCacheTtlMs ?? CODEBUDDY_CACHE_TTL_MS,
      options.catalogFetchTimeoutMs ?? CODEBUDDY_FETCH_TIMEOUT_MS,
    )
  }

  private get region(): CodeBuddyRegion {
    return readLive(this.options.region ?? (() => 'global'), 'global')
  }

  private disabledFor(region: CodeBuddyRegion): ReadonlySet<string> {
    const source = this.options.disabledModels?.(region) ?? NO_MODELS
    // The live config returns a fresh array per read, so compare by content.
    const key = source.join('\u0000')
    const cached = this.disabledCache.get(region)
    if (cached?.key === key) return cached.set
    const set = new Set(source)
    this.disabledCache.set(region, { key, set })
    return set
  }

  private get aliases(): Readonly<Record<string, string>> {
    return readLive(this.options.modelAliases, NO_ALIASES)
  }

  private get displayName(): string {
    return readLive(this.options.displayName, 'CodeBuddy')
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.displayName }
  }

  /** The live catalog, unfiltered (the page must show switched-off models). */
  async describeCatalog(region: CodeBuddyRegion = this.region): Promise<readonly CodeBuddyModel[]> {
    if (!this.isSignedIn(region)) return []
    return this.catalog.models(region)
  }

  /** Whether the selected (or given) region has a stored login. */
  isSignedIn(region: CodeBuddyRegion = this.region): boolean {
    return this.auth.status(region).signedIn === true
  }

  /** Why the last catalog read failed, for the page's guidance. */
  catalogError(region: CodeBuddyRegion = this.region): string | undefined {
    if (!this.isSignedIn(region)) return '请先登录 CodeBuddy，登录后才会读取并显示模型目录。'
    return this.catalog.error(region)
  }

  invalidateCatalog(region?: CodeBuddyRegion): void {
    this.catalog.invalidate(region)
  }

  /** The signed-in account, or the reason it could not be read. */
  async usageInfo(fresh = false, region?: CodeBuddyRegion): Promise<CodeBuddyUsageSnapshot> {
    return this.accounts.read(fresh, region)
  }

  invalidateUsage(region?: CodeBuddyRegion): void {
    this.accounts.invalidate(region)
  }

  /** Login progress for one region; the page polls this. */
  authStatus(region: CodeBuddyRegion): ReturnType<CodeBuddyAuth['status']> {
    return this.auth.status(region)
  }

  startLogin(region: CodeBuddyRegion): ReturnType<CodeBuddyAuth['start']> {
    return this.auth.start(region, ok => {
      if (!ok) return
      this.sessions.closeAll()
      this.invalidateCatalog(region)
      this.invalidateUsage(region)
    })
  }

  async logout(region: CodeBuddyRegion): ReturnType<CodeBuddyAuth['logout']> {
    const result = await this.auth.logout(region)
    this.sessions.closeAll()
    this.invalidateCatalog(region)
    this.invalidateUsage(region)
    return result
  }

  isModelDisabled(id: string, region: CodeBuddyRegion = this.region): boolean {
    return this.disabledFor(region).has(id)
  }

  contextWindowFor(id: string, region: CodeBuddyRegion = this.region): number | undefined {
    return this.options.modelContextWindows?.(region)[id]
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const region = this.region
    if (!this.isSignedIn(region)) return []
    const models = await this.catalog.models(region)
    const disabled = this.disabledFor(region)
    return models.filter(model => !disabled.has(model.id)).map(model => modelInfo(provider, model))
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const target = resolveCodeBuddyModelId(model, this.aliases)
    const live = (await this.catalog.models()).find(entry => entry.id === target)
    if (live !== undefined) {
      const reasoning = reasoningInfo(live.reasoningEfforts, live.defaultEffort, (live.reasoningEfforts?.length ?? 0) > 0)
      return {
        provider,
        id: model,
        name: live.name,
        ...live.description === undefined ? {} : { description: live.description },
        inputModalities: live.vision ? ['text', 'image'] : ['text'],
        context: { contextWindow: this.contextWindowFor(target) ?? live.defaultContextWindow },
        defaultMaxTokens: live.maxOutputTokens ?? readLive(this.options.defaultMaxTokens, CODEBUDDY_DEFAULT_MAX_TOKENS),
        ...reasoning === undefined ? {} : { reasoning },
      }
    }
    const reasoning = reasoningInfo(
      undefined,
      readLiveOptional(this.options.defaultReasoningEffort),
      true,
    )
    return {
      provider,
      id: model,
      name: model,
      inputModalities: ['text'],
      context: { contextWindow: this.contextWindowFor(target) ?? CODEBUDDY_DEFAULT_CONTEXT_WINDOW },
      defaultMaxTokens: readLive(this.options.defaultMaxTokens, CODEBUDDY_DEFAULT_MAX_TOKENS),
      ...reasoning === undefined ? {} : { reasoning },
    }
  }

  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const info = await this.resolveModel(provider, model)
    void signal
    return { model: info, stream: options => this.dispatch(options) }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield* this.dispatch(options)
  }

  private async *dispatch(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const region = this.region
    if (!this.isSignedIn(region)) {
      const label = region === 'cn' ? 'CodeBuddy 国内版' : 'CodeBuddy 国际版'
      throw new Error(`${label}尚未登录，请先在设置 → CodeBuddy 中登录。`)
    }
    const model = resolveCodeBuddyModelId(options.model, this.aliases)
    if (options.sessionId === undefined || options.purpose !== undefined) {
      const prompt = feedToText(renderInitialFeed(options.system, options.messages))
        + '\n（这是一次性旁路请求，直接输出下一条助手回复。）'
      for (const chunk of await codeBuddyColdStream(region, prompt, model, options)) yield chunk
      return
    }
    const sessionId = String(options.sessionId)
    const effort = options.reasoningEffort ?? readLiveOptional(this.options.defaultReasoningEffort)
    let session = this.sessions.forSession(sessionId, region, model)
    if (session.fedMessages === undefined) {
      yield* this.firstTurn(session, options, region, model, effort)
      return
    }
    const tail = options.messages.slice(session.fedMessages.length)
    session.deliverToolResults(tail)
    const plan = planContinuation(session.fedMessages, options.messages)
    if (plan.rebuild) {
      this.sessions.dispose(sessionId)
      session = this.sessions.forSession(sessionId, region, model)
      yield* this.firstTurn(session, options, region, model, effort)
      return
    }
    session.configure(region, model, { effort, system: options.system, cwd: this.cwdOf(options) })
    session.ensureTools(options.tools ?? [])
    session.fedMessages = options.messages
    session.fedSystem = options.system
    const feed = plan.feed === null ? null : feedToText(plan.feed)
    yield* session.stream(options, feed)
  }

  private async *firstTurn(
    session: ReturnType<CodeBuddySessionManager['forSession']>,
    options: GenerateOptions,
    region: CodeBuddyRegion,
    model: string,
    effort: string | undefined,
  ): AsyncGenerator<StreamChunk> {
    session.configure(region, model, { effort, system: options.system, cwd: this.cwdOf(options) })
    session.ensureTools(options.tools ?? [])
    session.fedMessages = options.messages
    session.fedSystem = options.system
    const feed = feedToText(renderInitialFeed(undefined, options.messages))
    yield* session.stream(options, feed)
  }

  private cwdOf(options: GenerateOptions): string | undefined {
    return (options as GenerateOptions & { cwd?: string }).cwd
  }

  close(): void {
    this.sessions.closeAll()
  }
}
