/**
 * Context-window family heuristic (FID-2026-0809-001 Phase 3).
 *
 * Moved from cli/src/utils/openrouter-models/static-catalogs.ts so the
 * heuristic lives in common — one implementation for every consumer.
 * Conservative estimates based on known model capabilities; the live gateway
 * catalog (resolveContextWindowForModel) takes priority over these.
 */

/**
 * Infer a reasonable context-window from a model name when the gateway does not
 * return one (e.g. hardcoded TokenRouter / OpenCode Go catalogs).
 */
export function inferContextLength(name: string): number {
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
