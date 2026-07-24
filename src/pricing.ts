/**
 * Styrr Pricing — Pre-call cost estimation + strategy-based routing
 *
 * Enables cost-aware decisions BEFORE calling the LLM:
 * - estimateCost(model, inputChars, outputChars) → USD
 * - selectModel(models, strategy, inputChars) → best model for strategy
 *
 * Pricing data is embedded (updated with package releases).
 * Character-based token approximation (~4 chars = 1 token).
 */

// ─── Types ──────────────────────────────────────────────────────────────

export interface ModelPricing {
  /** Model ID (e.g., "gpt-4o", "claude-sonnet-4-20250514") */
  model: string;
  /** Provider name */
  provider: string;
  /** USD per 1K input tokens */
  inputPer1K: number;
  /** USD per 1K output tokens */
  outputPer1K: number;
  /** Context window (tokens) */
  contextWindow: number;
  /** Average latency in ms (approximate) */
  avgLatencyMs?: number;
  /** Quality score 0-100 (reasoning ability, tool_use accuracy) */
  qualityScore?: number;
}

export type RoutingStrategy = 'cheapest' | 'fastest' | 'quality' | 'fallback';

// ─── Pricing Database (embedded, ~50 common models) ─────────────────────

export const MODEL_PRICING: ModelPricing[] = [
  // Free (OpenRouter)
  { model: 'nvidia/nemotron-3-ultra-550b-a55b:free', provider: 'openrouter', inputPer1K: 0, outputPer1K: 0, contextWindow: 32768, avgLatencyMs: 3000, qualityScore: 85 },
  { model: 'nvidia/nemotron-3-super-120b-a12b:free', provider: 'openrouter', inputPer1K: 0, outputPer1K: 0, contextWindow: 32768, avgLatencyMs: 2500, qualityScore: 80 },
  { model: 'google/gemma-4-31b-it:free', provider: 'openrouter', inputPer1K: 0, outputPer1K: 0, contextWindow: 131072, avgLatencyMs: 2000, qualityScore: 75 },
  { model: 'google/gemma-4-26b-a4b-it:free', provider: 'openrouter', inputPer1K: 0, outputPer1K: 0, contextWindow: 131072, avgLatencyMs: 1800, qualityScore: 73 },
  { model: 'meta-llama/llama-3.3-70b-instruct:free', provider: 'openrouter', inputPer1K: 0, outputPer1K: 0, contextWindow: 131072, avgLatencyMs: 2000, qualityScore: 78 },
  { model: 'qwen/qwen3-coder:free', provider: 'openrouter', inputPer1K: 0, outputPer1K: 0, contextWindow: 65536, avgLatencyMs: 1500, qualityScore: 70 },

  // Paid — OpenRouter / OpenAI
  { model: 'openai/gpt-4o', provider: 'openai', inputPer1K: 0.005, outputPer1K: 0.015, contextWindow: 128000, avgLatencyMs: 1500, qualityScore: 92 },
  { model: 'openai/gpt-4o-mini', provider: 'openai', inputPer1K: 0.00015, outputPer1K: 0.0006, contextWindow: 128000, avgLatencyMs: 800, qualityScore: 82 },
  { model: 'openai/o1', provider: 'openai', inputPer1K: 0.015, outputPer1K: 0.06, contextWindow: 200000, avgLatencyMs: 5000, qualityScore: 98 },

  // Paid — Anthropic
  { model: 'anthropic/claude-sonnet-4-20250514', provider: 'anthropic', inputPer1K: 0.003, outputPer1K: 0.015, contextWindow: 200000, avgLatencyMs: 2000, qualityScore: 95 },
  { model: 'anthropic/claude-haiku-3.5', provider: 'anthropic', inputPer1K: 0.0008, outputPer1K: 0.004, contextWindow: 200000, avgLatencyMs: 600, qualityScore: 80 },
  { model: 'anthropic/claude-opus-4', provider: 'anthropic', inputPer1K: 0.015, outputPer1K: 0.075, contextWindow: 200000, avgLatencyMs: 4000, qualityScore: 97 },

  // Paid — Google
  { model: 'google/gemini-2.5-pro', provider: 'google', inputPer1K: 0.00125, outputPer1K: 0.01, contextWindow: 1000000, avgLatencyMs: 2500, qualityScore: 90 },
  { model: 'google/gemini-2.5-flash', provider: 'google', inputPer1K: 0.000075, outputPer1K: 0.0003, contextWindow: 1000000, avgLatencyMs: 500, qualityScore: 83 },

  // Paid — Meta (via OpenRouter)
  { model: 'meta-llama/llama-3.3-70b-instruct', provider: 'openrouter', inputPer1K: 0.0004, outputPer1K: 0.0004, contextWindow: 131072, avgLatencyMs: 1200, qualityScore: 78 },

  // Local (Ollama)
  { model: 'ollama/llama3.2', provider: 'ollama', inputPer1K: 0, outputPer1K: 0, contextWindow: 8192, avgLatencyMs: 5000, qualityScore: 60 },
];

// ─── Functions ──────────────────────────────────────────────────────────

/**
 * Estimate cost in USD for a model call.
 * Returns -1 if model not found in pricing DB.
 */
export function estimateCost(
  modelId: string,
  inputChars: number,
  expectedOutputChars: number = 500
): number {
  const pricing = findPricing(modelId);
  if (!pricing) return -1;

  const inputTokens = charsToTokens(inputChars);
  const outputTokens = charsToTokens(expectedOutputChars);

  return (inputTokens / 1000) * pricing.inputPer1K +
         (outputTokens / 1000) * pricing.outputPer1K;
}

/**
 * Get pricing info for a model.
 * Matches by exact ID or prefix (e.g., "gpt-4o" matches "openai/gpt-4o").
 */
export function findPricing(modelId: string): ModelPricing | undefined {
  return MODEL_PRICING.find(p =>
    p.model === modelId ||
    p.model.endsWith(`/${modelId}`) ||
    modelId.startsWith(p.model.replace(':free', ''))
  );
}

/**
 * Select best model from a list based on routing strategy.
 * Returns models sorted by strategy preference (first = best choice).
 */
export function selectByStrategy(
  modelIds: string[],
  strategy: RoutingStrategy,
  inputChars: number = 1000
): string[] {
  if (strategy === 'fallback') return modelIds; // original order

  const withPricing = modelIds.map(id => ({
    id,
    pricing: findPricing(id),
  }));

  switch (strategy) {
    case 'cheapest':
      return withPricing
        .sort((a, b) => {
          const costA = a.pricing ? estimateCost(a.id, inputChars) : Infinity;
          const costB = b.pricing ? estimateCost(b.id, inputChars) : Infinity;
          return costA - costB;
        })
        .map(m => m.id);

    case 'fastest':
      return withPricing
        .sort((a, b) => {
          const latA = a.pricing?.avgLatencyMs ?? 10000;
          const latB = b.pricing?.avgLatencyMs ?? 10000;
          return latA - latB;
        })
        .map(m => m.id);

    case 'quality':
      return withPricing
        .sort((a, b) => {
          const qualA = a.pricing?.qualityScore ?? 0;
          const qualB = b.pricing?.qualityScore ?? 0;
          return qualB - qualA; // DESC (highest first)
        })
        .map(m => m.id);

    default:
      return modelIds;
  }
}

/**
 * Check if a prompt fits within a model's context window.
 */
export function fitsContext(modelId: string, inputChars: number, reserveOutputTokens: number = 4096): boolean {
  const pricing = findPricing(modelId);
  if (!pricing) return true; // unknown model, assume it fits
  const inputTokens = charsToTokens(inputChars);
  return (inputTokens + reserveOutputTokens) <= pricing.contextWindow;
}

// ─── Helpers ────────────────────────────────────────────────────────────

/** Approximate tokens from character count (~4 chars per token for English) */
function charsToTokens(chars: number): number {
  return Math.ceil(chars / 4);
}
