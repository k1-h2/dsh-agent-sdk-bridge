/**
 * Cache-first catalogue reads for the model picker.
 *
 * The harness resolves a route every time the user switches model or reasoning
 * level, and each of the three providers answers that resolution from a
 * catalogue whose fetch is expensive: Qoder cold-starts its CLI (up to the
 * fetch timeout), CodeBuddy boots a process, MiniMax probes over ACP. Awaiting
 * that fetch inside a resolution made the picker freeze for seconds whenever
 * the cache had just expired.
 *
 * So a resolution reads the last successful snapshot when there is one and lets
 * the catalogue refresh behind it; only the very first resolution, where there
 * is nothing to show, waits. A snapshot that is merely stale still describes
 * the same account's models, so answering from it is no less correct than the
 * previous behaviour of answering from a failed fetch's fallback.
 *
 * @module dsh-agent-sdk-bridge/model-cache
 */

/**
 * The cached list when one exists, otherwise the awaited fetch.
 *
 * @param snapshot - last successful catalogue, or undefined before the first.
 * @param fetch - the catalogue's normal (TTL-aware, in-flight-sharing) read.
 * @returns the entries to resolve against, never empty-by-surprise when a
 *   snapshot exists.
 */
export async function cachedModels<T>(
  snapshot: readonly T[] | undefined,
  fetch: () => Promise<readonly T[]>,
): Promise<readonly T[]> {
  if (snapshot !== undefined && snapshot.length > 0) {
    // Kick the refresh but do not wait for it: the caller needs an answer now,
    // and a failure here changes nothing because the snapshot stays published.
    void fetch().catch(() => undefined)
    return snapshot
  }
  return fetch()
}
