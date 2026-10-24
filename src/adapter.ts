/**
 * `QoderAdapter`: route the harness LLM seam onto a local Qoder CLI account
 * through the qoder-agent-sdk. One warm inner session per host session id
 * carries the conversation (model turns and tool rounds live inside it); host
 * tool schemas are exposed to the inner model through an in-process MCP
 * server whose handlers park until the host delivers tool results on the next
 * request. Side-channel requests (titles, compaction) run cold one-shots.
 * @module dsh-llm-qoder/adapter
 */

import { LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions, LlmModelInfo, LlmModelReasoningInfo, LlmProviderInfo, LlmResolvedModelInfo,
  PreparedAdapterCall, RequestMessage, StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { QoderBrand } from './brand.ts'
import { brandProfile } from './brand.ts'
import {
  DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, QODER_MODELS, resolveQoderModelId,
} from './catalog.ts'
import type { ResolvedConfig } from './config.ts'
import type { Live } from './live.ts'
import { readLive, readLiveOptional } from './live.ts'
import { DEFAULT_MODEL_CACHE_TTL_MS, DEFAULT_FETCH_TIMEOUT_MS, QoderModelCatalog } from './models.ts'
import { feedImageRefs, feedToText, imageRefs, joinFeeds, renderInitialFeed, renderRefreshed, renderUserTurn } from './render.ts'
import type { Feed } from './render.ts'
import { QoderSession, QoderSessionManager, DEFAULT_MAX_SESSIONS } from './session.ts'
import type { ChannelContent, ResolvedImages, SessionModelPolicy } from './session.ts'
import type { UsageSnapshot } from './usage.ts'
import { QoderUsage } from './usage.ts'

/**
 * Read one durable image occurrence into the bytes a request sends.
 * Implemented over `ctx.attachments`; returns undefined when the object is
 * unreadable, which degrades that one image instead of failing the turn.
 */
export type ImageRequestReader = (
  ref: ImageAttachmentRef,
  signal?: AbortSignal,
) => Promise<{ bytes: Uint8Array, mediaType: string } | undefined>

/**
 * Options for {@link QoderAdapter}.
 *
 * Most values are {@link Live}: a plain value, or a thunk the adapter calls
 * where it uses the option. The plugin passes thunks over its volatile config
 * cells, because a settings edit is committed in place without restarting the
 * plugin (`src/live.ts`) — an adapter that copied these into fields would keep
 * serving the values it was constructed with.
 */
export interface QoderAdapterOptions {
  /** Maximum simultaneously warm inner sessions (default 8). */
  maxSessions?: Live<number>
  /** How long a fetched CLI model catalog stays fresh (default 5 min). */
  modelCacheTtlMs?: Live<number>
  /** Request-image reader; absent → images are never forwarded as pixels. */
  readImage?: ImageRequestReader
  /** How long an unpaired MCP tool handler waits before failing its call. */
  toolResultTimeoutMs?: Live<number>
  /** How long the inner process gets to acknowledge an abort. */
  abortGraceMs?: Live<number>
  /** Maximum inner turns for one side-channel request. */
  coldMaxTurns?: Live<number>
  /** How long one CLI catalog fetch may take before the static fallback. */
  catalogFetchTimeoutMs?: Live<number>
  /**
   * Per-model context window in tokens, keyed by Qoder model id. A model with
   * no entry uses the window upstream declares for it.
   */
  modelContextWindows?: Live<Readonly<Record<string, number>>>
  /** Output-token cap assumed when a model reports none. */
  defaultMaxTokens?: Live<number>
  /** Model ids switched off; hidden from the picker. */
  disabledModels?: Live<readonly string[]>
  /** Extra harness-id → Qoder-id aliases, merged over the built-in ones. */
  modelAliases?: Live<Readonly<Record<string, string>>>
  /** Reasoning effort used when a request names none. */
  defaultReasoningEffort?: Live<string | undefined>
  /** Display name of the primary provider group. */
  displayName?: Live<string>
  /** Which edition this adapter serves; defaults to the CN one. */
  brand?: QoderBrand
  /** How long one quota reading stays fresh; read per use. */
  usageCacheTtlMs?: Live<number>
}

/** Shared empty values, so an unset list or map allocates nothing per read. */
const NO_MODELS: readonly string[] = []
const NO_WINDOWS: Readonly<Record<string, number>> = {}
const NO_ALIASES: Readonly<Record<string, string>> = {}

/** The primary provider route (the CN account's own models). */
export const QODER_PROVIDER = 'qoder-cn'
/** The international edition's route; a second adapter instance serves it. */
export const QODER_INTL_PROVIDER = 'qoder-intl'

/**
 * Decide the context window to report for one live model.
 *
 * A per-model override wins when the user chose one; otherwise upstream's own
 * `defaultContextWindow` is used, which is the window that model's session
 * actually runs with. `maxInputTokens` is NOT a substitute — it is the ceiling
 * for a single request and is often lower than the session window (e.g. 180 000
 * against a 200 000 session), so falling back to it would understate capacity.
 *
 * @param live - the live catalog entry, when the CLI answered.
 * @param override - the user's chosen window for this model, if any.
 * @param fallback - window used when the catalog has nothing for this model.
 * @returns the window in tokens.
 */
export function pickContextWindow(
  live: { maxInputTokens?: number, defaultContextWindow?: number, availableContextWindows?: readonly number[] } | undefined,
  override: number | undefined,
  fallback: number,
): number {
  if (override !== undefined && Number.isFinite(override) && override > 0) return override
  if (live === undefined) return fallback
  return live.defaultContextWindow
    ?? largestWindow(live.availableContextWindows)
    ?? live.maxInputTokens
    ?? fallback
}

/** The largest window in a catalog entry's selectable list, or undefined. */
function largestWindow(available: readonly number[] | undefined): number | undefined {
  if (available === undefined || available.length === 0) return undefined
  return Math.max(...available)
}

/**
 * The window the CLI will actually run this route with.
 *
 * Not the same thing as the window the harness is told about. A deployment may
 * declare any window it likes — `modelContextWindows` accepts arbitrary numbers
 * — but the CLI only honours one the model advertises in
 * `availableContextWindows`; anything else it silently ignores and keeps its own
 * default. Since the CLI measures `context_usage_ratio` against the window it is
 * really using, this is the only correct multiplier for that ratio: using the
 * declared window instead inflates every reading by
 * `declared / actually-honoured` (5x for a 1M override on a 200K-only model).
 *
 * @param live - the live catalog entry, when the CLI answered.
 * @param declared - the window this route publishes to the harness.
 * @returns the window the CLI runs with, or undefined when unknown.
 */
export function cliContextWindow(
  live: { maxInputTokens?: number, defaultContextWindow?: number, availableContextWindows?: readonly number[] } | undefined,
  declared: number,
): number | undefined {
  if (live === undefined) return undefined
  const available = live.availableContextWindows
  if (available !== undefined && available.includes(declared)) return declared
  return live.defaultContextWindow ?? largestWindow(available) ?? live.maxInputTokens
}

function modelInfo(provider: string, entry: { id: string, name: string, description?: string, isVl?: boolean }): LlmModelInfo {
  return {
    provider,
    id: entry.id,
    name: entry.name,
    ...entry.description === undefined ? {} : { description: entry.description },
    inputModalities: entry.isVl === true ? ['text' as const, 'image' as const] : ['text' as const],
  }
}

/**
 * Default selectable reasoning efforts for a Qoder model. The CLI catalog
 * reports per-model `efforts`; this is the fallback when a model (or the
 * static catalog) discloses none.
 */
const DEFAULT_REASONING_EFFORTS = ['low', 'medium', 'high', 'max'] as const

/** Human display name for the default effort ids. */
const EFFORT_NAMES: Readonly<Record<string, string>> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  max: 'Max',
}

/**
 * Build the `reasoning` metadata block for a resolved model, or undefined
 * when the model does not support reasoning.
 * @param efforts - CLI-reported effort ids (absent for reasoning-less models).
 * @param defaultEffort - CLI-reported default effort id.
 * @param isReasoning - whether the model supports reasoning per the CLI.
 * @returns the harness reasoning metadata, or undefined to omit it.
 */
export function reasoningInfo(
  efforts: readonly string[] | undefined,
  defaultEffort: string | undefined,
  isReasoning: boolean | undefined,
): LlmModelReasoningInfo | undefined {
  if (efforts === undefined && isReasoning === false) return undefined
  const ids = efforts !== undefined && efforts.length > 0
    ? efforts
    : DEFAULT_REASONING_EFFORTS
  return {
    efforts: ids.map(id => ({
      id: ReasoningEffortId(id),
      name: EFFORT_NAMES[id] ?? id,
    })),
    ...defaultEffort !== undefined && ids.includes(defaultEffort)
      ? { defaultEffort: ReasoningEffortId(defaultEffort) }
      : {},
  }
}

/** One adapter dispatch generation: the metadata the harness saw, plus what it implies. */
interface CallGeneration {
  readonly info: LlmResolvedModelInfo
  /** Whether the resolved route accepts image input, per that same resolution. */
  readonly vision: boolean
  /**
   * The window the CLI will run this route with. Distinct from
   * `info.context.contextWindow`, which is what the harness was told; the two
   * differ when the declared window is one the model does not advertise.
   */
  readonly cliContextWindow: number | undefined
}

/**
 * The Qoder-backed adapter. Session continuity, tool parking, and feed
 * planning live here; chunk synthesis lives in the session's consumer.
 */
export class QoderAdapter extends LlmAdapter {
  /**
   * The options as given, read where they are used rather than copied here.
   *
   * A `.volatile()` field is a live cell DSH updates in place, and such an edit
   * does not restart the plugin, so a value captured in the constructor would
   * stay frozen for the lifetime of the process (see `src/live.ts`).
   */
  private readonly options: QoderAdapterOptions
  private readonly sessions: QoderSessionManager
  private readonly catalog: QoderModelCatalog
  private readonly usage: QoderUsage
  private readonly readImage: ImageRequestReader | undefined
  private readonly brand: QoderBrand
  /**
   * Memoized `Set` view of the disabled-model list.
   *
   * `updateVolatile` stores the freshly parsed array, so identity changes only
   * when the value does: caching on that identity keeps the per-model lookup a
   * hash probe instead of rebuilding a set per call, with no staleness.
   */
  private disabledCache: { source: readonly string[], set: ReadonlySet<string> } | undefined

  constructor(options: QoderAdapterOptions = {}) {
    super()
    this.options = options
    this.brand = options.brand ?? 'cn'
    this.sessions = new QoderSessionManager(options.maxSessions ?? DEFAULT_MAX_SESSIONS, {
      toolResultTimeoutMs: options.toolResultTimeoutMs,
      abortGraceMs: options.abortGraceMs,
      coldMaxTurns: options.coldMaxTurns,
      brand: this.brand,
    })
    this.catalog = new QoderModelCatalog(
      this.brand,
      options.modelCacheTtlMs ?? DEFAULT_MODEL_CACHE_TTL_MS,
      options.catalogFetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
    )
    this.usage = new QoderUsage(this.brand, options.usageCacheTtlMs)
    this.readImage = options.readImage
  }

  private get defaultMaxTokens(): number {
    return readLive(this.options.defaultMaxTokens, DEFAULT_MAX_TOKENS)
  }

  private get modelContextWindows(): Readonly<Record<string, number>> {
    return readLive(this.options.modelContextWindows, NO_WINDOWS)
  }

  private get disabledModels(): ReadonlySet<string> {
    const source = readLive(this.options.disabledModels, NO_MODELS)
    const cached = this.disabledCache
    if (cached !== undefined && cached.source === source) return cached.set
    const set = new Set(source)
    this.disabledCache = { source, set }
    return set
  }

  private get modelAliases(): Readonly<Record<string, string>> {
    return readLive(this.options.modelAliases, NO_ALIASES)
  }

  private get defaultReasoningEffort(): string | undefined {
    return readLiveOptional(this.options.defaultReasoningEffort)
  }

  private get displayName(): string {
    return readLive(this.options.displayName, brandProfile(this.brand).defaultDisplayName)
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.displayName }
  }

  /**
   * Whether one catalog entry is enabled for the picker.
   *
   * Only the user's off-switch is consulted: a model the account adds later
   * appears enabled by default, which a stored allow-list could not do.
   */
  private isVisible(id: string): boolean {
    return !this.disabledModels.has(id)
  }

  /**
   * The user's chosen window for one catalog id, honouring aliases.
   *
   * A window may be stored under either the Qoder id or a harness-side alias,
   * so both spellings are checked before giving up.
   */
  private windowOverride(id: string): number | undefined {
    const direct = this.modelContextWindows[id]
    if (direct !== undefined) return direct
    for (const [key, value] of Object.entries(this.modelContextWindows)) {
      if (resolveQoderModelId(key, this.modelAliases) === id) return value
    }
    return undefined
  }

  // ── Accessors for the settings API ──────────────────────────────────────
  // The page needs the raw catalog plus the user's stored choices; these expose
  // exactly that without leaking the adapter's internals.

  /**
   * The live catalog as the page renders it.
   *
   * Unlike {@link listModels}, this is not filtered by the user's on/off
   * choices: the page must show a switched-off model in order to switch it
   * back on.
   *
   * @returns live catalog entries in upstream order.
   */
  async describeCatalog(): Promise<Awaited<ReturnType<QoderModelCatalog['liveModels']>>> {
    return this.catalog.liveModels()
  }

  /** Forget the cached catalog; the next read asks the CLI again. */
  invalidateCatalog(): void {
    this.catalog.invalidate()
  }

  /** Why the last catalog refresh failed, for the settings page's guidance. */
  catalogError(): string | undefined {
    return this.catalog.error
  }

  /**
   * Read the account's quota and usage, as the Qoder clients display it.
   *
   * @param fresh - ignore the cached reading.
   */
  async usageInfo(fresh = false): Promise<UsageSnapshot> {
    return this.usage.read(fresh)
  }

  /** Forget the cached quota reading; the next read asks the CLI again. */
  invalidateUsage(): void {
    this.usage.invalidate()
  }

  /** Whether the user switched one model off. */
  isModelDisabled(id: string): boolean {
    return this.disabledModels.has(id)
  }

  /** The stored disabled-model set, as a list for rewriting the field. */
  disabledModelIds(): readonly string[] {
    return [...this.disabledModels]
  }

  /** The user's window for one model, or undefined when following upstream. */
  contextWindowFor(id: string): number | undefined {
    return this.windowOverride(id)
  }

  /** The stored per-model window map, for rewriting the field. */
  modelWindowChoices(): Readonly<Record<string, number>> {
    return this.modelContextWindows
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    // One route, one list: the account's official models as the CLI reports
    // them, minus whatever the user switched off.
    const cliModels = await this.catalog.models()
    return cliModels
      .filter(entry => this.isVisible(entry.id))
      .map(entry => modelInfo(provider, entry))
  }

  override async resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    // The host may address a model by a `deepseek-v4-*` alias or a `qoder-`
    // prefixed id, while the CLI catalog is keyed by the SDK value. Resolve the
    // address to find the metadata, but echo the requested id back: the seam
    // rejects an exact-model result whose id differs from the one asked for.
    const target = resolveQoderModelId(model, this.modelAliases)
    const live = (await this.catalog.liveModels()).find(entry => entry.value === target)
    if (live !== undefined) {
      const reasoning = reasoningInfo(live.efforts, live.defaultEffort ?? this.defaultReasoningEffort, live.isReasoning)
      return {
        provider,
        id: model,
        name: live.displayName.length > 0 ? live.displayName : live.value,
        ...live.description.length > 0 ? { description: live.description } : {},
        // Only an affirmative CLI `isVl` declares image input. The harness
        // projects images to handle text for a route that omits it, so a claim
        // the CLI did not make would silently drop pixels; the reverse error
        // would send pixels to a model that cannot read them.
        inputModalities: live.isVl === true ? ['text' as const, 'image' as const] : ['text' as const],
        context: {
          // The compaction engine and context meter price against the window a
          // request actually uses. Upstream reports three different numbers
          // (per-request ceiling, effective session window, and the list of
          // selectable windows); `pickContextWindow` prefers the user's choice,
          // then upstream's own session window. Reporting a window larger than
          // the session really runs with would push the auto-compaction
          // threshold past what the provider accepts.
          contextWindow: pickContextWindow(
            live,
            this.windowOverride(target),
            DEFAULT_CONTEXT_WINDOW,
          ),
        },
        defaultMaxTokens: live.maxOutputTokens ?? this.defaultMaxTokens,
        ...reasoning === undefined ? {} : { reasoning },
      }
    }
    // The static catalog describes the CN plan only; an intl route whose live
    // catalog is unreachable must not borrow model ids the account may not have.
    const configured = brandProfile(this.brand).staticCatalog
      ? QODER_MODELS.find(entry => entry.id === target)
      : undefined
    const reasoning = reasoningInfo(undefined, this.defaultReasoningEffort, true)
    return Promise.resolve({
      ...configured === undefined
        ? { provider, id: model, name: model, inputModalities: ['text' as const] }
        : { ...modelInfo(provider, configured), id: model },
      context: {
        contextWindow: this.windowOverride(target) ?? DEFAULT_CONTEXT_WINDOW,
      },
      defaultMaxTokens: this.defaultMaxTokens,
      ...reasoning === undefined ? {} : { reasoning },
    })
  }

  /**
   * Bind one resolution generation to its dispatch, as the seam requires of a
   * dynamic adapter: the live catalog and the CLI login can change between the
   * harness preparing a call and the inner session running it, and a turn must
   * not mix one generation's declared capabilities with another's endpoint.
   */
  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const generation = await this.capture(provider, model, signal)
    return {
      model: generation.info,
      stream: options => this.dispatch(options, generation),
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield* this.dispatch(options, await this.capture(options.provider, options.model, options.signal))
  }

  /** Resolve the exact route once and derive the capability facts from it. */
  private async capture(provider: string, model: string, signal?: AbortSignal): Promise<CallGeneration> {
    const info = await this.resolveModel(provider, model, signal)
    const target = resolveQoderModelId(model, this.modelAliases)
    const live = (await this.catalog.liveModels()).find(entry => entry.value === target)
    const declared = info.context?.contextWindow
    return {
      info,
      vision: info.inputModalities?.includes('image') === true,
      cliContextWindow: declared === undefined ? undefined : cliContextWindow(live, declared),
    }
  }

  private async *dispatch(options: GenerateOptions, generation: CallGeneration): AsyncGenerator<StreamChunk> {
    const model = resolveQoderModelId(options.model, this.modelAliases)
    if (options.sessionId === undefined || options.purpose !== undefined) {
      // Side channels summarise text; pixels would only cost them context.
      const prompt = feedToText(renderInitialFeed(options.system, options.messages))
        + '\n（这是一次性旁路请求，直接输出下一条助手回复。）'
      // Side channels (titles, compaction summaries) reuse the main session's
      // model so dsh's recorded summarization target matches what qodercli
      // actually runs — a different default route could have different
      // context limits or quota, silently failing the compaction.
      yield* this.sessions.coldStream(options, prompt, model)
      return
    }
    const sessionId = String(options.sessionId)
    // The seam carries no per-request context window: the route's capacity comes
    // Two different windows, deliberately kept apart:
    //  - `contextWindow` is what the harness is told and divides its percentage
    //    by (the user's choice, when they made one).
    //  - `cliContextWindow` is what the CLI will actually run with, and is
    //    therefore the only honest denominator for its own context ratio. The
    //    CLI ignores a declared window the model does not advertise, so these
    //    two disagree exactly when the declaration is not honoured — and using
    //    the declared one there inflates every reading.
    const declaredWindow = generation.info.context?.contextWindow
    const policy = {
      ...options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort },
      ...declaredWindow === undefined ? {} : { contextWindow: declaredWindow },
      ...generation.cliContextWindow === undefined ? {} : { cliContextWindow: generation.cliContextWindow },
    }
    let session = this.sessions.forSession(sessionId, model)
    if (session.fedMessages === undefined) {
      yield* this.firstTurn(session, options, model, policy, generation.vision)
      return
    }
    const tail = options.messages.slice(session.fedMessages.length)
    const images = await this.resolveTurnImages(tail, generation.vision, options.signal)
    session.deliverToolResults(tail, images)
    const plan = planContinuation(session.fedMessages, options.messages)
    if (plan.rebuild) {
      this.sessions.dispose(sessionId)
      session = this.sessions.forSession(sessionId, model)
      yield* this.firstTurn(session, options, model, policy, generation.vision)
      return
    }
    session.setModel(model, policy)
    session.ensureTools(options.tools ?? [])
    session.recordRequestInput(options.system, options.messages)
    session.fedMessages = options.messages
    session.fedSystem = options.system
    const feed = plan.feed === null ? null : await this.buildFeed(plan.feed, generation.vision, images)
    yield* session.stream(options, feed, plan.feed === null ? undefined : feedToText(plan.feed))
  }

  private async *firstTurn(
    session: QoderSession,
    options: GenerateOptions,
    model: string,
    policy: SessionModelPolicy,
    vision: boolean,
  ): AsyncGenerator<StreamChunk> {
    session.setModel(model, policy)
    session.setSystem(options.system)
    // Older dsh-llm releases lack the cwd field on GenerateOptions; read it
    // through the widened view so this adapter compiles against the peer range.
    const cwd = (options as GenerateOptions & { cwd?: string }).cwd
    session.setCwd(cwd)
    session.ensureTools(options.tools ?? [])
    session.recordRequestInput(options.system, options.messages)
    session.fedMessages = options.messages
    session.fedSystem = options.system
    const feed = renderInitialFeed(options.system, options.messages)
    const images = await this.resolveImages(feedImageRefs(feed), vision, options.signal)
    yield* session.stream(options, await this.buildFeed(feed, vision, images), feedToText(feed))
  }

  /** Image references carried by a message tail, skipping assistant content. */
  private async resolveTurnImages(
    tail: readonly RequestMessage[],
    vision: boolean,
    signal?: AbortSignal,
  ): Promise<ResolvedImages> {
    const refs = tail.flatMap(message => message.role === 'assistant' ? [] : imageRefs(message.content))
    return this.resolveImages(refs, vision, signal)
  }

  /** Resolve image references into base64 request bytes; absent reader → none. */
  private async resolveImages(
    refs: readonly ImageAttachmentRef[],
    vision: boolean,
    signal?: AbortSignal,
  ): Promise<ResolvedImages> {
    const map = new Map<string, { data: string, mediaType: string }>()
    if (!vision || this.readImage === undefined || refs.length === 0) return map
    for (const ref of refs) {
      const key = String(ref.attachmentId)
      if (map.has(key)) continue
      try {
        const image = await this.readImage(ref, signal)
        if (image !== undefined) {
          map.set(key, { data: Buffer.from(image.bytes).toString('base64'), mediaType: image.mediaType })
        }
      } catch {
        // One unreadable attachment degrades to handle text; the turn continues.
      }
    }
    return map
  }

  /**
   * Turn a feed into channel content. A text feed passes through; a non-vision
   * feed flattens to the harness's own image handle text; an image the host
   * could not read keeps a note naming what was dropped, so the inner model
   * still knows the attachment was there.
   */
  private async buildFeed(
    feed: Feed,
    vision: boolean,
    images: ResolvedImages,
  ): Promise<string | ChannelContent[]> {
    if (typeof feed === 'string') return feed
    if (!vision) return feedToText(feed)
    const content: ChannelContent[] = []
    let pixels = 0
    for (const part of feed) {
      if (part.type === 'text') {
        if (part.text.length > 0) content.push({ type: 'text', text: part.text })
        continue
      }
      const resolved = images.get(String(part.attachment.attachmentId))
      if (resolved === undefined) {
        content.push({ type: 'text', text: `[图片附件 ${String(part.attachment.attachmentId)} 本次未能读取，请基于文字内容继续]` })
        continue
      }
      pixels += 1
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: resolved.mediaType, data: resolved.data },
      })
    }
    // Nothing to show as pixels: stay in the historical single-string shape.
    return pixels === 0 ? content.map(block => block.type === 'text' ? block.text : '').join('\n\n') : content
  }

  /** Tear down every warm inner session (plugin dispose). */
  close(): void {
    this.sessions.closeAll()
  }
}

interface ContinuationPlan {
  /** Feed for the inner session this turn, or null for a pure continuation. */
  feed: Feed | null
  /** Whether the warm session must be rebuilt (history diverged past repair). */
  rebuild: boolean
}

/**
 * Decide what to feed on a continuation request. The previous list must be a
 * prefix (same length growth, index 0 untouched, at most two in-place
 * mutations — the host refreshes runtime-context snapshots in place every
 * turn). Tail tool-result messages were already resolved into parked handlers
 * and never feed; fresh user turns and mutated messages do.
 */
export function planContinuation(
  previous: readonly RequestMessage[],
  current: readonly RequestMessage[],
): ContinuationPlan {
  if (current.length <= previous.length) return { feed: null, rebuild: true }
  const mutated: number[] = []
  for (let i = 0; i < previous.length; i++) {
    if (JSON.stringify(previous[i]) !== JSON.stringify(current[i])) mutated.push(i)
  }
  if (mutated.includes(0) || mutated.length > 2) return { feed: null, rebuild: true }
  const tail = current.slice(previous.length)
  const freshUser = tail.filter(m => m.role === 'user')
  if (freshUser.length === 0 && mutated.length === 0) return { feed: null, rebuild: false }
  const parts: Feed[] = []
  for (const index of mutated) {
    const message = current[index]
    if (message !== undefined) parts.push(renderRefreshed(message))
  }
  for (const message of freshUser) parts.push(renderUserTurn(message.content))
  const feed = joinFeeds(parts)
  return { feed: typeof feed === 'string' && feed.length === 0 ? null : feed, rebuild: false }
}
