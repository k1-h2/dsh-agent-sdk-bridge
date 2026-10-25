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
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { MinimaxRegion } from './brand.ts';
import { MinimaxAuth } from './minimax.ts';
import type { MinimaxModel, MinimaxUsageSnapshot } from './minimax.ts';
import type { Live } from './live.ts';
/** The MiniMax Code provider route. */
export declare const MINIMAX_PROVIDER = "minimax-acp";
/** Everything the adapter reads lazily from the plugin config. */
export interface MinimaxAdapterOptions {
    maxSessions?: Live<number>;
    modelCacheTtlMs?: Live<number>;
    catalogFetchTimeoutMs?: Live<number>;
    toolResultTimeoutMs?: Live<number>;
    abortGraceMs?: Live<number>;
    defaultMaxTokens?: Live<number>;
    defaultReasoningEffort?: Live<string | undefined>;
    displayName?: Live<string>;
    region?: Live<MinimaxRegion>;
    /** Per-region deny-lists; the page edits each region's list separately. */
    disabledModels?: (region: MinimaxRegion) => readonly string[];
    /** Per-region context-window overrides, keyed by model id. */
    modelContextWindows?: (region: MinimaxRegion) => Readonly<Record<string, number>>;
    modelAliases?: Live<Readonly<Record<string, string>>>;
}
/** Map a harness-side id onto an ACP model value. */
export declare function resolveMinimaxModelId(model: string, aliases?: Readonly<Record<string, string>>): string;
/** The MiniMax Code-backed adapter. */
export declare class MinimaxAdapter extends LlmAdapter {
    private readonly options;
    private readonly sessions;
    private readonly catalog;
    private readonly auth;
    private readonly mcpServer;
    private readonly disabledCache;
    constructor(options?: MinimaxAdapterOptions);
    private get region();
    private disabledFor;
    private get aliases();
    private get displayName();
    providerInfo(provider: string): LlmProviderInfo;
    /** The live catalog, unfiltered (the page must show switched-off models). */
    describeCatalog(region?: MinimaxRegion): Promise<readonly MinimaxModel[]>;
    /** Whether the region's endpoints are refusing this machine's network. */
    regionBlocked(region?: MinimaxRegion): boolean;
    /** Whether the selected (or given) region has a stored login. */
    isSignedIn(region?: MinimaxRegion): boolean;
    /** Why the last catalog read failed, for the page's guidance. */
    catalogError(region?: MinimaxRegion): string | undefined;
    invalidateCatalog(region?: MinimaxRegion): void;
    /** Login status, installer state and (when signed in) the account's quota. */
    usageInfo(fresh?: boolean, region?: MinimaxRegion): Promise<MinimaxUsageSnapshot>;
    /** Drop cached quota readings (after a login, logout or CLI change). */
    invalidateUsage(region?: MinimaxRegion): void;
    /** Login progress for one region; the page polls this. */
    authStatus(region: MinimaxRegion): ReturnType<MinimaxAuth['status']>;
    startLogin(region: MinimaxRegion): ReturnType<MinimaxAuth['start']>;
    logout(region: MinimaxRegion): ReturnType<MinimaxAuth['logout']>;
    isModelDisabled(id: string, region?: MinimaxRegion): boolean;
    contextWindowFor(id: string, region?: MinimaxRegion): number | undefined;
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo>;
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    private dispatch;
    private firstTurn;
    private cwdOf;
    close(): void;
}
