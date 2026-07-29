export interface OpenRouterModel {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  architecture?: { tokenizer?: string; instruct_type?: string };
  supported_parameters?: string[];
}

export interface DiscoveredModel {
  id: string;
  contextLength: number;
  supportsTools: boolean;
  provider: string;
}

export interface DiscoveryResult {
  models: DiscoveredModel[];
  fetchedAt: string;
  totalFree: number;
  toolCapable: number;
}

export interface DiscoveryOptions {
  /** Minimum context window in tokens (default: 8192) */
  minContextLength?: number;
  /** Max models to return (default: 10) */
  maxResults?: number;
  /** Only include models that support tool_use (default: true) */
  requireToolSupport?: boolean;
  /** OpenRouter API base URL (default: https://openrouter.ai/api/v1) */
  baseUrl?: string;
  /** AbortSignal for timeout */
  signal?: AbortSignal;
}

const OPENROUTER_API = 'https://openrouter.ai/api/v1';

export async function discoverFreeModels(options: DiscoveryOptions = {}): Promise<DiscoveryResult> {
  const {
    minContextLength = 8192,
    maxResults = 10,
    requireToolSupport = true,
    baseUrl = OPENROUTER_API,
    signal,
  } = options;

  const res = await fetch(`${baseUrl}/models`, {
    headers: { 'Content-Type': 'application/json' },
    signal,
  });

  if (!res.ok) {
    throw new Error(`OpenRouter API ${res.status}: ${res.statusText}`);
  }

  const body = await res.json() as { data: OpenRouterModel[] };
  const raw = body.data || [];

  const totalFree = raw.filter(m => {
    const prompt = parseFloat(m.pricing?.prompt || '1');
    return prompt === 0;
  });

  const filtered = totalFree
    .filter(m => {
      const prompt = parseFloat(m.pricing?.prompt || '1');
      return prompt === 0;
    })
    .filter(m => {
      if (!requireToolSupport) return true;
      const params = m.supported_parameters || [];
      return params.includes('tools') || params.includes('tool_choice');
    })
    .filter(m => (m.context_length || 0) >= minContextLength)
    .sort((a, b) => (b.context_length || 0) - (a.context_length || 0))
    .slice(0, maxResults)
    .map(m => ({
      id: m.id,
      contextLength: m.context_length || 0,
      supportsTools: (m.supported_parameters || []).includes('tools'),
      provider: extractProvider(m.id),
    }));

  return {
    models: filtered,
    fetchedAt: new Date().toISOString(),
    totalFree: totalFree.length,
    toolCapable: filtered.length,
  };
}

export function lastResortModels(): string[] {
  return [
    'nvidia/nemotron-3-ultra-550b-a55b:free',
    'google/gemma-4-31b-it:free',
    'meta-llama/llama-3.3-70b-instruct:free',
    'mistralai/mistral-small-3.2-24b-instruct:free',
    'qwen/qwen3-coder:free',
  ];
}

function extractProvider(modelId: string): string {
  if (modelId.startsWith('anthropic/')) return 'anthropic';
  if (modelId.startsWith('openai/')) return 'openai';
  if (modelId.startsWith('google/')) return 'google';
  if (modelId.startsWith('meta-llama/')) return 'meta';
  if (modelId.startsWith('mistralai/')) return 'mistral';
  if (modelId.startsWith('nvidia/')) return 'nvidia';
  if (modelId.startsWith('qwen/')) return 'qwen';
  if (modelId.startsWith('cohere/')) return 'cohere';
  return 'unknown';
}
