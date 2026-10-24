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
import type { Live } from './live.ts';
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
    disabledModels?: Live<readonly string[]>;
    modelContextWindows?: Live<Readonly<Record<string, number>>>;
    modelAliases?: Live<Readonly<Record<string, string>>>;
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
    private disabledCache;
    constructor(options?: CodeBuddyAdapterOptions);
    private get region();
    private get disabled();
    private get windows();
    private get aliases();
    private get displayName();
    providerInfo(provider: string): LlmProviderInfo;
    /** The live catalog, unfiltered (the page must show switched-off models). */
    describeCatalog(): Promise<readonly CodeBuddyModel[]>;
    /** Why the last catalog read failed, for the page's guidance. */
    catalogError(): string | undefined;
    invalidateCatalog(): void;
    /** The signed-in account, or the reason it could not be read. */
    usageInfo(fresh?: boolean): Promise<CodeBuddyUsageSnapshot>;
    invalidateUsage(): void;
    /** Login progress for one region; the page polls this. */
    authStatus(region: CodeBuddyRegion): ReturnType<CodeBuddyAuth['status']>;
    startLogin(region: CodeBuddyRegion): ReturnType<CodeBuddyAuth['start']>;
    logout(region: CodeBuddyRegion): ReturnType<CodeBuddyAuth['logout']>;
    isModelDisabled(id: string): boolean;
    contextWindowFor(id: string): number | undefined;
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo>;
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    private dispatch;
    private firstTurn;
    private cwdOf;
    close(): void;
}
