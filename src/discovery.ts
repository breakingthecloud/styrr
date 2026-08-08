import { findPricing } from './pricing.js';

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

// ─── Tools-first precheck (SoW-OSS-004 D1) ──────────────────────────────

export interface RecommendOptions {
  /** Minimum context window in tokens (default: 8192) */
  minContext?: number;
  /** Cap the ranked list (default: no cap) */
  maxResults?: number;
}

export interface RecommendResult {
  /** Echo of the input ids, in input order */
  models: string[];
  /** Ids that pass the tools + context precheck (unordered) */
  toolCapable: string[];
  /** toolCapable ordered by quality: qualityScore desc (unknown last), avgLatencyMs asc tie-break */
  ranked: string[];
}

/**
 * Canonical precheck: given model ids (or DiscoveredModel entries), return
 * the tool-capable subset ranked by quality. Apps consume `ranked` and cache
 * it — they should NOT reimplement the filter.
 *
 * Tool support: when a DiscoveredModel is given, its `supportsTools` flag is
 * authoritative. For plain string ids the model is assumed tool-capable
 * (discovery already filtered by `supported_parameters`).
 */
export function recommendToolsFirst(
  models: (string | DiscoveredModel)[],
  opts: RecommendOptions = {}
): RecommendResult {
  const { minContext = 8192, maxResults } = opts;

  const entries = models.map(m =>
    typeof m === 'string'
      ? { id: m, supportsTools: undefined as boolean | undefined, contextLength: undefined as number | undefined }
      : { id: m.id, supportsTools: m.supportsTools as boolean | undefined, contextLength: m.contextLength as number | undefined }
  );

  const toolCapable = entries.filter(e => {
    if (e.supportsTools === false) return false;
    const ctx = e.contextLength ?? findPricing(e.id)?.contextWindow ?? 0;
    return ctx >= minContext;
  });

  const ranked = [...toolCapable].sort((a, b) => {
    const pa = findPricing(a.id);
    const pb = findPricing(b.id);
    const qa = pa?.qualityScore ?? null;
    const qb = pb?.qualityScore ?? null;
    if (qa !== qb) return (qb ?? -1) - (qa ?? -1); // quality desc, unknown last
    return (pa?.avgLatencyMs ?? 10000) - (pb?.avgLatencyMs ?? 10000); // latency asc
  });

  const capped = maxResults ? ranked.slice(0, maxResults) : ranked;

  return {
    models: entries.map(e => e.id),
    toolCapable: toolCapable.map(e => e.id),
    ranked: capped.map(e => e.id),
  };
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
