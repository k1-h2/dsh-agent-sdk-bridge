/**
 * The plugin's configuration surface.
 *
 * DSH's settings service reads a plugin's exported `Config` schema and, when no
 * custom page is registered for that entry, auto-generates a settings page from
 * it (`autoGenerate` defaults to true in `dsh-settings`). That makes this schema
 * the single source of truth for both runtime behaviour and the settings UI —
 * every field documented here appears as a labelled control, and its
 * `description` becomes the help text under it.
 *
 * Field order matters: the generated form renders in declaration order, so the
 * groups below are arranged the way a user reads them (identity → capacity →
 * context → timeouts → models → aliases).
 *
 * @module dsh-qoder-link/config
 */
import z from '@deepseek-ai/schemastery';
/**
 * The plugin configuration as authored in a profile patch.
 *
 * These are the values a user writes; at runtime every one of them arrives
 * wrapped in a `Volatile<T>` reference (see {@link ConfigSchema}), which
 * {@link resolveConfig} unwraps. Keep this interface as the authoring shape and
 * `ResolvedConfig` as the runtime shape.
 *
 * Every field is optional and defaulted, so an empty config — the profile row
 * DSH inserts by default — runs with the tuned defaults below.
 */
export interface Config {
    /**
     * Whether the Qoder CN edition is served at all.
     *
     * Off removes its provider route, its model group and its settings page. The
     * per-model choices are kept, so switching it back on restores the previous
     * configuration rather than resetting it.
     */
    cnEnabled?: boolean;
    /** Whether the international edition is served; same semantics as {@link cnEnabled}. */
    intlEnabled?: boolean;
    /**
     * Model ids the user switched OFF in the settings page.
     *
     * Stored as a deny-list rather than an allow-list so a newly published model
     * appears enabled by default: the account's catalog changes upstream, and a
     * stored allow-list would silently hide anything added after it was written.
     *
     * Ids are Qoder SDK values (e.g. `qmodel_38max`).
     */
    disabledModels?: string[];
    /**
     * Per-model context window in tokens, keyed by Qoder model id.
     *
     * A model with no entry uses the window upstream declares for it, which is
     * what its own session actually runs with. A larger value makes the request
     * use that window, but it also raises the harness's auto-compaction
     * threshold, so a conversation can grow past what the provider accepts
     * before compaction fires.
     */
    modelContextWindows?: Record<string, number>;
    /**
     * Extra aliases mapping a harness-side model id onto a Qoder SDK value,
     * merged over the built-in `deepseek-v4-*` ones.
     */
    modelAliases?: Record<string, string>;
    /**
     * Model ids the user switched OFF for the international edition.
     *
     * A separate list from the CN one on purpose: the two plans publish different
     * catalogs, and a shared deny-list would hide a model on one side because the
     * user happened to switch an unrelated id off on the other.
     */
    intlDisabledModels?: string[];
    /**
     * Per-model context window for the international edition, keyed by model id.
     */
    intlModelContextWindows?: Record<string, number>;
    /**
     * Extra model aliases for the international edition.
     */
    intlModelAliases?: Record<string, string>;
    /**
     * Display name of the international provider group in the model picker.
     */
    intlDisplayName?: string;
    /**
     * Display name of the primary provider group in the model picker.
     */
    displayName?: string;
    /**
     * How many warm inner Qoder CLI sessions to keep alive at once. One warm
     * session exists per DSH session id; beyond this cap the least recently used
     * one is closed. Each warm session is a subprocess.
     */
    maxSessions?: number;
    /**
     * Seconds a fetched CLI model catalog stays fresh before it is re-fetched.
     */
    modelCacheTtlSeconds?: number;
    /**
     * Reasoning effort used when a request names none. Empty uses upstream's own
     * default for the model.
     */
    defaultReasoningEffort?: string;
    /**
     * Output-token cap assumed when a model does not report one.
     */
    defaultMaxTokens?: number;
    /**
     * Fallback seconds for a tool handler that could not be paired with a host
     * call (no announced tool-use id to match a result against).
     *
     * Paired calls are not bounded by this: a host tool may run for minutes, so
     * they wait for the host request that carries their result and are settled at
     * that request boundary when it does not.
     */
    toolResultTimeoutSeconds?: number;
    /**
     * Seconds to wait for the CLI model catalog before using the static fallback.
     */
    catalogFetchTimeoutSeconds?: number;
    /**
     * Seconds to wait for the inner process to acknowledge an abort.
     */
    abortGraceSeconds?: number;
    /**
     * Maximum inner turns for one side-channel request (title, compaction).
     */
    coldMaxTurns?: number;
}
/**
 * The configuration schema. This is what DSH turns into the settings page, so
 * the defaults and bounds here are user-visible documentation.
 *
 * ## Why every field is `.volatile()`
 *
 * DSH's settings service builds its form from `volatileForm(schema)`, which
 * keeps a field ONLY when the node (or an ancestor) carries `meta.volatile`;
 * an object whose fields are all non-volatile collapses to `undefined` and the
 * whole namespace is dropped from `describe()` before any client sees it. A
 * plugin with a plain schema therefore registers successfully, streams models
 * correctly, and still shows no settings page anywhere — the namespace never
 * reaches the wire.
 *
 * ## What `.volatile()` costs: read every field at use
 *
 * A volatile-only edit does not restart the plugin. The loader writes the new
 * value into the *same* `Volatile` cell the running plugin already holds and
 * skips the rest of the update lifecycle, so `apply()` is never called again
 * (`Entry.update` → `_commitVolatile` in `cordis-plugin-loader`). Capturing a
 * field in `apply()` therefore freezes it for the lifetime of the process, and
 * the plugin answers with mount-time values while the settings page and the
 * profile patch on disk show the new ones.
 *
 * That is why the whole plugin consumes its config through {@link liveConfig},
 * which returns a thunk per field: the value is unwrapped from its volatile
 * reference at every read, so an in-place edit is visible immediately. See
 * `src/live.ts` for the full mechanism.
 */
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    cnEnabled: z<boolean, boolean, "volatile-defined">;
    intlEnabled: z<boolean, boolean, "volatile-defined">;
    disabledModels: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    modelContextWindows: z<NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, "volatile-defined">;
    intlDisabledModels: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    intlModelContextWindows: z<NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, "volatile-defined">;
    intlModelAliases: z<NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, "volatile-defined">;
    intlDisplayName: z<string, string, "volatile-defined">;
    displayName: z<string, string, "volatile-defined">;
    maxSessions: z<number, number, "volatile-defined">;
    modelCacheTtlSeconds: z<number, number, "volatile-defined">;
    modelAliases: z<NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, "volatile-defined">;
    defaultReasoningEffort: z<string, string, "volatile-defined">;
    defaultMaxTokens: z<number, number, "volatile-defined">;
    toolResultTimeoutSeconds: z<number, number, "volatile-defined">;
    catalogFetchTimeoutSeconds: z<number, number, "volatile-defined">;
    abortGraceSeconds: z<number, number, "volatile-defined">;
    coldMaxTurns: z<number, number, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    cnEnabled: z<boolean, boolean, "volatile-defined">;
    intlEnabled: z<boolean, boolean, "volatile-defined">;
    disabledModels: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    modelContextWindows: z<NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, "volatile-defined">;
    intlDisabledModels: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    intlModelContextWindows: z<NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, "volatile-defined">;
    intlModelAliases: z<NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, "volatile-defined">;
    intlDisplayName: z<string, string, "volatile-defined">;
    displayName: z<string, string, "volatile-defined">;
    maxSessions: z<number, number, "volatile-defined">;
    modelCacheTtlSeconds: z<number, number, "volatile-defined">;
    modelAliases: z<NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, "volatile-defined">;
    defaultReasoningEffort: z<string, string, "volatile-defined">;
    defaultMaxTokens: z<number, number, "volatile-defined">;
    toolResultTimeoutSeconds: z<number, number, "volatile-defined">;
    catalogFetchTimeoutSeconds: z<number, number, "volatile-defined">;
    abortGraceSeconds: z<number, number, "volatile-defined">;
    coldMaxTurns: z<number, number, "volatile-defined">;
}>>, "plain">;
/** Fully-resolved options with every default applied. */
export interface ResolvedConfig {
    cnEnabled: boolean;
    intlEnabled: boolean;
    displayName: string;
    maxSessions: number;
    modelCacheTtlMs: number;
    defaultMaxTokens: number;
    toolResultTimeoutMs: number;
    catalogFetchTimeoutMs: number;
    abortGraceMs: number;
    coldMaxTurns: number;
    disabledModels: readonly string[];
    modelContextWindows: Readonly<Record<string, number>>;
    modelAliases: Readonly<Record<string, string>>;
    defaultReasoningEffort: string | undefined;
    intlDisplayName: string;
    intlDisabledModels: readonly string[];
    intlModelContextWindows: Readonly<Record<string, number>>;
    intlModelAliases: Readonly<Record<string, string>>;
}
/**
 * A parsed config as it arrives at `apply()`: every field wrapped in the
 * `Volatile<T>` reference its `.volatile()` schema produces.
 *
 * Typed structurally rather than with `Volatile<T>` per field so the module
 * needs no import of the wrapper type, and so a plain (non-volatile) config
 * still satisfies it — which is what tests and direct callers pass.
 */
export type ParsedConfig = {
    readonly [K in keyof Config]?: unknown;
};
/**
 * {@link ResolvedConfig} with every field as a thunk over its live value.
 *
 * Structurally a resolved config, temporally a subscription: each property
 * reads the underlying `Volatile` cell when it is called, so a settings edit
 * that the loader commits in place is visible on the next read.
 */
export type LiveConfig = {
    readonly [K in keyof ResolvedConfig]: () => ResolvedConfig[K];
};
/**
 * Wrap a parsed config as {@link LiveConfig}.
 *
 * Every normalizer {@link resolveConfig} applies is applied here too — the live
 * wrapper is the same interpretation of the same raw fields, just deferred —
 * and `resolveConfig` is implemented on top of it, so the two can never
 * disagree about what a given input means.
 *
 * @param config - the parsed plugin config, possibly partial or absent.
 * @returns one thunk per resolved field, each reading the live cell.
 */
export declare function liveConfig(config: ParsedConfig | undefined): LiveConfig;
/**
 * Apply defaults to a parsed config.
 *
 * A one-shot snapshot of {@link liveConfig}, for a caller that genuinely wants
 * the values as they are right now (a report, a test) rather than a view that
 * keeps following edits. The running plugin does not use it: every option it
 * hands downstream is a thunk, so a volatile edit is never missed.
 *
 * @param config - the parsed plugin config, possibly partial.
 * @returns the same values with every default filled in.
 */
export declare function resolveConfig(config: ParsedConfig | undefined): ResolvedConfig;
