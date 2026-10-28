/**
 * A model starts on the strongest reasoning level it accepts.
 *
 * The host applies the `defaultEffort` this adapter declares whenever a turn
 * carries no explicit level (`requested ?? reasoning.defaultEffort`), so the
 * value chosen here is what the provider actually runs. Upstream's own default
 * is deliberately ignored: CodeBuddy advertises `high` even when `max` is
 * selectable, and Qoder's CLI publishes no default at all. These cases pin the
 * strongest-level rule and the configured override.
 */
import { describe, expect, it } from 'vitest'
import { reasoningInfo, strongestEffort } from '../src/adapter.ts'

/** The ids one reasoning block offers, in declared order. */
function ids(info: ReturnType<typeof reasoningInfo>): string[] {
  return info?.efforts.map(effort => String(effort.id)) ?? []
}

describe('strongestEffort', () => {
  it('picks the strongest level regardless of the order it is listed in', () => {
    expect(strongestEffort(['low', 'medium', 'high', 'max'])).toBe('max')
    expect(strongestEffort(['max', 'high', 'low'])).toBe('max')
    expect(strongestEffort(['low', 'high'])).toBe('high')
    expect(strongestEffort(['none', 'low', 'medium', 'high', 'xhigh', 'max'])).toBe('max')
  })

  it('handles the levels the three providers actually publish', () => {
    // Qoder's fallback list, MiniMax's thinkingEffort options, CodeBuddy's
    // per-model supportedEfforts.
    expect(strongestEffort(['low', 'medium', 'high', 'max'])).toBe('max')
    expect(strongestEffort(['low', 'high'])).toBe('high')
    expect(strongestEffort(['low', 'medium', 'high'])).toBe('high')
  })

  it('keeps an unfamiliar id below every known level', () => {
    // An unknown spelling still resolves to something usable rather than
    // dropping the control, but never outranks a level we understand.
    expect(strongestEffort(['low', 'turbo'])).toBe('low')
    expect(strongestEffort(['turbo'])).toBe('turbo')
  })

  it('reports nothing for a model without levels', () => {
    expect(strongestEffort([])).toBeUndefined()
  })
})

describe('reasoningInfo', () => {
  it('defaults to the strongest level, not the upstream default', () => {
    // CodeBuddy names `high` as its default while `max` is selectable.
    const info = reasoningInfo(['low', 'high', 'max'], undefined, true)
    expect(ids(info)).toEqual(['low', 'high', 'max'])
    expect(String(info?.defaultEffort)).toBe('max')
  })

  it('uses the configured level when the model accepts it', () => {
    const info = reasoningInfo(['low', 'high', 'max'], 'low', true)
    expect(String(info?.defaultEffort)).toBe('low')
  })

  it('falls back to the strongest level when the configured one is not offered', () => {
    // A stored `max` against a model that only exposes low/high must not make
    // the host reject the turn with UNSUPPORTED_REASONING_EFFORT.
    const info = reasoningInfo(['low', 'high'], 'max', true)
    expect(String(info?.defaultEffort)).toBe('high')
  })

  it('declares the widest fallback list when the model reports none', () => {
    const info = reasoningInfo(undefined, undefined, true)
    expect(ids(info)).toEqual(['low', 'medium', 'high', 'max'])
    expect(String(info?.defaultEffort)).toBe('max')
  })

  it('omits reasoning entirely for a non-reasoning model', () => {
    expect(reasoningInfo(undefined, undefined, false)).toBeUndefined()
  })
})
