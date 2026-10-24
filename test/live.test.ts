/**
 * Regression guard for the "settings edits never apply" bug.
 *
 * Every config field of this plugin is `.volatile()`, and the loader commits
 * such an edit into the *running* plugin's config cells instead of restarting
 * it — `apply()` is not called again. The adapter therefore has to read each
 * value where it uses it; one that copies them into fields in its constructor
 * keeps serving mount-time config for the rest of the process, and the settings
 * page appears to save changes that never take effect.
 *
 * These tests reproduce the loader's commit precisely — validate a new raw
 * config through the plugin's own schema, then copy those values into the refs
 * the mounted plugin already holds — and assert the mounted adapter follows,
 * with no second `apply()`.
 */
import { updateVolatile } from '@deepseek-ai/cosmokit'
import { describe, expect, it } from 'vitest'
import {
  Config, QODER_INTL_PROVIDER, QODER_PROVIDER, apply, liveConfig, resolveConfig,
} from '../src/index.ts'

/**
 * Validate a raw config the way the loader does.
 *
 * `~standard.validate` answers `{ value, issues }`, and the value it returns is
 * the one whose fields are `Volatile` references.
 */
function parse(raw: Record<string, unknown>): Record<string, any> {
  const result = (Config as any)['~standard'].validate(raw)
  if (result.issues !== undefined) throw new Error(JSON.stringify(result.issues))
  return result.value
}

/** A plugin context that records what `apply()` registers. */
function stubContext() {
  const recorded = {
    routes: [] as string[],
    adapters: [] as any[],
    directory: [] as { provider: string, displayName: string }[],
    replaced: [] as unknown[],
    volatileListener: undefined as undefined | ((paths: readonly (readonly string[])[]) => void),
  }
  /**
   * A registration handle, as the real registry returns it: callable to
   * withdraw, with `replace` to swap contents in place.
   */
  const handle = (
    onReplace: (next: any) => void,
    onDispose: () => void,
  ) => {
    const disposer = Object.assign(() => { onDispose() }, {
      replace: (next: any) => { recorded.replaced.push(next); onReplace(next) },
    })
    return disposer
  }
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    llm: {
      registerAdapter: (providers: string[], adapter: unknown) => {
        let held = [...providers]
        recorded.routes.push(...providers)
        recorded.adapters.push(adapter)
        return handle(
          (next: string[]) => {
            recorded.routes = recorded.routes.filter(provider => !held.includes(provider))
            held = [...next]
            recorded.routes.push(...held)
          },
          () => { recorded.routes = recorded.routes.filter(provider => !held.includes(provider)) },
        )
      },
      registerConfigurableProviders: (entries: { provider: string, displayName: string }[]) => {
        let held = entries.map(entry => ({ ...entry }))
        recorded.directory = [...held]
        return handle(
          (next: { provider: string, displayName: string }[]) => {
            held = next.map(entry => ({ ...entry }))
            recorded.directory = [...held]
          },
          () => { recorded.directory = [] },
        )
      },
    },
    inject: () => {},
    effect: (fn: () => unknown) => fn(),
    on: (event: string, listener: any) => {
      if (event === 'loader/volatile-update') recorded.volatileListener = listener
    },
  }
  return { ctx, recorded }
}

describe('live config', () => {
  it('follows an in-place volatile commit without re-applying', () => {
    const mounted = parse({
      disabledModels: ['auto', 'qmodel_38max'],
      modelContextWindows: { auto: 200_000 },
      defaultMaxTokens: 32_000,
      displayName: 'Qoder CN',
    })
    const { ctx, recorded } = stubContext()
    apply(ctx as any, mounted as any)
    const adapter = recorded.adapters[0]

    // One route per edition, each with its own adapter and catalog.
    expect(recorded.routes).toEqual([QODER_PROVIDER, QODER_INTL_PROVIDER])
    expect(adapter.isModelDisabled('auto')).toBe(true)
    expect(adapter.contextWindowFor('auto')).toBe(200_000)

    // The write the settings page performs, as the loader commits it.
    const edited = parse({
      disabledModels: [],
      modelContextWindows: { auto: 200_000, qfmodel: 1_000_000 },
      defaultMaxTokens: 64_000,
      displayName: 'Qoder 工作号',
    })
    updateVolatile(mounted.disabledModels, edited.disabledModels)
    updateVolatile(mounted.modelContextWindows, edited.modelContextWindows)
    updateVolatile(mounted.defaultMaxTokens, edited.defaultMaxTokens)
    updateVolatile(mounted.displayName, edited.displayName)

    expect(adapter.disabledModelIds()).toEqual([])
    expect(adapter.isModelDisabled('auto')).toBe(false)
    expect(adapter.modelWindowChoices()).toEqual({ auto: 200_000, qfmodel: 1_000_000 })
    expect(adapter.providerInfo(QODER_PROVIDER).name).toBe('Qoder 工作号')
    expect(liveConfig(mounted).defaultMaxTokens()).toBe(64_000)
  })

  it('republishes the picker label only when the display name moves', () => {
    const mounted = parse({ displayName: 'Qoder CN' })
    const { ctx, recorded } = stubContext()
    apply(ctx as any, mounted as any)

    const edited = parse({ displayName: 'Qoder 工作号' })
    updateVolatile(mounted.displayName, edited.displayName)

    // The labels are republished through the directory handle, not by
    // re-registering: the provider set never changes any more.
    expect(recorded.directory.map(entry => entry.displayName)).toEqual(['Qoder CN', 'Qoder 国际版'])
    recorded.volatileListener?.([['displayName']])
    expect(recorded.directory.map(entry => entry.displayName)).toEqual(['Qoder 工作号', 'Qoder 国际版'])
    expect(recorded.routes).toEqual([QODER_PROVIDER, QODER_INTL_PROVIDER])

    recorded.replaced.length = 0
    recorded.volatileListener?.([['disabledModels']])
    expect(recorded.replaced).toEqual([])
  })

  it('registers only the editions that are switched on', () => {
    const mounted = parse({ cnEnabled: false, intlEnabled: true })
    const { ctx, recorded } = stubContext()
    apply(ctx as any, mounted as any)

    // Off means absent, not merely hidden: no route, no picker group.
    expect(recorded.routes).toEqual([QODER_INTL_PROVIDER])
    expect(recorded.directory.map(entry => entry.provider)).toEqual([QODER_INTL_PROVIDER])

    const both = parse({ cnEnabled: true, intlEnabled: true })
    updateVolatile(mounted.cnEnabled, both.cnEnabled)
    recorded.volatileListener?.([['cnEnabled']])
    expect([...recorded.routes].sort()).toEqual([QODER_INTL_PROVIDER, QODER_PROVIDER].sort())
    expect(recorded.directory.map(entry => entry.provider).sort())
      .toEqual([QODER_INTL_PROVIDER, QODER_PROVIDER].sort())

    const cnOnly = parse({ cnEnabled: true, intlEnabled: false })
    updateVolatile(mounted.intlEnabled, cnOnly.intlEnabled)
    recorded.volatileListener?.([['intlEnabled']])
    expect(recorded.routes).toEqual([QODER_PROVIDER])
    expect(recorded.directory.map(entry => entry.provider)).toEqual([QODER_PROVIDER])

    // Both off is a valid deployment: the plugin stays loaded with no routes.
    updateVolatile(mounted.cnEnabled, parse({ cnEnabled: false }).cnEnabled)
    recorded.volatileListener?.([['cnEnabled']])
    expect(recorded.routes).toEqual([])
    expect(recorded.directory).toEqual([])
  })

  it('keeps the two config views equivalent, including defaults', () => {
    const mounted = parse({ disabledModels: ['auto'], modelContextWindows: { auto: 1 } })
    const live = liveConfig(mounted)
    const snapshot = resolveConfig(mounted)

    expect({
      disabledModels: live.disabledModels(),
      modelContextWindows: live.modelContextWindows(),
      maxSessions: live.maxSessions(),
      defaultReasoningEffort: live.defaultReasoningEffort(),
    }).toEqual({
      disabledModels: snapshot.disabledModels,
      modelContextWindows: snapshot.modelContextWindows,
      maxSessions: snapshot.maxSessions,
      defaultReasoningEffort: snapshot.defaultReasoningEffort,
    })
  })

  it('runs on defaults when the profile row carries no config at all', () => {
    const live = liveConfig(undefined)
    expect(live.disabledModels()).toEqual([])
    expect(live.maxSessions()).toBe(8)
    expect(live.defaultReasoningEffort()).toBeUndefined()
    // Both editions are on unless the profile explicitly switches one off.
    expect(live.cnEnabled()).toBe(true)
    expect(live.intlEnabled()).toBe(true)
  })
})
