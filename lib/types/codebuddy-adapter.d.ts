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
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { CodeBuddyRegion } from './brand.ts';
import { CodeBuddyAuth } from './codebuddy.ts';
import type { CodeBuddyModel, CodeBuddyUsageSnapshot } from './codebuddy.ts';
import type { ImageRequestReader } from './adapter.ts';
import type { Live } from './live.ts';
import type { ImagePathResolver } from './render.ts';
/** The CodeBuddy provider route. */
export declare const CODEBUDDY_PROVIDER = "codebuddy";
/** Everything the adapter reads lazily from the plugin config. */
export interface CodeBuddyAdapterOptions {
    maxSessions?: Live<number>;
    modelCacheTtlMs?: Live<number>;
    catalogFetchTimeoutMs?: Live<number>;
    toolResultTimeoutMs?: Live<number>;
    abortGraceMs?: Live<number>;
    defaultMaxTokens?: Live<number>;
    defaultReasoningEffort?: Live<string | undefined>;
    displayName?: Live<string>;
    region?: Live<CodeBuddyRegion>;
    /** Per-region deny-lists; the page edits each region's list separately. */
    disabledModels?: (region: CodeBuddyRegion) => readonly string[];
    /** Per-region context-window overrides, keyed by model id. */
    modelContextWindows?: (region: CodeBuddyRegion) => Readonly<Record<string, number>>;
    modelAliases?: Live<Readonly<Record<string, string>>>;
    /**
     * Reads image attachment bytes. Absent (a deployment with no attachment
     * store) → images degrade to their handle text instead of failing the turn.
     */
    readImage?: ImageRequestReader;
    /**
     * The tool-world path of one image, for the handle text that lets the model
     * edit it. Absent → an unreadable image keeps the harness placeholder.
     */
    imagePath?: ImagePathResolver;
}
/** Map a harness-side id onto a CodeBuddy model value. */
export declare function resolveCodeBuddyModelId(model: string, aliases?: Readonly<Record<string, string>>): string;
/** The CodeBuddy-backed adapter. */
export declare class CodeBuddyAdapter extends LlmAdapter {
    private readonly options;
    private readonly sessions;
    private readonly catalog;
    private readonly accounts;
    private readonly auth;
    private readonly disabledCache;
    /** Last verified image capability, keyed `${region}:${model}`. */
    private readonly knownVision;
    constructor(options?: CodeBuddyAdapterOptions);
    private get region();
    private disabledFor;
    private get aliases();
    private get displayName();
    providerInfo(provider: string): LlmProviderInfo;
    /** The live catalog, unfiltered (the page must show switched-off models). */
    describeCatalog(region?: CodeBuddyRegion): Promise<readonly CodeBuddyModel[]>;
    /** Whether the selected (or given) region has a stored login. */
    isSignedIn(region?: CodeBuddyRegion): boolean;
    /** Why the last catalog read failed, for the page's guidance. */
    catalogError(region?: CodeBuddyRegion): string | undefined;
    invalidateCatalog(region?: CodeBuddyRegion): void;
    /** The signed-in account, or the reason it could not be read. */
    usageInfo(fresh?: boolean, region?: CodeBuddyRegion): Promise<CodeBuddyUsageSnapshot>;
    invalidateUsage(region?: CodeBuddyRegion): void;
    /** Login progress for one region; the page polls this. */
    authStatus(region: CodeBuddyRegion): ReturnType<CodeBuddyAuth['status']>;
    startLogin(region: CodeBuddyRegion): ReturnType<CodeBuddyAuth['start']>;
    logout(region: CodeBuddyRegion): ReturnType<CodeBuddyAuth['logout']>;
    isModelDisabled(id: string, region?: CodeBuddyRegion): boolean;
    /** Whether the resolved model accepts images (drives whether pixels are sent). */
    private modelVision;
    /**
     * Resolve a feed's images into base64 for the CLI's vision blocks.
     *
     * Only references the host can actually read become pixels; the rest keep
     * their handle text, so one unreadable attachment degrades that part of the
     * prompt instead of failing the whole turn.
     */
    private resolveFeedImages;
    /**
     * Turn a feed into what one CLI turn receives.
     *
     * A text-only feed stays a plain string (the historical shape). A feed with
     * readable images becomes the SDK's `ContentBlock[]`, because that is the
     * only shape the CLI sends to the model as pixels.
     */
    private buildFeed;
    /**
     * The window this model actually runs with.
     *
     * The user's override only applies where the provider accepts one. Every
     * model in the current catalog reports `supportedLengths: null`, so the CLI
     * answers a `set_config.contextWindow` with `Allowed: <none>`; a stored
     * override would then make DSH show a denominator the upstream never uses,
     * which is exactly how the context ring drifted.
     */
    contextWindowFor(id: string, region?: CodeBuddyRegion): number | undefined;
    /** The catalog snapshot the adapter last read (empty before the first read). */
    private models;
    /** Whether this model lets the user pick a context budget at all. */
    supportsContextWindowChoice(id: string, region?: CodeBuddyRegion): boolean;
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo>;
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    private dispatch;
    private firstTurn;
    /**
     * The context window the host and the inner session must agree on.
     *
     * Only a model that offers selectable budgets is configured: one fixed
     * window rejects every value, so the CLI's own default already matches what
     * the host shows. For a model with choices the adapter sends the picked
     * value; returning to "default" sends the model's own default budget, since
     * the CLI rejects a null clear (`contextWindow must be a positive safe
     * integer`). The override lives for the life of the CLI process, so the
     * default has to be sent explicitly to drop a previous choice.
     */
    private windowOption;
    private cwdOf;
    close(): void;
}
