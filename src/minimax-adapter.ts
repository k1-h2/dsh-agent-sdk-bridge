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
  MINIMAX_FETCH_TIMEOUT_MS, invalidateMinimaxRegionAccess, invalidateMinimaxUsage,
  minimaxColdStream, minimaxRegionBlockMessage, minimaxRegionBlocked,
  minimaxRegionBlockedCached, minimaxSignedIn, minimaxUsage,
} from './minimax.ts'
import type { MinimaxModel, MinimaxPromptBlock, MinimaxUsageSnapshot } from './minimax.ts'
import { resolveMinimaxCli } from './minimax-cli.ts'
import { reasoningInfo, planContinuation } from './adapter.ts'
import { cachedModels } from './model-cache.ts'
import type { ImageRequestReader } from './adapter.ts'
import type { Live } from './live.ts'
import { readLive, readLiveOptional } from './live.ts'
import type { Feed, ImagePathResolver } from './render.ts'
import { feedImageRefs, feedToText, imageRefText, renderInitialFeed, resolvedFeedParts } from './render.ts'

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
  /**
   * Reads image attachment bytes. Absent (a deployment with no attachment
   * store) → images degrade to their handle text instead of failing the turn.
   */
  readImage?: ImageRequestReader
  /**
   * The tool-world path of one image, for the handle text that lets the model
   * edit it. Absent → an unreadable image keeps the harness placeholder.
   */
  imagePath?: ImagePathResolver
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
  /** Last verified image capability, keyed `${region}:${model}`. */
  private readonly knownVision = new Map<string, boolean>()

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
    if (await minimaxRegionBlocked(region)) return []
    const models = await this.catalog.models(region)
    for (const model of models) this.knownVision.set(`${region}:${model.id}`, model.vision)
    return models
  }

  /** Whether the region's endpoints are refusing this machine's network. */
  regionBlocked(region: MinimaxRegion = this.region): boolean {
    return minimaxRegionBlockedCached(region)
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
    if (minimaxRegionBlockedCached(region)) return minimaxRegionBlockMessage(region)
    if (!this.isSignedIn(region)) return '请先登录 MiniMax Code，登录后才会读取并显示模型目录。'
    return this.catalog.error(region)
  }

  /**
   * Drop the cached catalog and the region verdict behind it.
   *
   * The page calls this with `fresh=1` on a region switch, which is exactly
   * when the network may have changed; keeping a 30-second "blocked" verdict
   * would hide the catalog the switch was meant to reveal.
   */
  invalidateCatalog(region?: MinimaxRegion): void {
    this.catalog.invalidate(region)
    invalidateMinimaxRegionAccess(region)
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

  /** Drop cached quota readings and the region verdict (login, logout, CLI). */
  invalidateUsage(region?: MinimaxRegion): void {
    invalidateMinimaxUsage(region)
    invalidateMinimaxRegionAccess(region)
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
      invalidateMinimaxRegionAccess(region)
    })
  }

  async logout(region: MinimaxRegion): ReturnType<MinimaxAuth['logout']> {
    const result = await this.auth.logout(region)
    this.sessions.closeAll()
    this.invalidateCatalog(region)
    this.invalidateUsage(region)
    invalidateMinimaxRegionAccess(region)
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
    if (await minimaxRegionBlocked(region)) return []
    const models = await this.catalog.models(region)
    const disabled = this.disabledFor(region)
    return models.filter(model => !disabled.has(model.id)).map(model => modelInfo(provider, model))
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const region = this.region
    const target = resolveMinimaxModelId(model, this.aliases)
    const key = `${region}:${target}`
    // Cache first: resolving a route may not wait on an ACP probe.
    const live = (await cachedModels(this.catalog.snapshot(region), () => this.catalog.models(region)))
      .find(entry => entry.id === target)
    if (live !== undefined) {
      this.knownVision.set(key, live.vision)
      const reasoning = reasoningInfo(live.reasoningEfforts, readLiveOptional(this.options.defaultReasoningEffort), live.reasoning)
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
      inputModalities: this.knownVision.get(key) === true ? ['text', 'image'] : ['text'],
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
    if (await minimaxRegionBlocked(region)) {
      throw new Error(minimaxRegionBlockMessage(region))
    }
    const model = resolveMinimaxModelId(options.model, this.aliases)
    if (options.sessionId === undefined || options.purpose !== undefined) {
      const prompt = feedToText(renderInitialFeed(options.system, options.messages, this.options.imagePath), this.options.imagePath)
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
    const vision = await this.modelVision(model, region)
    const feed = plan.feed === null
      ? null
      : await this.buildFeed(plan.feed, vision, options.signal)
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
    const vision = await this.modelVision(model, region)
    const feed = await this.buildFeed(
      renderInitialFeed(undefined, options.messages, this.options.imagePath),
      vision,
      options.signal,
    )
    yield* session.stream(options, feed)
  }

  /** Whether the resolved model accepts images (drives whether pixels are sent). */
  private async modelVision(model: string, region: MinimaxRegion): Promise<boolean> {
    const target = resolveMinimaxModelId(model, this.aliases)
    const key = `${region}:${target}`
    const live = (await this.catalog.models(region).catch(() => [])).find(entry => entry.id === target)
    if (live !== undefined) {
      this.knownVision.set(key, live.vision)
      return live.vision
    }
    // Keep a verified vision capability across a missed catalog read; otherwise
    // DSH strips the pixels before this adapter ever runs.
    return this.knownVision.get(key) === true
  }

  /**
   * Turn a feed into what one ACP prompt carries.
   *
   * A text-only feed stays a plain string (the historical shape). A feed with
   * readable images becomes ACP content blocks, because an image block is the
   * only thing the agent receives as pixels. An image the host could not read
   * keeps its handle text, so it degrades one part instead of failing the turn.
   */
  private async buildFeed(
    feed: Feed,
    vision: boolean,
    signal?: AbortSignal,
  ): Promise<string | MinimaxPromptBlock[]> {
    if (typeof feed === 'string') return feed
    if (!vision) return feedToText(feed, this.options.imagePath)
    const images = new Map<string, { data: string, mediaType: string }>()
    const readImage = this.options.readImage
    if (readImage !== undefined) {
      for (const ref of feedImageRefs(feed)) {
        const key = String(ref.attachmentId)
        if (images.has(key)) continue
        try {
          const image = await readImage(ref, signal)
          if (image !== undefined) {
            images.set(key, { data: Buffer.from(image.bytes).toString('base64'), mediaType: image.mediaType })
          }
        } catch {
          // Degrade this attachment to its handle text.
        }
      }
    }
    const parts = resolvedFeedParts(feed, images)
    if (!parts.some(part => part.type !== 'text')) {
      return parts.map(part => part.type === 'text' ? part.text : '').join('\n\n')
    }
    const content: MinimaxPromptBlock[] = []
    for (const part of parts) {
      if (part.type === 'text') {
        content.push({ type: 'text', text: part.text })
        continue
      }
      // The pixels let the model read the image; this handle lets it find and
      // edit the source file. Without it a "modify this image" turn searches
      // the workspace for a file that was never there.
      const path = this.options.imagePath?.(part.attachment)
      content.push({
        type: 'text',
        text: part.type === 'image-unreadable' && path === undefined
          ? `[图片附件 ${String(part.attachment.attachmentId)} 本次未能读取，请基于文字内容继续]`
          : imageRefText(part.attachment, path),
      })
      if (part.type === 'image-unreadable') continue
      content.push({ type: 'image', data: part.data, mimeType: part.mediaType })
    }
    return content
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
