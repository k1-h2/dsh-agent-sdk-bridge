/**
 * A tool can return a picture: `read_image` hands back pixels beside its path
 * envelope. On these routes tool results reach the inner model through the
 * MCP/ACP result channel, not through the prompt feed, so the renderer for that
 * channel is the only place the image can survive.
 *
 * These cases pin both halves: a readable attachment becomes an image content
 * block, and one the host could not read keeps the harness handle text instead
 * of disappearing.
 */
import { describe, expect, it } from 'vitest'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { CodeBuddyAdapter } from '../src/codebuddy-adapter.ts'
import { renderCodeBuddyResult } from '../src/codebuddy.ts'
import { MinimaxAdapter } from '../src/minimax-adapter.ts'
import { renderToolResult } from '../src/minimax.ts'

const REF: ImageAttachmentRef = {
  attachmentId: 'sha256:2b081468d33313d546912d12c2f5c6f2b352547ff871f3c939fc357dd096194a',
  mediaType: 'image/png',
  bytes: 3,
  width: 2,
  height: 2,
}

const IMAGES = new Map([[String(REF.attachmentId), { data: 'QUJD', mediaType: 'image/png' }]])
const RESULT = [
  { type: 'text', text: '<path>C:/pictures/9.png</path>' },
  { type: 'image', attachment: REF },
]

describe('tool-result images', () => {
  it('forwards a CodeBuddy tool image as an MCP image block', () => {
    const content = renderCodeBuddyResult(RESULT, IMAGES)
    expect(content).toEqual([
      { type: 'text', text: '<path>C:/pictures/9.png</path>' },
      { type: 'image', data: 'QUJD', mimeType: 'image/png' },
    ])
  })

  it('keeps the handle text when a CodeBuddy tool image cannot be read', () => {
    const content = renderCodeBuddyResult([{ type: 'image', attachment: REF }], new Map())
    expect(content).toHaveLength(1)
    expect(content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('image omitted') })
    expect(content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('2b081468') })
  })

  it('forwards a MiniMax tool image as an MCP image block', () => {
    expect(renderToolResult(RESULT, IMAGES).content).toEqual([
      { type: 'text', text: '<path>C:/pictures/9.png</path>' },
      { type: 'image', data: 'QUJD', mimeType: 'image/png' },
    ])
  })

  it('keeps the handle text when a MiniMax tool image cannot be read', () => {
    const result = renderToolResult([{ type: 'image', attachment: REF }], new Map())
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('2b081468') })
  })

  it('resolves images from tool results in the not-yet-fed tail', async () => {
    const tail = [{ role: 'tool', toolCallId: 'c1', content: [{ type: 'image', attachment: REF }] }] as never
    const reader = async () => ({ bytes: Buffer.from('ABC'), mediaType: 'image/png' as const })

    const codebuddy = new CodeBuddyAdapter({ readImage: reader })
    const cbImages = await (codebuddy as any).resolveTurnImages(tail, true)
    expect(cbImages.get(String(REF.attachmentId))).toEqual({ data: 'QUJD', mediaType: 'image/png' })

    const minimax = new MinimaxAdapter({ readImage: reader })
    const mmImages = await (minimax as any).resolveTurnImages(tail, true)
    expect(mmImages.get(String(REF.attachmentId))).toEqual({ data: 'QUJD', mediaType: 'image/png' })
  })
})
