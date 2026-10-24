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
export declare const WIDE_CHARS_PER_TOKEN = 1.77;
/** Characters per token for narrow (Latin, digits, punctuation) text, measured. */
export declare const NARROW_CHARS_PER_TOKEN = 5.2;
/**
 * Whether this tokenizer prices a character as wide (CJK) text.
 *
 * Ranges follow the Unicode blocks that CJK tokenizers treat as one-or-more
 * tokens per character, including the fullwidth forms that Chinese punctuation
 * uses. Everything else is priced as narrow text.
 */
export declare function isWideChar(character: string): boolean;
/** How many of a text's characters are wide (CJK) text. */
export declare function countWideChars(text: string): number;
/**
 * Price text by its script mix, rather than at a flat 4 chars/token.
 *
 * @param chars - total character count.
 * @param wideChars - how many of those characters are wide (CJK) text.
 * @returns the estimated token count.
 */
export declare function estimateTextTokens(chars: number, wideChars: number): number;
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
export declare class TurnOutputAccounting {
    private chars;
    private wideChars;
    private reasoningChars;
    private reasoningWideChars;
    /** Count generated text: visible output, or a tool-call name or arguments. */
    addOutput(text: string): void;
    /** Count generated reasoning, which is also part of the output total. */
    addReasoning(text: string): void;
    /** Total generated characters, for diagnostics. */
    get outputChars(): number;
    /** Generated reasoning characters, a subset of {@link outputChars}. */
    get reasoningCharsTotal(): number;
    /** Discard the turn's counts; called when a turn ends or is retried. */
    reset(): void;
    /**
     * The turn's `outputTokens` and, when it reasoned, its `reasoningTokens`.
     *
     * Both are at least 1 so a turn that produced only a tool call still reports a
     * positive count, and reasoning never exceeds output.
     */
    usage(): {
        outputTokens: number;
        reasoningTokens?: number;
    };
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
    reasoningTokensWithin(meteredOutput: number): {
        reasoningTokens?: number;
    };
}
