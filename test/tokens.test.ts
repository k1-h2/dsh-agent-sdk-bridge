/**
 * Script-aware text pricing.
 *
 * The harness prices text at a flat 4 chars/token and derives `tok/s` from the
 * output tokens an adapter reports, so these rates decide both the token meter
 * and the speed readout for Chinese. The measured values (1.77 CJK, 5.20 ASCII)
 * are pinned here, along with the harness invariant that `reasoningTokens` must
 * never exceed `outputTokens` — a reading that violates it is discarded whole.
 */
import { describe, expect, it } from 'vitest'
import {
  NARROW_CHARS_PER_TOKEN, TurnOutputAccounting, WIDE_CHARS_PER_TOKEN, countWideChars, estimateTextTokens, isWideChar,
} from '../src/tokens.ts'

describe('wide character classification', () => {
  it('treats CJK text, kana and fullwidth forms as wide', () => {
    for (const character of '中文漢字、。ひらがなカタカナ、全角！？') expect(isWideChar(character)).toBe(true)
  })

  it('treats Latin, digits, ASCII punctuation and emoji as narrow', () => {
    for (const character of 'abcXYZ019 .,;:!?-_/\\[]{}<>@#$%^&*()"\'`~+=|') {
      expect(isWideChar(character)).toBe(false)
    }
    expect(isWideChar('🎉')).toBe(false)
  })

  it('counts a mixed string exactly', () => {
    expect(countWideChars('你好 world 再见')).toBe(4)
    expect(countWideChars('no wide text here')).toBe(0)
    expect(countWideChars('')).toBe(0)
  })
})

describe('token estimation', () => {
  it('prices pure Chinese at the measured wide rate', () => {
    const text = '这是一段中文'
    const tokens = estimateTextTokens(text.length, countWideChars(text))
    expect(tokens).toBeCloseTo(text.length / WIDE_CHARS_PER_TOKEN, 5)
  })

  it('prices pure ASCII at the measured narrow rate', () => {
    const text = 'this is plain ascii text'
    expect(estimateTextTokens(text.length, 0)).toBeCloseTo(text.length / NARROW_CHARS_PER_TOKEN, 5)
  })

  it('prices a mixed string as the sum of both rates', () => {
    const tokens = estimateTextTokens(100, 30)
    expect(tokens).toBeCloseTo(30 / WIDE_CHARS_PER_TOKEN + 70 / NARROW_CHARS_PER_TOKEN, 5)
  })

  it('under-prices Chinese at a flat 4 chars/token, which is why the rate exists', () => {
    const text = '中'.repeat(177)
    const scriptAware = estimateTextTokens(text.length, countWideChars(text))
    const flat = text.length / 4
    expect(scriptAware / flat).toBeGreaterThan(2.2)
    expect(scriptAware / flat).toBeLessThan(2.3)
  })

  it('never prices more characters than it was given, nor fewer than none', () => {
    // A wide count above the total, or negative, must not distort the result.
    expect(estimateTextTokens(10, 99)).toBeCloseTo(10 / WIDE_CHARS_PER_TOKEN, 5)
    expect(estimateTextTokens(10, -5)).toBeCloseTo(10 / NARROW_CHARS_PER_TOKEN, 5)
    expect(estimateTextTokens(0, 0)).toBe(0)
  })
})

/**
 * Per-turn output accounting.
 *
 * The regression this guards: tool-call arguments were never counted, and on an
 * agentic turn they are most of the output — measured at 86% of the characters
 * in a three-call turn. Because the harness derives `tok/s` from the reported
 * output tokens, dropping them under-reported speed several fold (a real turn
 * went from 72.5 to 311.2 tok/s once they were counted).
 */
describe('turn output accounting', () => {
  it('counts tool-call arguments as generated output', () => {
    const account = new TurnOutputAccounting()
    account.addOutput('write_file')
    account.addOutput('{"path":"src/a.ts","content":"export const x = 1"}')
    const { outputTokens } = account.usage()
    const withoutArguments = new TurnOutputAccounting()
    withoutArguments.addOutput('write_file')
    expect(outputTokens).toBeGreaterThan(withoutArguments.usage().outputTokens * 3)
  })

  it('counts reasoning toward output, and reports it as a subset', () => {
    const account = new TurnOutputAccounting()
    account.addOutput('answer')
    account.addReasoning('thinking about the answer')
    const { outputTokens, reasoningTokens } = account.usage()
    expect(reasoningTokens).toBeDefined()
    expect(reasoningTokens!).toBeLessThanOrEqual(outputTokens)
    // Reasoning is inside the total, not added on top of it.
    const total = new TurnOutputAccounting()
    total.addOutput('answer')
    total.addOutput('thinking about the answer')
    expect(outputTokens).toBe(total.usage().outputTokens)
  })

  it('reports no reasoning field on a turn that did not reason', () => {
    const account = new TurnOutputAccounting()
    account.addOutput('plain answer')
    expect(account.usage().reasoningTokens).toBeUndefined()
  })

  it('always reports at least one output token', () => {
    expect(new TurnOutputAccounting().usage().outputTokens).toBe(1)
  })

  it('forgets everything on reset, so a retried turn is not double-counted', () => {
    const account = new TurnOutputAccounting()
    account.addOutput('discarded first attempt')
    account.addReasoning('discarded reasoning')
    account.reset()
    expect(account.outputChars).toBe(0)
    expect(account.reasoningCharsTotal).toBe(0)
    account.addOutput('好')
    expect(account.usage().reasoningTokens).toBeUndefined()
  })

  it('keeps a metered reasoning figure inside the provider total', () => {
    const account = new TurnOutputAccounting()
    account.addReasoning('很长的思考过程'.repeat(50))
    // A provider that counted fewer output tokens than the local reasoning
    // estimate must not be handed a reasoning figure above its own total.
    expect(account.reasoningTokensWithin(10).reasoningTokens).toBe(10)
    // And a provider that counted none must not be given 1, which would exceed 0.
    expect(account.reasoningTokensWithin(0).reasoningTokens).toBe(0)
    // A turn that did not reason carries no field at all.
    expect(new TurnOutputAccounting().reasoningTokensWithin(100)).toEqual({})
  })
})
