/**
 * `QoderAdapter`: route the harness LLM seam onto a local Qoder CLI account
 * through the qoder-agent-sdk. One warm inner session per host session id
 * carries the conversation (model turns and tool rounds live inside it); host
 * tool schemas are exposed to the inner model through an in-process MCP
 * server whose handlers park until the host delivers tool results on the next
 * request. Side-channel requests (titles, compaction) run cold one-shots.
 * @module dsh-llm-qoder/adapter
 */
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmModelReasoningInfo, LlmProviderInfo, LlmResolvedModelInfo, PreparedAdapterCall, RequestMessage, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import type { QoderBrand } from './brand.ts';
import type { Live } from './live.ts';
import { QoderModelCatalog } from './models.ts';
import type { Feed } from './render.ts';
import type { UsageSnapshot } from './usage.ts';
/**
 * Read one durable image occurrence into the bytes a request sends.
 * Implemented over `ctx.attachments`; returns undefined when the object is
 * unreadable, which degrades that one image instead of failing the turn.
 */
export type ImageRequestReader = (ref: ImageAttachmentRef, signal?: AbortSignal) => Promise<{
    bytes: Uint8Array;
    mediaType: string;
} | undefined>;
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
    maxSessions?: Live<number>;
    /** How long a fetched CLI model catalog stays fresh (default 5 min). */
    modelCacheTtlMs?: Live<number>;
    /** Request-image reader; absent → images are never forwarded as pixels. */
    readImage?: ImageRequestReader;
    /** How long an unpaired MCP tool handler waits before failing its call. */
    toolResultTimeoutMs?: Live<number>;
    /** How long the inner process gets to acknowledge an abort. */
    abortGraceMs?: Live<number>;
    /** Maximum inner turns for one side-channel request. */
    coldMaxTurns?: Live<number>;
    /** How long one CLI catalog fetch may take before the static fallback. */
    catalogFetchTimeoutMs?: Live<number>;
    /**
     * Per-model context window in tokens, keyed by Qoder model id. A model with
     * no entry uses the window upstream declares for it.
     */
    modelContextWindows?: Live<Readonly<Record<string, number>>>;
    /** Output-token cap assumed when a model reports none. */
    defaultMaxTokens?: Live<number>;
    /** Model ids switched off; hidden from the picker. */
    disabledModels?: Live<readonly string[]>;
    /** Extra harness-id → Qoder-id aliases, merged over the built-in ones. */
    modelAliases?: Live<Readonly<Record<string, string>>>;
    /** Reasoning effort used when a request names none. */
    defaultReasoningEffort?: Live<string | undefined>;
    /** Display name of the primary provider group. */
    displayName?: Live<string>;
    /** Which edition this adapter serves; defaults to the CN one. */
    brand?: QoderBrand;
    /** How long one quota reading stays fresh; read per use. */
    usageCacheTtlMs?: Live<number>;
}
/** The primary provider route (the CN account's own models). */
export declare const QODER_PROVIDER = "qoder-cn";
/** The international edition's route; a second adapter instance serves it. */
export declare const QODER_INTL_PROVIDER = "qoder-intl";
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
export declare function pickContextWindow(live: {
    maxInputTokens?: number;
    defaultContextWindow?: number;
    availableContextWindows?: readonly number[];
} | undefined, override: number | undefined, fallback: number): number;
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
export declare function cliContextWindow(live: {
    maxInputTokens?: number;
    defaultContextWindow?: number;
    availableContextWindows?: readonly number[];
} | undefined, declared: number): number | undefined;
/**
 * Build the `reasoning` metadata block for a resolved model, or undefined
 * when the model does not support reasoning.
 * @param efforts - CLI-reported effort ids (absent for reasoning-less models).
 * @param defaultEffort - CLI-reported default effort id.
 * @param isReasoning - whether the model supports reasoning per the CLI.
 * @returns the harness reasoning metadata, or undefined to omit it.
 */
export declare function reasoningInfo(efforts: readonly string[] | undefined, defaultEffort: string | undefined, isReasoning: boolean | undefined): LlmModelReasoningInfo | undefined;
/**
 * The Qoder-backed adapter. Session continuity, tool parking, and feed
 * planning live here; chunk synthesis lives in the session's consumer.
 */
export declare class QoderAdapter extends LlmAdapter {
    /**
     * The options as given, read where they are used rather than copied here.
     *
     * A `.volatile()` field is a live cell DSH updates in place, and such an edit
     * does not restart the plugin, so a value captured in the constructor would
     * stay frozen for the lifetime of the process (see `src/live.ts`).
     */
    private readonly options;
    private readonly sessions;
    private readonly catalog;
    private readonly usage;
    private readonly readImage;
    private readonly brand;
    /**
     * Memoized `Set` view of the disabled-model list.
     *
     * `updateVolatile` stores the freshly parsed array, so identity changes only
     * when the value does: caching on that identity keeps the per-model lookup a
     * hash probe instead of rebuilding a set per call, with no staleness.
     */
    private disabledCache;
    constructor(options?: QoderAdapterOptions);
    private get defaultMaxTokens();
    private get modelContextWindows();
    private get disabledModels();
    private get modelAliases();
    private get defaultReasoningEffort();
    private get displayName();
    providerInfo(provider: string): LlmProviderInfo;
    /**
     * Whether one catalog entry is enabled for the picker.
     *
     * Only the user's off-switch is consulted: a model the account adds later
     * appears enabled by default, which a stored allow-list could not do.
     */
    private isVisible;
    /**
     * The user's chosen window for one catalog id, honouring aliases.
     *
     * A window may be stored under either the Qoder id or a harness-side alias,
     * so both spellings are checked before giving up.
     */
    private windowOverride;
    /**
     * The live catalog as the page renders it.
     *
     * Unlike {@link listModels}, this is not filtered by the user's on/off
     * choices: the page must show a switched-off model in order to switch it
     * back on.
     *
     * @returns live catalog entries in upstream order.
     */
    describeCatalog(): Promise<Awaited<ReturnType<QoderModelCatalog['liveModels']>>>;
    /** Forget the cached catalog; the next read asks the CLI again. */
    invalidateCatalog(): void;
    /** Why the last catalog refresh failed, for the settings page's guidance. */
    catalogError(): string | undefined;
    /**
     * Read the account's quota and usage, as the Qoder clients display it.
     *
     * @param fresh - ignore the cached reading.
     */
    usageInfo(fresh?: boolean): Promise<UsageSnapshot>;
    /** Forget the cached quota reading; the next read asks the CLI again. */
    invalidateUsage(): void;
    /** Whether the user switched one model off. */
    isModelDisabled(id: string): boolean;
    /** The stored disabled-model set, as a list for rewriting the field. */
    disabledModelIds(): readonly string[];
    /** The user's window for one model, or undefined when following upstream. */
    contextWindowFor(id: string): number | undefined;
    /** The stored per-model window map, for rewriting the field. */
    modelWindowChoices(): Readonly<Record<string, number>>;
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    /**
     * Bind one resolution generation to its dispatch, as the seam requires of a
     * dynamic adapter: the live catalog and the CLI login can change between the
     * harness preparing a call and the inner session running it, and a turn must
     * not mix one generation's declared capabilities with another's endpoint.
     */
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    /** Resolve the exact route once and derive the capability facts from it. */
    private capture;
    private dispatch;
    private firstTurn;
    /** Image references carried by a message tail, skipping assistant content. */
    private resolveTurnImages;
    /** Resolve image references into base64 request bytes; absent reader → none. */
    private resolveImages;
    /**
     * Turn a feed into channel content. A text feed passes through; a non-vision
     * feed flattens to the harness's own image handle text; an image the host
     * could not read keeps a note naming what was dropped, so the inner model
     * still knows the attachment was there.
     */
    private buildFeed;
    /** Tear down every warm inner session (plugin dispose). */
    close(): void;
}
interface ContinuationPlan {
    /** Feed for the inner session this turn, or null for a pure continuation. */
    feed: Feed | null;
    /** Whether the warm session must be rebuilt (history diverged past repair). */
    rebuild: boolean;
}
/**
 * Decide what to feed on a continuation request. The previous list must be a
 * prefix (same length growth, index 0 untouched, at most two in-place
 * mutations — the host refreshes runtime-context snapshots in place every
 * turn). Tail tool-result messages were already resolved into parked handlers
 * and never feed; fresh user turns and mutated messages do.
 */
export declare function planContinuation(previous: readonly RequestMessage[], current: readonly RequestMessage[]): ContinuationPlan;
export {};
