/**
 * A model switch must answer from the cached catalogue.
 *
 * The harness resolves a route on every model switch and every reasoning-level
 * change. Each provider's catalogue fetch is expensive (Qoder cold-starts the
 * CLI, CodeBuddy boots a process, MiniMax probes over ACP), so awaiting it here
 * froze the picker for as long as the fetch took whenever the TTL had expired.
 * These cases pin the rule: a snapshot answers immediately, the refresh runs
 * behind it, and only the first resolution (no snapshot yet) may wait.
 */
import { describe, expect, it, vi } from 'vitest'
import { cachedModels } from '../src/model-cache.ts'

describe('cachedModels', () => {
  it('answers from the snapshot without waiting for the refresh', async () => {
    const snapshot = [{ id: 'model-1' }]
    const fetch = vi.fn(() => new Promise<readonly { id: string }[]>(() => {}))
    const started = Date.now()
    const models = await cachedModels(snapshot, fetch)
    const elapsed = Date.now() - started
    expect(models).toBe(snapshot)
    // The refresh was started but deliberately not awaited: the promise above
    // never settles, and this call still returned.
    expect(fetch).toHaveBeenCalledOnce()
    expect(elapsed).toBeLessThan(50)
  })

  it('waits for the fetch when nothing has been read yet', async () => {
    const models = [{ id: 'model-1' }]
    const fetch = vi.fn(async () => models)
    expect(await cachedModels(undefined, fetch)).toBe(models)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('waits when the snapshot is empty, so a real list can replace it', async () => {
    const models = [{ id: 'model-1' }]
    const fetch = vi.fn(async () => models)
    expect(await cachedModels([], fetch)).toBe(models)
  })

  it('keeps answering from the snapshot when the refresh rejects', async () => {
    const snapshot = [{ id: 'model-1' }]
    const fetch = vi.fn(async () => { throw new Error('cli down') })
    await expect(cachedModels(snapshot, fetch)).resolves.toBe(snapshot)
    // Let the swallowed rejection settle; an unhandled one would fail the run.
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(fetch).toHaveBeenCalledOnce()
  })
})
