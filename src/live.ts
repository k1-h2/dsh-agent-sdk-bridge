/**
 * Read-at-use configuration values.
 *
 * A `.volatile()` schema field does NOT make the plugin restart when it
 * changes. The loader classifies such a write as "volatile only", copies the
 * new value into the *existing* `Volatile` cell, and skips the restart
 * entirely (`Entry.update` → `_commitVolatile` in `cordis-plugin-loader`):
 *
 * ```js
 * const pending = volatileOnly && this._commitVolatile() ? [] : changes
 * if (!pending.length && !force) return          // no restart, no re-apply
 * ```
 *
 * So a plugin that copies its config into fields in `apply()` (or into a
 * constructor) keeps serving the values it saw when it was mounted, forever.
 * Nothing errors: the settings page writes, the profile patch on disk changes,
 * and the running plugin answers with the old state. Every field of this
 * plugin is volatile, so *every* setting behaved that way.
 *
 * The contract is therefore: read a volatile field where it is used, not where
 * the plugin is mounted. {@link Live} is the type that carries either shape —
 * a plain value for direct callers and tests, or a thunk over a live cell —
 * so an option can be live without forcing every caller to wrap it.
 *
 * @module dsh-qoder-link/live
 */

/**
 * A configuration value a consumer reads at each use: the value itself, or a
 * thunk that resolves it.
 */
export type Live<T> = T | (() => T)

/**
 * Resolve one {@link Live} option, falling back when it is absent.
 *
 * @param value - the plain value or thunk, possibly undefined.
 * @param fallback - value used when the option is absent or resolves to undefined.
 * @returns the option's current value.
 */
export function readLive<T>(value: Live<T> | undefined, fallback: T): T {
  const current = typeof value === 'function' ? (value as () => T)() : value
  return current === undefined ? fallback : current
}

/**
 * Resolve one {@link Live} option that may legitimately be undefined.
 *
 * Separate from {@link readLive} because an option whose "unset" state is
 * itself meaningful (`defaultReasoningEffort`: empty means "follow upstream")
 * has no fallback to apply.
 *
 * @param value - the plain value or thunk, possibly undefined.
 * @returns the option's current value, or undefined when it is unset.
 */
export function readLiveOptional<T>(value: Live<T | undefined> | undefined): T | undefined {
  return typeof value === 'function' ? (value as () => T | undefined)() : value
}
