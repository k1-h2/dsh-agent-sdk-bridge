/**
 * Live model catalog retrieval from one edition's local Qoder CLI. One
 * short-lived inner session sends the SDK's `get_models` control request; the
 * response (including account-custom models) stays fresh for a TTL, concurrent
 * callers share one in-flight fetch, and the static CN catalog is a fallback
 * only while that edition's CLI is installed but cannot answer — never for an
 * account that answered with an empty list (see {@link emptyCatalogFallback}).
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
     * Bumped by {@link invalidate}. A fetch that started before a sign-in carries
     * the previous account's entries, so it must not republish them after the
     * cache was dropped for that account change.
     */
    private epoch;
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
    /**
     * The last successful live list, without fetching.
     *
     * The model picker resolves a route on every switch, and a switch must not
     * wait on a CLI cold start (up to the fetch timeout). Callers that need an
     * immediate answer read this and let {@link liveModels} refresh behind them;
     * `undefined` means nothing has been read yet, which only the first switch
     * has to wait for.
     */
    snapshot(): readonly ModelInfo[] | undefined;
    /** Why the last refresh failed, or undefined when it succeeded. */
    get error(): string | undefined;
    /**
     * Drop the cached catalog so the next read goes back to the CLI.
     *
     * What the CLI answers depends on state this plugin does not own — whether it
     * is installed at all, and which account is signed in — and an empty answer is
     * cached like any other. So after the setup helper has run, the page's next
     * read must not be served from a snapshot taken before that login existed.
     *
     * The remembered empty answer is deliberately kept: it says the account has
     * nothing, which a later failed read must not turn back into the static plan.
     */
    invalidate(): void;
    /** dsh catalog entries: the enabled live list, or the fallback {@link emptyCatalogFallback} allows. */
    models(): Promise<readonly QoderCatalogModel[]>;
    private fetch;
    private read;
}
/**
 * What the picker may show when the live catalogue came back empty.
 *
 * The captured CN plan is a stand-in for exactly one situation: this edition's
 * CLI is installed, and the catalogue could not be read because the CLI or the
 * network was unavailable. Two cases must stay empty:
 *
 * - The CLI answered. That is the account speaking — signed out, or a plan
 *   with no official models — and publishing the plan here is what put every
 *   Qoder CN model back into the picker after a sign-out, where selecting one
 *   could only fail. `getAvailableModels()` answers a *successful* empty list
 *   while signed out (its `cache` and `live` strategies included, even with a
 *   populated `~/.qoder-cn/.models`), so this is the ordinary sign-out path,
 *   not an edge case.
 * - The CLI is not installed at all, so none of those models could run.
 *
 * @param brand - which edition's catalogue is empty.
 * @param state - whether that edition's CLI is on the machine, and whether a
 *   successful read has ever produced an answer.
 */
export declare function emptyCatalogFallback(brand: QoderBrand, state: {
    cliInstalled: boolean;
    answered: boolean;
}): readonly QoderCatalogModel[];
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
