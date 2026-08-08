import { cloneDeep, has } from 'lodash'

import type { ProviderMetadata } from '../../types/messages/provider-metadata'

export function withCacheControl<
  T extends { providerOptions?: ProviderMetadata },
>(obj: T): T {
  const wrapper = cloneDeep(obj)
  if (!wrapper.providerOptions) {
    wrapper.providerOptions = {}
  }

  /* 'savant-code' provider name is not compatible with providerMetadata for
   * messages, so we need to use 'openaiCompatible' instead.
   * https://github.com/vercel/ai/blob/8e4fdac31b4f8c6a8d07a606a8833e74adf99470/packages/openai-compatible/src/chat/convert-to-openai-compatible-chat-messages.ts#L9
   */
  for (const provider of [
    'anthropic',
    'openrouter',
    'openaiCompatible',
  ] as const) {
    if (!wrapper.providerOptions[provider]) {
      wrapper.providerOptions[provider] = {}
    }
    wrapper.providerOptions[provider].cache_control = { type: 'ephemeral' }
  }

  return wrapper
}

export function withoutCacheControl<
  T extends { providerOptions?: ProviderMetadata },
>(obj: T): T {
  const wrapper = cloneDeep(obj)

  for (const provider of [
    'anthropic',
    'openrouter',
    'openaiCompatible',
  ] as const) {
    if (has(wrapper.providerOptions?.[provider]?.cache_control, 'type')) {
      delete wrapper.providerOptions?.[provider]?.cache_control?.type
    }
    if (
      Object.keys(wrapper.providerOptions?.[provider]?.cache_control ?? {})
        .length === 0
    ) {
      delete wrapper.providerOptions?.[provider]?.cache_control
    }
    if (Object.keys(wrapper.providerOptions?.[provider] ?? {}).length === 0) {
      delete wrapper.providerOptions?.[provider]
    }
  }

  if (Object.keys(wrapper.providerOptions ?? {}).length === 0) {
    delete wrapper.providerOptions
  }

  return wrapper
}
