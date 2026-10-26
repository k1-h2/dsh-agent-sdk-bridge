/**
 * An image reaches the model twice: as pixels it can look at, and as a handle
 * that names the file it can process.
 *
 * Pixels alone are enough to answer "what is in this picture?", which is why
 * Qoder and CodeBuddy looked fine there. A "invert it and save" turn then went
 * looking for a file that was never in the workspace: the prompt carried no
 * path to the durable attachment. The host's native adapter avoids that by
 * appending `requestImageHandleText`, whose read-only normalized path (and the
 * instruction to copy it to a writable `.png`) is what makes editing work.
 *
 * These cases pin both halves: every forwarded image carries that handle, and
 * a historical image (already reduced to text on a rebuild) keeps it too.
 */
import { describe, expect, it } from 'vitest'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { CodeBuddyAdapter } from '../src/codebuddy-adapter.ts'
import { QoderAdapter } from '../src/adapter.ts'
import { feedToText, imageRefText, renderInitialFeed } from '../src/render.ts'

const REF: ImageAttachmentRef = {
  attachmentId: 'sha256:2b081468d33313d546912d12c2f5c6f2b352547ff871f3c939fc357dd096194a',
  mediaType: 'image/png',
  bytes: 12362,
  width: 492,
  height: 150,
} as ImageAttachmentRef

const PATH = 'C:\\Users\\tester\\.dsh\\attachments\\v1\\objects\\2b\\2b081468.png'
/** The host quotes the path with JSON.stringify, so backslashes are doubled. */
const QUOTED = JSON.stringify(PATH)

describe('image handle text', () => {
  it('names the read-only copy and how to make it writable', () => {
    const text = imageRefText(REF, PATH)
    expect(text).toContain(QUOTED)
    expect(text).toContain('492x150px')
    expect(text).toContain('image/png')
    // The instruction that turns "I can see it" into "I can edit it".
    expect(text).toContain('Copy to a writable path ending in .png before editing')
  })

  it('does not claim a text-only route when only the path is missing', () => {
    // Pixels are still sent; the old fallback said "accepts text only", which
    // made a vision model hunt for a file instead of looking at the image.
    const text = imageRefText(REF, undefined)
    expect(text).toContain('2b081468')
    expect(text).not.toContain('text only')
  })

  it('keeps the path on a historical image across a rebuild', () => {
    const messages = [
      {
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'image', attachment: REF }, { type: 'text', text: '这是原图' }],
      },
      { role: 'assistant', source: { kind: 'model', provider: 'qoder-cn', model: 'dfmodel' }, content: [{ type: 'text', text: '看到了' }] },
      { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '把它反色保存' }] },
    ] as never

    const feed = renderInitialFeed(undefined, messages, () => PATH)
    const text = feedToText(feed)
    // The current turn has no pixels, so this is the only way the model can
    // find the file the user is asking it to change.
    expect(text).toContain(QUOTED)
  })

  it('puts the handle in front of a Qoder image block', async () => {
    const adapter = new QoderAdapter({ imagePath: () => PATH })
    const images = new Map([[String(REF.attachmentId), { data: 'QUJD', mediaType: 'image/png' }]])
    const content = await (adapter as any).buildFeed(
      [{ type: 'image', attachment: REF }, { type: 'text', text: '把它反色保存' }],
      true,
      images,
    )
    expect(content[0]).toMatchObject({ type: 'text', text: expect.stringContaining(QUOTED) })
    expect(content[1]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/png' } })
    expect(content[2]).toEqual({ type: 'text', text: '把它反色保存' })
  })

  it('puts the handle in front of a CodeBuddy image block', async () => {
    const adapter = new CodeBuddyAdapter({
      imagePath: () => PATH,
      readImage: async () => ({ bytes: Buffer.from('ABC'), mediaType: 'image/png' }),
    })
    const content = await (adapter as any).buildFeed([{ type: 'image', attachment: REF }], true)
    expect(content[0]).toMatchObject({ type: 'text', text: expect.stringContaining(QUOTED) })
    expect(content[1]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/png' } })
  })
})
