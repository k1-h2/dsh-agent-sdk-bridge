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

const ADAPTERS = { cn: adapter('cn'), global: adapter('global'), codebuddy: codeBuddyAdapter() }

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

  it('serves the CodeBuddy catalog and account through the same routes', async () => {
    const models = response()
    await handleApi(request(`${API_PREFIX}/models?brand=codebuddy`), models.res, ADAPTERS)
    expect(models.status()).toBe(200)
    expect(models.body().signedIn).toBe(true)
    expect(models.body().models[0]).toMatchObject({ id: 'cb-model', vision: true, reasoning: true })

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
