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

const ADAPTERS = { cn: adapter('cn'), global: adapter('global') }

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
