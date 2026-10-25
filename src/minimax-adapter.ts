/**
 * `MinimaxAdapter`: route the harness LLM seam onto a MiniMax Code account.
 *
 * The ACP agent owns the conversation; this adapter decides what new text to
 * send, which model/effort to select, and how the ACP tool calls map onto the
 * harness's tool seam. One provider serves both login regions; the region is a
 * live config choice and every ACP process is pinned to it.
 *
 * @module dsh-agent-sdk-bridge/minimax-adapter
 */

import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo,
  PreparedAdapterCall, RequestMessage, StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { MinimaxRegion } from './brand.ts'
import {
  MinimaxAuth, MinimaxCatalog, MinimaxMcpServer, MinimaxSessionManager,
  MINIMAX_CACHE_TTL_MS, MINIMAX_DEFAULT_CONTEXT_WINDOW, MINIMAX_DEFAULT_MAX_TOKENS,
  MINIMAX_FETCH_TIMEOUT_MS, invalidateMinimaxUsage, minimaxColdStream, minimaxSignedIn,
  minimaxUsage,
} from './minimax.ts'
import type { MinimaxModel, MinimaxUsageSnapshot } from './minimax.ts'
import { resolveMinimaxCli } from './minimax-cli.ts'
import { reasoningInfo, planContinuation } from './adapter.ts'
import type { Live } from './live.ts'
import { readLive, readLiveOptional } from './live.ts'
import { feedToText, renderInitialFeed } from './render.ts'

/** The MiniMax Code provider route. */
export const MINIMAX_PROVIDER = 'minimax-acp'

/** Everything the adapter reads lazily from the plugin config. */
export interface MinimaxAdapterOptions {
  maxSessions?: Live<number>
  modelCacheTtlMs?: Live<number>
  catalogFetchTimeoutMs?: Live<number>
  toolResultTimeoutMs?: Live<number>
  abortGraceMs?: Live<number>
  defaultMaxTokens?: Live<number>
  defaultReasoningEffort?: Live<string | undefined>
  displayName?: Live<string>
  region?: Live<MinimaxRegion>
  /** Per-region deny-lists; the page edits each region's list separately. */
  disabledModels?: (region: MinimaxRegion) => readonly string[]
  /** Per-region context-window overrides, keyed by model id. */
  modelContextWindows?: (region: MinimaxRegion) => Readonly<Record<string, number>>
  modelAliases?: Live<Readonly<Record<string, string>>>
}

const NO_MODELS: readonly string[] = []
const NO_ALIASES: Readonly<Record<string, string>> = {}

/** Map a harness-side id onto an ACP model value. */
export function resolveMinimaxModelId(
  model: string,
  aliases: Readonly<Record<string, string>> = {},
): string {
  const configured = aliases[model] ?? aliases[model.toLowerCase()]
  if (configured !== undefined && configured.length > 0) return configured
  const stripped = model.startsWith('minimax-') ? model.slice('minimax-'.length) : model
  return stripped
}

function modelInfo(provider: string, model: MinimaxModel): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name,
    ...model.description === undefined ? {} : { description: model.description },
    inputModalities: model.vision ? ['text', 'image'] : ['text'],
  }
}

/** The MiniMax Code-backed adapter. */
export class MinimaxAdapter extends LlmAdapter {
  private readonly options: MinimaxAdapterOptions
  private readonly sessions: MinimaxSessionManager
  private readonly catalog: MinimaxCatalog
  private readonly auth = new MinimaxAuth()
  private readonly mcpServer = new MinimaxMcpServer()
  private readonly disabledCache = new Map<MinimaxRegion, { key: string, set: ReadonlySet<string> }>()

  constructor(options: MinimaxAdapterOptions = {}) {
    super()
    this.options = options
    this.sessions = new MinimaxSessionManager(
      options.maxSessions ?? 8,
      this.mcpServer,
      { toolResultTimeoutMs: options.toolResultTimeoutMs, abortGraceMs: options.abortGraceMs },
    )
    this.catalog = new MinimaxCatalog(
      options.region ?? (() => 'cn'),
      options.modelCacheTtlMs ?? MINIMAX_CACHE_TTL_MS,
      options.catalogFetchTimeoutMs ?? MINIMAX_FETCH_TIMEOUT_MS,
    )
  }

  private get region(): MinimaxRegion {
    return readLive(this.options.region ?? (() => 'cn'), 'cn')
  }

  private disabledFor(region: MinimaxRegion): ReadonlySet<string> {
    const source = this.options.disabledModels?.(region) ?? NO_MODELS
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
    return readLive(this.options.displayName, 'MiniMax Code')
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.displayName }
  }

  /** The live catalog, unfiltered (the page must show switched-off models). */
  async describeCatalog(region: MinimaxRegion = this.region): Promise<readonly MinimaxModel[]> {
    if (!this.isSignedIn(region)) return []
    return this.catalog.models(region)
  }

  /** Whether the selected (or given) region has a stored login. */
  isSignedIn(region: MinimaxRegion = this.region): boolean {
    return this.auth.status(region).signedIn || minimaxSignedIn(region)
  }

  /** Why the last catalog read failed, for the page's guidance. */
  catalogError(region: MinimaxRegion = this.region): string | undefined {
    if (resolveMinimaxCli() === undefined) {
      return '未安装 MiniMax Code CLI（mcode）。请先安装后再登录。'
    }
    if (!this.isSignedIn(region)) return '请先登录 MiniMax Code，登录后才会读取并显示模型目录。'
    return this.catalog.error(region)
  }

  invalidateCatalog(region?: MinimaxRegion): void {
    this.catalog.invalidate(region)
  }

  /** Login status, installer state and (when signed in) the account's quota. */
  async usageInfo(fresh = false, region?: MinimaxRegion): Promise<MinimaxUsageSnapshot> {
    const target = region ?? this.region
    const installed = resolveMinimaxCli() !== undefined
    const status = this.auth.status(target)
    const signedIn = status.signedIn || minimaxSignedIn(target)
    if (!signedIn) {
      return {
        at: Date.now(),
        region: target,
        signedIn: false,
        installed,
        ...installed ? {} : { error: '未安装 MiniMax Code CLI（mcode）。' },
        ...status.error === undefined ? {} : { error: status.error },
      }
    }
    const snapshot = await minimaxUsage(target, { fresh })
    return {
      ...snapshot,
      signedIn: true,
      installed,
      ...snapshot.error !== undefined || status.error === undefined ? {} : { error: status.error },
    }
  }

  /** Drop cached quota readings (after a login, logout or CLI change). */
  invalidateUsage(region?: MinimaxRegion): void {
    invalidateMinimaxUsage(region)
  }

  /** Login progress for one region; the page polls this. */
  authStatus(region: MinimaxRegion): ReturnType<MinimaxAuth['status']> {
    return this.auth.status(region)
  }

  startLogin(region: MinimaxRegion): ReturnType<MinimaxAuth['start']> {
    return this.auth.start(region, ok => {
      if (!ok) return
      this.sessions.closeAll()
      this.invalidateCatalog(region)
      this.invalidateUsage(region)
    })
  }

  async logout(region: MinimaxRegion): ReturnType<MinimaxAuth['logout']> {
    const result = await this.auth.logout(region)
    this.sessions.closeAll()
    this.invalidateCatalog(region)
    this.invalidateUsage(region)
    return result
  }

  isModelDisabled(id: string, region: MinimaxRegion = this.region): boolean {
    return this.disabledFor(region).has(id)
  }

  contextWindowFor(id: string, region: MinimaxRegion = this.region): number | undefined {
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
    const region = this.region
    const target = resolveMinimaxModelId(model, this.aliases)
    const live = (await this.catalog.models(region)).find(entry => entry.id === target)
    if (live !== undefined) {
      const reasoning = reasoningInfo(live.reasoningEfforts, live.defaultEffort, live.reasoning)
      return {
        provider,
        id: model,
        name: live.name,
        ...live.description === undefined ? {} : { description: live.description },
        inputModalities: live.vision ? ['text', 'image'] : ['text'],
        context: { contextWindow: this.contextWindowFor(target, region) ?? live.defaultContextWindow },
        defaultMaxTokens: readLive(this.options.defaultMaxTokens, MINIMAX_DEFAULT_MAX_TOKENS),
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
      context: { contextWindow: this.contextWindowFor(target, region) ?? MINIMAX_DEFAULT_CONTEXT_WINDOW },
      defaultMaxTokens: readLive(this.options.defaultMaxTokens, MINIMAX_DEFAULT_MAX_TOKENS),
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
      const label = region === 'cn' ? 'MiniMax 国内站' : 'MiniMax 国际站'
      throw new Error(`${label}尚未登录，请先在设置 → MiniMax Code 中登录。`)
    }
    const model = resolveMinimaxModelId(options.model, this.aliases)
    if (options.sessionId === undefined || options.purpose !== undefined) {
      const prompt = feedToText(renderInitialFeed(options.system, options.messages))
        + '\n（这是一次性旁路请求，直接输出下一条助手回复。）'
      for (const chunk of await minimaxColdStream(region, prompt, model, options)) yield chunk
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
    if (plan.feed !== null && session.busy) {
      // The user took over while a tool round was still open. The old ACP turn
      // cannot accept the new message, so rebuild from the durable history.
      this.sessions.dispose(sessionId)
      session = this.sessions.forSession(sessionId, region, model)
      yield* this.firstTurn(session, options, region, model, effort)
      return
    }
    const reset = session.configure(region, model, {
      effort,
      system: options.system,
      cwd: this.cwdOf(options),
    })
    if (reset || (plan.feed === null && !session.busy)) {
      // Either the prompt/cwd change discarded the warm ACP process, or the
      // tool round it was waiting on ended without it. Only a complete replay
      // can restore the conversation in both cases.
      this.sessions.dispose(sessionId)
      session = this.sessions.forSession(sessionId, region, model)
      yield* this.firstTurn(session, options, region, model, effort)
      return
    }
    session.ensureTools(options.tools ?? [])
    session.fedMessages = options.messages
    session.fedSystem = options.system
    const feed = plan.feed === null ? null : feedToText(plan.feed)
    yield* session.stream(options, feed)
  }

  private async *firstTurn(
    session: ReturnType<MinimaxSessionManager['forSession']>,
    options: GenerateOptions,
    region: MinimaxRegion,
    model: string,
    effort: string | undefined,
  ): AsyncGenerator<StreamChunk> {
    session.configure(region, model, {
      effort,
      system: options.system,
      cwd: this.cwdOf(options),
    })
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
    this.mcpServer.close()
    this.auth.stop()
  }
}
