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

import { isVolatile } from '@deepseek-ai/cosmokit'
import z from '@deepseek-ai/schemastery'

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
  // ── Editions: which settings pages exist ────────────────────────────────
  /**
   * Whether the Qoder CN edition is served at all.
   *
   * Off removes its provider route, its model group and its settings page. The
   * per-model choices are kept, so switching it back on restores the previous
   * configuration rather than resetting it.
   */
  cnEnabled?: boolean
  /** Whether the international edition is served; same semantics as {@link cnEnabled}. */
  intlEnabled?: boolean

  // ── Models: the only settings most users touch ──────────────────────────
  /**
   * Model ids the user switched OFF in the settings page.
   *
   * Stored as a deny-list rather than an allow-list so a newly published model
   * appears enabled by default: the account's catalog changes upstream, and a
   * stored allow-list would silently hide anything added after it was written.
   *
   * Ids are Qoder SDK values (e.g. `qmodel_38max`).
   */
  disabledModels?: string[]
  /**
   * Per-model context window in tokens, keyed by Qoder model id.
   *
   * A model with no entry uses the window upstream declares for it, which is
   * what its own session actually runs with. A larger value makes the request
   * use that window, but it also raises the harness's auto-compaction
   * threshold, so a conversation can grow past what the provider accepts
   * before compaction fires.
   */
  modelContextWindows?: Record<string, number>
  /**
   * Extra aliases mapping a harness-side model id onto a Qoder SDK value,
   * merged over the built-in `deepseek-v4-*` ones.
   */
  modelAliases?: Record<string, string>

  // ── International edition ───────────────────────────────────────────────
  /**
   * Model ids the user switched OFF for the international edition.
   *
   * A separate list from the CN one on purpose: the two plans publish different
   * catalogs, and a shared deny-list would hide a model on one side because the
   * user happened to switch an unrelated id off on the other.
   */
  intlDisabledModels?: string[]
  /**
   * Per-model context window for the international edition, keyed by model id.
   */
  intlModelContextWindows?: Record<string, number>
  /**
   * Extra model aliases for the international edition.
   */
  intlModelAliases?: Record<string, string>
  /**
   * Display name of the international provider group in the model picker.
   */
  intlDisplayName?: string

  // ── Advanced: sensible defaults, rarely changed ─────────────────────────
  /**
   * Display name of the primary provider group in the model picker.
   */
  displayName?: string
  /**
   * How many warm inner Qoder CLI sessions to keep alive at once. One warm
   * session exists per DSH session id; beyond this cap the least recently used
   * one is closed. Each warm session is a subprocess.
   */
  maxSessions?: number
  /**
   * Seconds a fetched CLI model catalog stays fresh before it is re-fetched.
   */
  modelCacheTtlSeconds?: number
  /**
   * Reasoning effort used when a request names none. Empty uses upstream's own
   * default for the model.
   */
  defaultReasoningEffort?: string
  /**
   * Output-token cap assumed when a model does not report one.
   */
  defaultMaxTokens?: number
  /**
   * Fallback seconds for a tool handler that could not be paired with a host
   * call (no announced tool-use id to match a result against).
   *
   * Paired calls are not bounded by this: a host tool may run for minutes, so
   * they wait for the host request that carries their result and are settled at
   * that request boundary when it does not.
   */
  toolResultTimeoutSeconds?: number
  /**
   * Seconds to wait for the CLI model catalog before using the static fallback.
   */
  catalogFetchTimeoutSeconds?: number
  /**
   * Seconds to wait for the inner process to acknowledge an abort.
   */
  abortGraceSeconds?: number
  /**
   * Maximum inner turns for one side-channel request (title, compaction).
   */
  coldMaxTurns?: number
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
export const Config = z.object({
  // ── 版本开关：控制哪个设置页与模型分组存在 ─────────────────────────────
  cnEnabled: z.boolean().default(true).description('启用 Qoder CN。关闭后该设置页、模型列表与 provider 路由都会移除；已保存的模型选择会保留。').volatile(),
  intlEnabled: z.boolean().default(true).description('启用 Qoder 国际版。关闭后该设置页、模型列表与 provider 路由都会移除；已保存的模型选择会保留。').volatile(),

  // ── Models: the only settings most users touch ──────────────────────────
  // These two are the model page's data source. The settings page renders the
  // live catalog with a switch per model and a window choice per model, and
  // writes back through these fields.
  disabledModels: z.array(z.string()).default([]).description('已关闭的模型 ID 列表（以 Qoder 模型 ID 为准）。关闭的模型不会出现在模型选择器里。').volatile(),
  modelContextWindows: z.dict(z.number()).default({}).description('按模型指定上下文窗口（token 数）。未指定的模型使用上游声明的窗口。').volatile(),

  // ── 国际版：与 CN 账户独立 ─────────────────────────────────────────────
  intlDisabledModels: z.array(z.string()).default([]).description('国际版已关闭的模型 ID 列表。与 CN 列表分开，因为两边的模型目录不同。').volatile(),
  intlModelContextWindows: z.dict(z.number()).default({}).description('国际版按模型指定的上下文窗口（token 数）。').volatile(),
  intlModelAliases: z.dict(z.string()).default({}).description('国际版额外的模型别名映射：DSH 侧名称 → Qoder 模型 ID。').volatile(),
  intlDisplayName: z.string().default('Qoder 国际版').description('模型选择器里国际版分组的名称。').volatile(),

  // ── 高级：一般无需改动 ─────────────────────────────────────────────────
  displayName: z.string().default('Qoder CN').description('模型选择器里主分组的名称。同时使用多个 Qoder 账号时可区分。').volatile(),
  maxSessions: z.number().step(1).min(1).max(64).default(8).description('同时保持的内层会话数上限，超出后按最久未使用关闭。每个会话是一个子进程。').volatile(),
  modelCacheTtlSeconds: z.number().step(1).min(10).max(86_400).default(300).description('模型列表缓存时长（秒）。调小可更快看到账号侧变化。').volatile(),
  modelAliases: z.dict(z.string()).default({}).description('额外的模型别名映射：DSH 侧名称 → Qoder 模型 ID。内置 deepseek-v4-* 别名仍然生效。').volatile(),
  defaultReasoningEffort: z.string().default('').description('请求未指定思考档位时使用的默认档位；留空则用上游默认。').volatile(),
  defaultMaxTokens: z.number().step(1).min(1).default(32_000).description('模型未声明输出上限时使用的输出上限。').volatile(),
  toolResultTimeoutSeconds: z.number().step(1).min(5).max(3_600).default(120).description('仅用于未配对 handler 的兜底时限（秒）：正常工具调用会等宿主下一次请求携带结果，不按此超时。').volatile(),
  catalogFetchTimeoutSeconds: z.number().step(1).min(1).max(300).default(20).description('拉取模型列表的时限（秒），超时后回退到内置列表。').volatile(),
  abortGraceSeconds: z.number().step(1).min(1).max(120).default(5).description('内层进程确认中断的宽限时间（秒）。').volatile(),
  coldMaxTurns: z.number().step(1).min(1).max(32).default(4).description('旁路请求（生成标题、压缩摘要）允许的最大内层轮次。').volatile(),
})

/** Fully-resolved options with every default applied. */
export interface ResolvedConfig {
  cnEnabled: boolean
  intlEnabled: boolean
  displayName: string
  maxSessions: number
  modelCacheTtlMs: number
  defaultMaxTokens: number
  toolResultTimeoutMs: number
  catalogFetchTimeoutMs: number
  abortGraceMs: number
  coldMaxTurns: number
  disabledModels: readonly string[]
  modelContextWindows: Readonly<Record<string, number>>
  modelAliases: Readonly<Record<string, string>>
  defaultReasoningEffort: string | undefined
  intlDisplayName: string
  intlDisabledModels: readonly string[]
  intlModelContextWindows: Readonly<Record<string, number>>
  intlModelAliases: Readonly<Record<string, string>>
}

/**
 * A parsed config as it arrives at `apply()`: every field wrapped in the
 * `Volatile<T>` reference its `.volatile()` schema produces.
 *
 * Typed structurally rather than with `Volatile<T>` per field so the module
 * needs no import of the wrapper type, and so a plain (non-volatile) config
 * still satisfies it — which is what tests and direct callers pass.
 */
export type ParsedConfig = { readonly [K in keyof Config]?: unknown }

/**
 * {@link ResolvedConfig} with every field as a thunk over its live value.
 *
 * Structurally a resolved config, temporally a subscription: each property
 * reads the underlying `Volatile` cell when it is called, so a settings edit
 * that the loader commits in place is visible on the next read.
 */
export type LiveConfig = { readonly [K in keyof ResolvedConfig]: () => ResolvedConfig[K] }

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
export function liveConfig(config: ParsedConfig | undefined): LiveConfig {
  const source = (config ?? {}) as Record<string, unknown>

  /**
   * One field's current value.
   *
   * The volatile unwrap happens on every call rather than once, which is the
   * entire point: the reference object outlives an edit, only its contents
   * change.
   */
  const field = (key: keyof Config): unknown => {
    const value = source[key]
    return isVolatile(value) ? value.get() : value
  }

  return {
    cnEnabled: () => bool(field('cnEnabled'), true),
    intlEnabled: () => bool(field('intlEnabled'), true),
    displayName: () => nonEmpty(field('displayName'), 'Qoder CN'),
    maxSessions: () => positive(field('maxSessions'), 8),
    modelCacheTtlMs: () => positive(field('modelCacheTtlSeconds'), 300) * 1_000,
    defaultMaxTokens: () => positive(field('defaultMaxTokens'), 32_000),
    toolResultTimeoutMs: () => positive(field('toolResultTimeoutSeconds'), 120) * 1_000,
    catalogFetchTimeoutMs: () => positive(field('catalogFetchTimeoutSeconds'), 20) * 1_000,
    abortGraceMs: () => positive(field('abortGraceSeconds'), 5) * 1_000,
    coldMaxTurns: () => positive(field('coldMaxTurns'), 4),
    disabledModels: () => stringList(field('disabledModels')),
    modelContextWindows: () => numberMap(field('modelContextWindows')),
    modelAliases: () => stringMap(field('modelAliases')),
    defaultReasoningEffort: () => {
      const raw = field('defaultReasoningEffort')
      const effort = typeof raw === 'string' ? raw.trim() : ''
      return effort.length > 0 ? effort : undefined
    },
    intlDisplayName: () => nonEmpty(field('intlDisplayName'), 'Qoder 国际版'),
    intlDisabledModels: () => stringList(field('intlDisabledModels')),
    intlModelContextWindows: () => numberMap(field('intlModelContextWindows')),
    intlModelAliases: () => stringMap(field('intlModelAliases')),
  }
}

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
export function resolveConfig(config: ParsedConfig | undefined): ResolvedConfig {
  const live = liveConfig(config)
  return {
    cnEnabled: live.cnEnabled(),
    intlEnabled: live.intlEnabled(),
    displayName: live.displayName(),
    maxSessions: live.maxSessions(),
    modelCacheTtlMs: live.modelCacheTtlMs(),
    defaultMaxTokens: live.defaultMaxTokens(),
    toolResultTimeoutMs: live.toolResultTimeoutMs(),
    catalogFetchTimeoutMs: live.catalogFetchTimeoutMs(),
    abortGraceMs: live.abortGraceMs(),
    coldMaxTurns: live.coldMaxTurns(),
    disabledModels: live.disabledModels(),
    modelContextWindows: live.modelContextWindows(),
    modelAliases: live.modelAliases(),
    defaultReasoningEffort: live.defaultReasoningEffort(),
    intlDisplayName: live.intlDisplayName(),
    intlDisabledModels: live.intlDisabledModels(),
    intlModelContextWindows: live.intlModelContextWindows(),
    intlModelAliases: live.intlModelAliases(),
  }
}

function nonEmpty(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
}

function positive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/** A boolean with a default for a value the form has not supplied yet. */
function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function stringList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map(entry => entry.trim())
}

/**
 * Keep only the positive, finite entries of a map.
 *
 * A window of zero or a negative number would be passed straight to the
 * harness as a capacity, so invalid entries are dropped here rather than
 * rejected — one bad row must not discard the user's other choices.
 */
function numberMap(value: unknown): Readonly<Record<string, number>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, number> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'number' && Number.isFinite(entry) && entry > 0) out[key] = entry
  }
  return out
}

function stringMap(value: unknown): Readonly<Record<string, string>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string' && entry.trim().length > 0) out[key] = entry.trim()
  }
  return out
}
