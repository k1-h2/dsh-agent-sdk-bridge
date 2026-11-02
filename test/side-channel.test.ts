/**
 * A side-channel request must be rendered as a task, not as a conversation turn.
 *
 * DSH compacts a session by calling the same LLM seam with `purpose:
 * 'compaction'` and appending its own instruction (`Condense the conversation
 * ABOVE into a structured checkpoint…`) as the **last user message**. The request
 * therefore reads as "here is the conversation; now execute this instruction".
 *
 * Every adapter used to build that prompt with `renderInitialFeed`, which is
 * written for the opposite shape: it opens with "you are this agent's LLM
 * backend, output the next assistant reply" and closes with "the above is
 * background — output the next assistant reply". Both of those told the model to
 * continue the conversation, while the actual instruction sat inside the
 * "background" it was told to ignore. A compaction run dutifully replied with
 * the previous assistant message, so the checkpoint became a restatement of the
 * last reply.
 *
 * These tests pin the rendered prompt itself, because that string *is* the
 * contract with the model: nothing downstream can recover a summary from a
 * request that asked for a continuation.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { feedToText, renderInitialFeed, renderSideChannelFeed } from '../src/render.ts'

/** The first line and shape of DSH's compaction instruction, verbatim. */
const COMPACTION_INSTRUCTION = [
  'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
  '',
  '## Primary Request and Intent',
  '- [the user\'s original and evolving goals]',
  '',
  '## Next Step',
  '- [the single next action]',
].join('\n')

/** A short conversation followed by the instruction DSH appends for compaction. */
const COMPACTION_MESSAGES = [
  { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '把 1.2.4 发布到 npm' }] },
  { role: 'assistant', source: { kind: 'model', provider: 'codebuddy', model: 'm' }, content: [{ type: 'text', text: '先跑测试，然后提交。' }] },
  { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: COMPACTION_INSTRUCTION }] },
] as never

/** The prompt one compaction request produces. */
function sideChannelPrompt(messages = COMPACTION_MESSAGES): string {
  return feedToText(renderSideChannelFeed(undefined, messages))
}

describe('side-channel prompt shape', () => {
  it('presents the trailing instruction as the task', () => {
    const prompt = sideChannelPrompt()
    // The instruction is present and sits in the conversation it is asked to
    // summarise, not after it.
    expect(prompt).toContain('Condense the conversation ABOVE')
    expect(prompt.indexOf('Condense the conversation ABOVE')).toBeGreaterThan(prompt.indexOf('---- 宿主对话记录 ----'))
    // And the closing line names it as the thing to do.
    expect(prompt).toContain('请执行最后一条用户消息给出的任务')
    expect(prompt.indexOf('请执行最后一条用户消息给出的任务')).toBeGreaterThan(prompt.indexOf('Condense the conversation ABOVE'))
  })

  it('never asks for the next assistant reply', () => {
    const prompt = sideChannelPrompt()
    // The exact wording that produced a restated previous reply. Both the role
    // preamble and the old closing line carried it.
    expect(prompt).not.toContain('输出下一条助手回复')
    expect(prompt).not.toContain('下一条助手回复')
    // The host-tools sentence is equally wrong here: compaction runs no tools.
    expect(prompt).not.toContain('宿主的工具已经通过 MCP 挂进来')
  })

  it('renders the history it is asked to condense', () => {
    const prompt = sideChannelPrompt()
    // Both sides of the conversation must be visible, or the summary would be
    // invented rather than derived.
    expect(prompt).toContain('把 1.2.4 发布到 npm')
    expect(prompt).toContain('先跑测试，然后提交。')
    expect(prompt).toContain('[用户]')
    expect(prompt).toContain('[助手]')
  })

  it('keeps the host system prompt when the request carries one', () => {
    // DSH may summarise with the session's system prompt attached; dropping it
    // would lose the constraints the checkpoint must preserve.
    const withSystem = feedToText(renderSideChannelFeed('不要改 public API', COMPACTION_MESSAGES))
    expect(withSystem).toContain('不要改 public API')
    expect(withSystem).toContain('请执行最后一条用户消息给出的任务')
  })

  it('applies the same shape to a session-title request', () => {
    // Titles use the same seam with a shorter instruction; the role mismatch was
    // identical, so the rendering must be too.
    const messages = [
      { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '修一下 compaction 的问题' }] },
      { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Generate a short title for this session.' }] },
    ] as never
    const prompt = feedToText(renderSideChannelFeed(undefined, messages))
    expect(prompt).toContain('Generate a short title for this session.')
    expect(prompt).toContain('请执行最后一条用户消息给出的任务')
    expect(prompt).not.toContain('输出下一条助手回复')
  })
})

describe('normal conversation unchanged', () => {
  it('still asks for the next assistant reply', () => {
    // The contrast that makes the fix specific: an ordinary turn keeps the
    // backend role and the continuation instruction, because that *is* its job.
    const prompt = feedToText(renderInitialFeed(undefined, COMPACTION_MESSAGES))
    expect(prompt).toContain('你只输出"下一条助手回复"本身')
    expect(prompt).toContain('以上是背景。输出下一条助手回复')
  })
})

describe('every adapter routes side channels through the shared renderer', () => {
  const adapters = ['src/adapter.ts', 'src/codebuddy-adapter.ts', 'src/minimax-adapter.ts']

  it.each(adapters)('%s', file => {
    // A behavioral test would have to boot three SDKs; what actually regressed
    // was one line in each adapter, so the guard is on that line: build the
    // prompt with renderSideChannelFeed, and never re-add the old tail.
    const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    expect(text).toContain('renderSideChannelFeed(options.system, options.messages')
    expect(text).not.toContain('这是一次性旁路请求')
  })
})
