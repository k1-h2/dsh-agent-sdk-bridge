/**
 * MCP tool-name namespacing, shared by every CLI backend this bridge drives.
 *
 * Each backend reaches the host's tools over an in-process MCP server, so the
 * name a model emits is namespaced (`mcp__dsh-host__ops_bash`) while the host
 * dispatches on the bare name (`ops_bash`). Two things make that translation
 * less trivial than it looks, and both are the same bug in different clothes:
 *
 * - **Spelling.** CodeBuddy rewrites a server name's non-alphanumeric characters
 *   to `_`, so `dsh-host` is exposed as `mcp__dsh_host__…`; the Qoder CLI keeps
 *   the hyphen. A handler must accept both.
 * - **Depth.** A model occasionally emits an already-qualified name, and the CLI
 *   then qualifies it again. Peeling exactly one layer handed the host
 *   `mcp__dsh_host__edit` — a name it does not have — so DSH answered
 *   `unknown tool "mcp__dsh_host__edit"`; the model then retried the doubled
 *   spelling and the CLI refused it with its own
 *   `does not exist in the current tool set.` Two error messages, one cause:
 *   a prefix peeled once instead of exhaustively.
 *
 * This module exists so all three backends peel the same way, rather than each
 * carrying its own one-layer `slice`.
 *
 * @module dsh-agent-sdk-bridge/mcp-naming
 */

/** How many prefix layers a single name may carry before the walk gives up. */
const MAX_NAMESPACE_LAYERS = 8

/**
 * Peel every matching namespace layer off a tool name.
 *
 * @param name - the tool name as the CLI's `tool_use` block carried it.
 * @param prefixes - the namespaced spellings that belong to one server, in
 *   either spelling the backends produce. Longest first is not required; the
 *   walk re-checks the whole list after each peel.
 * @returns the bare host tool name, or null when no prefix matched at all (or
 *   the name was nothing but namespaces).
 */
export function stripMcpNamespace(name: string, prefixes: readonly string[]): string | null {
  const usable = prefixes.filter(prefix => prefix.length > 0)
  let current = name
  let stripped = false
  // Bounded, so a name made only of prefixes cannot spin here.
  for (let layer = 0; layer < MAX_NAMESPACE_LAYERS; layer++) {
    const found = usable.find(prefix => current.startsWith(prefix))
    if (found === undefined) return stripped && current.length > 0 ? current : null
    current = current.slice(found.length)
    stripped = true
  }
  // Still a namespace after the cap: there is no tool name in here, and
  // returning the remainder would hand the host a prefix as if it were a tool.
  return usable.some(prefix => current.startsWith(prefix)) || current.length === 0
    ? null
    : stripped ? current : null
}

/**
 * The two spellings one MCP server name is exposed under by the backends.
 *
 * @param serverName - the name the server was registered with, e.g. `dsh-host`.
 * @returns the registered spelling followed by the CLI-sanitised one; the two
 *   collapse to a single entry when the name is already alphanumeric.
 */
export function mcpToolPrefixes(serverName: string): string[] {
  const registered = `mcp__${serverName}__`
  const sanitized = `mcp__${serverName.replace(/[^a-zA-Z0-9]/g, '_')}__`
  return sanitized === registered ? [registered] : [registered, sanitized]
}
