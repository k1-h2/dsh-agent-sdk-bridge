/**
 * The settings API's brand routing.
 *
 * Both editions answer through the same routes, so the one thing that must
 * never regress is which adapter a request reaches: the `brand` parameter is
 * the only thing standing between the page and the other account's catalog or
 * quota. These cases drive the real handler with stubbed adapters and a fake
 * request/response pair.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { API_PREFIX, handleApi } from '../src/api.ts'
import type { QoderAdapter } from '../src/adapter.ts'
import type { CodeBuddyAdapter } from '../src/codebuddy-adapter.ts'
import type { MinimaxAdapter } from '../src/minimax-adapter.ts'

/** One live catalog entry the stubbed adapters report. */
const ENTRY = {
  value: 'model-1',
  displayName: 'Model One',
  description: '',
  isVl: false,
  isEnabled: true,
  maxInputTokens: 200_000,
  defaultContextWindow: 200_000,
  availableContextWindows: [200_000],
}

/** An adapter that answers with its own name, so routing is observable. */
function adapter(label: string): QoderAdapter {
  return {
    describeCatalog: async () => [ENTRY],
    contextWindowFor: () => undefined,
    isModelDisabled: () => false,
    catalogError: () => `${label} catalog failed`,
    usageInfo: async (fresh: boolean) => ({ at: 1, brand: label, fresh }),
    invalidateCatalog: () => {},
    invalidateUsage: () => {},
  } as unknown as QoderAdapter
}

const ADAPTERS = {
  cn: adapter('cn'),
  global: adapter('global'),
  codebuddy: codeBuddyAdapter(),
  minimax: minimaxAdapter(),
}

/** CodeBuddy's catalog uses its own row shape, so it gets its own stub. */
function codeBuddyAdapter(): CodeBuddyAdapter {
  return {
    describeCatalog: async (region?: string) => [{
      id: region === 'cn' ? 'cb-cn-model' : 'cb-model',
      name: 'CB Model', contextWindows: [200_000, 1_000_000],
      defaultContextWindow: 200_000, vision: true, reasoningEfforts: ['low', 'high'],
    }],
    contextWindowFor: () => undefined,
    isModelDisabled: () => false,
    isSignedIn: () => true,
    catalogError: () => undefined,
    usageInfo: async () => ({ at: 1, account: { email: 'cb@example.com' } }),
    invalidateCatalog: () => {},
    invalidateUsage: () => {},
    authStatus: (region: string) => ({ running: false, region }),
    startLogin: () => ({ started: true }),
    logout: async () => ({ ok: true }),
  } as unknown as CodeBuddyAdapter
}

/** MiniMax's catalog carries its own reasoning flags and login region. */
function minimaxAdapter(): MinimaxAdapter {
  return {
    describeCatalog: async (region?: string) => [{
      id: region === 'cn' ? 'mm-cn-model' : 'mm-model',
      name: region === 'cn' ? 'MiniMax CN' : 'MiniMax Global',
      contextWindows: [512_000], defaultContextWindow: 512_000,
      vision: true, reasoning: true, reasoningEfforts: ['default', 'high'],
    }],
    contextWindowFor: () => undefined,
    isModelDisabled: () => false,
    isSignedIn: () => true,
    regionBlocked: () => false,
    catalogError: () => undefined,
    usageInfo: async (_fresh: boolean, region?: string) => ({ at: 1, region, installed: true }),
    invalidateCatalog: () => {},
    authStatus: (region: string) => ({ running: false, region, signedIn: true }),
    startLogin: () => ({ started: true }),
    logout: async () => ({ running: false, region: 'cn', signedIn: false }),
  } as unknown as MinimaxAdapter
}

/** A request the handler can iterate for a POST body. */
function request(url: string, method = 'GET', body?: unknown): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    url,
    method,
    async *[Symbol.asyncIterator]() { yield* chunks },
  } as unknown as IncomingMessage
}

/** A response that records the JSON it was given. */
function response(): { res: ServerResponse, status: () => number, body: () => any } {
  const state = { status: 0, body: undefined as any }
  const res = {
    writeHead: (status: number) => { state.status = status },
    end: (text: string) => { state.body = JSON.parse(text) },
  } as unknown as ServerResponse
  return { res, status: () => state.status, body: () => state.body }
}

describe('settings API brand routing', () => {
  it('serves each edition from its own adapter', async () => {
    for (const brand of ['cn', 'global'] as const) {
      const r = response()
      await handleApi(request(`${API_PREFIX}/models?brand=${brand}`), r.res, ADAPTERS)
      expect(r.status(), brand).toBe(200)
      expect(r.body().brand, brand).toBe(brand)
      expect(r.body().models[0].id, brand).toBe('model-1')
      // This stub advertises a single window, so the page must not offer a
      // selector the CLI would refuse.
      expect(r.body().models[0].contextWindowSelectable, brand).toBe(false)
      // Empty-list guidance is per adapter; a populated list carries none.
      expect(r.body().notice, brand).toBeUndefined()
    }
  })

  it('reads the quota from the requested edition, and honours refresh', async () => {
    const r = response()
    await handleApi(request(`${API_PREFIX}/usage?brand=global&fresh=1`), r.res, ADAPTERS)
    expect(r.status()).toBe(200)
    // The snapshot is spread into the response, so its own fields (here the
    // stub's `fresh` marker) sit beside the requested brand.
    expect(r.body()).toMatchObject({ brand: 'global', fresh: true })

    const cached = response()
    await handleApi(request(`${API_PREFIX}/usage?brand=cn`), cached.res, ADAPTERS)
    expect(cached.body()).toMatchObject({ brand: 'cn', fresh: false })
  })

  it('passes a missing CLI through so the page can drop its cached reading', async () => {
    // Without this flag the card kept showing the previous install's account
    // and credits after the CLI had been uninstalled.
    const missing = {
      describeCatalog: async () => [],
      contextWindowFor: () => undefined,
      isModelDisabled: () => false,
      catalogError: () => undefined,
      usageInfo: async () => ({
        at: 1, cliMissing: true,
        error: '未检测到可用的 qoderclicn，请先安装并登录后再使用此版本。',
      }),
      invalidateCatalog: () => {},
      invalidateUsage: () => {},
    } as unknown as QoderAdapter

    const r = response()
    await handleApi(request(`${API_PREFIX}/usage?brand=cn`), r.res, { ...ADAPTERS, cn: missing })
    expect(r.status()).toBe(200)
    expect(r.body()).toMatchObject({ brand: 'cn', cliMissing: true })
    expect(r.body().usage).toBeUndefined()
  })

  it('serves the CodeBuddy catalog and account through the same routes', async () => {
    const models = response()
    await handleApi(request(`${API_PREFIX}/models?brand=codebuddy`), models.res, ADAPTERS)
    expect(models.status()).toBe(200)
    expect(models.body().signedIn).toBe(true)
    expect(models.body().models[0]).toMatchObject({
      id: 'cb-model', vision: true, reasoning: true,
      // The provider's own default budget is what the session runs at; the
      // physical limit is not, and reporting it made the host divide by a
      // window the CLI never used.
      contextWindow: 200_000,
      defaultContextWindow: 200_000,
      contextWindows: [200_000, 1_000_000],
      contextWindowSelectable: true,
    })

    const account = response()
    await handleApi(request(`${API_PREFIX}/usage?brand=codebuddy`), account.res, ADAPTERS)
    expect(account.body()).toMatchObject({ brand: 'codebuddy', account: { email: 'cb@example.com' } })

    const region = response()
    await handleApi(request(`${API_PREFIX}/usage?brand=codebuddy&region=cn`), region.res, ADAPTERS)
    expect(region.body()).toMatchObject({ brand: 'codebuddy', account: { email: 'cb@example.com' } })
  })

  it('passes the requested region through to the CodeBuddy catalog', async () => {
    const cn = response()
    await handleApi(request(`${API_PREFIX}/models?brand=codebuddy&region=cn`), cn.res, ADAPTERS)
    expect(cn.status()).toBe(200)
    // The page refuses a table whose echoed region is not the one it asked for.
    expect(cn.body().region).toBe('cn')
    expect(cn.body().models[0].id).toBe('cb-cn-model')

    const bad = response()
    await handleApi(request(`${API_PREFIX}/models?brand=codebuddy&region=ioa`), bad.res, ADAPTERS)
    expect(bad.status()).toBe(400)
  })

  it('does not read a CodeBuddy catalog while signed out', async () => {
    const signedOut = { ...(ADAPTERS.codebuddy as unknown as Record<string, unknown>) }
    signedOut.isSignedIn = () => false
    signedOut.catalogError = () => '请先登录 CodeBuddy'
    let catalogReads = 0
    signedOut.describeCatalog = async () => { catalogReads++; return [] }
    const r = response()
    await handleApi(request(`${API_PREFIX}/models?brand=codebuddy`), r.res, {
      ...ADAPTERS,
      codebuddy: signedOut as unknown as CodeBuddyAdapter,
    })
    expect(r.status()).toBe(200)
    expect(r.body()).toMatchObject({ brand: 'codebuddy', signedIn: false, models: [] })
    expect(catalogReads).toBe(0)
  })

  it('starts a CodeBuddy login for the requested region and refuses a bad one', async () => {
    const started = response()
    await handleApi(request(`${API_PREFIX}/auth`, 'POST', { brand: 'codebuddy', region: 'cn', action: 'login' }), started.res, ADAPTERS)
    expect(started.status()).toBe(200)
    expect(started.body()).toMatchObject({ brand: 'codebuddy', running: false, region: 'cn' })

    const badRegion = response()
    await handleApi(request(`${API_PREFIX}/auth`, 'POST', { brand: 'codebuddy', region: 'ioa', action: 'login' }), badRegion.res, ADAPTERS)
    expect(badRegion.status()).toBe(400)

    const qoderAuth = response()
    await handleApi(request(`${API_PREFIX}/auth?brand=cn`), qoderAuth.res, ADAPTERS)
    expect(qoderAuth.status()).toBe(404)
  })

  it('refuses the CLI setup route for CodeBuddy', async () => {
    const r = response()
    await handleApi(request(`${API_PREFIX}/setup?brand=codebuddy`), r.res, ADAPTERS)
    expect(r.status()).toBe(400)
  })

  it('serves the MiniMax catalog and account, per login region', async () => {
    const global = response()
    await handleApi(request(`${API_PREFIX}/models?brand=minimax&region=global`), global.res, ADAPTERS)
    expect(global.status()).toBe(200)
    expect(global.body()).toMatchObject({ brand: 'minimax', signedIn: true, region: 'global' })
    expect(global.body().models[0]).toMatchObject({
      id: 'mm-model', vision: true, reasoning: true, defaultContextWindow: 512_000,
    })

    const cn = response()
    await handleApi(request(`${API_PREFIX}/models?brand=minimax&region=cn`), cn.res, ADAPTERS)
    expect(cn.body().region).toBe('cn')
    expect(cn.body().models[0].id).toBe('mm-cn-model')

    const bad = response()
    await handleApi(request(`${API_PREFIX}/models?brand=minimax&region=ioa`), bad.res, ADAPTERS)
    expect(bad.status()).toBe(400)

    const account = response()
    await handleApi(request(`${API_PREFIX}/usage?brand=minimax&region=cn`), account.res, ADAPTERS)
    expect(account.body()).toMatchObject({ brand: 'minimax', region: 'cn', installed: true, signedIn: true })
  })

  it('does not read a MiniMax catalog while signed out', async () => {
    const signedOut = { ...(ADAPTERS.minimax as unknown as Record<string, unknown>) }
    signedOut.isSignedIn = () => false
    signedOut.catalogError = () => '请先登录 MiniMax Code'
    let catalogReads = 0
    signedOut.describeCatalog = async () => { catalogReads++; return [] }
    const r = response()
    await handleApi(request(`${API_PREFIX}/models?brand=minimax&region=global`), r.res, {
      ...ADAPTERS,
      minimax: signedOut as unknown as MinimaxAdapter,
    })
    expect(r.status()).toBe(200)
    expect(r.body()).toMatchObject({ brand: 'minimax', signedIn: false, models: [], notice: '请先登录 MiniMax Code' })
    expect(catalogReads).toBe(0)
  })

  it('passes a blocked region through and offers no models', async () => {
    const blocked = { ...(ADAPTERS.minimax as unknown as Record<string, unknown>) }
    blocked.regionBlocked = () => true
    blocked.catalogError = () => '本机 IP 不在 MiniMax 国际站的服务区域'
    blocked.describeCatalog = async () => []
    const r = response()
    await handleApi(request(`${API_PREFIX}/models?brand=minimax&region=global`), r.res, {
      ...ADAPTERS,
      minimax: blocked as unknown as MinimaxAdapter,
    })
    expect(r.status()).toBe(200)
    expect(r.body()).toMatchObject({
      brand: 'minimax',
      region: 'global',
      signedIn: true,
      regionBlocked: true,
      models: [],
      notice: expect.stringContaining('IP'),
    })
  })

  it('starts and ends a MiniMax login per region', async () => {
    const started = response()
    await handleApi(request(`${API_PREFIX}/auth`, 'POST', { brand: 'minimax', region: 'cn', action: 'login' }), started.res, ADAPTERS)
    expect(started.status()).toBe(200)
    expect(started.body()).toMatchObject({ brand: 'minimax', region: 'cn', signedIn: true })

    const status = response()
    await handleApi(request(`${API_PREFIX}/auth?brand=minimax&region=global`), status.res, ADAPTERS)
    expect(status.status()).toBe(200)
    expect(status.body()).toMatchObject({ brand: 'minimax', region: 'global' })

    const ended = response()
    await handleApi(request(`${API_PREFIX}/auth`, 'POST', { brand: 'minimax', region: 'cn', action: 'logout' }), ended.res, ADAPTERS)
    expect(ended.status()).toBe(200)
    expect(ended.body()).toMatchObject({ brand: 'minimax', signedIn: false })
  })

  it('routes the MiniMax installer from the POST body, not the query string', async () => {
    const status = response()
    await handleApi(request(`${API_PREFIX}/setup?brand=minimax`), status.res, ADAPTERS)
    expect(status.status()).toBe(200)
    expect(typeof status.body().installed).toBe('boolean')

    // The page posts `/setup` without a query brand, so the body alone must
    // reach the MiniMax branch. An invalid mode is rejected there — before the
    // installer spawns — and the message proves which branch answered.
    const badMode = response()
    await handleApi(request(`${API_PREFIX}/setup`, 'POST', { brand: 'minimax', mode: 'configure' }), badMode.res, ADAPTERS)
    expect(badMode.status()).toBe(400)
    expect(badMode.body().error).toBe('mode 只接受 install 或 uninstall')

    // Qoder still answers with its own mode vocabulary for the same request.
    const qoderMode = response()
    await handleApi(request(`${API_PREFIX}/setup`, 'POST', { brand: 'cn', mode: 'bogus' }), qoderMode.res, ADAPTERS)
    expect(qoderMode.status()).toBe(400)
    expect(qoderMode.body().error).toBe('mode 只接受 configure、login、uninstall 或 cancel')

    const noBrand = response()
    await handleApi(request(`${API_PREFIX}/setup`, 'POST', { mode: 'install' }), noBrand.res, ADAPTERS)
    expect(noBrand.status()).toBe(400)
  })

  it('cancels a stalled Qoder login from the page', async () => {
    // `qodercli login` waits for the browser callback; closing that tab used to
    // leave the page polling forever. The cancel action settles the run, so the
    // status comes back not-running and the buttons return.
    const cancelled = response()
    await handleApi(request(`${API_PREFIX}/setup`, 'POST', { brand: 'cn', mode: 'cancel' }), cancelled.res, ADAPTERS)
    expect(cancelled.status()).toBe(200)
    expect(cancelled.body()).toMatchObject({ running: false })
    expect(typeof cancelled.body().installed).toBe('boolean')
  })

  it('refuses a brand it does not serve instead of defaulting to CN', async () => {
    for (const url of [
      `${API_PREFIX}/models?brand=qoder`,
      `${API_PREFIX}/usage?brand=CN`,
    ]) {
      const r = response()
      await handleApi(request(url), r.res, ADAPTERS)
      expect(r.status(), url).toBe(400)
    }
  })

  it('defaults an old page without a brand to CN', async () => {
    const r = response()
    await handleApi(request(`${API_PREFIX}/models`), r.res, ADAPTERS)
    expect(r.body().brand).toBe('cn')
  })

  it('rejects an unknown setup mode and an unknown setup brand', async () => {
    const badMode = response()
    await handleApi(request(`${API_PREFIX}/setup`, 'POST', { brand: 'cn', mode: 'check' }), badMode.res, ADAPTERS)
    expect(badMode.status()).toBe(400)

    const badBrand = response()
    await handleApi(request(`${API_PREFIX}/setup`, 'POST', { brand: 'other', mode: 'login' }), badBrand.res, ADAPTERS)
    expect(badBrand.status()).toBe(400)
  })
})
