/**
 * One tool name, however many times it was namespaced.
 *
 * A model occasionally emits an already-qualified tool name, and the CLI then
 * qualifies it again, so a handler receives `mcp__dsh_host__mcp__dsh_host__edit`.
 * Every backend used to peel exactly one layer, handing the host
 * `mcp__dsh_host__edit` — a name it does not have — and the two errors this
 * produced looked like two unrelated bugs:
 *
 *   Error: unknown tool "mcp__dsh_host__edit"            (DSH, dsh-tools)
 *   Tool "mcp__dsh_host__mcp__dsh_host__edit" does not    (the CodeBuddy CLI,
 *     exist in the current tool set.                       synthesised by it)
 *
 * The first is the host failing to dispatch a name nobody registered; the second
 * is the CLI refusing a name its MCP server does not carry. The model oscillated
 * between them because each error taught it the opposite spelling. Both are the
 * same defect: a prefix peeled once instead of exhaustively.
 */
import { describe, expect, it } from 'vitest'
import { stripMcpNamespace, mcpToolPrefixes } from '../src/mcp-naming.ts'

const CODEBUDDY_PREFIXES = mcpToolPrefixes('dsh-host')

describe('namespace spellings', () => {
  it('accepts both spellings each backend produces', () => {
    // CodeBuddy rewrites the server name's hyphen to `_`; the Qoder and MiniMax
    // CLIs keep it. One server, two names on the wire.
    expect(CODEBUDDY_PREFIXES).toEqual(['mcp__dsh-host__', 'mcp__dsh_host__'])
  })

  it('collapses to one prefix when the server name needs no rewriting', () => {
    expect(mcpToolPrefixes('dshhost')).toEqual(['mcp__dshhost__'])
  })
})

describe('stripping the namespace', () => {
  it('peels a single layer', () => {
    expect(stripMcpNamespace('mcp__dsh_host__ops_bash', CODEBUDDY_PREFIXES)).toBe('ops_bash')
    expect(stripMcpNamespace('mcp__dsh-host__ops_bash', CODEBUDDY_PREFIXES)).toBe('ops_bash')
  })

  it('peels every layer, which is the case that produced both errors', () => {
    // The name the CLI handed over after the model re-sent an already-qualified
    // one. One layer would yield `mcp__dsh_host__edit` — the exact string DSH
    // reported as `unknown tool`.
    const doubled = 'mcp__dsh_host__mcp__dsh_host__edit'
    expect(stripMcpNamespace(doubled, CODEBUDDY_PREFIXES)).toBe('edit')
    // And the mixed-spelling variant, because the CLI's rewrite is per layer.
    expect(stripMcpNamespace('mcp__dsh-host__mcp__dsh_host__edit', CODEBUDDY_PREFIXES)).toBe('edit')
    expect(stripMcpNamespace('mcp__dsh_host__mcp__dsh_host__mcp__dsh_host__read', CODEBUDDY_PREFIXES)).toBe('read')
  })

  it('reports "not mine" rather than inventing a name', () => {
    // A bare tool name is not this server's; each backend falls back to treating
    // it as its own native tool, so the distinction has to survive.
    expect(stripMcpNamespace('ops_bash', CODEBUDDY_PREFIXES)).toBeNull()
    expect(stripMcpNamespace('Bash', CODEBUDDY_PREFIXES)).toBeNull()
    // Nothing but namespaces leaves no tool name at all.
    expect(stripMcpNamespace('mcp__dsh_host__', CODEBUDDY_PREFIXES)).toBeNull()
    expect(stripMcpNamespace('mcp__dsh_host__mcp__dsh_host__', CODEBUDDY_PREFIXES)).toBeNull()
  })

  it('ignores an empty prefix instead of matching everything', () => {
    // `startsWith('')` is always true, so an unguarded empty entry would make
    // every tool name look like this server's and strip nothing.
    expect(stripMcpNamespace('anything', ['', 'mcp__x__'])).toBeNull()
    expect(stripMcpNamespace('mcp__x__t', ['', 'mcp__x__'])).toBe('t')
  })

  it('terminates on a name made only of prefixes', () => {
    // The walk is bounded, so a pathological name cannot spin forever.
    expect(stripMcpNamespace('mcp__x__'.repeat(50), ['mcp__x__'])).toBeNull()
  })
})

describe('each backend agrees', () => {
  it('CodeBuddy, Qoder and MiniMax strip the doubled name to the same tool', async () => {
    const { hostToolName: codeBuddyName } = await import('../src/codebuddy.ts')
    const qoder = await import('../src/session.ts')
    const minimax = await import('../src/minimax.ts')

    // Each backend is asked about its own namespaced spelling of the same tool.
    expect(codeBuddyName('mcp__dsh_host__mcp__dsh_host__ops_edit_file')).toBe('ops_edit_file')
    expect(qoder.hostToolName('mcp__dsh-host__mcp__dsh-host__ops_edit_file')).toBe('ops_edit_file')
    expect(minimax.hostMcpToolName('mcp__dsh-host__mcp__dsh-host__ops_edit_file')).toBe('ops_edit_file')

    // And each still recognises its own namespaced tools while rejecting bare
    // names, which is what routes a call to the host at all.
    const { isHostTool } = await import('../src/codebuddy.ts')
    expect(isHostTool('mcp__dsh_host__ops_edit_file')).toBe(true)
    expect(isHostTool('ops_edit_file')).toBe(false)
    expect(minimax.isHostMcpTool('mcp__dsh-host__ops_bash')).toBe(true)
    expect(minimax.isHostMcpTool('ops_bash')).toBe(false)
  })
})
