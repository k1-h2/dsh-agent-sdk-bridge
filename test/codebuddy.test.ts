/**
 * CodeBuddy's catalog mapping and region routing.
 *
 * The SDK exposes richer raw entries than the Qoder one; these cases pin the
 * mapping the settings page and the adapter depend on, plus the two public
 * login regions (enterprise environments are deliberately not offered).
 */
import { describe, expect, it } from 'vitest'
import { codeBuddyEnvironment, isCodeBuddyRegion } from '../src/brand.ts'
import { resolveCodeBuddyModelId } from '../src/codebuddy-adapter.ts'
import { fetchCodeBuddyQuota, parseCodeBuddyQuota, toCodeBuddyModel } from '../src/codebuddy.ts'

describe('CodeBuddy model mapping', () => {
  it('reads windows, vision, reasoning and the quoted credit multiplier', () => {
    const model = toCodeBuddyModel({
      id: 'glm-5.3',
      name: 'GLM-5.3',
      descriptionZh: '旗舰模型',
      maxInputTokens: 1_000_000,
      maxOutputTokens: 64_000,
      supportsImages: true,
      supportsReasoning: true,
      credits: 'x0.79 credits',
      contextWindow: { supportedLengths: [200_000, 400_000], defaultLength: 1_000_000 },
      reasoning: { supportedEfforts: ['low', 'high'], defaultEffort: 'high' },
    })
    expect(model).toMatchObject({
      id: 'glm-5.3',
      name: 'GLM-5.3',
      description: '旗舰模型',
      // Only the declared selectable budgets. The default window (1M) is what
      // the model runs with, not a menu entry: the CLI rejects any override
      // outside `supportedLengths` with `Allowed: <none>`.
      contextWindows: [200_000, 400_000],
      defaultContextWindow: 1_000_000,
      vision: true,
      reasoningEfforts: ['low', 'high'],
      defaultEffort: 'high',
      priceFactor: 0.79,
    })
  })

  it('falls back to the input window and hides multimodal for a text model', () => {
    const model = toCodeBuddyModel({
      id: 'text-model',
      maxInputTokens: 128_000,
      supportsImages: true,
      disabledMultimodal: true,
      credits: 'x0.00 credits',
    })
    expect(model.defaultContextWindow).toBe(128_000)
    // No declared budgets: this model runs at one fixed window upstream.
    expect(model.contextWindows).toEqual([])
    expect(model.vision).toBe(false)
    expect(model.priceFactor).toBe(0)
    expect(model.name).toBe('text-model')
  })

  it('offers no window choice for a model the provider pins to one budget', () => {
    // Every model in the current CodeBuddy catalog reports supportedLengths
    // null; the CLI then answers `set_config.contextWindow` with
    // `Invalid context_window value … Allowed: <none>`.
    const model = toCodeBuddyModel({ id: 'deepseek-v4.1-flash', maxInputTokens: 1_000_000 })
    expect(model.contextWindows).toEqual([])
    expect(model.defaultContextWindow).toBe(1_000_000)
  })

  it('reports the budget the session runs at, not the physical limit', () => {
    // The global catalog's `deepseek-v4.1-flash`: supportedLengths [300K, 1M]
    // with a 300K defaultLength. The CLI resolves a session budget of 300K —
    // its compaction trigger is 276000 and the gateway refuses anything past
    // it — while `maxInputTokens` is 1M. Reporting the physical limit left the
    // host showing (and feeding) a history the session could never hold.
    const model = toCodeBuddyModel({
      id: 'deepseek-v4.1-flash',
      maxInputTokens: 1_000_000,
      maxAllowedSize: 1_000_000,
      contextWindow: { supportedLengths: [300_000, 1_000_000], defaultLength: 300_000 },
    })
    expect(model.defaultContextWindow).toBe(300_000)
    expect(model.contextWindows).toEqual([300_000, 1_000_000])
  })
})

describe('CodeBuddy model ids', () => {
  it('honours configured aliases and the codebuddy- prefix', () => {
    expect(resolveCodeBuddyModelId('fast', { fast: 'fast-model' })).toBe('fast-model')
    expect(resolveCodeBuddyModelId('codebuddy-glm-5.3')).toBe('glm-5.3')
    expect(resolveCodeBuddyModelId('glm-5.3')).toBe('glm-5.3')
  })

  it('falls back to the SDK default rather than an empty id', () => {
    expect(resolveCodeBuddyModelId('')).toBe('default-model')
    expect(resolveCodeBuddyModelId('codebuddy-')).toBe('default-model')
  })
})

describe('CodeBuddy login regions', () => {
  it('maps the two public regions to the SDK environments', () => {
    expect(codeBuddyEnvironment('global')).toBe('external')
    expect(codeBuddyEnvironment('cn')).toBe('internal')
  })

  it('excludes enterprise environments', () => {
    for (const value of ['ioa', 'cloudhosted', 'selfhosted', 'internal', 'external', undefined]) {
      expect(isCodeBuddyRegion(value)).toBe(false)
    }
  })
})

describe('CodeBuddy quota response', () => {
  const payload = {
    code: 0,
    data: {
      Response: {
        Data: {
          // Stale period figure; the parser must ignore it.
          TotalDosage: 999,
          Accounts: [
            {
              Status: 0,
              PackageName: '个人体验版',
              CycleEndTime: '2099-01-01 00:00:00',
              CycleCapacitySize: 100,
              CycleCapacityRemain: 60,
              CycleCapacitySizePrecise: '100',
              CycleCapacityRemainPrecise: '60.5',
            },
            {
              Status: 1,
              PackageName: '已失效',
              CycleCapacitySizePrecise: '500',
              CycleCapacityRemainPrecise: '500',
            },
            { Status: 0, CycleCapacitySizePrecise: '0' },
          ],
        },
      },
    },
  }

  it('sums live precise balances and keeps package expiry', () => {
    const quota = parseCodeBuddyQuota(payload)
    expect(quota.total).toBe(100)
    expect(quota.remaining).toBe(60.5)
    expect(quota.used).toBe(39.5)
    expect(quota.packages).toHaveLength(1)
    expect(quota.packages[0]).toMatchObject({ name: '个人体验版', total: 100, used: 39.5 })
    expect(quota.cycleEnd).toBeGreaterThan(Date.now())
  })

  it('surfaces an upstream business error instead of reporting zero', () => {
    expect(() => parseCodeBuddyQuota({
      data: { Response: { Error: { Code: 'InvalidParameterValue', Message: 'bad product code' } } },
    })).toThrow(/InvalidParameterValue/)
  })

  it('posts the account-page payload to the region host with the bearer token', async () => {
    let seen: { url?: string, init?: RequestInit } = {}
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), init }
      return new Response(JSON.stringify(payload), { status: 200 })
    }) as typeof fetch
    const quota = await fetchCodeBuddyQuota('cn', 'token-1', fakeFetch)
    expect(quota.remaining).toBe(60.5)
    expect(seen.url).toBe('https://copilot.tencent.com/v2/billing/meter/get-user-resource')
    const headers = seen.init?.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer token-1')
    expect(headers['x-domain']).toBe('copilot.tencent.com')
    expect(JSON.parse(String(seen.init?.body))).toMatchObject({
      PageNumber: 1,
      PageSize: 200,
      Status: [0, 3],
      PackageEndTimeRangeEnd: '2099-12-31 23:59:59',
    })
  })

  it('reports an expired login on 401 instead of echoing HTML', async () => {
    const fakeFetch = (async () => new Response('<html>401 Authorization Required</html>', { status: 401 })) as typeof fetch
    await expect(fetchCodeBuddyQuota('global', 'expired', fakeFetch)).rejects.toThrow(/登录已过期/)
  })
})
