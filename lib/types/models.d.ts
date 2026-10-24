/**
 * Live model catalog retrieval from one edition's local Qoder CLI. One
 * short-lived inner session sends the SDK's `get_models` control request; the
 * response (including account-custom models) stays fresh for a TTL, concurrent
 * callers share one in-flight fetch, and the static CN catalog is the fallback
 * while that edition's CLI is unreachable.
 *
 * The CN and international editions publish different catalogs, so cache and
 * fallback are kept per brand: a list fetched from one account must never be
 * served to the other route.
 *
 * @module dsh-llm-qoder/models
 */
import type { ModelInfo } from '@qodercn-ai/qodercn-agent-sdk';
import type { QoderBrand } from './brand.ts';
import type { QoderCatalogModel } from './catalog.ts';
import type { Live } from './live.ts';
/** How long a fetched catalog stays fresh by default. */
export declare const DEFAULT_MODEL_CACHE_TTL_MS: number;
/** Give up on one CLI catalog fetch after this long by default. */
export declare const DEFAULT_FETCH_TIMEOUT_MS = 20000;
/** Cached live CLI catalog with a static fallback. */
export declare class QoderModelCatalog {
    private readonly brand;
    private readonly ttlMs;
    private readonly fetchTimeoutMs;
    private cached;
    private inflight;
    /** Why the last refresh failed, for the settings page's guidance. */
    private failure;
    /**
     * @param brand - which edition's CLI answers.
     * @param ttlMs - how long a fetched catalog stays fresh before a re-fetch.
     *   Read per use, so a settings edit takes effect on the next read.
     * @param fetchTimeoutMs - how long one CLI catalog fetch may take before the
     *   static fallback takes over.
     */
    constructor(brand: QoderBrand, ttlMs: Live<number>, fetchTimeoutMs?: Live<number>);
    /**
     * Raw live entries; the stale snapshot when a refresh fails, else nothing.
     *
     * Filtered to the subscription's official models here, so the picker and the
     * settings page cannot disagree about what the account has.
     */
    liveModels(): Promise<readonly ModelInfo[]>;
    /** Why the last refresh failed, or undefined when it succeeded. */
    get error(): string | undefined;
    /**
     * Drop the cached catalog so the next read goes back to the CLI.
     *
     * What the CLI answers depends on state this plugin does not own — whether it
     * is installed at all, and which account is signed in — and an empty answer is
     * cached like any other. So after the setup helper has run, the page's next
     * read must not be served from a snapshot taken before that login existed.
     */
    invalidate(): void;
    /** dsh catalog entries: the enabled live list, or the static fallback. */
    models(): Promise<readonly QoderCatalogModel[]>;
    private fetch;
}
/**
 * The credit multiplier upstream quotes for one model.
 *
 * Present on every live entry as `priceFactor`; `0` means the model is free.
 * Returned as a number rather than a formatted string so callers decide how to
 * render it.
 *
 * @param entry - one live catalog entry.
 * @returns the multiplier, or undefined when upstream did not quote one.
 */
export declare function priceFactorOf(entry: {
    priceFactor?: number;
}): number | undefined;
export declare function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T>;
