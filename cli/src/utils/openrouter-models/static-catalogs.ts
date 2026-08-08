/**
 * Hardcoded catalogs for providers whose model-list APIs require auth
 * (TokenRouter, TokenHarbor, OpenCode Go) or share the common model
 * configuration (CommandCode). All are synchronous.
 */
import {
  commandcodeModels,
  tokenharborModels,
} from '@savant-code/common/constants/model-config'

import type { OpenRouterModel } from './types'

const TOKENROUTER_CATALOG: OpenRouterModel[] = [
  // Tier 1 — Elite Flagships
  {
    id: 'tokenrouter/anthropic/claude-fable-5',
    name: 'Claude Fable 5',
    provider: 'tokenrouter',
  },
  {
    id: 'tokenrouter/openai/gpt-5.6-sol',
    name: 'GPT 5.6 Sol',
    provider: 'tokenrouter',
  },
  {
    id: 'tokenrouter/deepseek/deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    provider: 'tokenrouter',
  },
  {
    id: 'tokenrouter/qwen/qwen3.7-max',
    name: 'Qwen 3.7 Max',
    provider: 'tokenrouter',
  },
  { id: 'tokenrouter/z-ai/glm-5.2', name: 'GLM 5.2', provider: 'tokenrouter' },
  {
    id: 'tokenrouter/openai/gpt-5.5-pro',
    name: 'GPT 5.5 Pro',
    provider: 'tokenrouter',
  },
  {
    id: 'tokenrouter/anthropic/claude-opus-4.8',
    name: 'Claude Opus 4.8',
    provider: 'tokenrouter',
  },
  {
    id: 'tokenrouter/x-ai/grok-4.5',
    name: 'Grok 4.5',
    provider: 'tokenrouter',
  },
  {
    id: 'tokenrouter/moonshotai/kimi-k3',
    name: 'Kimi K3',
    provider: 'tokenrouter',
  },
  {
    id: 'tokenrouter/bytedance-seed/seedream-5.0-pro',
    name: 'Seedream 5.0 Pro',
    provider: 'tokenrouter',
  },
  { id: 'tokenrouter/MiniMax-M3', name: 'MiniMax M3', provider: 'tokenrouter' },
  // Tier 2 — Frontier Performers
  {
    id: 'tokenrouter/anthropic/claude-sonnet-5',
    name: 'Claude Sonnet 5',
    provider: 'tokenrouter',
  },
  {
    id: 'tokenrouter/openai/gpt-5.6-terra',
    name: 'GPT 5.6 Terra',
    provider: 'tokenrouter',
  },
  {
    id: 'tokenrouter/qwen/qwen3.7-plus',
    name: 'Qwen 3.7 Plus',
    provider: 'tokenrouter',
  },
  {
    id: 'tokenrouter/anthropic/claude-opus-4.8-fast',
    name: 'Claude Opus 4.8 Fast',
    provider: 'tokenrouter',
  },
  {
    id: 'tokenrouter/google/gemini-3.1-pro-preview',
    name: 'Gemini 3.1 Pro',
    provider: 'tokenrouter',
  },
  {
    id: 'tokenrouter/anthropic/claude-opus-4.7',
    name: 'Claude Opus 4.7',
    provider: 'tokenrouter',
  },
  {
    id: 'tokenrouter/anthropic/claude-opus-4.7-fast',
    name: 'Claude Opus 4.7 Fast',
    provider: 'tokenrouter',
  },
  {
    id: 'tokenrouter/openai/gpt-5.5',
    name: 'GPT 5.5',
    provider: 'tokenrouter',
  },
  {
    id: 'tokenrouter/z-ai/glm-5.2-free',
    name: 'GLM 5.2 Free',
    provider: 'tokenrouter',
  },
  {
    id: 'tokenrouter/deepseek/deepseek-v3.2',
    name: 'DeepSeek V3.2',
    provider: 'tokenrouter',
  },
  {
    id: 'tokenrouter/qwen/qwen3.6-plus',
    name: 'Qwen 3.6 Plus',
    provider: 'tokenrouter',
  },
  {
    id: 'tokenrouter/moonshotai/kimi-k2.7-code',
    name: 'Kimi K2.7 Code',
    provider: 'tokenrouter',
  },
  {
    id: 'tokenrouter/xiaomi/mimo-v2.5-pro',
    name: 'MiMo V2.5 Pro',
    provider: 'tokenrouter',
  },
  { id: 'tokenrouter/z-ai/glm-5.1', name: 'GLM 5.1', provider: 'tokenrouter' },
  {
    id: 'tokenrouter/openai/gpt-5.4',
    name: 'GPT 5.4',
    provider: 'tokenrouter',
  },
  {
    id: 'tokenrouter/x-ai/grok-4.3',
    name: 'Grok 4.3',
    provider: 'tokenrouter',
  },
  {
    id: 'tokenrouter/anthropic/claude-opus-4.6',
    name: 'Claude Opus 4.6',
    provider: 'tokenrouter',
  },
  {
    id: 'tokenrouter/openai/gpt-5.3-codex',
    name: 'GPT 5.3 Codex',
    provider: 'tokenrouter',
  },
  {
    id: 'tokenrouter/nvidia/nemotron-3-super-120b-a12b',
    name: 'Nemotron 3 Super 120B',
    provider: 'tokenrouter',
  },
  {
    id: 'tokenrouter/miromind/mirothinker-1-7-deepresearch',
    name: 'MiroThinker 1.7 DeepResearch',
    provider: 'tokenrouter',
  },
  {
    id: 'tokenrouter/qwen/qwen3.5-397b-a17b',
    name: 'Qwen 3.5 397B',
    provider: 'tokenrouter',
  },
  {
    id: 'tokenrouter/qwen/qwen3.5-122b-a10b',
    name: 'Qwen 3.5 122B',
    provider: 'tokenrouter',
  },
  {
    id: 'tokenrouter/openai/gpt-oss-120b',
    name: 'GPT-OSS 120B',
    provider: 'tokenrouter',
  },
]

const TOKENHARBOR_NAMES: Record<string, string> = {
  'tokenharbor/claude-opus-5': 'Claude Opus 5',
  'tokenharbor/claude-fable-5': 'Claude Fable 5',
  'tokenharbor/gpt-5.6-sol': 'GPT-5.6 Sol',
  'tokenharbor/kimi-k3': 'Kimi K3',
  'tokenharbor/qwen3.8-max': 'Qwen3.8 Max',
  'tokenharbor/gpt-5.6-terra': 'GPT-5.6 Terra',
  'tokenharbor/grok-4.5': 'Grok 4.5',
  'tokenharbor/claude-sonnet-5': 'Claude Sonnet 5',
  'tokenharbor/gemini-3.6-flash': 'Gemini 3.6 Flash',
  'tokenharbor/glm-5.2': 'GLM 5.2',
  'tokenharbor/gpt-5.6-luna': 'GPT-5.6 Luna',
  'tokenharbor/deepseek-v4-flash': 'DeepSeek V4 Flash',
  'tokenharbor/minimax-m3': 'MiniMax M3',
  'tokenharbor/deepseek-v4-pro': 'DeepSeek V4 Pro',
  'tokenharbor/mimo-v2.5-pro': 'MiMo V2.5 Pro',
  'tokenharbor/mimo-v2.5': 'MiMo V2.5',
  'tokenharbor/kimi-k3:free': 'Kimi K3 (Free)',
  'tokenharbor/deepseek-v4-flash:free': 'DeepSeek V4 Flash (Free)',
  'tokenharbor/mimo-v2.5:free': 'MiMo V2.5 (Free)',
  'tokenharbor/th-orchestra': 'TH Orchestra',
}

const OPENCODE_GO_CATALOG: OpenRouterModel[] = [
  // OpenAI-compatible models
  { id: 'opencode-go/grok-4.5', name: 'Grok 4.5', provider: 'opencode-go' },
  { id: 'opencode-go/glm-5.2', name: 'GLM 5.2', provider: 'opencode-go' },
  { id: 'opencode-go/glm-5.1', name: 'GLM 5.1', provider: 'opencode-go' },
  { id: 'opencode-go/kimi-k3', name: 'Kimi K3', provider: 'opencode-go' },
  {
    id: 'opencode-go/kimi-k2.7-code',
    name: 'Kimi K2.7 Code',
    provider: 'opencode-go',
  },
  { id: 'opencode-go/kimi-k2.6', name: 'Kimi K2.6', provider: 'opencode-go' },
  { id: 'opencode-go/mimo-v2.5', name: 'MiMo V2.5', provider: 'opencode-go' },
  {
    id: 'opencode-go/mimo-v2.5-pro',
    name: 'MiMo V2.5 Pro',
    provider: 'opencode-go',
  },
  {
    id: 'opencode-go/deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    provider: 'opencode-go',
  },
  {
    id: 'opencode-go/deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    provider: 'opencode-go',
  },
  // Anthropic-compatible models
  { id: 'opencode-go/minimax-m3', name: 'MiniMax M3', provider: 'opencode-go' },
  {
    id: 'opencode-go/minimax-m2.7',
    name: 'MiniMax M2.7',
    provider: 'opencode-go',
  },
  {
    id: 'opencode-go/qwen3.7-max',
    name: 'Qwen 3.7 Max',
    provider: 'opencode-go',
  },
  {
    id: 'opencode-go/qwen3.7-plus',
    name: 'Qwen 3.7 Plus',
    provider: 'opencode-go',
  },
  {
    id: 'opencode-go/qwen3.6-plus',
    name: 'Qwen 3.6 Plus',
    provider: 'opencode-go',
  },
]

/**
 * Infer a reasonable context-window from a model name when the gateway does not
 * return one (e.g. hardcoded TokenRouter / OpenCode Go catalogs).
 */
function inferContextLength(name: string): number {
  const lower = name.toLowerCase()
  // FID-2026-0725-085 CTX-010: Corrected model family context windows.
  // These are conservative estimates based on known model capabilities.
  // The live OpenRouter catalog (resolveContextWindowForModel) takes priority;
  // these only apply to hardcoded TokenRouter/OpenCode Go catalogs.
  if (lower.includes('gemini')) return 1_048_576
  if (lower.includes('claude')) return 200_000
  if (lower.includes('kimi')) return 256_000
  if (lower.includes('deepseek')) return 131_072
  // Grok-4.x: xAI models have 1M+ context windows
  if (lower.includes('grok')) return 1_000_000
  // GPT-5.x: OpenAI flagship models have 256k+ context
  if (lower.includes('gpt')) return 256_000
  // Qwen-3.x: 128k-256k depending on variant; use 128k as floor
  if (lower.includes('qwen')) return 128_000
  // GLM-5.x: Zhipu AI models have 1M context
  if (lower.includes('glm')) return 1_000_000
  // MiMo V2.5: Xiaomi reasoning models, 1M context
  if (lower.includes('mimo')) return 1_000_000
  // MiniMax M3: 256k context
  if (lower.includes('minimax')) return 256_000
  // Nemotron: NVIDIA models, 128k context
  if (lower.includes('nemotron')) return 128_000
  // MiroThinker: 128k context
  if (lower.includes('mirothinker')) return 128_000
  // Seedream: Image generation model, 128k context
  if (lower.includes('seedream')) return 128_000
  return 200_000
}

/**
 * Return the TokenRouter model catalog.
 * TokenRouter requires auth for its /v1/models endpoint, so we use a
 * hardcoded list. This is always synchronous — returns instantly.
 */
export function fetchTokenRouterModels(): OpenRouterModel[] {
  return TOKENROUTER_CATALOG.map((m) => ({
    ...m,
    contextLength: m.contextLength ?? inferContextLength(m.name),
  }))
}

/**
 * Return the complete published TokenHarbor catalog snapshot from
 * https://tokenharbor.ai/models. TokenHarbor's /v1/models endpoint is
 * intentionally not queried here; refresh this checked-in snapshot when the
 * public models page changes.
 */
export function getTokenHarborModels(): OpenRouterModel[] {
  return Object.values(tokenharborModels).map((id) => ({
    id,
    name: TOKENHARBOR_NAMES[id] ?? id.slice('tokenharbor/'.length),
    provider: 'tokenharbor' as const,
  }))
}

/**
 * Return the OpenCode Go model catalog.
 * OpenCode Go requires auth for its API, so we use a hardcoded list.
 * This is always synchronous — returns instantly.
 */
export function fetchOpenCodeGoModels(): OpenRouterModel[] {
  return OPENCODE_GO_CATALOG.map((m) => ({
    ...m,
    contextLength: m.contextLength ?? inferContextLength(m.name),
  }))
}

/**
 * Return the CommandCode model catalog.
 * The IDs are maintained in common model configuration so routing and picker
 * entries cannot silently drift apart. Context lengths are conservative
 * family estimates until CommandCode exposes authoritative metadata.
 */
export function fetchCommandCodeModels(): OpenRouterModel[] {
  return Object.values(commandcodeModels)
    .map((id) => ({
      id,
      name: id.slice('commandcode/'.length),
      provider: 'commandcode' as const,
      contextLength: inferContextLength(id),
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
}
