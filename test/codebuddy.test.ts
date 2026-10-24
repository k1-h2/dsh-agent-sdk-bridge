/**
 * CodeBuddy's catalog mapping and region routing.
 *
 * The SDK exposes richer raw entries than the Qoder one; these cases pin the
 * mapping the settings page and the adapter depend on, plus the two public
 * login regions (enterprise environments are deliberately not offered).
 */
import { describe, expect, it } from 'vitest'
import { codeBuddyEnvironment, isCodeBuddyRegion } from '../src/brand.ts'
import { resolveCodeBuddyModelId } from '../src/codebuddy-adapter.ts'
import { toCodeBuddyModel } from '../src/codebuddy.ts'

describe('CodeBuddy model mapping', () => {
  it('reads windows, vision, reasoning and the quoted credit multiplier', () => {
    const model = toCodeBuddyModel({
      id: 'glm-5.3',
      name: 'GLM-5.3',
      descriptionZh: '旗舰模型',
      maxInputTokens: 1_000_000,
      maxOutputTokens: 64_000,
      supportsImages: true,
      supportsReasoning: true,
      credits: 'x0.79 credits',
      contextWindow: { supportedLengths: [200_000, 400_000], defaultLength: 1_000_000 },
      reasoning: { supportedEfforts: ['low', 'high'], defaultEffort: 'high' },
    })
    expect(model).toMatchObject({
      id: 'glm-5.3',
      name: 'GLM-5.3',
      description: '旗舰模型',
      contextWindows: [200_000, 400_000, 1_000_000],
      defaultContextWindow: 1_000_000,
      vision: true,
      reasoningEfforts: ['low', 'high'],
      defaultEffort: 'high',
      priceFactor: 0.79,
    })
  })

  it('falls back to the input window and hides multimodal for a text model', () => {
    const model = toCodeBuddyModel({
      id: 'text-model',
      maxInputTokens: 128_000,
      supportsImages: true,
      disabledMultimodal: true,
      credits: 'x0.00 credits',
    })
    expect(model.defaultContextWindow).toBe(128_000)
    expect(model.vision).toBe(false)
    expect(model.priceFactor).toBe(0)
    expect(model.name).toBe('text-model')
  })
})

describe('CodeBuddy model ids', () => {
  it('honours configured aliases and the codebuddy- prefix', () => {
    expect(resolveCodeBuddyModelId('fast', { fast: 'fast-model' })).toBe('fast-model')
    expect(resolveCodeBuddyModelId('codebuddy-glm-5.3')).toBe('glm-5.3')
    expect(resolveCodeBuddyModelId('glm-5.3')).toBe('glm-5.3')
  })

  it('falls back to the SDK default rather than an empty id', () => {
    expect(resolveCodeBuddyModelId('')).toBe('default-model')
    expect(resolveCodeBuddyModelId('codebuddy-')).toBe('default-model')
  })
})

describe('CodeBuddy login regions', () => {
  it('maps the two public regions to the SDK environments', () => {
    expect(codeBuddyEnvironment('global')).toBe('external')
    expect(codeBuddyEnvironment('cn')).toBe('internal')
  })

  it('excludes enterprise environments', () => {
    for (const value of ['ioa', 'cloudhosted', 'selfhosted', 'internal', 'external', undefined]) {
      expect(isCodeBuddyRegion(value)).toBe(false)
    }
  })
})
