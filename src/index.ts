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

import type { Context } from '@deepseek-ai/cordis'
import type { ServerResponse, IncomingMessage } from 'node:http'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { QoderAdapter, QODER_PROVIDER, QODER_INTL_PROVIDER } from './adapter.ts'
import { API_PREFIX, handleApi } from './api.ts'
import type { QoderBrand } from './brand.ts'
import { BRANDS } from './brand.ts'
import { stopSetup } from './setup.ts'
import type { LiveConfig, ParsedConfig } from './config.ts'
import { Config as ConfigSchema, liveConfig } from './config.ts'

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
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Present only in web compositions; reached through a nested inject. */
    webServer?: WebServerService
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
    'loader/volatile-update'(paths: readonly (readonly string[])[]): void
  }
}

export { QoderAdapter, QODER_PROVIDER, QODER_INTL_PROVIDER, cliContextWindow, pickContextWindow } from './adapter.ts'
export type { ImageRequestReader, QoderAdapterOptions } from './adapter.ts'
export { BRANDS, CN_BRAND, GLOBAL_BRAND, brandProfile } from './brand.ts'
export type { BrandProfile, QoderBrand } from './brand.ts'
export { loadSdk } from './sdk.ts'
export { QoderUsage, DEFAULT_USAGE_CACHE_TTL_MS, DEFAULT_USAGE_TIMEOUT_MS } from './usage.ts'
export type { UsageSnapshot } from './usage.ts'
export { QoderSession, QoderSessionManager, ToolResultPairing } from './session.ts'
export type { SessionModelPolicy, SessionRuntimeOptions } from './session.ts'
export { NARROW_CHARS_PER_TOKEN, WIDE_CHARS_PER_TOKEN, countWideChars, estimateTextTokens, isWideChar } from './tokens.ts'
export { QODER_MODELS, MODEL_ALIASES, resolveQoderModelId, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from './catalog.ts'
export { QoderModelCatalog, priceFactorOf } from './models.ts'
export { API_PREFIX, buildRows, handleApi } from './api.ts'
export { SCRIPT_NAME, isSetupMode, readSetupStatus, setupScriptPath, startSetup, stopSetup } from './setup.ts'
export type { SetupFailure, SetupMode, SetupStatus } from './setup.ts'
export type { Live } from './live.ts'
export { readLive, readLiveOptional } from './live.ts'
export { liveConfig, resolveConfig } from './config.ts'
// The authoring shape is re-exported as `ConfigShape` because this module also
// exports the `Config` *schema* value the loader reads; one module cannot
// re-export a type and declare a value under the same name.
export type {
  Config as ConfigShape, LiveConfig, ParsedConfig, ResolvedConfig,
} from './config.ts'

/** Cordis plugin name; must match the `id` used by `cordis.patch.yml`. */
export const name = 'llm-qoder-cn'
/** The LLM registry must exist before an adapter can be registered on it. */
export const inject = ['llm']

/**
 * Configuration namespace: the profile entry id this plugin is mounted under.
 * The settings service and the configurable-provider directory both address the
 * plugin by this key, and the exported {@link ConfigSchema} is the form source,
 * so no page has to be registered by hand.
 */
const NS = 'llm-qoder-cn'

/** Encoded-byte ceiling for one forwarded request image, before base64 expansion. */
const REQUEST_IMAGE_MAX_BYTES = 1_048_576

/**
 * Config fields whose value decides a registration shape rather than a runtime
 * behaviour, and which therefore cannot be read lazily.
 *
 * The edition switches decide which routes exist at all; the two display names
 * are copied into the picker directory. Everything else is read where it is
 * used, so a change to these fields is the only thing that needs a republish.
 */
const STRUCTURAL_FIELDS: ReadonlySet<string> = new Set([
  'cnEnabled', 'intlEnabled', 'displayName', 'intlDisplayName',
])

/** The configurable-provider directory rows for the enabled editions. */
function directoryFor(live: LiveConfig): {
  provider: string
  displayName: string
  settingsNs: string
  settingsPath: string[]
}[] {
  const rows = []
  if (live.cnEnabled()) {
    rows.push({ provider: QODER_PROVIDER, displayName: live.displayName(), settingsNs: NS, settingsPath: [] })
  }
  if (live.intlEnabled()) {
    rows.push({ provider: QODER_INTL_PROVIDER, displayName: live.intlDisplayName(), settingsNs: NS, settingsPath: [] })
  }
  return rows
}

/**
 * The plugin's configuration schema, re-exported under the name the loader
 * looks for. DSH reads `runtime.Config` off the plugin fiber to build the
 * settings page, so this must stay the exported `Config` binding.
 *
 * Every field is `.volatile()`, which is what makes the namespace appear in
 * `settings.describe()` at all — see the note on {@link ConfigSchema}.
 */
export const Config = ConfigSchema

/**
 * Mount the adapter for the lifetime of the plugin.
 *
 * @param ctx - the plugin's cordis context.
 * @param config - parsed plugin config, whose volatile fields arrive as
 *   references. {@link liveConfig} wraps them as thunks the adapter reads where
 *   it uses them, so an edit applies without this function running again; an
 *   empty object is a valid deployment.
 */
export function apply(ctx: Context, config: ParsedConfig): void {
  // Every field is read through this view rather than snapshotted, because a
  // volatile-only edit updates the config cells in place and never re-runs
  // `apply()` — see `live.ts`. A single resolved value taken here would be the
  // plugin's answer for the rest of the process lifetime.
  const live = liveConfig(config)
  let attachments: AttachmentStore | undefined

  /**
   * Everything both editions share.
   *
   * Images reach the inner model only through the host attachment store, so
   * this stays a lazy lookup. An unmounted store leaves the adapter with no
   * reader, and images degrade to the harness's own handle text instead of
   * failing the turn — which is also why `attachments` is not a hard inject:
   * the provider routes must register even on a deployment without one.
   */
  const shared = {
    maxSessions: live.maxSessions,
    modelCacheTtlMs: live.modelCacheTtlMs,
    toolResultTimeoutMs: live.toolResultTimeoutMs,
    abortGraceMs: live.abortGraceMs,
    coldMaxTurns: live.coldMaxTurns,
    catalogFetchTimeoutMs: live.catalogFetchTimeoutMs,
    defaultMaxTokens: live.defaultMaxTokens,
    defaultReasoningEffort: live.defaultReasoningEffort,
    readImage: (ref: ImageAttachmentRef, signal?: AbortSignal) => {
      const store = attachments
      if (store === undefined) return Promise.resolve(undefined)
      // Ask for the attachment's own dimensions: the host already normalized
      // it, so only the byte ceiling binds the request version.
      return store.readImageRequest(ref, { width: ref.width, height: ref.height, maxBytes: REQUEST_IMAGE_MAX_BYTES }, signal)
        .then(image => ({ bytes: image.data, mediaType: image.mediaType }))
    },
  }

  /**
   * One adapter per edition.
   *
   * Two instances, not one instance on two routes: each carries its own model
   * catalog, warm-session pool, quota reading and user choices, so an intl
   * request can never be resolved against a CN catalog or share a CN session.
   */
  const adapters: Record<QoderBrand, QoderAdapter> = {
    cn: new QoderAdapter({
      ...shared,
      brand: 'cn',
      displayName: live.displayName,
      disabledModels: live.disabledModels,
      modelContextWindows: live.modelContextWindows,
      modelAliases: live.modelAliases,
    }),
    global: new QoderAdapter({
      ...shared,
      brand: 'global',
      displayName: live.intlDisplayName,
      disabledModels: live.intlDisabledModels,
      modelContextWindows: live.intlModelContextWindows,
      modelAliases: live.intlModelAliases,
    }),
  }

  ctx.inject(['attachments'], (scope) => {
    attachments = scope.attachments
    scope.effect(() => () => { attachments = undefined }, 'llm-qoder-cn.attachments')
  })

  // Routes and the provider directory are the two shapes a live value cannot
  // reach on its own: which provider ids exist, and the labels the selection
  // surfaces render. A disabled edition must own neither, so both are kept in
  // step with the switches rather than registered once for the process lifetime.
  const routes: Partial<Record<QoderBrand, () => void>> = {}
  let directory: ReturnType<typeof ctx.llm.registerConfigurableProviders> | undefined

  /**
   * Bring the registered routes and the picker directory in line with the
   * current switches and labels.
   *
   * `registerAdapter` refuses an empty provider list, which is why a disabled
   * edition is *not registered* instead of being registered and then hidden:
   * the route itself has to disappear so no request can reach it and no model
   * list is offered for it. Turning it back on registers a fresh handle.
   */
  const syncRegistration = (): void => {
    for (const brand of BRANDS) {
      const enabled = brand.id === 'cn' ? live.cnEnabled() : live.intlEnabled()
      const current = routes[brand.id]
      if (enabled && current === undefined) {
        routes[brand.id] = ctx.llm.registerAdapter([brand.provider], adapters[brand.id])
      } else if (!enabled && current !== undefined) {
        current()
        delete routes[brand.id]
      }
    }
    const entries = directoryFor(live)
    if (entries.length === 0) {
      directory?.()
      directory = undefined
    } else if (directory === undefined) {
      directory = ctx.llm.registerConfigurableProviders(entries)
    } else {
      directory.replace(entries)
    }
  }

  syncRegistration()

  /**
   * React to a structural config edit.
   *
   * A volatile-only edit does not re-run `apply()`, so this is the only place
   * the route set, the picker labels and the enabled editions can follow it.
   */
  ctx.on('loader/volatile-update', (paths: readonly (readonly string[])[]) => {
    if (!paths.some(path => STRUCTURAL_FIELDS.has(String(path[0])))) return
    try {
      syncRegistration()
    } catch (error) {
      ctx.logger?.warn(`llm-qoder-cn: 重新发布模型分组失败：${String(error)}`)
    }
  })

  // registerAdapter's disposer only withdraws the routes; the warm qodercli
  // subprocesses are owned by the adapters and must close with the plugin.
  ctx.effect(() => () => {
    adapters.cn.close()
    adapters.global.close()
  }, 'llm-qoder-cn.sessions')

  // A CLI helper still running when this plugin is reloaded or removed would
  // otherwise keep writing into a page that can no longer read it.
  ctx.effect(() => () => stopSetup(), 'llm-qoder-cn.setup')

  // The settings page's data source: the live catalog joined with the user's
  // on/off and window choices. Served from its own route because the catalog
  // comes from the CLI and cannot ride the config form.
  //
  // `webServer` publishes after plugin load, so this pends on a nested fiber
  // rather than reading the service at apply time — a `ctx.get('webServer')`
  // here answers undefined in a real web composition.
  ctx.inject(['webServer'], (scope) => {
    const server = scope.webServer
    if (server === undefined) return
    scope.effect(
      () => server.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: (req, res) => { void handleApi(req, res, adapters) },
      }),
      'llm-qoder-cn: settings api',
    )
    ctx.logger?.info(`llm-qoder-cn: 设置接口已挂载于 ${API_PREFIX}`)
  })
}
