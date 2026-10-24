/**
 * What one CLI usage frame becomes on the harness seam.
 *
 * The two backends disagree about what `input_tokens` counts, and the harness's
 * buckets are disjoint, so getting this wrong shows up as an inflated total and
 * a wrong context percentage rather than as an error. The frame below is a real
 * second-turn frame from this backend (9 805 of 10 268 prompt tokens served from
 * cache), and the harness's own disclosure rule is why a zero cache bucket must
 * still be reported rather than omitted.
 *
 * The second half pins which frame may supply the occupancy sample at all: only
 * a finished request may, because the turn-level `result` frame sums every
 * request the inner turn made and once pegged a 1M window at 100%.
 *
 * The last block pins the tool-result pairing against a live-CLI measurement:
 * the MCP handler fires *after* the turn that announced it has already ended, so
 * the pairing must outlive the turn. Clearing it at the turn boundary — what
 * this code used to do — made a fast host tool park under a fallback key and
 * wait out the whole tool-result timeout, which is the "model stopped answering"
 * stall users worked around by stopping the conversation and resending.
 *
 * A second, independent cause of the same symptom is pinned there too: the host
 * batches every result of a tool round into its next request, so a slow sibling
 * (a 300 s pwsh) delays a result that is already ready. A wall-clock deadline on
 * a paired handler cancelled that call at 120 s in a live log; the pairing now
 * waits for the request boundary and only settles calls that request did not
 * answer.
 */
import { describe, expect, it } from 'vitest'
import { ToolResultPairing, carriesTokens, meteredUsage, requestUsageSample } from '../src/session.ts'

/** A turn that produced no reasoning text. */
const noReasoning = (): { reasoningTokens?: number } => ({})

describe('metered usage', () => {
  it('takes the cached halves out of the prompt total', () => {
    // The CLI reports the whole prompt in input_tokens and measures its context
    // ratio against that same number, so the harness's uncached bucket is the
    // remainder. Keeping input_tokens as-is would count the cached prefix twice.
    expect(meteredUsage({
      input_tokens: 10_268,
      output_tokens: 233,
      cache_read_input_tokens: 9_805,
      cache_creation_input_tokens: 0,
    }, noReasoning)).toEqual({
      inputTokens: 463,
      outputTokens: 233,
      cacheReadTokens: 9_805,
      cacheWriteTokens: 0,
      totalTokens: 10_501,
    })
  })

  it('reports both cache buckets even when the provider served none', () => {
    // An omitted cache bucket makes the harness withhold the turn's usage
    // disclosure, so a zero has to be stated rather than left out.
    expect(meteredUsage({ input_tokens: 321, output_tokens: 43 }, noReasoning)).toEqual({
      inputTokens: 321,
      outputTokens: 43,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 364,
    })
  })

  it('never reports more uncached input than the prompt held', () => {
    // A frame claiming more cached tokens than tokens is inconsistent; the
    // reading degrades to "nothing uncached" instead of a negative bucket.
    expect(meteredUsage({ input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 400 }, noReasoning))
      .toMatchObject({ inputTokens: 0, cacheReadTokens: 400 })
  })

  it('carries the clamped reasoning estimate alongside the metered total', () => {
    const usage = meteredUsage({ input_tokens: 900, output_tokens: 120 }, output => ({ reasoningTokens: Math.min(output, 300) }))
    expect(usage).toMatchObject({ outputTokens: 120, reasoningTokens: 120 })
  })

  it('refuses a frame that carries no metering at all', () => {
    // The CLI zeroes every token counter unless it was asked to expose them,
    // and those frames are exactly what the usage fallbacks exist for.
    const zeroed = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    expect(meteredUsage(zeroed, noReasoning)).toBeUndefined()
    expect(meteredUsage(undefined, noReasoning)).toBeUndefined()
    expect(meteredUsage({ context_usage_ratio: 0.49 }, noReasoning)).toBeUndefined()
  })
})

describe('usage sample selection', () => {
  it('takes metering from the frame a finished request emits', () => {
    // A four-request probe: message_delta reported 837 input for its own
    // request, which is the prompt this session is holding.
    const usage = { input_tokens: 837, output_tokens: 26, cache_read_input_tokens: 576 }
    expect(requestUsageSample({ type: 'stream_event', event: { type: 'message_delta', usage } })).toBe(usage)
  })

  it('ignores the zero filler a request-start frame carries', () => {
    expect(requestUsageSample({
      type: 'stream_event',
      event: { type: 'message_start', message: { usage: { input_tokens: 0, output_tokens: 0 } } },
    })).toBeUndefined()
  })

  it('ignores an assembled assistant message, which reports no request metering', () => {
    // Its own usage record is the zero filler; even a non-zero one would not be
    // sampled, because only a stream frame describes the live request.
    expect(requestUsageSample({
      type: 'assistant',
      usage: { input_tokens: 12, output_tokens: 3 },
    })).toBeUndefined()
  })

  it('ignores the whole-run total the result frame carries', () => {
    // The regression: the same probe's result frame summed all four requests
    // (2 921 input) and the next reading showed 9.8M against a 1M window.
    expect(requestUsageSample({
      type: 'result',
      usage: { input_tokens: 2_921, output_tokens: 195, cache_read_input_tokens: 1_728 },
    })).toBeUndefined()
  })

  it('recognizes real metering by any positive counter', () => {
    // A cached second turn can report a small uncached remainder; the cache
    // bucket is what makes it real, not the input total.
    expect(carriesTokens({ input_tokens: 463, output_tokens: 233 })).toBe(true)
    expect(carriesTokens({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 9_805 })).toBe(true)
    expect(carriesTokens({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })).toBe(false)
    expect(carriesTokens({ context_usage_ratio: 0.49 })).toBe(false)
  })
})

/** A host tool result, as the MCP handler reads it. */
const result = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: false })

describe('tool-result pairing', () => {
  /**
   * The measured race, as a unit: the host answers a tool call the instant it
   * sees the block, and the CLI dispatches the MCP message a few milliseconds
   * later — so the result is buffered before any handler exists.
   *
   * The old implementation cleared the announcements at the turn boundary, which
   * is exactly what happens between these two steps. That made the handler claim
   * `undefined`, park under `anonymous-1`, and never read the buffered result:
   * the call waited out `toolResultTimeoutMs` (120 s by default). Against that
   * build this test fails with a timeout, which is the point.
   */
  it('hands a fast host result to the handler that arrives after the turn ended', async () => {
    const pairing = new ToolResultPairing()
    // Turn N: the CLI announces the call, the host's result is filed before the
    // handler fires. Nothing here is turn-scoped state the turn may clear.
    pairing.announce('call_80d292a7')
    pairing.mapHostCall('qoder-probe-1', 'call_80d292a7')
    const key = pairing.deliver('qoder-probe-1', result('The secret word is BANANA.'))
    // Turn N+1 starts and carries that result. The request boundary must keep
    // both the announcement and the buffered result.
    pairing.beginHostRequest(new Set([key]), false)

    const claimed = await pairing.claim(50)
    expect(claimed.content).toEqual([{ type: 'text', text: 'The secret word is BANANA.' }])
    expect(claimed.isError).toBe(false)
  })

  it('waits past the fallback timeout while the host is still running a tool', async () => {
    // The regression: a host tool is allowed to run for minutes, and its result
    // only arrives with the next host request. A wall-clock deadline here
    // cancelled a call whose real result was still on its way (measured against
    // a 300 s pwsh: the handler died at 120 s, the result arrived 45 s later).
    const pairing = new ToolResultPairing()
    pairing.announce('call_slow_host')
    pairing.mapHostCall('qoder-slow-host-1', 'call_slow_host')

    const parked = pairing.claim(20)
    await new Promise(resolve => setTimeout(resolve, 60))

    const key = pairing.deliver('qoder-slow-host-1', result('slow but real'))
    pairing.beginHostRequest(new Set([key]), false)

    await expect(parked).resolves.toMatchObject({ isError: false })
    expect((await parked).content).toEqual([{ type: 'text', text: 'slow but real' }])
  })

  it('settles a paired call the next host request did not answer', async () => {
    // The host runs the whole tool batch and then sends one request with every
    // result. If a call the host *was shown* is missing from that request, it
    // will never be answered — waiting longer cannot help.
    const pairing = new ToolResultPairing()
    pairing.announce('call_skipped')
    pairing.mapHostCall('qoder-skipped-1', 'call_skipped')
    const parked = pairing.claim(60_000)

    pairing.beginHostRequest(new Set(), false)

    await expect(parked).resolves.toMatchObject({ isError: true })
    expect(pairing.parkedCount).toBe(0)
  })

  it('fails a call the host was never shown instead of parking forever', async () => {
    // The measured hang of 2026-10-20 (572 s, ended by the user): the inner
    // model asked for a host tool by its bare name, qodercli could not resolve
    // it, ran its own loop ahead of the host, and retried with the qualified
    // name. That retry's block reached the adapter in the window where no host
    // request was open, so the session dropped it and the host never saw the
    // call — while the CLI still dispatched its MCP message.
    //
    // Parking here can never end: the host files no result for an id it never
    // received, and the next request that would settle it cannot be sent until
    // this turn ends. Before this rule the test hangs on `claim` forever.
    const pairing = new ToolResultPairing()
    pairing.announce('call_never_shown')
    // No mapHostCall: `canUseTool` allowed the call, but the adapter never
    // emitted its block, so no host request can ever carry its result.

    const claimed = await pairing.claim(600_000)
    expect(claimed.isError).toBe(true)
    expect(String(claimed.content[0] && 'text' in claimed.content[0] ? claimed.content[0].text : ''))
      .toContain('未返回这次工具调用的结果')
    expect(pairing.parkedCount).toBe(0)
  })

  it('still parks a shown call whose block the host has not answered yet', async () => {
    // The counterpart of the rule above, and the reason it is safe: a call the
    // adapter did emit may legitimately wait minutes for its result, so it must
    // not be failed for being slow.
    const pairing = new ToolResultPairing()
    pairing.announce('call_shown')
    pairing.mapHostCall('qoder-shown-1', 'call_shown')

    const parked = pairing.claim(20)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(pairing.parkedCount).toBe(1)

    const key = pairing.deliver('qoder-shown-1', result('late but real'))
    pairing.beginHostRequest(new Set([key]), false)
    await expect(parked).resolves.toMatchObject({ isError: false })
  })

  it('settles a handler that arrives after its call was abandoned', async () => {
    // The boundary may run before the CLI dispatches the MCP message. That
    // handler must not park for the full fallback timeout; its call is already
    // known to be unanswerable.
    const pairing = new ToolResultPairing()
    pairing.announce('call_skipped')
    pairing.beginHostRequest(new Set(), false)

    const claimed = await pairing.claim(60_000)
    expect(claimed.isError).toBe(true)
    expect(String(claimed.content[0] && 'text' in claimed.content[0] ? claimed.content[0].text : ''))
      .toContain('未返回这次工具调用的结果')
  })

  it('hands a lone buffered result to a handler with no announcement', async () => {
    // A permission ask that never reached the pairing leaves the handler with no
    // id. With nothing else outstanding, the one unclaimed result is still the
    // only possible match, so it must not be dropped.
    const pairing = new ToolResultPairing()
    pairing.mapHostCall('qoder-unannounced-1', 'call_unannounced')
    const key = pairing.deliver('qoder-unannounced-1', result('matched anyway'))
    pairing.beginHostRequest(new Set([key]), false)

    const claimed = await pairing.claim(50)
    expect(claimed.content).toEqual([{ type: 'text', text: 'matched anyway' }])
  })

  it('wakes a handler that parked before the host answered', async () => {
    // The slow-tool path: a shell command takes seconds, so the handler parks
    // first and `deliver` resolves it. This path always worked; it is pinned so
    // the fast path above cannot be fixed by breaking this one.
    const pairing = new ToolResultPairing()
    pairing.announce('call_slow')
    pairing.mapHostCall('qoder-slow-1', 'call_slow')

    const parked = pairing.claim(5_000)
    expect(pairing.parkedCount).toBe(1)
    pairing.deliver('qoder-slow-1', result('slow result done'))

    await expect(parked).resolves.toMatchObject({ isError: false })
    expect(pairing.parkedCount).toBe(0)
  })

  it('keeps two concurrent calls on their own ids', async () => {
    // `canUseTool` and the handlers agree by order, so a dropped or reordered
    // announcement would hand one call the other's result.
    const pairing = new ToolResultPairing()
    pairing.announce('call_A')
    pairing.announce('call_B')
    pairing.mapHostCall('qoder-1', 'call_A')
    pairing.mapHostCall('qoder-2', 'call_B')

    // B's result is filed first, and must still reach B.
    pairing.deliver('qoder-2', result('for B'))
    pairing.deliver('qoder-1', result('for A'))

    const first = await pairing.claim(50)
    const second = await pairing.claim(50)
    expect(first.content).toEqual([{ type: 'text', text: 'for A' }])
    expect(second.content).toEqual([{ type: 'text', text: 'for B' }])
  })

  it('cancels a parked call when the host starts a fresh user turn', async () => {
    const pairing = new ToolResultPairing()
    pairing.announce('call_abandoned')
    pairing.mapHostCall('qoder-abandoned-1', 'call_abandoned')
    const parked = pairing.claim(5_000)
    expect(pairing.parkedCount).toBe(1)

    pairing.beginHostRequest(new Set(), true)

    await expect(parked).resolves.toMatchObject({ isError: true })
    expect(pairing.parkedCount).toBe(0)
  })

  it('keeps delivered results when the request also carries a runtime-context user message', async () => {
    // The host refreshes its runtime-context snapshot as a user-role message on
    // some continuation requests. That must not supersede the tool round: the
    // results delivered in the same request still belong to their handlers.
    const pairing = new ToolResultPairing()
    pairing.announce('call_fast')
    pairing.mapHostCall('qoder-fast', 'call_fast')
    const key = pairing.deliver('qoder-fast', result('real result'))
    pairing.beginHostRequest(new Set([key]), true)

    const claimed = await pairing.claim(50)
    expect(claimed.content).toEqual([{ type: 'text', text: 'real result' }])
  })

  it('cancels a handler that arrives after a fresh user turn superseded it', async () => {
    // Same race as the fast-result path, but in the other direction: the user
    // replaced the turn before the CLI dispatched its MCP message. That handler
    // must settle immediately instead of parking for minutes.
    const pairing = new ToolResultPairing()
    pairing.announce('call_superseded')
    pairing.beginHostRequest(new Set(), true)

    const claimed = await pairing.claim(60_000)
    expect(claimed.isError).toBe(true)
  })

  it('still fails an unpaired handler rather than hanging forever', async () => {
    // The bounded park remains the last-resort recovery for a handler with no
    // announced id, where no delivered result can be matched to it at all.
    const pairing = new ToolResultPairing()
    const claimed = await pairing.claim(20)
    expect(claimed.isError).toBe(true)
    expect(String(claimed.content[0] && 'text' in claimed.content[0] ? claimed.content[0].text : ''))
      .toContain('未返回工具结果')
  })

  it('drops announcements an aborted turn can no longer dispatch', async () => {
    // On abort the CLI cancels its pending dispatch. An announcement it never
    // spent would otherwise shift the NEXT turn's handler onto the wrong id and
    // park it under a key nothing resolves — reintroducing the same stall.
    const pairing = new ToolResultPairing()
    pairing.announce('call_never_dispatched')
    pairing.forgetUnclaimed()

    pairing.announce('call_real')
    pairing.mapHostCall('qoder-9', 'call_real')
    pairing.deliver('qoder-9', result('real result'))

    const claimed = await pairing.claim(50)
    expect(claimed.content).toEqual([{ type: 'text', text: 'real result' }])
  })

  it('releases a parked handler when the session is torn down', async () => {
    // `close()` must not leave a handler holding a promise nothing can resolve.
    const pairing = new ToolResultPairing()
    pairing.announce('call_live')
    pairing.mapHostCall('qoder-live-1', 'call_live')
    const parked = pairing.claim(60_000)
    expect(pairing.parkedCount).toBe(1)
    pairing.clear()
    await expect(parked).resolves.toMatchObject({ isError: true })
  })
})
