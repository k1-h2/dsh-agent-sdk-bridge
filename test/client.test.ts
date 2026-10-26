/**
 * The browser half, loaded without a browser.
 *
 * `client.js` is a hand-written ModuleLoader bundle with no build step, so it
 * can be evaluated against a stub `window` and a stub `react`: that reaches the
 * pure helpers and the two copy dictionaries. Two things are worth pinning.
 *
 * The credential countdown must never fall back to an absolute date. The
 * MiniMax CLI's OAuth access token lives about an hour and renews itself, so a
 * date always reads "today" and looks like a problem the user has to fix.
 *
 * The two dictionaries drift apart the moment a string is added to one of them:
 * a key missing from `en` renders its own name in the English UI, which no
 * server-side test would ever notice.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

interface PackageSummary {
  count: number
  total: number
  nearest?: number
}

interface ClientTestFace {
  zh: Record<string, string>
  en: Record<string, string>
  tokenExpiryText: (t: (key: string) => string, ms: unknown, now?: number) => string
  packageSummary: (packages: unknown) => PackageSummary
}

/** Evaluate the bundle the way the shell's loader does and take its test face. */
function loadClient(): ClientTestFace {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let loaded: { factory: (require: (id: string) => unknown) => Record<string, unknown> } | undefined
  const windowStub = {
    __ModuleLoader__: {
      load: (spec: typeof loaded) => { loaded = spec },
    },
  }
  new Function('window', source)(windowStub)
  if (loaded === undefined) throw new Error('client.js never registered with the module loader')
  // The factory destructures the hooks it uses, so the stub must carry them.
  const reactStub = {
    createElement: () => ({}),
    useState: () => undefined,
    useEffect: () => undefined,
    useCallback: () => undefined,
    useMemo: () => undefined,
    useRef: () => undefined,
    useSyncExternalStore: () => undefined,
  }
  const exports = loaded.factory(() => reactStub)
  return exports.__test as ClientTestFace
}

const client = loadClient()
const NOW = 1_800_000_000_000
const minutes = (count: number): number => NOW + count * 60_000

describe('client credential countdown', () => {
  it('counts a live token down in minutes', () => {
    const text = client.tokenExpiryText(key => client.zh[key] ?? key, minutes(58), NOW)
    expect(text).toBe('访问令牌剩余 58 分钟')
  })

  it('switches to hours once an hour remains', () => {
    const text = client.tokenExpiryText(key => client.zh[key] ?? key, minutes(90), NOW)
    expect(text).toBe('访问令牌剩余 1 小时')
  })

  it('reports a spent or unusable timestamp as expired, never as NaN', () => {
    const t = (key: string): string => client.zh[key] ?? key
    expect(client.tokenExpiryText(t, minutes(-1), NOW)).toBe('访问令牌已过期')
    expect(client.tokenExpiryText(t, 0, NOW)).toBe('访问令牌已过期')
    expect(client.tokenExpiryText(t, undefined, NOW)).toBe('访问令牌已过期')
    expect(client.tokenExpiryText(t, Number.NaN, NOW)).toBe('访问令牌已过期')
  })

  it('fills the placeholder in the English copy too', () => {
    const text = client.tokenExpiryText(key => client.en[key] ?? key, minutes(58), NOW)
    expect(text).toBe('Access token: 58 min left')
    expect(text).not.toContain('{n}')
  })

  it('never prints a calendar date for the access token', () => {
    // The old label was a date, which always read "expires today".
    expect(client.zh.minimaxExpires).toBeUndefined()
    expect(client.en.minimaxExpires).toBeUndefined()
    expect(client.zh.minimaxTokenRenew).toContain('自动续期')
  })
})

describe('client copy dictionaries', () => {
  it('keep the mainland and international key sets identical', () => {
    const zh = Object.keys(client.zh).sort()
    const en = Object.keys(client.en).sort()
    expect(en.filter(key => !zh.includes(key))).toEqual([])
    expect(zh.filter(key => !en.includes(key))).toEqual([])
    expect(zh.length).toBeGreaterThan(100)
  })

  it('carries no empty string that would render a blank control', () => {
    for (const [name, table] of [['zh', client.zh], ['en', client.en]] as const) {
      const empty = Object.entries(table).filter(([, value]) => value === '')
      expect(empty, name).toEqual([])
    }
  })
})

describe('CodeBuddy credit package summary', () => {
  it('summarizes every package instead of cutting the list at four', () => {
    const packages = Array.from({ length: 7 }, (_, index) => ({
      name: `包 ${index + 1}`,
      total: 100,
      used: 10,
      end: NOW + (index + 1) * 86_400_000,
    }))
    // The card used to render at most four packages without saying so; the
    // collapsed row now carries the true count and combined total.
    expect(client.packageSummary(packages)).toEqual({
      count: 7,
      total: 700,
      nearest: NOW + 86_400_000,
    })
  })

  it('ignores the never-expiring sentinel and falls back to the used figure', () => {
    const summary = client.packageSummary([
      { name: '永久', total: 50, end: 253_402_300_799_000 },
      { name: '按量', used: 25 },
    ])
    expect(summary.count).toBe(2)
    expect(summary.total).toBe(75)
    // Year 9999 is the endpoint's "no expiry"; it must not read as nearest.
    expect(summary.nearest).toBeUndefined()
  })

  it('treats a missing package list as empty', () => {
    expect(client.packageSummary(undefined)).toEqual({ count: 0, total: 0, nearest: undefined })
  })
})
