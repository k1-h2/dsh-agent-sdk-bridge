/**
 * Register a {@link QoderAdapter} for each subscription edition on `ctx.llm`:
 * `qoder-cn` backed by the official CN Agent SDK
 * (`@qodercn-ai/qodercn-agent-sdk`) and `qoder-intl` backed by the
 * international one (`@qoder-ai/qoder-agent-sdk`).
 *
 * Each edition's inner sessions ride on its own local CLI login state
 * (`qoderclicn` / `qodercli`), so no API key or credential entry is required:
 * the account's model catalog is fetched live from that CLI and split into the
 * account's built-in models and its custom ones. Everything a deployment may
 * want to tune — session pool size, context window, timeouts, model allow/deny
 * lists, aliases, and the same choices separately for the international
 * edition — is declared in {@link Config}, which DSH renders as this plugin's
 * settings pages.
 *
 * ## Settings edits apply without a restart, and that shapes this module
 *
 * Every config field is volatile, and DSH commits a volatile-only edit into the
 * running plugin's config cells instead of restarting it — `apply()` is not
 * called again. The adapter is therefore handed {@link liveConfig} thunks and
 * reads each value where it uses it; the only thing captured at mount is the
 * picker-directory registration (`directoryFor`), which is republished through
 * its `replace` handle when the display name changes.
 * See `src/live.ts` for the mechanism.
 *
 * @module dsh-qoder-link
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ServerResponse, IncomingMessage } from 'node:http';
import type { ParsedConfig } from './config.ts';
/**
 * The web carrier this plugin mounts its settings API on.
 *
 * Declared locally rather than imported from `@deepseek-ai/dsh-host-webserver`
 * so the plugin keeps only the peer dependencies it actually needs: a
 * deployment that boots without a web server must still load this plugin, and
 * an import of the carrier package would make it a hard requirement.
 */
interface WebServerService {
    register(route: {
        kind: 'exact' | 'prefix';
        path: string;
        handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
    }): () => void;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** Present only in web compositions; reached through a nested inject. */
        webServer?: WebServerService;
    }
    interface Events {
        /**
         * The loader committed a volatile-only config edit into this fiber.
         *
         * Emitted by `cordis-plugin-loader` from `Entry._commitVolatile` with the
         * config paths whose cells changed. The plugin does not restart for such an
         * edit, so this is the only notification that one happened; see
         * `src/live.ts`. Declared here because it is an internal loader event that
         * the framework's own `Events` interface does not carry.
         *
         * @param paths - one path array per committed field, e.g. `[['displayName']]`.
         */
        'loader/volatile-update'(paths: readonly (readonly string[])[]): void;
    }
}
export { QoderAdapter, QODER_PROVIDER, QODER_INTL_PROVIDER, cliContextWindow, pickContextWindow } from './adapter.ts';
export type { ImageRequestReader, QoderAdapterOptions } from './adapter.ts';
export { BRANDS, CN_BRAND, GLOBAL_BRAND, brandProfile } from './brand.ts';
export type { BrandProfile, QoderBrand } from './brand.ts';
export { loadSdk } from './sdk.ts';
export { QoderUsage, DEFAULT_USAGE_CACHE_TTL_MS, DEFAULT_USAGE_TIMEOUT_MS } from './usage.ts';
export type { UsageSnapshot } from './usage.ts';
export { QoderSession, QoderSessionManager, ToolResultPairing } from './session.ts';
export type { SessionModelPolicy, SessionRuntimeOptions } from './session.ts';
export { NARROW_CHARS_PER_TOKEN, WIDE_CHARS_PER_TOKEN, countWideChars, estimateTextTokens, isWideChar } from './tokens.ts';
export { QODER_MODELS, MODEL_ALIASES, resolveQoderModelId, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from './catalog.ts';
export { QoderModelCatalog, priceFactorOf } from './models.ts';
export { API_PREFIX, buildRows, handleApi } from './api.ts';
export { SCRIPT_NAME, isSetupMode, readSetupStatus, setupScriptPath, startSetup, stopSetup } from './setup.ts';
export type { SetupFailure, SetupMode, SetupStatus } from './setup.ts';
export type { Live } from './live.ts';
export { readLive, readLiveOptional } from './live.ts';
export { liveConfig, resolveConfig } from './config.ts';
export type { Config as ConfigShape, LiveConfig, ParsedConfig, ResolvedConfig, } from './config.ts';
/** Cordis plugin name; must match the `id` used by `cordis.patch.yml`. */
export declare const name = "llm-qoder-cn";
/** The LLM registry must exist before an adapter can be registered on it. */
export declare const inject: string[];
/**
 * The plugin's configuration schema, re-exported under the name the loader
 * looks for. DSH reads `runtime.Config` off the plugin fiber to build the
 * settings page, so this must stay the exported `Config` binding.
 *
 * Every field is `.volatile()`, which is what makes the namespace appear in
 * `settings.describe()` at all — see the note on {@link ConfigSchema}.
 */
export declare const Config: import("@deepseek-ai/schemastery").default<Schemastery.ObjectS<NoInfer<{
    cnEnabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "volatile-defined">;
    intlEnabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "volatile-defined">;
    disabledModels: import("@deepseek-ai/schemastery").default<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    modelContextWindows: import("@deepseek-ai/schemastery").default<NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, "volatile-defined">;
    intlDisabledModels: import("@deepseek-ai/schemastery").default<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    intlModelContextWindows: import("@deepseek-ai/schemastery").default<NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, "volatile-defined">;
    intlModelAliases: import("@deepseek-ai/schemastery").default<NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, "volatile-defined">;
    intlDisplayName: import("@deepseek-ai/schemastery").default<string, string, "volatile-defined">;
    displayName: import("@deepseek-ai/schemastery").default<string, string, "volatile-defined">;
    maxSessions: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
    modelCacheTtlSeconds: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
    modelAliases: import("@deepseek-ai/schemastery").default<NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, "volatile-defined">;
    defaultReasoningEffort: import("@deepseek-ai/schemastery").default<string, string, "volatile-defined">;
    defaultMaxTokens: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
    toolResultTimeoutSeconds: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
    catalogFetchTimeoutSeconds: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
    abortGraceSeconds: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
    coldMaxTurns: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    cnEnabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "volatile-defined">;
    intlEnabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "volatile-defined">;
    disabledModels: import("@deepseek-ai/schemastery").default<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    modelContextWindows: import("@deepseek-ai/schemastery").default<NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, "volatile-defined">;
    intlDisabledModels: import("@deepseek-ai/schemastery").default<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    intlModelContextWindows: import("@deepseek-ai/schemastery").default<NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, "volatile-defined">;
    intlModelAliases: import("@deepseek-ai/schemastery").default<NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, "volatile-defined">;
    intlDisplayName: import("@deepseek-ai/schemastery").default<string, string, "volatile-defined">;
    displayName: import("@deepseek-ai/schemastery").default<string, string, "volatile-defined">;
    maxSessions: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
    modelCacheTtlSeconds: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
    modelAliases: import("@deepseek-ai/schemastery").default<NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, "volatile-defined">;
    defaultReasoningEffort: import("@deepseek-ai/schemastery").default<string, string, "volatile-defined">;
    defaultMaxTokens: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
    toolResultTimeoutSeconds: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
    catalogFetchTimeoutSeconds: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
    abortGraceSeconds: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
    coldMaxTurns: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
}>>, "plain">;
/**
 * Mount the adapter for the lifetime of the plugin.
 *
 * @param ctx - the plugin's cordis context.
 * @param config - parsed plugin config, whose volatile fields arrive as
 *   references. {@link liveConfig} wraps them as thunks the adapter reads where
 *   it uses them, so an edit applies without this function running again; an
 *   empty object is a valid deployment.
 */
export declare function apply(ctx: Context, config: ParsedConfig): void;
