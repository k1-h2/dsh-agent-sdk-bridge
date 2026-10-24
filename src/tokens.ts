/**
 * Script-aware text pricing, shared by the input and output estimators.
 *
 * The harness prices text at a flat 4 chars/token (dsh-token-meter's
 * `CHARS_PER_TOKEN`). That is close for Latin text but under-prices Chinese by
 * about 2.3x, which matters twice over in this plugin: it reports the tokens for
 * a turn, and the harness derives `tok/s` from the output half of that report.
 * A flat rate therefore made Chinese replies look roughly half as fast as they
 * really are.
 *
 * The rates below were measured against this backend's own tokenizer, by
 * least-squares fit over four content sizes per script, each read against the
 * CLI's `context_usage_ratio` with a window the CLI had confirmed it honoured:
 *
 * | script | chars/token | tokens/char |
 * |--------|-------------|-------------|
 * | CJK    | 1.77        | 0.565       |
 * | ASCII  | 5.20        | 0.192       |
 *
 * A constant offset in that fit (qodercli's own prompt, skills and tool
 * definitions, ~127 tokens) is deliberately not modelled here: it belongs to the
 * CLI's session, not to the text being priced.
 * @module dsh-agent-sdk-bridge/tokens
 */

/** Characters per token for wide (CJK) text, measured. */
export const WIDE_CHARS_PER_TOKEN = 1.77

/** Characters per token for narrow (Latin, digits, punctuation) text, measured. */
export const NARROW_CHARS_PER_TOKEN = 5.2

/**
 * Whether this tokenizer prices a character as wide (CJK) text.
 *
 * Ranges follow the Unicode blocks that CJK tokenizers treat as one-or-more
 * tokens per character, including the fullwidth forms that Chinese punctuation
 * uses. Everything else is priced as narrow text.
 */
export function isWideChar(character: string): boolean {
  const code = character.codePointAt(0) ?? 0
  return (code >= 0x1100 && code <= 0x115f)   // Hangul Jamo
    || (code >= 0x2e80 && code <= 0x303e)     // CJK radicals, Kangxi, CJK punctuation
    || (code >= 0x3041 && code <= 0x33ff)     // Kana, CJK compatibility
    || (code >= 0x3400 && code <= 0x4dbf)     // CJK extension A
    || (code >= 0x4e00 && code <= 0x9fff)     // CJK unified ideographs
    || (code >= 0xa000 && code <= 0xa4cf)     // Yi
    || (code >= 0xac00 && code <= 0xd7a3)     // Hangul syllables
    || (code >= 0xf900 && code <= 0xfaff)     // CJK compatibility ideographs
    || (code >= 0xfe30 && code <= 0xfe6f)     // CJK compatibility forms
    || (code >= 0xff00 && code <= 0xff60)     // Fullwidth forms
    || (code >= 0xffe0 && code <= 0xffe6)     // Fullwidth signs
    || (code >= 0x20000 && code <= 0x3fffd)   // CJK extensions B and beyond
}

/** How many of a text's characters are wide (CJK) text. */
export function countWideChars(text: string): number {
  let wide = 0
  for (const character of text) if (isWideChar(character)) wide += 1
  return wide
}

/**
 * Price text by its script mix, rather than at a flat 4 chars/token.
 *
 * @param chars - total character count.
 * @param wideChars - how many of those characters are wide (CJK) text.
 * @returns the estimated token count.
 */
export function estimateTextTokens(chars: number, wideChars: number): number {
  const wide = Math.max(0, Math.min(chars, wideChars))
  return wide / WIDE_CHARS_PER_TOKEN + (chars - wide) / NARROW_CHARS_PER_TOKEN
}

/**
 * The output tokens one turn generated, priced by script.
 *
 * Everything the model produced belongs here, whatever block carried it: visible
 * text, reasoning, and tool-call names and arguments. That last one is easy to
 * miss and usually the largest — measured at 86% of the characters in a
 * three-call turn — and because the harness derives `tok/s` from the output
 * tokens an adapter reports, omitting it under-reports speed several fold on
 * exactly the multi-step agentic work where the figure is worth reading.
 *
 * Reasoning is a SUBSET of the output total, not a separate bucket: the harness
 * discards an entire reading whose `reasoningTokens` exceeds its `outputTokens`,
 * so {@link usage} clamps it rather than trusting the caller to.
 */
export class TurnOutputAccounting {
  private chars = 0
  private wideChars = 0
  private reasoningChars = 0
  private reasoningWideChars = 0

  /** Count generated text: visible output, or a tool-call name or arguments. */
  addOutput(text: string): void {
    if (text.length === 0) return
    this.chars += text.length
    this.wideChars += countWideChars(text)
  }

  /** Count generated reasoning, which is also part of the output total. */
  addReasoning(text: string): void {
    if (text.length === 0) return
    this.addOutput(text)
    this.reasoningChars += text.length
    this.reasoningWideChars += countWideChars(text)
  }

  /** Total generated characters, for diagnostics. */
  get outputChars(): number { return this.chars }

  /** Generated reasoning characters, a subset of {@link outputChars}. */
  get reasoningCharsTotal(): number { return this.reasoningChars }

  /** Discard the turn's counts; called when a turn ends or is retried. */
  reset(): void {
    this.chars = 0
    this.wideChars = 0
    this.reasoningChars = 0
    this.reasoningWideChars = 0
  }

  /**
   * The turn's `outputTokens` and, when it reasoned, its `reasoningTokens`.
   *
   * Both are at least 1 so a turn that produced only a tool call still reports a
   * positive count, and reasoning never exceeds output.
   */
  usage(): { outputTokens: number, reasoningTokens?: number } {
    const outputTokens = Math.max(1, Math.ceil(estimateTextTokens(this.chars, this.wideChars)))
    if (this.reasoningChars === 0) return { outputTokens }
    const reasoningTokens = Math.max(1, Math.ceil(estimateTextTokens(this.reasoningChars, this.reasoningWideChars)))
    return { outputTokens, reasoningTokens: Math.min(reasoningTokens, outputTokens) }
  }

  /**
   * This turn's reasoning tokens, clamped inside a real metered output total.
   *
   * Used when the CLI reports genuine `output_tokens`: the reasoning figure is
   * still the local estimate, but it must stay a subset of what the provider
   * counted or the harness discards the reading.
   *
   * @param meteredOutput - the provider's own output token count.
   * @returns a spreadable `reasoningTokens` field, or nothing when unmeasured.
   */
  reasoningTokensWithin(meteredOutput: number): { reasoningTokens?: number } {
    if (this.reasoningChars === 0) return {}
    const reasoningTokens = Math.ceil(estimateTextTokens(this.reasoningChars, this.reasoningWideChars))
    // Clamped to the metered total, not floored at 1: a provider that counted no
    // output tokens must not be handed a reasoning figure of 1, which would
    // exceed its output and cost the whole reading.
    return { reasoningTokens: Math.max(0, Math.min(meteredOutput, reasoningTokens)) }
  }
}
